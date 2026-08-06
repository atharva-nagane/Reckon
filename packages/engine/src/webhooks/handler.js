import { withTransaction } from '../db/client.js';
import { logger } from '../logger.js';
import { insertOutbox } from '../outbox/outbox.js';
import { applyPaymentTransition, getPaymentByIntentForUpdate, mapProviderStatus } from '../payments/service.js';
import { SignatureVerificationError } from './verify.js';

/**
 * The exactly-once core, shared by the webhook route and the backfill
 * command. Everything — idempotency record, state transition, ledger write,
 * outbox rows — commits in one DB transaction: a crash anywhere inside rolls
 * back the whole event, so the provider's redelivery reprocesses it from
 * scratch instead of double-processing. Exactly-once rests on the
 * processed_events PRIMARY KEY, not on isolation level (READ COMMITTED is
 * sufficient; the second inserter of a given event_id blocks until the first
 * commits, then short-circuits on conflict).
 */
export function createEventProcessor(opts) {
  return (event, rawPayload) =>
    withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
        [event.id, event.type],
      );
      if (inserted.rowCount === 0) return 'duplicate';

      let outcome;
      const payment = await getPaymentByIntentForUpdate(client, opts.providerName, event.intent.providerPaymentIntentId);
      if (!payment) {
        // A verified event for a payment Reckon never created. Ack it — the
        // receipt is durably recorded here, and the missing-payment follow-up
        // is reconciliation's job, not the webhook path's.
        logger.warn({ eventId: event.id, intentId: event.intent.providerPaymentIntentId }, 'webhook for unknown payment');
        outcome = 'unknown_payment';
      } else {
        const result = await applyPaymentTransition(client, payment, mapProviderStatus(event.intent.status), {
          eventType: event.type,
          providerEventRef: event.id,
          rawPayload,
        });
        if (result.applied) {
          await insertOutbox(client, 'payment.state_changed', {
            paymentId: payment.id,
            fromState: payment.state,
            toState: result.payment.state,
            providerEventRef: event.id,
          });
        }
        outcome = result.applied ? 'applied' : 'recorded_unapplied';
      }

      opts.crashBeforeMarkDone?.();
      await client.query(`UPDATE processed_events SET status = 'done', processed_at = now() WHERE event_id = $1`, [
        event.id,
      ]);
      return outcome;
    });
}

export function createWebhookHandler(opts) {
  const processEvent = createEventProcessor(opts);

  return {
    async handleEvent(rawBody, signatureHeader) {
      let event;
      try {
        event = opts.verify(rawBody, signatureHeader);
      } catch (err) {
        if (err instanceof SignatureVerificationError) {
          logger.warn({ reason: err.message }, 'webhook signature rejected');
          return { status: 400, outcome: 'invalid_signature' };
        }
        throw err;
      }
      if (!event) return { status: 200, outcome: 'ignored' };

      try {
        const outcome = await processEvent(event, JSON.parse(rawBody.toString('utf8')));
        logger.info({ eventId: event.id, eventType: event.type, outcome }, 'webhook processed');
        return { status: 200, outcome };
      } catch (err) {
        // Never swallow a processing error — non-2xx makes the provider
        // retry, and the idempotency record makes that retry safe.
        logger.error({ eventId: event.id, err: err instanceof Error ? err.message : String(err) }, 'webhook processing failed');
        return { status: 500, outcome: 'error' };
      }
    },
  };
}
