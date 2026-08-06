import 'dotenv/config';
import { createPayment, resolveProvider, syncPaymentStatus } from '../payments/index.js';
import { pool } from '../db/client.js';

/**
 * M1 gate: create a sandbox PaymentIntent and drive it to `succeeded`
 * locally. Against the mock provider this simulates the customer completing
 * checkout; against Stripe test mode, confirm the PaymentIntent with a test
 * card via the Stripe CLI/dashboard between the two syncs, or use
 * `stripe trigger payment_intent.succeeded`.
 */
async function main() {
  const { provider, name } = resolveProvider();
  console.log(`using provider: ${name}`);

  const payment = await createPayment(provider, name, { amount: 50000n, currency: process.env.LEDGER_CURRENCY ?? 'INR' });
  console.log(`created payment ${payment.id} (provider intent ${payment.providerPaymentIntentId}), state=${payment.state}`);

  let current = await syncPaymentStatus(provider, payment.id); // created -> pending
  console.log(`synced -> state=${current.state}`);

  if (name === 'mock') {
    provider.simulateProcessing(payment.providerPaymentIntentId);
  } else {
    console.log('waiting for you to confirm the PaymentIntent in Stripe test mode, then press enter...');
    await waitForEnter();
  }

  current = await syncPaymentStatus(provider, payment.id); // pending -> inflight
  console.log(`synced -> state=${current.state}`);

  if (name === 'mock') {
    provider.simulateSucceeded(payment.providerPaymentIntentId);
    current = await syncPaymentStatus(provider, payment.id);
    console.log(`synced -> state=${current.state}`);
  } else {
    console.log('waiting for the PaymentIntent to settle, then press enter...');
    await waitForEnter();
    current = await syncPaymentStatus(provider, payment.id);
    console.log(`synced -> state=${current.state}`);
  }

  if (current.state !== 'succeeded') {
    throw new Error(`expected payment to reach succeeded, got ${current.state}`);
  }

  console.log('payment reached succeeded — M1 gate satisfied');
  await pool.end();
}

async function waitForEnter() {
  await new Promise((resolve) => {
    process.stdin.once('data', () => resolve());
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
