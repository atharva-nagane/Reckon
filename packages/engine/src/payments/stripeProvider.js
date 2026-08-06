import Stripe from 'stripe';

const PAYMENT_INTENT_EVENT_TYPES = new Set([
  'payment_intent.created',
  'payment_intent.processing',
  'payment_intent.amount_capturable_updated',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
]);

// Stripe test-mode reference implementation. Card data never reaches this
// class — Stripe's hosted element owns confirmation; we only
// create/retrieve/refund PaymentIntents.
export class StripePaymentProvider {
  #stripe;

  constructor(secretKey) {
    if (secretKey.startsWith('sk_live_')) {
      throw new Error('refusing to initialize StripePaymentProvider with a live secret key');
    }
    this.#stripe = new Stripe(secretKey, { apiVersion: '2024-06-20' });
  }

  async createPaymentIntent(input) {
    const intent = await this.#stripe.paymentIntents.create(
      {
        amount: Number(input.amount),
        currency: input.currency.toLowerCase(),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return toProviderIntent(intent);
  }

  async retrievePaymentIntent(providerPaymentIntentId) {
    const intent = await this.#stripe.paymentIntents.retrieve(providerPaymentIntentId);
    return toProviderIntent(intent);
  }

  async createRefund(input) {
    const refund = await this.#stripe.refunds.create(
      {
        payment_intent: input.providerPaymentIntentId,
        amount: Number(input.amount),
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return {
      providerRefundId: refund.id,
      status: refund.status === 'succeeded' ? 'succeeded' : refund.status === 'failed' ? 'failed' : 'pending',
      amount: BigInt(refund.amount),
    };
  }

  async listPaymentIntents(fromInclusive, toExclusive) {
    const intents = [];
    for await (const intent of this.#stripe.paymentIntents.list({
      created: { gte: Math.floor(fromInclusive.getTime() / 1000), lt: Math.floor(toExclusive.getTime() / 1000) },
      limit: 100,
    })) {
      intents.push(toProviderIntent(intent));
    }
    return intents;
  }

  async listEvents(since) {
    const events = [];
    for await (const event of this.#stripe.events.list({
      created: { gte: Math.floor(since.getTime() / 1000) },
      limit: 100,
    })) {
      if (!PAYMENT_INTENT_EVENT_TYPES.has(event.type)) continue;
      events.push(stripeEventToProviderEvent(event));
    }
    // Stripe lists newest-first; backfill wants oldest-first so the state machine sees natural order.
    return events.reverse();
  }
}

export function stripeEventToProviderEvent(event) {
  return {
    id: event.id,
    type: event.type,
    createdAt: new Date(event.created * 1000),
    intent: toProviderIntent(event.data.object),
  };
}

// Stripe has no single "failed" PaymentIntent status — a declined attempt
// falls back to requires_payment_method with `last_payment_error` set.
// Reckon treats that combination as `failed` so the state machine sees a
// terminal state instead of looping back to "still pending".
function toProviderIntent(intent) {
  return {
    providerPaymentIntentId: intent.id,
    status: mapStatus(intent),
    amount: BigInt(intent.amount),
    currency: intent.currency.toUpperCase(),
  };
}

function mapStatus(intent) {
  switch (intent.status) {
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
      return 'canceled';
    case 'processing':
      return 'processing';
    case 'requires_capture':
      return 'requires_capture';
    case 'requires_payment_method':
      return intent.last_payment_error ? 'failed' : 'requires_payment';
    case 'requires_confirmation':
    case 'requires_action':
      return 'requires_payment';
    default:
      return 'requires_payment';
  }
}
