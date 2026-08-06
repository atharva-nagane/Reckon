import { createHmac, timingSafeEqual } from 'node:crypto';
import Stripe from 'stripe';
import { z } from 'zod';
import { moneyFromJSON } from '../money/money.js';
import { stripeEventToProviderEvent } from '../payments/stripeProvider.js';

export class SignatureVerificationError extends Error {}

// Reject signatures whose timestamp is outside ±5 minutes.
const TOLERANCE_SECONDS = 300;

const mockEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  created: z.number().int(),
  data: z.object({
    object: z.object({
      id: z.string(),
      status: z.enum(['requires_payment', 'processing', 'requires_capture', 'succeeded', 'canceled', 'failed']),
      amount: z.string(),
      currency: z.string(),
    }),
  }),
});

/** Verifies the mock provider's Stripe-format `t=<ts>,v1=<hmac>` signature over the raw bytes. */
export function mockVerifier(secret) {
  return (rawBody, signatureHeader) => {
    const parts = new Map(
      signatureHeader.split(',').map((pair) => {
        const idx = pair.indexOf('=');
        return [pair.slice(0, idx), pair.slice(idx + 1)];
      }),
    );
    const timestampRaw = parts.get('t');
    const signature = parts.get('v1');
    if (!timestampRaw || !signature) {
      throw new SignatureVerificationError('malformed signature header');
    }

    const timestamp = Number(timestampRaw);
    if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) {
      throw new SignatureVerificationError('signature timestamp outside tolerance');
    }

    const expected = createHmac('sha256', secret).update(`${timestampRaw}.${rawBody.toString('utf8')}`).digest();
    const provided = Buffer.from(signature, 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new SignatureVerificationError('signature mismatch');
    }

    let parsed;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new SignatureVerificationError('body is not valid JSON');
    }
    const event = mockEventSchema.safeParse(parsed);
    if (!event.success) {
      throw new SignatureVerificationError(`event payload failed validation: ${event.error.message}`);
    }

    const { id, type, created, data } = event.data;
    return {
      id,
      type,
      createdAt: new Date(created * 1000),
      intent: {
        providerPaymentIntentId: data.object.id,
        status: data.object.status,
        amount: moneyFromJSON(data.object.amount),
        currency: data.object.currency,
      },
    };
  };
}

const PAYMENT_INTENT_TYPE_PREFIX = 'payment_intent.';

export function stripeVerifier(webhookSecret) {
  // constructEvent never touches the network; the key is only needed to instantiate the SDK.
  const stripe = new Stripe(process.env.STRIPE_TEST_KEY ?? 'sk_test_signature_verification_only', {
    apiVersion: '2024-06-20',
  });

  return (rawBody, signatureHeader) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
    } catch (err) {
      throw new SignatureVerificationError(err instanceof Error ? err.message : 'signature verification failed');
    }
    if (!event.type.startsWith(PAYMENT_INTENT_TYPE_PREFIX)) return null;
    return stripeEventToProviderEvent(event);
  };
}
