import { pool, withTransaction } from '../db/client.js';
import { sumMoney } from '../money/money.js';

export class UnbalancedTransactionError extends Error {
  constructor(debits, credits) {
    super(`transaction does not balance: debits=${debits} credits=${credits}`);
  }
}

/**
 * Writes a balanced ledger transaction and its postings. Rejects in application
 * code before ever hitting the DB — the deferred DB trigger in
 * 001_ledger_core.sql is the second, independent enforcement layer.
 */
export async function writeLedgerTransaction(input, client) {
  const debitTotal = sumMoney(input.postings.filter((p) => p.direction === 'debit').map((p) => p.amount));
  const creditTotal = sumMoney(input.postings.filter((p) => p.direction === 'credit').map((p) => p.amount));

  if (debitTotal !== creditTotal) {
    throw new UnbalancedTransactionError(debitTotal, creditTotal);
  }
  if (input.postings.length === 0) {
    throw new UnbalancedTransactionError(0n, 0n);
  }

  const run = async (c) => {
    const txnResult = await c.query(
      `INSERT INTO ledger_transactions (kind, external_ref, description, reverses_transaction_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, kind, external_ref, description, reverses_transaction_id, created_at`,
      [input.kind, input.externalRef ?? null, input.description ?? null, input.reversesTransactionId ?? null],
    );
    const row = txnResult.rows[0];
    if (!row) throw new Error('insert into ledger_transactions returned no row');

    for (const posting of input.postings) {
      await c.query(
        `INSERT INTO postings (transaction_id, account_id, direction, amount)
         VALUES ($1, $2, $3, $4)`,
        [row.id, posting.accountId, posting.direction, posting.amount.toString()],
      );
    }

    return {
      id: row.id,
      kind: row.kind,
      externalRef: row.external_ref,
      description: row.description,
      reversesTransactionId: row.reverses_transaction_id,
      createdAt: row.created_at,
    };
  };

  return client ? run(client) : withTransaction(run);
}

/** Derived balance: credits minus debits, reconstructed from postings — never a stored field. */
export async function accountBalance(accountId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0) AS debit_total,
       COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0) AS credit_total
     FROM postings WHERE account_id = $1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) return 0n;
  return BigInt(row.credit_total) - BigInt(row.debit_total);
}

export async function getAccountByName(name) {
  const { rows } = await pool.query('SELECT id, type FROM accounts WHERE name = $1', [name]);
  return rows[0] ?? null;
}

/** All account balances at once — the "books balance" proof for the dashboard. */
export async function trialBalance() {
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.type,
            COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'debit'), 0) AS debit_total,
            COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'credit'), 0) AS credit_total
     FROM accounts a
     LEFT JOIN postings p ON p.account_id = a.id
     GROUP BY a.id, a.name, a.type
     ORDER BY a.name`,
  );
  return rows.map((r) => ({
    accountId: r.id,
    accountName: r.name,
    accountType: r.type,
    balance: BigInt(r.credit_total) - BigInt(r.debit_total),
  }));
}

export async function listLedgerTransactions(limit = 100) {
  const { rows: txnRows } = await pool.query(
    'SELECT id, kind, external_ref, description, reverses_transaction_id, created_at FROM ledger_transactions ORDER BY created_at DESC LIMIT $1',
    [limit],
  );

  const results = [];
  for (const t of txnRows) {
    const { rows: postingRows } = await pool.query(
      'SELECT id, account_id, direction, amount FROM postings WHERE transaction_id = $1 ORDER BY created_at',
      [t.id],
    );
    results.push({
      id: t.id,
      kind: t.kind,
      externalRef: t.external_ref,
      description: t.description,
      reversesTransactionId: t.reverses_transaction_id,
      createdAt: t.created_at,
      postings: postingRows.map((p) => ({
        id: p.id,
        accountId: p.account_id,
        direction: p.direction,
        amount: BigInt(p.amount),
      })),
    });
  }
  return results;
}
