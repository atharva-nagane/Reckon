-- M0: double-entry ledger core (§6.2). Postings and ledger_transactions are append-only;
-- balance is derived, never stored as a mutable field (§6.1.4).

CREATE TABLE accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('asset', 'liability', 'revenue', 'fee')),
  currency TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_ref TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('payment', 'refund', 'fee', 'adjustment', 'reversal', 'hold')),
  description TEXT,
  reverses_transaction_id UUID REFERENCES ledger_transactions (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ledger_transactions_external_ref ON ledger_transactions (external_ref);

CREATE TABLE postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES ledger_transactions (id),
  account_id UUID NOT NULL REFERENCES accounts (id),
  direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount BIGINT NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_postings_transaction_id ON postings (transaction_id);
CREATE INDEX idx_postings_account_id ON postings (account_id);

-- §6.1.1: a transaction whose postings don't sum to zero must never commit.
-- Deferred to end-of-transaction so multi-statement inserts within one
-- ledger transaction still see all postings before the check runs.
CREATE OR REPLACE FUNCTION assert_transaction_balances() RETURNS TRIGGER AS $$
DECLARE
  txn_id UUID;
  debit_total NUMERIC;
  credit_total NUMERIC;
BEGIN
  txn_id := COALESCE(NEW.transaction_id, OLD.transaction_id);

  SELECT
    COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)
  INTO debit_total, credit_total
  FROM postings
  WHERE transaction_id = txn_id;

  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'ledger_transaction % does not balance: debits=% credits=%', txn_id, debit_total, credit_total;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_assert_transaction_balances
  AFTER INSERT OR UPDATE OR DELETE ON postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION assert_transaction_balances();

-- §6.1.2: postings and ledger_transactions are append-only. Corrections are new
-- reversing transactions, never edits or deletes.
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden — the ledger is append-only, write a reversing transaction instead', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_postings_append_only
  BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_ledger_transactions_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
