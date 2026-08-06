-- M1: payment lifecycle (§7). Current state is a cache; the append-only
-- payment_events log is the source of truth (§7.2).

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('stripe', 'mock')),
  provider_payment_intent_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  currency TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('created', 'pending', 'inflight', 'succeeded', 'failed', 'refund_pending', 'refunded')
  ),
  create_idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_intent_id),
  UNIQUE (create_idempotency_key)
);

-- Append-only event log driving the state machine (§7.2). `applied` is false
-- for events recorded but not applied — premature or illegal transitions that
-- reconciliation (M3) is responsible for resolving.
CREATE TABLE payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments (id),
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  applied BOOLEAN NOT NULL,
  reason TEXT,
  provider_event_ref TEXT,
  raw_payload JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_events_payment_id ON payment_events (payment_id);

CREATE OR REPLACE FUNCTION reject_mutation_payment_events() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden — payment_events is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payment_events_append_only
  BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation_payment_events();
