import { pool } from '../db/client.js';
import { MOCK_WEBHOOK_SECRET } from '../payments/mockProvider.js';
import { createWebhookHandler } from '../webhooks/handler.js';
import { mockVerifier } from '../webhooks/verify.js';

/** Minor units shaved off by the simulated write-path bug. */
export const MUTATION_DELTA = 1_000n;

/**
 * Sits between the (mock) provider and the webhook handler and corrupts
 * delivery on command. Deliveries are real signed bodies through the real
 * handler — the point is to prove the production path survives, not a copy of
 * it. Demo/test-mode only by construction: it needs the mock's signing key.
 */
export class FaultProxy {
  #provider;
  #plan = new Map();
  #delayed = [];
  #handler;

  constructor(provider) {
    this.#provider = provider;
    this.#handler = createWebhookHandler({ providerName: 'mock', verify: mockVerifier(MOCK_WEBHOOK_SECRET) });
  }

  inject(kind, eventId) {
    this.#plan.set(eventId, kind);
  }

  async deliverAll(events) {
    const ordered = events.filter((e) => this.#plan.get(e.id) !== 'reorder');
    ordered.push(...events.filter((e) => this.#plan.get(e.id) === 'reorder'));

    const outcomes = [];
    for (const event of ordered) {
      const fault = this.#plan.get(event.id);
      if (fault === 'drop') continue;
      if (fault === 'delay') {
        this.#delayed.push(event);
        continue;
      }
      if (fault === 'mutate_amount') {
        // The fault is in Reckon's local write path, not on the wire — the
        // signature stays valid; the amount the ledger writes from is wrong
        await pool.query(
          'UPDATE payments SET amount = amount - $1 WHERE provider = $2 AND provider_payment_intent_id = $3',
          [MUTATION_DELTA.toString(), 'mock', event.intent.providerPaymentIntentId],
        );
      }
      outcomes.push(await this.#deliver(event));
      if (fault === 'duplicate') outcomes.push(await this.#deliver(event)); // same event id, delivered twice
    }
    return outcomes;
  }

  /** Late arrival of delayed events — must be harmless by idempotency + the state machine. */
  async releaseDelayed() {
    const events = this.#delayed.splice(0);
    const outcomes = [];
    for (const event of events) {
      outcomes.push(await this.#deliver(event));
    }
    return outcomes;
  }

  async #deliver(event) {
    const { rawBody, signature } = this.#provider.signedEventBody(event.id);
    const { status, outcome } = await this.#handler.handleEvent(rawBody, signature);
    if (status >= 500) throw new Error(`webhook handler errored on ${event.id}: ${outcome}`);
    return outcome;
  }
}
