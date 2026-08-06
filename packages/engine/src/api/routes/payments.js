import { Router } from 'express';
import { z } from 'zod';
import { resolveProvider } from '../../payments/index.js';
import { moneyFromJSON, moneyToJSON } from '../../money/money.js';
import { createPayment, getPayment, listPayments, paymentEvents, syncPaymentStatus } from '../../payments/service.js';

export const paymentsRouter = Router();

const createPaymentSchema = z.object({
  amount: z.union([z.string(), z.number()]),
  currency: z.string().min(3).max(3),
});

paymentsRouter.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await listPayments(limit);
  res.json(rows.map(serializePayment));
});

paymentsRouter.get('/:id', async (req, res) => {
  const payment = await getPayment(req.params.id);
  if (!payment) {
    res.status(404).json({ error: 'payment not found' });
    return;
  }
  const events = await paymentEvents(payment.id);
  res.json({ ...serializePayment(payment), events });
});

paymentsRouter.post('/', async (req, res) => {
  const parsed = createPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const { provider, name } = resolveProvider();
  const amount = moneyFromJSON(String(parsed.data.amount));
  const payment = await createPayment(provider, name, { amount, currency: parsed.data.currency });
  res.status(201).json(serializePayment(payment));
});

paymentsRouter.post('/:id/sync', async (req, res) => {
  const { provider } = resolveProvider();
  try {
    const payment = await syncPaymentStatus(provider, req.params.id);
    res.json(serializePayment(payment));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'sync failed' });
  }
});

function serializePayment(p) {
  return {
    id: p.id,
    provider: p.provider,
    providerPaymentIntentId: p.providerPaymentIntentId,
    amount: moneyToJSON(p.amount),
    currency: p.currency,
    state: p.state,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
