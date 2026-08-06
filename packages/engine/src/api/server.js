import 'dotenv/config';
import express from 'express';
import { requestLogger } from '../logger.js';
import { resolveProvider } from '../payments/index.js';
import { MOCK_WEBHOOK_SECRET } from '../payments/mockProvider.js';
import { createWebhookHandler } from '../webhooks/handler.js';
import { mockVerifier, stripeVerifier } from '../webhooks/verify.js';
import { analyticsRouter } from './routes/analytics.js';
import { chaosRouter } from './routes/chaos.js';
import { ledgerRouter } from './routes/ledger.js';
import { overviewRouter } from './routes/overview.js';
import { paymentsRouter } from './routes/payments.js';
import { reconciliationRouter } from './routes/reconciliation.js';

export function buildApp() {
  const app = express();
  app.use(requestLogger);
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  // The webhook route consumes the raw bytes — signature verification breaks
  // under any body re-encoding, so it must be mounted before express.json().
  const { name: providerName } = resolveProvider();
  let verify;
  if (providerName === 'stripe') {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error('PROVIDER=stripe requires STRIPE_WEBHOOK_SECRET — from `stripe listen --print-secret`');
    }
    verify = stripeVerifier(webhookSecret);
  } else {
    verify = mockVerifier(MOCK_WEBHOOK_SECRET);
  }
  const webhookHandler = createWebhookHandler({ providerName, verify });

  app.post('/webhooks/provider', express.raw({ type: 'application/json' }), async (req, res) => {
    const signature = req.header('stripe-signature');
    if (!signature) {
      res.status(400).json({ error: 'missing stripe-signature header' });
      return;
    }
    const { status, outcome } = await webhookHandler.handleEvent(req.body, signature);
    res.status(status).json({ outcome });
  });

  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/overview', overviewRouter);
  app.use('/ledger', ledgerRouter);
  app.use('/payments', paymentsRouter);
  app.use('/analytics', analyticsRouter);
  app.use('/reconciliation', reconciliationRouter);
  app.use('/chaos', chaosRouter);

  return app;
}

const app = buildApp();
const port = Number(process.env.PORT) || 4000;
app.listen(port, () => console.log(`reckon engine listening on :${port}`));
