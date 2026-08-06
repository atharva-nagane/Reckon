import { Router } from 'express';
import { listLedgerTransactions, trialBalance } from '../../ledger/ledger.js';
import { moneyToJSON } from '../../money/money.js';

export const ledgerRouter = Router();

ledgerRouter.get('/trial-balance', async (_req, res) => {
  const rows = await trialBalance();
  res.json(
    rows.map((r) => ({
      accountId: r.accountId,
      accountName: r.accountName,
      accountType: r.accountType,
      balance: moneyToJSON(r.balance),
    })),
  );
});

ledgerRouter.get('/transactions', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await listLedgerTransactions(limit);
  res.json(
    rows.map((t) => ({
      id: t.id,
      kind: t.kind,
      externalRef: t.externalRef,
      description: t.description,
      reversesTransactionId: t.reversesTransactionId,
      createdAt: t.createdAt,
      postings: t.postings.map((p) => ({
        id: p.id,
        accountId: p.accountId,
        direction: p.direction,
        amount: moneyToJSON(p.amount),
      })),
    })),
  );
});
