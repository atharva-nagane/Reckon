# Launch assets — demo script and blog outline

## Demo video script (~2 minutes)

1. **(0:00–0:15) The claim.** Dashboard Overview on screen: "books balanced: yes", assets exactly offsetting liabilities+revenue. "Every number here is derived from append-only double-entry postings — nothing is a mutable balance column."
2. **(0:15–0:35) The ledger.** Ledger tab: trial balance netting to zero, a payment's hold → reversal → settlement transaction chain. "Money reserved, money released, money settled — three balanced transactions, never an edit."
3. **(0:35–1:10) Break it.** Chaos tab: fire **drop webhooks**. The verification row appears: expected `missing`, detected `missing`, auto-resolved by backfill replay. Flip to Payments and show the payment reached `succeeded` anyway, with the reconciliation events in its history.
4. **(1:10–1:35) The one it refuses to fix.** Fire **corrupt amount**. Break appears `amount_mismatch / critical / open`. Reconciliation tab: drill into the break — provider snapshot says 25000, Reckon's ledger says 24000, side by side. "When money is wrong, the engine flags a human. It never guesses."
5. **(1:35–2:00) The proof.** Run **full matrix** — all rows green — then **precision/recall run**: 100/100 against injected ground truth. Overview again: books still balanced. "Chaos in, consistency out, with an audit trail for every correction."

## Blog series outline (problem-first, prose-heavy, no timeline voice)

1. **Why money is double-entry, not a balance column.** The overwrite bug class; balanced immutable postings; the deferred Postgres trigger as second enforcement layer; deriving balances and why caching them is a reconciliation problem of its own.
2. **Exactly-once webhook processing that survives a crash.** At-least-once delivery is the provider's contract; the idempotency-record-plus-business-write-in-one-transaction pattern; why the crash between "fulfilled" and "recorded" is the whole game; raw-body signature verification pitfalls.
3. **The outbox pattern in practice.** Side effects that must not be lost or invented across crashes; same-transaction outbox rows; at-least-once delivery workers and idempotent sinks.
4. **Detecting six classes of payment drift.** The window diff; why "missing" and "stuck-pending" are different classes; the unresolved hold as reserved-money risk; the safety rule — append-only corrections, and never auto-resolve an amount mismatch.
5. **Injecting chaos into a payment pipeline to prove reconciliation works.** Fault proxy design; ground truth at injection time; scoring detection as precision/recall; what a green matrix does and does not prove.
6. **Porting a TypeScript+Tailwind codebase to plain JS+CSS without losing any invariants.** What a type system was actually buying (compile-time money-safety), what replaces it at runtime (`moneyFromJSON`'s explicit `number` rejection, the test suite), and the one real bug class the port has to watch for that TypeScript used to catch for free.

## Launch checklist

- [ ] Pick license (MIT or Apache-2.0), add `LICENSE`.
- [ ] Record the demo video from the script above.
- [ ] Publish blog posts; fill their URLs into the README.
- [ ] Show HN / r/fintech / r/programming / LinkedIn. Hook: *"I built the boring, important half of payments — the reconciliation engine that proves the money is right. Then I injected chaos to prove it catches every kind of drift."*
- [ ] Resume bullets from LAUNCH_REPORT's measured numbers only.
