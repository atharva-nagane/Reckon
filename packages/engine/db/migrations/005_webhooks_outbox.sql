-- M2: exactly-once webhook processing + outbox (§8.2). Exactly-once rests on
-- the PRIMARY KEY on event_id plus INSERT ... ON CONFLICT DO NOTHING inside the
-- same transaction as the business write — no SERIALIZABLE needed (§8.2 allows
-- either; the unique constraint is the cheaper, contention-free choice).

CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'done')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Side-effects are written here in the same transaction as the state change,
-- then delivered by the worker in src/outbox/worker.ts — never executed inline.
CREATE TABLE outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX idx_outbox_pending ON outbox (created_at) WHERE status = 'pending';
