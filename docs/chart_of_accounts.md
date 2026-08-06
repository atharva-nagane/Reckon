# Chart of accounts

Seeded by `db/migrations/003_seed_accounts.sql`. Single currency for v1.

| Account | Type | Purpose |
|---|---|---|
| `provider_clearing` | asset | Settled money held at the provider before payout. |
| `provider_holds` | asset | Money authorized/reserved but not yet finally settled — the `inflight` state. Kept separate from `provider_clearing` so the trial balance always shows reserved-vs-settled money distinctly. |
| `customer_liability` | liability | What Reckon owes the merchant/customer for a payment not yet paid out. |
| `revenue` | revenue | Recognized revenue net of fees. |
| `fees` | fee | Provider processing fees, recognized as an expense offset. |

## Postings per payment (`src/payments/service.js`)

**Hold (payment enters `inflight`):**
- debit `provider_holds` — amount
- credit `customer_liability` — amount

**Settle (`inflight` → `succeeded`):**
1. Reversal, `reverses_transaction_id` = the hold transaction:
   - debit `customer_liability` — amount
   - credit `provider_holds` — amount
2. Payment transaction:
   - debit `provider_clearing` — amount
   - credit `revenue` — amount minus fee
   - credit `fees` — fee

Fee is computed via `FEE_BPS` (basis points, default 200 = 2%) in `src/payments/service.js`, integer division, fee rounds down.

**Release (`inflight` → `failed`):** single reversal of the hold transaction only. No `payment` transaction is ever written — no money was ever earned.
