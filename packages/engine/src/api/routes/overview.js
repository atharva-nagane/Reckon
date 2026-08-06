import { Router } from 'express';
import { pool } from '../../db/client.js';
import { trialBalance } from '../../ledger/ledger.js';
import { moneyToJSON } from '../../money/money.js';

export const overviewRouter = Router();

overviewRouter.get('/', async (_req, res) => {
  const [balances, paymentCounts, breakCounts] = await Promise.all([
    trialBalance(),
    pool.query('SELECT state, count(*) FROM payments GROUP BY state'),
    pool.query(`SELECT severity, count(*) FROM breaks WHERE status = 'open' GROUP BY severity`),
  ]);

  const totalDebits = balances.reduce((sum, b) => sum + (b.balance < 0n ? -b.balance : 0n), 0n);
  const assets = balances.filter((b) => b.accountType === 'asset').reduce((s, b) => s + b.balance, 0n);
  const liabilitiesAndRevenue = balances
    .filter((b) => b.accountType !== 'asset')
    .reduce((s, b) => s + b.balance, 0n);

  res.json({
    booksBalance: {
      assets: moneyToJSON(assets),
      liabilitiesAndRevenue: moneyToJSON(liabilitiesAndRevenue),
      // assets are debit-normal so this is expected to equal -liabilitiesAndRevenue when balanced
      balanced: assets === -liabilitiesAndRevenue,
    },
    totalPostingsDebitVolume: moneyToJSON(totalDebits),
    paymentsByState: Object.fromEntries(paymentCounts.rows.map((r) => [r.state, Number(r.count)])),
    openBreaksBySeverity: Object.fromEntries(breakCounts.rows.map((r) => [r.severity, Number(r.count)])),
  });
});
