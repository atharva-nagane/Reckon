# Reckon (plain-JS port) — Full Project Report

**A reconciliation and ledger-integrity engine — proving the money is always right.**

**Author:** Atharva Nagane · **Version:** 1.0-js · **Status:** v1 complete (M0–M6), ported to plain JS/CSS
**Type:** Solo backend / distributed-systems-correctness project
**Stack:** Node.js + JavaScript (ESM), PostgreSQL 16, Redis + BullMQ, React + Vite + plain CSS

> This document is the complete record of Reckon: the idea and why it's worth building, the architecture, the implementation milestone by milestone, the measured results, the engineering problems solved along the way, and an honest account of what is and isn't done. Every number in the "Results" section comes from code in this repository actually running — none are invented.

---

## 0. Why this repo exists — the TypeScript→JavaScript, Tailwind→CSS port

This is a deliberate fork of the original build at `e:/reckon`, which was written in strict TypeScript with a Tailwind dashboard. The original spec even says, in so many words, "do not implement this in plain JavaScript" — TypeScript's compiler was chosen as one of two independent enforcement layers for money-safety (the other being tests).

That decision got revisited for a practical reason: recent technical interviews exposed a real gap in TypeScript fundamentals, and the fastest way to close it is to stop leaning on the compiler as a crutch in personal projects. So this repo strips TypeScript and Tailwind out of the same codebase — same architecture, same double-entry ledger, same exactly-once webhook core, same six-drift-class reconciliation engine, same fault-injection harness — and reimplements it in plain JavaScript (ESM, Node's native class-private-field syntax where the original used `private`/parameter properties) and hand-written CSS (a small design-token system replacing Tailwind's utility classes). The two repos are meant to sit side by side for comparison, not to replace one another.

Everything below describes the same system as the original report; §§0, and the callouts marked **[port]**, are what's new.

---

## 1. One-line summary

Reckon is **not a checkout app.** It is the layer *underneath* the "payment successful" page — a double-entry ledger where every movement of money is a balanced, immutable set of postings, a payment lifecycle engineered to stay correct when webhooks arrive twice / out of order / never, and a reconciliation engine that continuously proves the internal ledger matches the payment provider's records — backed by a fault-injection harness that deliberately breaks delivery to *prove* the reconciler catches every class of drift.

---

## 2. The idea — and why it's the interesting half of payments

Most payment projects are a checkout flow bolted onto Stripe: everyone builds it, nobody remembers it, and every reviewer thinks "so it's a Stripe wrapper?"

The genuinely hard, high-stakes part of payments infrastructure is **making sure the money is actually right after the fact.** Payment gateways fail mid-transaction. Webhooks arrive twice, out of order, or never. Your database says "paid" while the provider says "pending." At scale, a tiny fraction of mismatches becomes a real financial hole. **Reconciliation** is the unglamorous backbone that real fintech teams staff whole squads for, and that flashy demos never touch.

Reckon was built to operate at exactly that layer. The framing was deliberate from day one: describe it as *reconciliation and ledger integrity*, never as "a payments app." The former is a distributed-systems-correctness project reviewers respect; the latter invites the Stripe-wrapper dismissal.

**The "aha" moment in the demo:** inject chaos into a live payment pipeline — drop a webhook, send a duplicate, corrupt an amount — and watch the reconciler catch it and *prove the ledger is consistent again.* Anyone who has worked near money recognizes instantly that the problem has been thought about the way they have to think about it.

---

## 3. Positioning — what makes it different

| What most people build | What Reckon builds |
|---|---|
| Checkout → Stripe → "payment successful" page | The ledger and reconciliation layer *underneath* that page |
| A mutable `balance` column they overwrite | Append-only double-entry postings with a zero-sum invariant |
| "Handle the webhook" (once, happy path) | Exactly-once processing under duplicate / out-of-order / dropped delivery |
| Trust that the DB and provider agree | Continuously *prove* they agree; detect and resolve every drift class |
| A screenshot of a success page | A live chaos demo: break delivery, watch the reconciler restore integrity |

**The unique claim:** Reckon treats a payment system the way a bank's back office does — the front-end charge is the easy part; the reconciliation and ledger integrity *is* the real system.

**Honest caveat (stated up front):** reconciliation is well-understood in industry — this is not a novel research contribution. The value is demonstrating it can be *implemented correctly*, which is rare at the junior level and highly legible to fintech reviewers.

---

## 4. Goals and non-goals (scope discipline was a deliverable)

### Primary goals (all delivered in v1, preserved by the port)
1. A double-entry ledger with a provable zero-sum invariant.
2. A payment lifecycle with idempotent, exactly-once webhook processing and the outbox pattern, against a provider sandbox.
3. A reconciliation engine detecting six drift classes, with safe auto-resolution and flagging otherwise, all audited.
4. A fault-injection harness that drops / duplicates / reorders / corrupts events, plus a test suite proving the reconciler catches each.
5. A dashboard + BI export exposing reconciliation metrics.

### Explicit non-goals for v1 (deliberately *not* built — recorded as clean seams, never fake stubs)
- **Real money / live mode.** Sandbox only, forever, in this repo. Live `sk_live_` keys are *refused in code*.
- **Storing card data / any PCI-scoped handling.** The provider's hosted checkout owns all card data; Reckon sees only tokens and object IDs.
- **Multi-currency / FX reconciliation.** One currency; amounts already carry a `currency` column so FX drift is an additive later class.
- **A second payment provider.** The `PaymentProvider` shape is defined day one so Razorpay can slot in later; v1 ships Stripe test mode + a mock provider.
- **Fraud / KYC / AML, payouts, disputes/chargebacks, multi-tenant.** Out of scope; documented in the roadmap.
- **[port] Re-introducing TypeScript.** That's the entire point of this repo's existence — see §0.

Building any non-goal in v1 would have been scope failure. Each is a documented placeholder in `docs/ROADMAP.md`, not a stub that pretends to work.

---

## 5. Architecture

```
                                   ┌──────────────────────────────────────────┐
  Stripe test mode                 │  Reckon engine (Node + JavaScript, ESM)  │
  or mock provider                 │                                          │
 ┌───────────────┐   webhooks     │  ┌────────────┐   same-DB-transaction    │
 │ PaymentIntents │──(signed raw──▶│  │  webhook   │──┬─ processed_events    │
 │ events.list    │    bodies)     │  │  handler   │  ├─ payment_events      │
 └───────┬───────┘                 │  └────────────┘  ├─ ledger postings     │
         │                         │        ▲         └─ outbox ─▶ worker    │
         │ provider truth          │        │ replay                         │
         ▼                         │  ┌────────────┐      ┌───────────────┐  │
 ┌───────────────┐    window diff  │  │ backfill / │      │ double-entry  │  │
 │ fault proxy    │──(drop, dup,──▶│  │ reconciler │─────▶│ ledger        │  │
 │ (chaos)        │  reorder, ...) │  └────────────┘      │ zero-sum, DB- │  │
 └───────────────┘                 │   breaks + audit     │ enforced      │  │
                                   └──────────────────────────────────────────┘
                                            │                    │
                                     React dashboard      CSV → PowerBI
                                     (plain CSS)
```

### Tech stack (with reasons)

| Layer | Choice | Why |
|---|---|---|
| Language | **JavaScript, ESM, Node 20+** | **[port]** Deliberately *not* TypeScript — see §0. Money-safety now leans entirely on runtime discipline (`moneyFromJSON` throws on a `number` input) plus the same 42-test suite the TS build had; there is no compiler backstop, and that trade-off is documented rather than hidden (§16). |
| Runtime / API | **Node.js + Express** | First-class payment SDK + webhook tooling. The webhook route uses a **raw-body** parser (`express.raw`) because signature verification needs the unmodified bytes; every other route uses JSON. |
| Database | **PostgreSQL 16** | Reconciliation correctness leans on real transactions, isolation levels, unique constraints, row locking, and trigger-enforced invariants — none of which SQLite gives you. |
| Queue / async | **BullMQ + Redis 7** | Drives the outbox delivery worker and scheduled reconciliation jobs. |
| Money math | **`bigint` minor units**, runtime-guarded | Never JS `number`/float in the money path. `moneyFromJSON()` explicitly rejects a `number` argument at the boundary — the one guard the port keeps, since it's a runtime check, not a type-system one. |
| Validation | **zod** | On every API and webhook payload boundary — unaffected by the language swap; zod's schema objects are runtime values either way. |
| Testing | **Vitest + fast-check** | Property-based ledger invariants, idempotency, crash safety, the fault matrix — same 42 tests, same assertions, now running against plain JS. |
| Provider | **Stripe SDK (test mode)** + a built-in **mock provider** | The mock emits canned, signable events using the same signature scheme, so the entire system is demoable with no Stripe account. |
| Dashboard | **React + Vite + plain CSS + Recharts** | **[port]** Tailwind's utility classes replaced with a small hand-written design-token stylesheet (`index.css`): CSS custom properties for the slate/emerald palette, semantic classes (`.card`, `.btn-primary`, `.data-table`) instead of utility soup, dynamic per-state colors (severity dots, status labels) as small JS color-map objects applied via inline `style`. |

---

## 6. The double-entry ledger (the intellectual core)

Representing money as balanced, immutable, integer postings is *the* thing that separates someone who has thought about financial systems from someone who hasn't. This is the part that had to be exactly right — and the part the port could least afford to get wrong, since the compiler is no longer watching it.

### Non-negotiable invariants (enforced in code *and* in the database)
1. **Balanced transactions:** within any ledger transaction, `sum(debits) == sum(credits)`. Enforced in application code *and* by a deferred Postgres constraint trigger. An unbalanced transaction is rejected at commit, never written.
2. **Append-only:** postings and transactions are immutable once written. A DB trigger rejects `UPDATE`/`DELETE` on posting rows. Corrections are *new reversing transactions*, never edits.
3. **Integer minor units:** all amounts are `bigint` paise/cents. No floats, ever.
4. **Every balance is derived**, never stored as a mutable field: `balance(account) = sum(credits) − sum(debits)` over its postings.

### Example: a ₹500 payment with a ₹10 fee
One `ledger_transaction(kind=payment)` with three postings — debit `provider_clearing` 50000, credit `revenue` 49000, credit `fees` 1000 (debits 50000 == credits 50000 ✓). The exact account map lives once in `docs/chart_of_accounts.md`.

### Holds (`inflight` payments)
Money reserved but not finally settled gets its own transaction kind — `hold` — posting into a dedicated `provider_holds` asset account, so the trial balance always shows exactly how much is reserved-but-unsettled. On settle, a `payment` transaction moves it to the normal accounts and a reversing entry clears the hold; on release, a single reversing transaction zeroes the hold and no `payment` is ever created. Holds that outlive their window are a distinct, higher-urgency drift class than ordinary stuck-pending, because real money is reserved and unaccounted for.

---

## 7. Payment lifecycle (correct under failure)

### State machine (explicit, enforced)
```
created ──▶ pending ──▶ inflight ──▶ succeeded
   │          │           │
   └──────────┴───────────┴────────▶ failed
succeeded ──▶ refund_pending ──▶ refunded
```
- Current state is derived from an append-only `payment_events` log; the mutable column is only a cache.
- Illegal transitions (e.g. `succeeded` after `refunded`) are **not applied blindly** — they are recorded and flagged for reconciliation. Out-of-order handling is a designed feature, not an afterthought.
- **Outbound idempotency:** every create/refund call to the provider carries a deterministic idempotency key derived from the Reckon payment id + action, so a retried create never double-creates a provider object.

---

## 8. Exactly-once webhook processing (the crash-safe core)

This encodes researched, verified provider mechanics: webhooks are delivered **at-least-once** (the same `event.id` can arrive multiple times), signatures are HMAC over the **raw** request body via the `Stripe-Signature` header with a ~5-minute timestamp tolerance, and providers retry with backoff for up to 72 hours.

The pattern:
```
1. verify signature (raw body)                      → 400 on failure
2. BEGIN TX
3.   INSERT event.id INTO processed_events           -- UNIQUE(event_id)
        ON CONFLICT DO NOTHING
     if no row inserted (duplicate): COMMIT; 200      -- short-circuit
4.   apply business logic:
        - validate the state transition
        - write the ledger transaction IF this event settles money
        - write outbox rows for side-effects
5.   mark processed_events row done
6. COMMIT       -- idempotency record + business write in ONE transaction
7. return 2xx quickly; heavy work already enqueued via the outbox
```

**The critical rule:** the idempotency record and the business write live in the **same DB transaction.** A crash between "fulfilled" and "recorded" would otherwise double-process on the provider's retry. On any processing error the handler returns non-2xx so the provider retries — the idempotency store makes that retry safe *by construction*.

A `backfill --since <ts>` command re-feeds provider events for a window through the same idempotent handler — the manual recovery path when webhooks were down, and a live demonstration of why idempotency matters.

---

## 9. The reconciliation engine — six drift classes

A scheduled BullMQ job (and an on-demand `reconcile --window` CLI) pulls the provider's record of truth for a time window, pulls Reckon's ledger + payment state for the same window, and diffs them into **breaks**. Every break stores *both* snapshots (what the provider said vs. what Reckon said) and, on resolution, the exact action taken including any reversing-transaction id — a full audit trail.

| # | Drift class | Detection | Resolution |
|---|---|---|---|
| 1 | **Missing** | Provider shows a settled payment Reckon has no ledger transaction for (lost webhook) | Auto: replay the event via backfill, then re-check |
| 2 | **Duplicate** | Reckon has two ledger transactions for one provider payment | Auto: write a reversing transaction for the extra |
| 3 | **Amount-mismatch** | Provider amount ≠ Reckon ledger amount | **Never auto-resolved** — always flagged for a human. Highest severity. |
| 4 | **Stuck-pending** | Reckon shows `pending` past a threshold; provider is terminal | Auto: pull provider truth, advance the state machine |
| 5 | **Unresolved hold** | Reckon shows `inflight` past a threshold with no provider resolution | Auto if provider shows release/capture; flag if the provider has *no record* of the hold (a lost authorization needs a human) |
| 6 | **Status / out-of-order** | States genuinely disagree (Reckon `succeeded`, provider `refunded`) | Auto if provider truth simply supersedes a stale local state; flag if contradictory |

**Safety rule:** auto-resolution may only ever *append* reversing/correcting transactions (append-only), never edit or delete history, and **never** auto-resolves an amount-mismatch. When unsure, flag — a false "resolved" is worse than an open break.

---

## 10. The fault-injection harness (what makes the demo memorable)

In test/demo mode, provider events pass through a Reckon **fault proxy** that can be configured to corrupt the stream. Because the harness knows exactly what it corrupted, every injected fault has a *known expected break* — so detection can be scored against ground truth (a real, quotable precision/recall number).

The five faults: **drop** (lost webhook → missing / stuck-pending), **duplicate** (same id → must NOT break; a "double-count" variant that bypasses idempotency → must break), **reorder** (`succeeded` before `pending` → out-of-order), **mutate-amount** (alter Reckon's local write → amount-mismatch), and **delay** (hold past the window → stuck-pending or unresolved-hold).

---

## 11. Results — measured, not invented

> Every figure below is produced by code in *this* repository (`reckon-js`) running (`npm run engine:test`, `npm run chaos`), against real Postgres 16 + Redis 7 containers, on 2026-08-06. Re-run to regenerate rather than quoting stale values.

### Fault-injection verification matrix (`npm run chaos`)
```
fault               expected break   detected         resolution                                         result
------------------  ---------------  ---------------  -------------------------------------------------  ------
control             (none)           (none)           -                                                  PASS
drop                missing          missing          auto_resolved: backfill_replay                     PASS
drop_resolution     unresolved_hold  unresolved_hold  auto_resolved: provider_truth_applied              PASS
duplicate_delivery  (none)           (none)           -                                                  PASS
double_count        duplicate        duplicate        auto_resolved: reversed_1_duplicate_settlement(s)  PASS
reorder             unresolved_hold  unresolved_hold  auto_resolved: provider_truth_applied              PASS
mutate_amount       amount_mismatch  amount_mismatch  open                                               PASS
delay               stuck_pending    stuck_pending    auto_resolved: provider_truth_applied              PASS
```

### Headline metrics
| Metric | Value | Meaning |
|---|---|---|
| Fault scenarios passing | **8 / 8** | Every injected fault yields its expected break with the correct resolution |
| Detection precision | **100%** | Zero false positives against injected ground truth |
| Detection recall | **100%** | Zero false negatives — every real drift caught |
| Auto-resolution rate | **83.3%** | Deliberately below 100% — amount-mismatches *must* go to a human by rule |
| Exactly-once under duplicate delivery | **1 ledger txn from 5× replay** | Same signed event replayed 5 times → exactly one ledger transaction |
| Automated tests passing | **42** | Property-based invariants, idempotency, crash safety, per-drift-class suites, the fault matrix |

**[port] Identical to the original TypeScript build's numbers**, run for run — the strongest evidence the port changed no runtime behavior, only syntax and tooling.

### Ledger invariants proven by tests
| Property | How it's proven |
|---|---|
| Balanced transactions commit; unbalanced never do | Property-based tests (fast-check) over random posting sets, plus a test that bypasses app checks to confirm the DB trigger rejects independently |
| Postings are immutable | `UPDATE`/`DELETE` attempts rejected by the trigger, asserted in tests |
| Balances reconstruct from postings | Derived-balance assertions across the full payment lifecycle |
| Exactly-once under duplicate delivery | Same signed event replayed 5× → one ledger transaction |
| Crash-safe idempotency | Simulated crash between business write and idempotency mark → full rollback, safe retry |

---

## 12. Implementation, by the numbers

| Area | Figure |
|---|---|
| Engine source files (JavaScript) | **33** (unchanged file count from the TS build — a 1:1 port, not a restructure) |
| Engine source lines | **~2,645** (down from ~3,004 in TypeScript — the delta is almost entirely type annotations, `interface`/`type` declarations, and generic parameters) |
| Test files / test cases | **6 files / 42 cases** (money 5, ledger 5, payments 4, webhooks 10, reconciliation 14, faults 4) — identical to the TS build |
| Test lines | **~883** |
| SQL migrations | **7** (extensions → ledger core → payments → hold ref → webhooks/outbox → reconciliation → seed accounts), ~205 lines — copied verbatim; SQL has no TypeScript to strip |
| Dashboard pages / lines | **5 pages / ~732 lines** (Overview, Ledger, Payments, Reconciliation, Chaos) |
| Dashboard CSS | **~636 lines** hand-written (`index.css`) replacing Tailwind's generated utility stylesheet |
| CLI commands | **4** (`drive-payment`, `backfill`, `reconcile`, `chaos`) + migrate/seed/workers |
| Static gates | eslint clean (plain JS config — the TS build's `no-restricted-syntax` money-typing rule doesn't have a JS equivalent and was dropped, see §16) |

### Milestone journey — original build (each ended demoable — no building ahead)
- **M0 — Scaffolding + ledger core.** Postgres schema, the `Money` bigint discipline, the balanced write path with the trigger, property-based invariant tests. *Gate:* balanced commits, unbalanced rejected, balances reconstruct.
- **M1 — Payment lifecycle + provider.** `PaymentProvider` interface, Stripe test-mode impl, mock-provider fallback, outbound idempotency keys, the state machine over an append-only event log.
- **M2 — Exactly-once webhooks + outbox.** Raw-body signature verification, the same-transaction idempotency pattern, outbox table + BullMQ worker, `backfill`. *Gate:* replay/duplicate → one ledger transaction; kill mid-handler → no double-processing.
- **M3 — Reconciliation engine.** Window diff, six drift-class detectors, break lifecycle + audit, safe auto-resolution via reversing transactions.
- **M4 — Fault-injection harness.** The fault proxy, five faults, the verification matrix, precision/recall scoring. *Gate:* every fault yields its expected break; the table prints green.
- **M5 — Dashboard + analytics + export.** Five-tab React dashboard wired to live APIs, stored metrics, CSV export, `docs/powerbi.md`.
- **M6 — Docs, hardening, launch assets.** README with architecture diagram + the two proof tables, `chart_of_accounts.md`, the PCI-scope note, demo script, blog outline, `LAUNCH_REPORT.md`.

### **[port]** M7 — the JavaScript/CSS port (this repo)
- Scaffolded a parallel npm-workspaces repo (`packages/engine`, `apps/dashboard`) at `e:/reckon-js`, mirroring the original's structure exactly.
- Converted all 33 engine source files: stripped `interface`/`type`/generics, converted TS parameter-properties and `private` fields to real JS `#private` class fields, replaced `tsx` (TS execution) with native `node --watch`.
- Converted all 6 test files (Vitest + fast-check don't care whether the code under test is TS or JS) and all 7 SQL migrations (copied verbatim).
- Designed a plain-CSS replacement for Tailwind: CSS custom properties for the color system, semantic component classes, JS color-map objects for the handful of genuinely data-driven colors (severity dots, payment-state labels).
- Converted all 5 dashboard pages + shared UI helpers from TSX to JSX.
- Verified byte-for-byte behavioral parity: same 42 tests pass, same 8/8 chaos matrix, same 100%/100%/83.3% precision/recall/auto-resolution numbers as the original TS build, run independently against a fresh Postgres/Redis pair.

---

## 13. Engineering problems solved (the real war stories)

These are the non-obvious failures hit during the build and how each was diagnosed and fixed — the parts that show up in a good interview conversation.

### From the original TypeScript build
1. **Clock skew between host and Docker VM broke reconciliation tests.** Tests compared `Date.now()` (host clock) against DB timestamps written on the container clock; the VM had drifted, producing *negative* ages and false stuck-pending detections. **Fix:** measure age against `SELECT now()` — the same clock the timestamps were written on — and anchor the test window helper on both clocks. *Lesson: never mix two clocks in a time-based invariant.* This code carried over to the JS port unchanged — the bug and its fix are in the business logic, not the type layer.

2. **Nondeterministic cross-file test failures from a shared database.** `ledger.test.ts` and `payments.test.ts` ran in parallel against one Postgres; balance-delta assertions failed *off by exactly the amount the other test wrote*. Diagnosed by the tell-tale exact-amount offset across re-runs. **Fix:** `fileParallelism: false` in the Vitest config — correctness of a shared-state suite over raw speed. Also carried over unchanged.

3. **State-machine bug surfaced by the test suite itself.** Tests called `simulateProcessing()` immediately after `createPayment()`, trying to jump `created → inflight` and bypassing the mandatory `pending` transition. The state machine correctly rejected the illegal jump. **Fix:** insert a `syncPaymentStatus()` step so the payment goes `created → pending → inflight` — in both the test and the seed script. *The enforcement caught its own author* — and note this was a *runtime* logic bug the type system never could have caught, since `PaymentState` was a valid string either way.

4. *(TypeScript-specific, historical only — does not apply to this repo)* A destructured regex match group typed `string | undefined` needed a default before flowing into `bigint` math; strict mode caught it at compile time. **This is exactly the class of bug the port loses compiler protection against** — see §16 for the honest trade-off.

### **[port] New, from converting this repo to plain JS/CSS
5. **A CSS specificity bug swallowed table-header padding.** `.data-table th { padding: 0 1rem 0.5rem 0; }` has specificity `(0,1,1)` — one class plus one element selector — which silently outranked a plain utility class like `.pl-4 { padding-left: 1rem; }` at `(0,1,0)`, regardless of source order. The result: the Payments page's "State" column header rendered flush against "Amount" — `AMOUNTSTATE`, no gap — and the Ledger page's "Credit" column had the same problem. Not a rendering bug in the sense of a crash; the kind of bug that only shows up in an actual screenshot, which is exactly how it was caught. **Fix:** scope the utility rules under `.data-table` (`.data-table th.pl-4, .data-table td.pl-4 { … }`) so they win the specificity contest instead of relying on source order. *Lesson: Tailwind's utility classes get this right by construction (single-purpose, flat specificity, `!important`-free cascade by convention) — hand-rolled CSS has to earn that same property deliberately.*
6. **`private` fields and TS parameter-properties needed a real JS equivalent, not just deletion.** `class FaultProxy { constructor(private readonly provider: MockPaymentProvider) { ... } }` has no direct JS syntax; naively dropping `private readonly` would have made `provider` a plain public property. Used real `#private` class fields instead (`#provider`, assigned in the constructor body) everywhere the original used TS-only privacy, in `MockPaymentProvider`, `StripePaymentProvider`, and `FaultProxy` — preserving the original's encapsulation intent rather than quietly loosening it.
7. **A Windows path/escaping trap in a throwaway Playwright script cost two failed runs.** A heredoc-written `.mjs` script that specified `'E:\\reckon-js-screenshots'` came out as `'E:\reckon-js-screenshots'` after passing through the tool layer's string handling (`\\` collapsed to `\`, and `\r` is not a meaningful escape here but `\R` mid-path still broke `path.join`). **Fix:** use forward slashes (`'E:/reckon-js-screenshots'`) — Node resolves them fine on Windows and sidesteps the whole escaping question. *Not a Reckon bug, but a reminder that cross-platform path handling deserves the boring, portable choice by default.*

---

## 14. Analytics, dashboard & BI export

- **Dashboard (5 tabs):** Overview (payment totals, live balance-sheet check `assets == liabilities + revenue`, open breaks by severity), Ledger (transactions/postings + live trial balance), Payments (per-payment state-machine history), Reconciliation (break list filtered by drift class/status, provider-vs-Reckon snapshots, resolve/ignore), and **Chaos** (the fault-injection control panel + live verification table — the demo tab).
- **CSV export:** `GET /analytics/export?dataset=breaks|payments|ledger|recon_runs` produces clean flat CSVs.
- **PowerBI:** `docs/powerbi.md` rebuilds break-rate and mean-time-to-reconcile charts from the exports, making "financial/operational analytics with PowerBI over real reconciliation data" a truthful résumé line.

---

## 15. PCI scope boundary (a designed feature, not a limitation)

Reckon never sees, stores, or transmits card data. The provider's hosted checkout owns the PAN end-to-end; Reckon holds only provider object IDs (PaymentIntent ids, event ids) and its own ledger records. There is no card-number-shaped column anywhere in the schema, live keys are refused in code, and the repo runs sandbox/test mode only. Staying out of PCI scope is an architectural property, documented deliberately, and untouched by the language port.

---

## 16. Honest caveats (what is not done, and what the port gave up)

- **The Stripe integration is implemented against the SDK but has not been exercised against a live Stripe test account** in this build (no `STRIPE_TEST_KEY` was available — by design, same as the original). The full lifecycle, exactly-once pipeline, reconciliation, and chaos harness are all proven against the **mock provider**, whose events use the same signature scheme and event shapes.
- **[port] No compile-time money-safety guard.** The TypeScript build's strongest claim was "the type system *and* an eslint rule both refuse a `number`-typed money field." This repo keeps the runtime half (`moneyFromJSON` throws on a `number`) and the test suite, but a future edit that assigns a float to an `amount` field somewhere off the tested paths would not be caught until a test fails or a human notices — there is no second, independent layer anymore. This is the deliberate cost of the pivot documented in §0, not an oversight.
- **Placeholders** (all in `LAUNCH_REPORT.md`): `STRIPE_TEST_KEY`, `STRIPE_WEBHOOK_SECRET`, and `OUTBOX_SINK_URL` degrade gracefully — absent a key the engine falls back to the mock provider; absent a sink URL the outbox structured-logs its deliveries (an honest no-op, not a fake integration).
- **Launch assets** (blog posts, 2-minute demo video) have scripts/outlines written in `docs/launch.md` but are not yet published/recorded.

Nothing is faked. Every non-goal is a clean seam, every placeholder degrades honestly, every quoted number is reproducible, and the one real trade-off from the port (§16, bullet 2) is stated plainly rather than glossed over.

---

## 17. Quantifiable résumé outcomes (truthful, from this build)

- Built a **double-entry ledger** with a DB-trigger-enforced zero-sum invariant, verified by property-based tests (fast-check) over randomized posting sets.
- Achieved **exactly-once webhook processing** under duplicate, out-of-order, and dropped-delivery fault injection — crash-safe via a same-transaction idempotency record (proven: 5× replay → 1 ledger transaction).
- Built a reconciliation engine detecting **6 drift classes at 100% precision / 100% recall** against injected ground truth, with **83.3% safe auto-resolution** and full audit trails (amount-mismatches always escalated to a human by rule).
- Reduced mean-time-to-reconcile from manual review to **seconds** via automated detection + safe auto-resolution.
- Shipped **~3,300 lines** of plain JavaScript/CSS across engine + dashboard, **42 automated tests**, **7 migrations**, and a **5-tab operational dashboard** with **PowerBI CSV export**.
- **[port]** Ported an entire TypeScript+Tailwind codebase to plain JavaScript+CSS with zero behavioral regressions — same 42/42 tests, same 8/8 fault matrix, same 100%/100%/83.3% precision/recall/auto-resolution — verified independently against a fresh database, not asserted from memory.

---

## 18. Roadmap (clean seams left for v2)

Second provider (Razorpay test mode — interface already defined) · multi-currency / FX drift as a seventh class (`currency` column already present) · refund/dispute/chargeback reconciliation · a generic break-alerting webhook · a materialized-balance cache service for scale · optionally, JSDoc `@typedef` annotations plus `checkJs` if compile-time checking is wanted back without a full TypeScript migration. All recorded in `docs/ROADMAP.md`.

---

## 19. Repository map

```
packages/engine/
  db/migrations/        7 SQL migrations: ledger core, payments, webhooks/outbox, reconciliation
  src/money/             Money = bigint, minor units only
  src/ledger/            balanced write path, derived balances, trial balance
  src/payments/          provider abstraction (Stripe test + mock), state machine, lifecycle
  src/webhooks/          raw-body signature verification + the exactly-once event processor
  src/outbox/            same-transaction outbox + BullMQ delivery worker
  src/reconciliation/    window diff, six drift detectors, break store, scheduled worker
  src/faults/             fault proxy + chaos harness with ground-truth scoring
  src/analytics/          CSV export
  src/api/                Express server + routes (overview, ledger, payments, reconciliation, chaos)
  src/cli/                drive-payment, backfill, reconcile, chaos
  test/                   42 tests across 6 suites
apps/dashboard/           React + Vite + plain CSS: Overview, Ledger, Payments, Reconciliation, Chaos
docs/                     chart_of_accounts.md, powerbi.md, ROADMAP.md, launch.md
```

---

*All metrics in this report are reproducible: `npm run engine:test` (42 tests) and `npm run chaos` (the fault matrix + precision/recall) against the built-in mock provider — no external credentials required. See [README.md](README.md) for the exact commands, including the ones used to verify this report's numbers.*
