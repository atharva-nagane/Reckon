-- §6.5: tracks the hold ledger_transaction so it can be referenced when the
-- hold settles or releases (reversed), without scanning ledger_transactions.
ALTER TABLE payments ADD COLUMN hold_transaction_id UUID REFERENCES ledger_transactions (id);
