-- M3: reconciliation runs and breaks (§10.3). Breaks carry both snapshots and
-- the exact resolution taken — the audit trail is the point, not an extra.
-- Break rows transition status (open -> auto_resolved/resolved/ignored) but the
-- evidence columns are write-once by convention; ledger corrections they
-- reference are append-only reversing transactions (§10.4).

CREATE TABLE recon_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  window_from TIMESTAMPTZ NOT NULL,
  window_to TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  breaks_created INT NOT NULL DEFAULT 0,
  auto_resolved INT NOT NULL DEFAULT 0
);

CREATE TABLE breaks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recon_run_id UUID REFERENCES recon_runs (id),
  drift_class TEXT NOT NULL CHECK (
    drift_class IN ('missing', 'duplicate', 'amount_mismatch', 'stuck_pending', 'unresolved_hold', 'status_mismatch')
  ),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  payment_ref TEXT NOT NULL,
  provider_snapshot JSONB NOT NULL,
  reckon_snapshot JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'auto_resolved', 'resolved', 'ignored')),
  resolution_action TEXT,
  resolution_transaction_id UUID REFERENCES ledger_transactions (id),
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_breaks_status ON breaks (status);
CREATE INDEX idx_breaks_payment_ref ON breaks (payment_ref);
CREATE INDEX idx_breaks_drift_class ON breaks (drift_class);
