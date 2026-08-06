import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client.js';
import { accountBalance, getAccountByName, writeLedgerTransaction } from '../src/ledger/ledger.js';
import { MockPaymentProvider } from '../src/payments/mockProvider.js';
import { createPayment, getPayment } from '../src/payments/service.js';
import { createReconciliationEngine } from '../src/reconciliation/engine.js';
import { createEventProcessor } from '../src/webhooks/handler.js';

afterAll(async () => {
  await pool.end();
});

const processEvent = createEventProcessor({ providerName: 'mock' });

function engineFor(provider, thresholds = {}) {
  return createReconciliationEngine({
    provider,
    providerName: 'mock',
    pendingThresholdMs: thresholds.pending ?? 0,
    holdThresholdMs: thresholds.hold ?? 0,
  });
}

// Per-test windows must satisfy two skewed clocks at once: payments carry DB
// timestamps, mock intents carry JS timestamps (Docker VM drift makes the gap
// real). Anchor on both. Strays from earlier tests that slip into the wider
// window only ever produce flagged breaks for other payment_refs.
async function window() {
  const { rows } = await pool.query('SELECT now() AS db_now');
  const dbNow = rows[0]?.db_now.getTime() ?? Date.now();
  const jsNow = Date.now();
  return { from: new Date(Math.min(dbNow, jsNow) - 2000), to: new Date(Math.max(dbNow, jsNow) + 600_000) };
}

async function deliverCreated(provider, payment) {
  const events = await provider.listEvents(new Date(0));
  const created = events.find(
    (e) => e.intent.providerPaymentIntentId === payment.providerPaymentIntentId && e.type === 'payment_intent.created',
  );
  if (!created) throw new Error('no created event');
  await processEvent(created);
}

async function breaksFor(paymentRef, driftClass) {
  const { rows } = await pool.query(
    driftClass
      ? `SELECT drift_class, severity, status, resolution_action, resolution_transaction_id FROM breaks
         WHERE payment_ref = $1 AND drift_class = $2 ORDER BY created_at`
      : `SELECT drift_class, severity, status, resolution_action, resolution_transaction_id FROM breaks
         WHERE payment_ref = $1 ORDER BY created_at`,
    driftClass ? [paymentRef, driftClass] : [paymentRef],
  );
  return rows;
}

async function settlementCount(paymentId) {
  const { rows } = await pool.query(
    `SELECT count(*) AS n FROM ledger_transactions t
     WHERE t.kind = 'payment' AND t.external_ref = $1
       AND NOT EXISTS (SELECT 1 FROM ledger_transactions r WHERE r.kind = 'reversal' AND r.reverses_transaction_id = t.id)`,
    [paymentId],
  );
  return Number(rows[0]?.n ?? 0);
}

async function account(name) {
  const acc = await getAccountByName(name);
  if (!acc) throw new Error(`missing account ${name}`);
  return acc;
}

describe('reconciliation engine', () => {
  it('control: a payment settled on both sides produces no break', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const payment = await createPayment(provider, 'mock', { amount: 10_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    await processEvent(provider.simulateProcessing(payment.providerPaymentIntentId));
    await processEvent(provider.simulateSucceeded(payment.providerPaymentIntentId));

    await engineFor(provider).runWindow(from, to);
    expect(await breaksFor(payment.id)).toEqual([]);
  });

  it('control: fresh lag under thresholds is webhook latency, not drift', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const payment = await createPayment(provider, 'mock', { amount: 10_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    provider.simulateProcessing(payment.providerPaymentIntentId);
    provider.simulateSucceeded(payment.providerPaymentIntentId);
    // webhooks "in flight" — provider succeeded, Reckon still pending

    await engineFor(provider, { pending: 60_000, hold: 60_000 }).runWindow(from, to);
    expect(await breaksFor(payment.id)).toEqual([]);
  });

  it('missing: lost webhooks auto-resolve via backfill replay', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const payment = await createPayment(provider, 'mock', { amount: 20_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    provider.simulateProcessing(payment.providerPaymentIntentId);
    provider.simulateSucceeded(payment.providerPaymentIntentId);
    // both webhooks dropped

    const result = await engineFor(provider).runWindow(from, to);
    expect(result.breaksCreated).toBeGreaterThanOrEqual(1);

    expect(await breaksFor(payment.id, 'missing')).toMatchObject([
      { severity: 'high', status: 'auto_resolved', resolution_action: 'backfill_replay' },
    ]);
    expect((await getPayment(payment.id))?.state).toBe('succeeded');
    expect(await settlementCount(payment.id)).toBe(1);
  });

  it('missing: falls back to a state-machine advance when replay is dedupe-blocked', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const payment = await createPayment(provider, 'mock', { amount: 15_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    provider.simulateProcessing(payment.providerPaymentIntentId);
    const succeeded = provider.simulateSucceeded(payment.providerPaymentIntentId);
    // succeeded arrives early (consumed as premature); processing never arrives
    expect(await processEvent(succeeded)).toBe('recorded_unapplied');

    await engineFor(provider).runWindow(from, to);

    expect(await breaksFor(payment.id, 'missing')).toMatchObject([{ status: 'auto_resolved' }]);
    expect((await getPayment(payment.id))?.state).toBe('succeeded');
    expect(await settlementCount(payment.id)).toBe(1);
  });

  it('missing: a settled provider payment Reckon never created flags and stays open', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const intent = await provider.createPaymentIntent({ amount: 9_000n, currency: 'INR', idempotencyKey: 'ghost' });
    provider.simulateSucceeded(intent.providerPaymentIntentId);

    await engineFor(provider).runWindow(from, to);
    expect(await breaksFor(intent.providerPaymentIntentId, 'missing')).toMatchObject([
      { severity: 'high', status: 'open' },
    ]);
  });

  it('duplicate: equal-amount double-count auto-resolves with a reversing transaction', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const clearing = await account('provider_clearing');
    const revenue = await account('revenue');

    const payment = await createPayment(provider, 'mock', { amount: 30_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    await processEvent(provider.simulateProcessing(payment.providerPaymentIntentId));
    await processEvent(provider.simulateSucceeded(payment.providerPaymentIntentId));

    const clearingSettled = await accountBalance(clearing.id);

    // a bug that bypassed idempotency and settled twice
    await writeLedgerTransaction({
      kind: 'payment',
      externalRef: payment.id,
      description: `duplicate settlement for payment ${payment.id} (injected)`,
      postings: [
        { accountId: clearing.id, direction: 'debit', amount: 30_000n },
        { accountId: revenue.id, direction: 'credit', amount: 30_000n },
      ],
    });
    expect(await settlementCount(payment.id)).toBe(2);

    await engineFor(provider).runWindow(from, to);

    const rows = await breaksFor(payment.id, 'duplicate');
    expect(rows).toMatchObject([{ severity: 'high', status: 'auto_resolved' }]);
    expect(rows[0].resolution_transaction_id).toBeTruthy();
    expect(await settlementCount(payment.id)).toBe(1);
    expect(await accountBalance(clearing.id)).toBe(clearingSettled); // reversal restored the books

    // re-running the window must not re-detect the corrected ledger
    await engineFor(provider).runWindow(from, to);
    expect((await breaksFor(payment.id, 'duplicate')).length).toBe(1);
  });

  it('duplicate: differing amounts are flagged, never reversed automatically', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const clearing = await account('provider_clearing');
    const revenue = await account('revenue');

    const payment = await createPayment(provider, 'mock', { amount: 12_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    await processEvent(provider.simulateProcessing(payment.providerPaymentIntentId));
    await processEvent(provider.simulateSucceeded(payment.providerPaymentIntentId));

    await writeLedgerTransaction({
      kind: 'payment',
      externalRef: payment.id,
      description: `duplicate settlement with wrong amount for ${payment.id} (injected)`,
      postings: [
        { accountId: clearing.id, direction: 'debit', amount: 11_000n },
        { accountId: revenue.id, direction: 'credit', amount: 11_000n },
      ],
    });

    await engineFor(provider).runWindow(from, to);
    expect(await breaksFor(payment.id, 'duplicate')).toMatchObject([{ status: 'open' }]);
    expect(await settlementCount(payment.id)).toBe(2); // untouched
  });

  it('amount_mismatch: critical, flagged, and never auto-resolved', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const payment = await createPayment(provider, 'mock', { amount: 50_000n, currency: 'INR' });
    await deliverCreated(provider, payment);

    // an app bug corrupts the local amount before the money-moving writes
    await pool.query('UPDATE payments SET amount = $1 WHERE id = $2', ['49000', payment.id]);
    await processEvent(provider.simulateProcessing(payment.providerPaymentIntentId));
    await processEvent(provider.simulateSucceeded(payment.providerPaymentIntentId));

    await engineFor(provider).runWindow(from, to);

    expect(await breaksFor(payment.id, 'amount_mismatch')).toMatchObject([
      { severity: 'critical', status: 'open', resolution_action: null, resolution_transaction_id: null },
    ]);
    expect(await settlementCount(payment.id)).toBe(1); // reconciler wrote nothing
  });

  it('stuck_pending: provider-terminal failure advances the local state machine', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const payment = await createPayment(provider, 'mock', { amount: 8_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    provider.simulateFailed(payment.providerPaymentIntentId); // webhook dropped

    await engineFor(provider).runWindow(from, to);

    expect(await breaksFor(payment.id, 'stuck_pending')).toMatchObject([
      { severity: 'low', status: 'auto_resolved', resolution_action: 'provider_truth_applied' },
    ]);
    expect((await getPayment(payment.id))?.state).toBe('failed');
  });

  it('unresolved_hold: provider-resolved hold settles and clears provider_holds', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const holds = await account('provider_holds');
    const holdsBefore = await accountBalance(holds.id);

    const payment = await createPayment(provider, 'mock', { amount: 60_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    await processEvent(provider.simulateProcessing(payment.providerPaymentIntentId)); // inflight, hold posted
    provider.simulateSucceeded(payment.providerPaymentIntentId); // resolution webhook dropped

    await engineFor(provider).runWindow(from, to);

    expect(await breaksFor(payment.id, 'unresolved_hold')).toMatchObject([
      { severity: 'high', status: 'auto_resolved', resolution_action: 'provider_truth_applied' },
    ]);
    expect((await getPayment(payment.id))?.state).toBe('succeeded');
    expect(await accountBalance(holds.id)).toBe(holdsBefore); // hold fully released
    expect(await settlementCount(payment.id)).toBe(1);
  });

  it('unresolved_hold: a hold the provider has no record of flags critical and touches nothing', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const payment = await createPayment(provider, 'mock', { amount: 5_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    await processEvent(provider.simulateProcessing(payment.providerPaymentIntentId));
    provider.forgetIntent(payment.providerPaymentIntentId); // lost authorization

    await engineFor(provider).runWindow(from, to);

    expect(await breaksFor(payment.id, 'unresolved_hold')).toMatchObject([
      { severity: 'critical', status: 'open', resolution_transaction_id: null },
    ]);
    expect((await getPayment(payment.id))?.state).toBe('inflight'); // untouched

    // dedup: a second run must not multiply the open break
    await engineFor(provider).runWindow(from, to);
    expect((await breaksFor(payment.id, 'unresolved_hold')).length).toBe(1);
  });

  it('status_mismatch: contradictory terminal states flag for review', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const payment = await createPayment(provider, 'mock', { amount: 14_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    await processEvent(provider.simulateProcessing(payment.providerPaymentIntentId));
    await processEvent(provider.simulateSucceeded(payment.providerPaymentIntentId));
    provider.simulateFailed(payment.providerPaymentIntentId); // provider now contradicts local succeeded

    await engineFor(provider).runWindow(from, to);

    expect(await breaksFor(payment.id, 'status_mismatch')).toMatchObject([{ severity: 'high', status: 'open' }]);
    expect((await getPayment(payment.id))?.state).toBe('succeeded'); // never rewound
  });

  it('status_mismatch: provider truth ahead along legal edges auto-resolves by advancing', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const payment = await createPayment(provider, 'mock', { amount: 4_000n, currency: 'INR' });
    // not even the created webhook was delivered — Reckon still shows `created`
    provider.simulateProcessing(payment.providerPaymentIntentId);

    await engineFor(provider).runWindow(from, to);

    expect(await breaksFor(payment.id, 'status_mismatch')).toMatchObject([
      { severity: 'medium', status: 'auto_resolved', resolution_action: 'provider_truth_applied' },
    ]);
    expect((await getPayment(payment.id))?.state).toBe('inflight'); // stepped created -> pending -> inflight
  });

  it('records the run with its break counts', async () => {
    const provider = new MockPaymentProvider();
    const { from, to } = await window();
    const payment = await createPayment(provider, 'mock', { amount: 2_000n, currency: 'INR' });
    await deliverCreated(provider, payment);
    provider.simulateFailed(payment.providerPaymentIntentId);

    const result = await engineFor(provider).runWindow(from, to);
    const { rows } = await pool.query('SELECT breaks_created, auto_resolved, finished_at FROM recon_runs WHERE id = $1', [
      result.runId,
    ]);
    expect(rows[0]).toMatchObject({ breaks_created: result.breaksCreated, auto_resolved: result.autoResolved });
    expect(rows[0].finished_at).toBeTruthy();
    expect(result.breaksCreated).toBeGreaterThanOrEqual(1);
  });
});
