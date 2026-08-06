import { Router } from 'express';
import { z } from 'zod';
import { resolveProvider } from '../../payments/index.js';
import { getBreak, ignoreBreak, listBreaks, resolveBreak } from '../../reconciliation/breaks.js';
import { createReconciliationEngine } from '../../reconciliation/engine.js';
import { pool } from '../../db/client.js';

export const reconciliationRouter = Router();

const BREAK_STATUSES = ['open', 'auto_resolved', 'resolved', 'ignored'];
const DRIFT_CLASSES = [
  'missing',
  'duplicate',
  'amount_mismatch',
  'stuck_pending',
  'unresolved_hold',
  'status_mismatch',
];

reconciliationRouter.get('/breaks', async (req, res) => {
  const status = req.query.status ? String(req.query.status) : undefined;
  const driftClass = req.query.drift_class ? String(req.query.drift_class) : undefined;
  if (status && !BREAK_STATUSES.includes(status)) {
    res.status(400).json({ error: `status must be one of ${BREAK_STATUSES.join(', ')}` });
    return;
  }
  if (driftClass && !DRIFT_CLASSES.includes(driftClass)) {
    res.status(400).json({ error: `drift_class must be one of ${DRIFT_CLASSES.join(', ')}` });
    return;
  }
  const rows = await listBreaks({
    ...(status ? { status } : {}),
    ...(driftClass ? { driftClass } : {}),
    limit: Math.min(Number(req.query.limit) || 200, 500),
  });
  res.json(rows);
});

reconciliationRouter.get('/breaks/:id', async (req, res) => {
  const row = await getBreak(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'break not found' });
    return;
  }
  res.json(row);
});

const resolveSchema = z.object({ resolvedBy: z.string().min(1), action: z.string().min(1) });

reconciliationRouter.post('/breaks/:id/resolve', async (req, res) => {
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const row = await resolveBreak(req.params.id, parsed.data.resolvedBy, parsed.data.action);
  if (!row) {
    res.status(409).json({ error: 'break not found or not open' });
    return;
  }
  res.json(row);
});

const ignoreSchema = z.object({ resolvedBy: z.string().min(1) });

reconciliationRouter.post('/breaks/:id/ignore', async (req, res) => {
  const parsed = ignoreSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const row = await ignoreBreak(req.params.id, parsed.data.resolvedBy);
  if (!row) {
    res.status(409).json({ error: 'break not found or not open' });
    return;
  }
  res.json(row);
});

const runSchema = z.object({ windowMinutes: z.number().int().positive().max(24 * 60).default(60) });

reconciliationRouter.post('/run', async (req, res) => {
  const parsed = runSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { provider, name } = resolveProvider();
  const engine = createReconciliationEngine({ provider, providerName: name });
  const now = new Date();
  const result = await engine.runWindow(new Date(now.getTime() - parsed.data.windowMinutes * 60_000), new Date(now.getTime() + 60_000));
  res.json(result);
});

reconciliationRouter.get('/runs', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await pool.query(
    `SELECT id, window_from, window_to, started_at, finished_at, breaks_created, auto_resolved
     FROM recon_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  res.json(rows);
});
