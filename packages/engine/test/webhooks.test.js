import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pool, withTransaction } from '../src/db/client.js';
import { drainOutbox, insertOutbox } from '../src/outbox/outbox.js';
import { MOCK_WEBHOOK_SECRET, MockPaymentProvider } from '../src/payments/mockProvider.js';
import { createPayment, getPayment, paymentEvents } from '../src/payments/service.js';
import { createEventProcessor, createWebhookHandler } from '../src/webhooks/handler.js';
import { mockVerifier } from '../src/webhooks/verify.js';

afterAll(async () => {
  await pool.end();
});

function buildHandler(crashBeforeMarkDone) {
  return createWebhookHandler({ providerName: 'mock', verify: mockVerifier(MOCK_WEBHOOK_SECRET), crashBeforeMarkDone });
}

async function deliver(handler, provider, eventId) {
  const { rawBody, signature } = provider.signedEventBody(eventId);
  return handler.handleEvent(rawBody, signature);
}

async function createdEventId(provider, payment) {
  const events = await provider.listEvents(new Date(0));
  const created = events.find(
    (e) => e.intent.providerPaymentIntentId === payment.providerPaymentIntentId && e.type === 'payment_intent.created',
  );
  if (!created) throw new Error('mock provider recorded no created event');
  return created.id;
}

async function ledgerTxnCount(paymentId, kind) {
  const { rows } = await pool.query(
    kind
      ? 'SELECT count(*) AS n FROM ledger_transactions WHERE external_ref = $1 AND kind = $2'
      : 'SELECT count(*) AS n FROM ledger_transactions WHERE external_ref = $1',
    kind ? [paymentId, kind] : [paymentId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function processedCount(eventId) {
  const { rows } = await pool.query('SELECT count(*) AS n FROM processed_events WHERE event_id = $1', [eventId]);
  return Number(rows[0]?.n ?? 0);
}

describe('signature verification', () => {
  it('rejects a tampered body', async () => {
    const provider = new MockPaymentProvider();
    const payment = await createPayment(provider, 'mock', { amount: 1_000n, currency: 'INR' });
    const eventId = await createdEventId(provider, payment);
    const { rawBody, signature } = provider.signedEventBody(eventId);

    const tampered = Buffer.from(rawBody.toString('utf8').replace('"1000"', '"9000"'));
    const result = await buildHandler().handleEvent(tampered, signature);
    expect(result).toEqual({ status: 400, outcome: 'invalid_signature' });
    expect(await processedCount(eventId)).toBe(0);
  });

  it('rejects a stale signature even when the HMAC is valid', async () => {
    const provider = new MockPaymentProvider();
    const payment = await createPayment(provider, 'mock', { amount: 1_000n, currency: 'INR' });
    const { rawBody } = provider.signedEventBody(await createdEventId(provider, payment));

    const staleTs = Math.floor(Date.now() / 1000) - 400;
    const hmac = createHmac('sha256', MOCK_WEBHOOK_SECRET).update(`${staleTs}.${rawBody.toString('utf8')}`).digest('hex');
    const result = await buildHandler().handleEvent(rawBody, `t=${staleTs},v1=${hmac}`);
    expect(result).toEqual({ status: 400, outcome: 'invalid_signature' });
  });

  it('rejects a malformed signature header', async () => {
    const result = await buildHandler().handleEvent(Buffer.from('{}'), 'not-a-signature');
    expect(result).toEqual({ status: 400, outcome: 'invalid_signature' });
  });
});

describe('exactly-once processing', () => {
  it('drives a payment to succeeded via webhooks and writes ledger effects once', async () => {
    const provider = new MockPaymentProvider();
    const handler = buildHandler();
    const payment = await createPayment(provider, 'mock', { amount: 25_000n, currency: 'INR' });

    expect((await deliver(handler, provider, await createdEventId(provider, payment))).outcome).toBe('applied');
    const processing = provider.simulateProcessing(payment.providerPaymentIntentId);
    expect((await deliver(handler, provider, processing.id)).outcome).toBe('applied');
    const succeeded = provider.simulateSucceeded(payment.providerPaymentIntentId);
    expect((await deliver(handler, provider, succeeded.id)).outcome).toBe('applied');

    expect((await getPayment(payment.id))?.state).toBe('succeeded');
    expect(await ledgerTxnCount(payment.id, 'hold')).toBe(1);
    expect(await ledgerTxnCount(payment.id, 'payment')).toBe(1);

    // replay the settlement event several times — expect exactly one ledger transaction
    for (let i = 0; i < 5; i++) {
      const replay = await deliver(handler, provider, succeeded.id);
      expect(replay).toEqual({ status: 200, outcome: 'duplicate' });
    }
    expect(await ledgerTxnCount(payment.id, 'payment')).toBe(1);
    expect(await processedCount(succeeded.id)).toBe(1);

    const { rows: outboxRows } = await pool.query(
      `SELECT payload FROM outbox WHERE topic = 'payment.state_changed' AND payload->>'paymentId' = $1`,
      [payment.id],
    );
    expect(outboxRows.length).toBe(3); // one per applied transition, none for the replays
  });

  it('acks an event for a payment Reckon never created without writing business state', async () => {
    const provider = new MockPaymentProvider();
    const intent = await provider.createPaymentIntent({ amount: 500n, currency: 'INR', idempotencyKey: 'orphan' });
    const events = await provider.listEvents(new Date(0));
    const orphan = events.find((e) => e.intent.providerPaymentIntentId === intent.providerPaymentIntentId);
    if (!orphan) throw new Error('no orphan event');

    const result = await deliver(buildHandler(), provider, orphan.id);
    expect(result).toEqual({ status: 200, outcome: 'unknown_payment' });
    expect(await processedCount(orphan.id)).toBe(1);
  });
});

describe('crash safety', () => {
  it('rolls back the whole event on a crash before mark-done, and the retry processes exactly once', async () => {
    const provider = new MockPaymentProvider();
    const payment = await createPayment(provider, 'mock', { amount: 7_000n, currency: 'INR' });
    await deliver(buildHandler(), provider, await createdEventId(provider, payment));

    const processing = provider.simulateProcessing(payment.providerPaymentIntentId);
    const crashing = buildHandler(() => {
      throw new Error('simulated crash between the write and the mark-done commit');
    });
    const crashed = await deliver(crashing, provider, processing.id);
    expect(crashed.status).toBe(500);

    // the same-transaction guarantee: idempotency record AND business write both rolled back
    expect(await processedCount(processing.id)).toBe(0);
    expect((await getPayment(payment.id))?.state).toBe('pending');
    expect(await ledgerTxnCount(payment.id, 'hold')).toBe(0);

    const retried = await deliver(buildHandler(), provider, processing.id);
    expect(retried).toEqual({ status: 200, outcome: 'applied' });
    expect((await getPayment(payment.id))?.state).toBe('inflight');
    expect(await ledgerTxnCount(payment.id, 'hold')).toBe(1);
  });
});

describe('out-of-order delivery', () => {
  it('records a premature event as unapplied instead of corrupting state', async () => {
    const provider = new MockPaymentProvider();
    const handler = buildHandler();
    const payment = await createPayment(provider, 'mock', { amount: 3_000n, currency: 'INR' });
    await deliver(handler, provider, await createdEventId(provider, payment));

    const processing = provider.simulateProcessing(payment.providerPaymentIntentId);
    const succeeded = provider.simulateSucceeded(payment.providerPaymentIntentId);

    // succeeded arrives before processing
    const early = await deliver(handler, provider, succeeded.id);
    expect(early).toEqual({ status: 200, outcome: 'recorded_unapplied' });
    expect((await getPayment(payment.id))?.state).toBe('pending');

    const events = await paymentEvents(payment.id);
    const unapplied = events.find((e) => !e.applied);
    expect(unapplied?.toState).toBe('succeeded');

    const late = await deliver(handler, provider, processing.id);
    expect(late).toEqual({ status: 200, outcome: 'applied' });
    expect((await getPayment(payment.id))?.state).toBe('inflight');
    // the succeeded event was consumed while premature — the payment is now
    // stuck inflight with provider truth ahead of it: exactly the drift the
    // reconciler exists to catch.
  });
});

describe('backfill recovery', () => {
  it('replays a window of provider events through the idempotent core, safely twice', async () => {
    const provider = new MockPaymentProvider();
    const since = new Date();
    const payment = await createPayment(provider, 'mock', { amount: 40_000n, currency: 'INR' });
    provider.simulateProcessing(payment.providerPaymentIntentId);
    provider.simulateSucceeded(payment.providerPaymentIntentId);
    // no webhooks delivered at all — total delivery outage

    const processEvent = createEventProcessor({ providerName: 'mock' });
    const run = async () => {
      const outcomes = [];
      for (const event of await provider.listEvents(since)) {
        outcomes.push(await processEvent(event));
      }
      return outcomes;
    };

    expect(await run()).toEqual(['applied', 'applied', 'applied']);
    expect((await getPayment(payment.id))?.state).toBe('succeeded');
    expect(await ledgerTxnCount(payment.id, 'payment')).toBe(1);

    expect(await run()).toEqual(['duplicate', 'duplicate', 'duplicate']);
    expect(await ledgerTxnCount(payment.id, 'payment')).toBe(1);
  });
});

describe('outbox delivery', () => {
  it('delivers pending rows and marks them, exactly once per row', async () => {
    const seen = [];
    const first = await drainOutbox(async (topic, payload) => {
      seen.push({ topic, payload });
    });
    expect(first.delivered).toBe(seen.length);
    expect(first.failed).toBe(0);

    const again = await drainOutbox(async () => {
      throw new Error('should not be called — nothing pending');
    });
    expect(again).toEqual({ delivered: 0, failed: 0 });
  });

  it('keeps a failing row pending with attempts and last_error recorded', async () => {
    await withTransaction((client) => insertOutbox(client, 'test.failing', { probe: true }));

    const result = await drainOutbox(async () => {
      throw new Error('sink down');
    });
    expect(result).toEqual({ delivered: 0, failed: 1 });

    const { rows } = await pool.query(
      `SELECT status, attempts, last_error FROM outbox WHERE topic = 'test.failing' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 1, last_error: 'sink down' });

    const recovered = await drainOutbox(async () => {});
    expect(recovered.delivered).toBe(1);
  });
});
