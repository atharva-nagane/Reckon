/**
 * Abstraction over a payment provider's sandbox API. v1 ships a Stripe
 * test-mode implementation and a mock fallback; Razorpay is a documented
 * future implementer of this same shape:
 *
 *   createPaymentIntent(input) -> Promise<ProviderPaymentIntent>
 *   retrievePaymentIntent(providerPaymentIntentId) -> Promise<ProviderPaymentIntent>
 *   createRefund(input) -> Promise<ProviderRefund>
 *   listEvents(since) -> Promise<ProviderEvent[]>
 *   listPaymentIntents(fromInclusive, toExclusive) -> Promise<ProviderPaymentIntent[]>
 *
 * `listEvents` exists for the backfill path: pull the provider's event log
 * for a window and re-feed it through the idempotent webhook core.
 * `listPaymentIntents` is the record of truth for a reconciliation window:
 * current intent states, keyed by creation time.
 */
