import 'dotenv/config';
import { MockPaymentProvider } from '../payments/mockProvider.js';
import { createPayment, syncPaymentStatus } from '../payments/service.js';
import { pool } from './client.js';

const AMOUNTS = [50000n, 12000n, 250000n, 9900n, 75000n];

async function main() {
  const provider = new MockPaymentProvider();

  for (const [i, amount] of AMOUNTS.entries()) {
    const payment = await createPayment(provider, 'mock', { amount, currency: process.env.LEDGER_CURRENCY ?? 'INR' });
    await syncPaymentStatus(provider, payment.id); // -> pending
    provider.simulateProcessing(payment.providerPaymentIntentId);
    await syncPaymentStatus(provider, payment.id); // -> inflight

    if (i === AMOUNTS.length - 1) {
      provider.simulateFailed(payment.providerPaymentIntentId);
    } else {
      provider.simulateSucceeded(payment.providerPaymentIntentId);
    }
    const final = await syncPaymentStatus(provider, payment.id);
    console.log(`seeded payment ${payment.id}: ${amount} -> ${final.state}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
