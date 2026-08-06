# Loading Reckon data into PowerBI

Reckon exports flat CSVs from `GET /analytics/export?dataset=<name>`. Four datasets are available:

- `payments` — one row per payment (id, provider, amount, currency, state, timestamps).
- `ledger` — one row per posting, joined to its parent transaction and account (transaction_id, kind, account_name, direction, amount).
- `breaks` — one row per reconciliation break (drift_class, severity, payment_ref, status, resolution_action, resolved_by, created_at, resolved_at, seconds_to_resolve).
- `recon_runs` — one row per reconciliation run (window, started/finished, breaks_created, auto_resolved).

## Get Data

1. Start the engine (`npm run engine:dev`), or point at a running instance.
2. In PowerBI Desktop: **Get Data → Web**, paste `http://localhost:4000/analytics/export?dataset=payments`.
3. PowerBI will detect the CSV; confirm delimiter is comma, first row as headers.
4. Repeat for `ledger`, `breaks`, and `recon_runs`.

## Charts

- **Payments by state** — bar chart of `payments`, axis = `state`, value = count of `id`.
- **Payment volume over time** — line chart of `payments`, axis = `created_at` (bucketed by day), value = sum of `amount` (divide by 100 for major units).
- **Trial balance** — from `ledger`, group by `account_name`, measure = `SUMX` of `amount` signed by `direction` (credit positive, debit negative) — this should net to zero across all accounts, visually proving the books balance.
- **Break rate by drift class** — from `breaks`, axis = `drift_class`, value = count of `id`; divide by payment count for breaks-per-1,000-payments.
- **Mean-time-to-reconcile** — from `breaks` filtered to resolved statuses, average of `seconds_to_resolve` by `drift_class`. Auto-resolved breaks resolve within the same reconciliation run, so expect sub-second values for them and human timescales for manually resolved ones.
- **Auto-resolution rate** — from `breaks`, share of rows with `status = "auto_resolved"` over all non-open rows.
- **Runs over time** — from `recon_runs`, axis = `started_at`, values = `breaks_created` and `auto_resolved`.
