# Roadmap — deliberate v1 boundaries

v1 draws its scope on purpose. Each item below is a clean seam, not a half-built stub; nothing in the shipped code pretends these exist.

- **Second provider: Razorpay test mode.** The `PaymentProvider` shape (`packages/engine/src/payments/provider.js`) is the seam — create/retrieve/refund, `listEvents` for backfill, `listPaymentIntents` for reconciliation truth. A Razorpay implementation slots in beside `stripeProvider.js` and `mockProvider.js` with no engine changes. Webhook verification would add a Razorpay verifier in `src/webhooks/verify.js`.
- **Multi-currency / FX reconciliation.** Amounts already carry a `currency` column end to end; v1 pins one currency (`LEDGER_CURRENCY`). FX-rate drift becomes a seventh drift class once a second currency exists.
- **Refunds beyond the state machine.** `refund_pending → refunded` states and `createRefund` (with outbound idempotency keys) exist; a full refund-reconciliation case — refund webhooks, refund ledger postings, refund drift detection — is the next lifecycle to build on the same exactly-once processor.
- **Disputes / chargebacks.** Out of scope entirely in v1; later a break type of their own.
- **Alerting integrations.** The outbox already delivers to a generic `OUTBOX_SINK_URL` webhook (or structured logs when unset). Real integrations (Slack, PagerDuty) are new sinks in `src/outbox/outbox.js`, nothing more.
- **Materialized-balance cache.** Balances are derived from postings by design. At scale, a cached balance table can be layered on — and reconciling the cache against postings becomes one more reconciliation job, using machinery that already exists.
- **Multi-tenant / auth.** Single operator in v1; the API is unauthenticated for local use and must gain auth before any shared deployment.
- **TypeScript, if ever wanted back.** This build (`e:/reckon-js`) is a deliberate plain-JavaScript/plain-CSS port of the original TypeScript+Tailwind build (`e:/reckon`) for interview-prep reasons. The `PaymentProvider` shape, the ledger's balanced-posting contract, and the state machine's legal-edge list are all still implicit "types" worth re-introducing with JSDoc `@typedef` comments or a narrow `tsconfig.json` with `checkJs: true` if compile-time checking is wanted again without a full TS migration.
