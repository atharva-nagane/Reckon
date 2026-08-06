import { Router } from 'express';
import { exportDataset } from '../../analytics/export.js';

export const analyticsRouter = Router();

const VALID_DATASETS = ['payments', 'ledger', 'breaks', 'recon_runs'];

analyticsRouter.get('/export', async (req, res) => {
  const dataset = String(req.query.dataset ?? '');
  if (!VALID_DATASETS.includes(dataset)) {
    res.status(400).json({ error: `dataset must be one of ${VALID_DATASETS.join(', ')}` });
    return;
  }
  const csv = await exportDataset(dataset);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${dataset}.csv"`);
  res.send(csv);
});
