# LAUNCH_REPORT — placeholder inventory

This repo (`reckon-js`) is a plain-JavaScript, plain-CSS port of the original TypeScript+Tailwind build at `e:/reckon`. Same architecture, same invariants, same tests — see [PROJECT_REPORT.md](PROJECT_REPORT.md) for what changed and why. Everything the build could not know is listed here. The build never fails on a placeholder; each one degrades gracefully as described.

## Secrets and environment (owner must supply to use Stripe test mode)

| Placeholder | Where | Behavior when absent |
|---|---|---|
| `STRIPE_TEST_KEY` | `packages/engine/.env` | Engine falls back to the built-in mock provider; everything remains demoable. Live `sk_live_` keys are refused in code. |
| `STRIPE_WEBHOOK_SECRET` | `packages/engine/.env` | Required only when `PROVIDER=stripe`; the server fails fast at startup with instructions (`stripe listen --print-secret`). |
| `OUTBOX_SINK_URL` | `packages/engine/.env` | Outbox deliveries are structured-logged instead of POSTed — an honest no-op sink, not a fake integration. |

Non-secret defaults that ship working values: `DATABASE_URL`, `REDIS_URL`, `MOCK_WEBHOOK_SECRET` (test-only signing key for the mock provider's webhooks — not a real credential), `LEDGER_CURRENCY=INR`.

## Launch assets (owner-supplied)

- Blog posts — the outline exists in [docs/launch.md](docs/launch.md); the published URLs do not.
- Demo video — the 2-minute script is in [docs/launch.md](docs/launch.md); the recording is not made.
- License file — pick one (MIT/Apache-2.0) and add `LICENSE`.
- Screenshots in [`E:\reckon-js-screenshots`](../reckon-js-screenshots) were captured from this build with real seeded + chaos-generated data — see the README for how to reproduce them.

## Verified-fact caveats

- This build swaps TypeScript's compile-time money-safety guard for a runtime-only one: `moneyFromJSON()` in `src/money/money.js` still throws on a JS `number` input, and the test suite still asserts bigint math throughout — but nothing stops a future edit from typing a money field as `number` and having it silently compile. The original TypeScript build used the type system plus an eslint rule as a *second*, independent enforcement layer; this port relies on tests and code review alone. Documented honestly, not hidden.
- The Stripe integration is implemented against the SDK but has not been exercised against a real Stripe test account in this build (no `STRIPE_TEST_KEY` was available — same as the original). The full lifecycle, exactly-once pipeline, reconciliation, and chaos harness are proven against the mock provider, whose events use the same signature scheme and event shapes. First run against real Stripe test mode: `npm run drive-payment` with the CLI steps it prints, then `stripe trigger payment_intent.succeeded`.

## Accuracy numbers (measured, not invented)

All quotable figures come from this build actually running, against real Postgres/Redis containers, on 2026-08-06:

- **42 automated tests passing** (property-based ledger invariants, idempotency, crash safety, six drift-class reconciliation suites, the fault matrix) — `npm run engine:test`.
- **Fault verification matrix: 8/8 scenarios PASS** — `npm run chaos`.
- Detection scored against injected ground truth: **100% precision, 100% recall** over mixed multi-round runs; **83.3% of detected breaks auto-resolved** (amount mismatches are never auto-resolved, by rule) — identical to the original TypeScript build's numbers, confirming the port changed no behavior.

Re-run `npm run chaos` to regenerate these rather than quoting stale values.
