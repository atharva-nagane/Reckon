import { pool } from '../db/client.js';
import { getAccountByName, writeLedgerTransaction } from '../ledger/ledger.js';
import { MockPaymentProvider } from '../payments/mockProvider.js';
import { createPayment } from '../payments/service.js';
import { createReconciliationEngine } from '../reconciliation/engine.js';
import { FaultProxy } from './proxy.js';

// The five faults plus a clean control and the two spec-mandated duplicate
// variants: same-id redelivery (must NOT break — idempotency absorbs it) and
// the double-count bug that bypasses idempotency (must break).

// Every scenario's expected break is known at injection time — this is the
// ground truth detection gets scored against.
const EXPECTATIONS = {
  control: { break: null, status: null },
  drop: { break: 'missing', status: 'auto_resolved' },
  drop_resolution: { break: 'unresolved_hold', status: 'auto_resolved' },
  duplicate_delivery: { break: null, status: null },
  double_count: { break: 'duplicate', status: 'auto_resolved' },
  reorder: { break: 'unresolved_hold', status: 'auto_resolved' },
  mutate_amount: { break: 'amount_mismatch', status: 'open' },
  delay: { break: 'stuck_pending', status: 'auto_resolved' },
};

export const SCENARIO_ORDER = [
  'control',
  'drop',
  'drop_resolution',
  'duplicate_delivery',
  'double_count',
  'reorder',
  'mutate_amount',
  'delay',
];

export function createHarness(provider = new MockPaymentProvider()) {
  const proxy = new FaultProxy(provider);
  const startedAtJs = Date.now();

  async function newPayment() {
    const payment = await createPayment(provider, 'mock', { amount: 25_000n, currency: 'INR' });
    const events = await provider.listEvents(new Date(0));
    const created = events.find(
      (e) => e.intent.providerPaymentIntentId === payment.providerPaymentIntentId && e.type === 'payment_intent.created',
    );
    if (!created) throw new Error('mock provider recorded no created event');
    await proxy.deliverAll([created]);
    return payment;
  }

  async function runScenario(kind) {
    const payment = await newPayment();
    const pi = payment.providerPaymentIntentId;

    switch (kind) {
      case 'control': {
        await proxy.deliverAll([provider.simulateProcessing(pi), provider.simulateSucceeded(pi)]);
        break;
      }
      case 'drop': {
        const processing = provider.simulateProcessing(pi);
        const succeeded = provider.simulateSucceeded(pi);
        proxy.inject('drop', processing.id);
        proxy.inject('drop', succeeded.id);
        await proxy.deliverAll([processing, succeeded]);
        break;
      }
      case 'drop_resolution': {
        const processing = provider.simulateProcessing(pi);
        const succeeded = provider.simulateSucceeded(pi);
        proxy.inject('drop', succeeded.id); // hold opens, its resolution never arrives
        await proxy.deliverAll([processing, succeeded]);
        break;
      }
      case 'duplicate_delivery': {
        const processing = provider.simulateProcessing(pi);
        const succeeded = provider.simulateSucceeded(pi);
        proxy.inject('duplicate', succeeded.id);
        await proxy.deliverAll([processing, succeeded]);
        break;
      }
      case 'double_count': {
        await proxy.deliverAll([provider.simulateProcessing(pi), provider.simulateSucceeded(pi)]);
        const clearing = await getAccountByName('provider_clearing');
        const revenue = await getAccountByName('revenue');
        if (!clearing || !revenue) throw new Error('chart of accounts missing');
        // The second variant: a bug that bypassed idempotency and settled twice
        await writeLedgerTransaction({
          kind: 'payment',
          externalRef: payment.id,
          description: `chaos: double-count settlement for ${payment.id}`,
          postings: [
            { accountId: clearing.id, direction: 'debit', amount: payment.amount },
            { accountId: revenue.id, direction: 'credit', amount: payment.amount },
          ],
        });
        break;
      }
      case 'reorder': {
        const processing = provider.simulateProcessing(pi);
        const succeeded = provider.simulateSucceeded(pi);
        proxy.inject('reorder', processing.id); // succeeded lands first, deflected as premature
        await proxy.deliverAll([processing, succeeded]);
        break;
      }
      case 'mutate_amount': {
        const processing = provider.simulateProcessing(pi);
        const succeeded = provider.simulateSucceeded(pi);
        proxy.inject('mutate_amount', processing.id);
        await proxy.deliverAll([processing, succeeded]);
        break;
      }
      case 'delay': {
        const failed = provider.simulateFailed(pi);
        proxy.inject('delay', failed.id);
        await proxy.deliverAll([failed]);
        break;
      }
    }

    const expectation = EXPECTATIONS[kind];
    return { scenario: kind, paymentRef: payment.id, expectedBreak: expectation.break, expectedStatus: expectation.status };
  }

  async function reconcile() {
    // window anchored on both clocks — payments carry DB time, mock intents JS time
    const { rows } = await pool.query('SELECT now() AS db_now');
    const dbNow = rows[0]?.db_now.getTime() ?? Date.now();
    const jsNow = Date.now();
    const skew = dbNow - jsNow;
    const from = new Date(Math.min(startedAtJs, startedAtJs + skew) - 2000);
    const to = new Date(Math.max(dbNow, jsNow) + 600_000);

    const engine = createReconciliationEngine({
      provider,
      providerName: 'mock',
      pendingThresholdMs: 0,
      holdThresholdMs: 0,
    });
    await engine.runWindow(from, to);
  }

  async function evaluate(truths) {
    const results = [];
    for (const truth of truths) {
      const { rows } = await pool.query(
        'SELECT drift_class, status, resolution_action FROM breaks WHERE payment_ref = $1 ORDER BY created_at',
        [truth.paymentRef],
      );
      const match = truth.expectedBreak ? rows.find((b) => b.drift_class === truth.expectedBreak) : undefined;
      const detected = match ?? rows[0];
      const pass =
        truth.expectedBreak === null
          ? rows.length === 0
          : rows.length === 1 && !!match && match.status === truth.expectedStatus;
      results.push({
        ...truth,
        detectedBreak: detected?.drift_class ?? null,
        detectedStatus: detected?.status ?? null,
        resolutionAction: detected?.resolution_action ?? null,
        pass,
      });
    }
    return results;
  }

  async function runMatrix() {
    const truths = [];
    for (const kind of SCENARIO_ORDER) {
      truths.push(await runScenario(kind));
    }
    await reconcile();
    await proxy.releaseDelayed();
    return evaluate(truths);
  }

  async function runScoring(rounds) {
    const truths = [];
    for (let i = 0; i < rounds; i++) {
      for (const kind of SCENARIO_ORDER) {
        truths.push(await runScenario(kind));
      }
    }
    await reconcile();
    await proxy.releaseDelayed();
    return evaluate(truths);
  }

  return { proxy, runScenario, reconcile, evaluate, runMatrix, runScoring };
}

export function score(rows) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let detected = 0;
  let detectedAuto = 0;

  for (const row of rows) {
    if (row.detectedBreak !== null) {
      detected += 1;
      if (row.detectedStatus === 'auto_resolved') detectedAuto += 1;
    }
    if (row.expectedBreak === null) {
      if (row.detectedBreak !== null) fp += 1;
    } else if (row.detectedBreak === row.expectedBreak) {
      tp += 1;
    } else if (row.detectedBreak === null) {
      fn += 1;
    } else {
      fp += 1; // detected the wrong class: both spurious...
      fn += 1; // ...and a miss of the real drift
    }
  }

  return {
    payments: rows.length,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    autoResolutionRate: detected === 0 ? 0 : detectedAuto / detected,
  };
}

export function renderMatrix(rows) {
  const header = ['fault', 'expected break', 'detected', 'resolution', 'result'];
  const table = rows.map((r) => [
    r.scenario,
    r.expectedBreak ?? '(none)',
    r.detectedBreak ?? '(none)',
    r.detectedStatus ? `${r.detectedStatus}${r.resolutionAction ? `: ${r.resolutionAction}` : ''}` : '-',
    r.pass ? 'PASS' : 'FAIL',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]?.length ?? 0)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...table.map(line)].join('\n');
}
