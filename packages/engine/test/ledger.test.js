import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { pool } from '../src/db/client.js';
import {
  UnbalancedTransactionError,
  accountBalance,
  getAccountByName,
  writeLedgerTransaction,
} from '../src/ledger/ledger.js';

let clearingId;
let revenueId;

beforeAll(async () => {
  const clearing = await getAccountByName('provider_clearing');
  const revenue = await getAccountByName('revenue');
  if (!clearing || !revenue) {
    throw new Error('seed accounts missing — run `npm run migrate -w packages/engine` first');
  }
  clearingId = clearing.id;
  revenueId = revenue.id;
});

afterAll(async () => {
  await pool.end();
});

describe('ledger invariants', () => {
  it('commits a balanced transaction and both balances move', async () => {
    const before = await accountBalance(clearingId);
    const txn = await writeLedgerTransaction({
      kind: 'adjustment',
      postings: [
        { accountId: clearingId, direction: 'debit', amount: 100n },
        { accountId: revenueId, direction: 'credit', amount: 100n },
      ],
    });
    expect(txn.id).toBeTruthy();
    const after = await accountBalance(clearingId);
    expect(after).toBe(before - 100n);
  });

  it('rejects an unbalanced transaction before touching the DB', async () => {
    await expect(
      writeLedgerTransaction({
        kind: 'adjustment',
        postings: [
          { accountId: clearingId, direction: 'debit', amount: 100n },
          { accountId: revenueId, direction: 'credit', amount: 99n },
        ],
      }),
    ).rejects.toThrow(UnbalancedTransactionError);

    const { rows } = await pool.query('SELECT count(*) FROM postings WHERE amount = 99');
    expect(Number(rows[0].count)).toBe(0);
  });

  it('the DB trigger independently rejects an unbalanced transaction bypassing app checks', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const txnResult = await client.query(
        `INSERT INTO ledger_transactions (kind) VALUES ('adjustment') RETURNING id`,
      );
      const txnId = txnResult.rows[0].id;
      await client.query(
        `INSERT INTO postings (transaction_id, account_id, direction, amount) VALUES ($1, $2, 'debit', 500)`,
        [txnId, clearingId],
      );
      await client.query(
        `INSERT INTO postings (transaction_id, account_id, direction, amount) VALUES ($1, $2, 'credit', 400)`,
        [txnId, revenueId],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('postings are append-only: UPDATE and DELETE are rejected', async () => {
    const { rows } = await pool.query('SELECT id FROM postings LIMIT 1');
    const postingId = rows[0].id;
    await expect(pool.query('UPDATE postings SET amount = 1 WHERE id = $1', [postingId])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query('DELETE FROM postings WHERE id = $1', [postingId])).rejects.toThrow(/append-only/);
  });

  it('property: random balanced posting sets always commit and reconstruct to the same balance', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.bigInt({ min: 1n, max: 100_000n }), { minLength: 1, maxLength: 5 }), async (amounts) => {
        const before = await accountBalance(clearingId);
        const total = amounts.reduce((a, b) => a + b, 0n);
        await writeLedgerTransaction({
          kind: 'adjustment',
          postings: [
            { accountId: clearingId, direction: 'debit', amount: total },
            ...amounts.map((amount) => ({
              accountId: revenueId,
              direction: 'credit',
              amount,
            })),
          ],
        });
        const after = await accountBalance(clearingId);
        expect(after).toBe(before - total);
      }),
      { numRuns: 15 },
    );
  });
});
