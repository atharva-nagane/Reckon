import { MockPaymentProvider } from './mockProvider.js';
import { StripePaymentProvider } from './stripeProvider.js';

export * from './stateMachine.js';
export * from './service.js';
export { MockPaymentProvider } from './mockProvider.js';
export { StripePaymentProvider } from './stripeProvider.js';

let cachedProvider;

/** Falls back to the mock provider when Stripe test credentials are absent. */
export function resolveProvider() {
  if (cachedProvider) return cachedProvider;

  const secretKey = process.env.STRIPE_TEST_KEY;
  if (process.env.PROVIDER === 'stripe' && secretKey) {
    cachedProvider = { provider: new StripePaymentProvider(secretKey), name: 'stripe' };
  } else {
    cachedProvider = { provider: new MockPaymentProvider(), name: 'mock' };
  }
  return cachedProvider;
}
