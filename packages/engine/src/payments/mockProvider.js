import { createHmac, randomUUID } from 'node:crypto';

export const MOCK_WEBHOOK_SECRET = process.env.MOCK_WEBHOOK_SECRET ?? 'whsec_mock_test';

const EVENT_TYPE_BY_STATUS = {
  requires_payment: 'payment_intent.created',
  processing: 'payment_intent.processing',
  requires_capture: 'payment_intent.amount_capturable_updated',
  succeeded: 'payment_intent.succeeded',
  canceled: 'payment_intent.canceled',
  failed: 'payment_intent.payment_failed',
};

/**
 * Local fallback when no Stripe test credentials are configured, so the
 * whole system stays demoable without a Stripe account. Progresses status
 * only when explicitly told to (`confirm`/`fail`) — nothing advances on a timer,
 * so demos and tests are deterministic.
 */
export class MockPaymentProvider {
  #intents = new Map();
  #refunds = new Map();
  #usedIdempotencyKeys = new Map();
  #events = [];

  async createPaymentIntent(input) {
    const existingId = this.#usedIdempotencyKeys.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.#intents.get(existingId);
      if (existing) return toPublic(existing);
    }

    const id = `mock_pi_${randomUUID()}`;
    const intent = {
      providerPaymentIntentId: id,
      status: 'requires_payment',
      amount: input.amount,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date(),
    };
    this.#intents.set(id, intent);
    this.#usedIdempotencyKeys.set(input.idempotencyKey, id);
    this.#recordEvent(intent);
    return toPublic(intent);
  }

  async retrievePaymentIntent(providerPaymentIntentId) {
    const intent = this.#intents.get(providerPaymentIntentId);
    if (!intent) throw new Error(`mock provider: unknown payment intent ${providerPaymentIntentId}`);
    return toPublic(intent);
  }

  async createRefund(input) {
    const intent = this.#intents.get(input.providerPaymentIntentId);
    if (!intent) throw new Error(`mock provider: unknown payment intent ${input.providerPaymentIntentId}`);
    const existing = this.#refunds.get(input.idempotencyKey);
    if (existing) return existing;

    const refund = {
      providerRefundId: `mock_re_${randomUUID()}`,
      status: 'succeeded',
      amount: input.amount,
    };
    this.#refunds.set(input.idempotencyKey, refund);
    return refund;
  }

  async listEvents(since) {
    return this.#events.filter((e) => e.createdAt >= since);
  }

  async listPaymentIntents(fromInclusive, toExclusive) {
    return [...this.#intents.values()]
      .filter((i) => i.createdAt >= fromInclusive && i.createdAt < toExclusive)
      .map(toPublic);
  }

  /** Test/demo-only: erases the provider's record of an intent — the "lost authorization" shape. */
  forgetIntent(providerPaymentIntentId) {
    this.#intents.delete(providerPaymentIntentId);
  }

  /** Test/demo-only: simulates the customer completing the hosted checkout. */
  simulateProcessing(providerPaymentIntentId) {
    return this.#transition(providerPaymentIntentId, 'processing');
  }

  /** Test/demo-only: simulates the provider finally settling the payment. */
  simulateSucceeded(providerPaymentIntentId) {
    return this.#transition(providerPaymentIntentId, 'succeeded');
  }

  /** Test/demo-only: simulates a declined or canceled payment. */
  simulateFailed(providerPaymentIntentId) {
    return this.#transition(providerPaymentIntentId, 'failed');
  }

  /**
   * The mock's webhook deliveries are real signed payloads — same
   * `t=<ts>,v1=<hmac>` header scheme Stripe uses — so the verification path is
   * exercised for real even without a Stripe account.
   */
  signedEventBody(eventId, secret = MOCK_WEBHOOK_SECRET) {
    const event = this.#events.find((e) => e.id === eventId);
    if (!event) throw new Error(`mock provider: unknown event ${eventId}`);

    const rawBody = Buffer.from(
      JSON.stringify({
        id: event.id,
        type: event.type,
        created: Math.floor(event.createdAt.getTime() / 1000),
        data: {
          object: {
            id: event.intent.providerPaymentIntentId,
            status: event.intent.status,
            amount: event.intent.amount.toString(),
            currency: event.intent.currency,
          },
        },
      }),
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const hmac = createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
    return { rawBody, signature: `t=${timestamp},v1=${hmac}` };
  }

  #transition(id, status) {
    const intent = this.#intents.get(id);
    if (!intent) throw new Error(`mock provider: unknown payment intent ${id}`);
    intent.status = status;
    return this.#recordEvent(intent);
  }

  #recordEvent(intent) {
    const event = {
      id: `mock_evt_${randomUUID()}`,
      type: EVENT_TYPE_BY_STATUS[intent.status],
      createdAt: new Date(),
      intent: toPublic(intent),
    };
    this.#events.push(event);
    return event;
  }
}

function toPublic(intent) {
  return {
    providerPaymentIntentId: intent.providerPaymentIntentId,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
  };
}
