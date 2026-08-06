import { Router } from 'express';
import { z } from 'zod';
import { createHarness, score, SCENARIO_ORDER } from '../../faults/harness.js';
import { MockPaymentProvider } from '../../payments/mockProvider.js';
import { resolveProvider } from '../../payments/index.js';

export const chaosRouter = Router();

// Fault injection is demo/test-mode machinery. It signs mock events, so it
// only runs when the engine itself is on the mock provider — using the shared
// instance, so chaos payments stay consistent with later reconciliation runs.
function mockProviderOr403(res) {
  const { provider, name } = resolveProvider();
  if (name !== 'mock' || !(provider instanceof MockPaymentProvider)) {
    res.status(403).json({ error: 'chaos endpoints require PROVIDER=mock (never against a real provider)' });
    return null;
  }
  return provider;
}

chaosRouter.post('/matrix', async (_req, res) => {
  const provider = mockProviderOr403(res);
  if (!provider) return;
  const rows = await createHarness(provider).runMatrix();
  res.json({ rows, allPass: rows.every((r) => r.pass) });
});

const scenarioSchema = z.object({ scenario: z.enum(SCENARIO_ORDER) });

chaosRouter.post('/scenario', async (req, res) => {
  const parsed = scenarioSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const provider = mockProviderOr403(res);
  if (!provider) return;
  const harness = createHarness(provider);
  const truth = await harness.runScenario(parsed.data.scenario);
  await harness.reconcile();
  await harness.proxy.releaseDelayed();
  const [row] = await harness.evaluate([truth]);
  res.json(row);
});

const scoringSchema = z.object({ rounds: z.number().int().positive().max(10).default(2) });

chaosRouter.post('/scoring', async (req, res) => {
  const parsed = scoringSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const provider = mockProviderOr403(res);
  if (!provider) return;
  const rows = await createHarness(provider).runScoring(parsed.data.rounds);
  res.json({ rows, score: score(rows) });
});
