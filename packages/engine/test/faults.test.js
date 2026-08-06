import { afterAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client.js';
import { createHarness, renderMatrix, score } from '../src/faults/harness.js';
import { getPayment } from '../src/payments/service.js';

afterAll(async () => {
  await pool.end();
});

describe('fault-injection verification matrix', () => {
  it('every injected fault yields its expected break with the correct resolution', async () => {
    const harness = createHarness();
    const rows = await harness.runMatrix();

    // the demo artifact — visible in test output, same table `npm run chaos` prints
    console.log(`\n${renderMatrix(rows)}\n`);

    for (const row of rows) {
      expect(row, `${row.scenario}: expected ${row.expectedBreak ?? 'no break'}/${row.expectedStatus ?? '-'}, got ${row.detectedBreak ?? 'none'}/${row.detectedStatus ?? '-'}`).toMatchObject({ pass: true });
    }
  }, 120_000);

  it('a delayed event arriving after reconciliation already resolved the break is harmless', async () => {
    const harness = createHarness();
    const truth = await harness.runScenario('delay');
    await harness.reconcile();

    expect((await getPayment(truth.paymentRef))?.state).toBe('failed'); // stuck_pending auto-resolved

    const outcomes = await harness.proxy.releaseDelayed();
    expect(outcomes).toEqual(['recorded_unapplied']); // stale by the state machine, not applied

    expect((await getPayment(truth.paymentRef))?.state).toBe('failed');
    await harness.reconcile();
    const { rows } = await pool.query('SELECT count(*) AS n FROM breaks WHERE payment_ref = $1', [truth.paymentRef]);
    expect(Number(rows[0].n)).toBe(1); // no second break after the late arrival
  }, 60_000);

  it('same-id duplicate delivery is absorbed by idempotency: one settlement, zero breaks', async () => {
    const harness = createHarness();
    const truth = await harness.runScenario('duplicate_delivery');
    await harness.reconcile();

    const [row] = await harness.evaluate([truth]);
    expect(row).toMatchObject({ pass: true, detectedBreak: null });
    const { rows } = await pool.query(
      `SELECT count(*) AS n FROM ledger_transactions WHERE kind = 'payment' AND external_ref = $1`,
      [truth.paymentRef],
    );
    expect(Number(rows[0].n)).toBe(1);
  }, 60_000);
});

describe('detection accuracy against ground truth', () => {
  it('scores perfect precision and recall over a mixed multi-round fault run', async () => {
    const rows = await createHarness().runScoring(2);
    const s = score(rows);

    expect(s.payments).toBe(16); // 2 rounds x 8 scenarios
    expect(s.precision).toBe(1);
    expect(s.recall).toBe(1);
    expect(s.falsePositives).toBe(0);
    expect(s.falseNegatives).toBe(0);
    // mutate_amount stays open by design, so this is intentionally < 1
    expect(s.autoResolutionRate).toBeGreaterThan(0.5);
    expect(s.autoResolutionRate).toBeLessThan(1);
  }, 180_000);
});
