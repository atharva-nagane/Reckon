import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/client.js';
import { accountBalance, getAccountByName } from '../src/ledger/ledger.js';
import { MockPaymentProvider } from '../src/payments/mockProvider.js';
import { createPayment, getPayment, paymentEvents, syncPaymentStatus } from '../src/payments/service.js';
import { evaluateTransition } from '../src/payments/stateMachine.js';

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // ledger is append-only; tests rely on relative balance deltas rather than a clean slate.
});

describe('payment state machine', () => {
  it('allows the happy path and rejects illegal transitions', () => {
    expect(evaluateTransition('created', 'pending')).toEqual({ applied: true });
    expect(evaluateTransition('pending', 'inflight')).toEqual({ applied: true });
    expect(evaluateTransition('inflight', 'succeeded')).toEqual({ applied: true });
    expect(evaluateTransition('succeeded', 'succeeded').applied).toBe(false);
    const illegal = evaluateTransition('succeeded', 'pending');
    expect(illegal.applied).toBe(false);
  });
});

describe('payment lifecycle + ledger integration', () => {
  it('drives a mock payment to succeeded and posts hold + settlement transactions', async () => {
    const provider = new MockPaymentProvider();
    const holds = await getAccountByName('provider_holds');
    const clearing = await getAccountByName('provider_clearing');
    if (!holds || !clearing) throw new Error('seed accounts missing');

    const holdsBefore = await accountBalance(holds.id);
    const clearingBefore = await accountBalance(clearing.id);

    const payment = await createPayment(provider, 'mock', { amount: 10_000n, currency: 'INR' });
    expect(payment.state).toBe('created');

    await syncPaymentStatus(provider, payment.id); // requires_payment -> pending

    provider.simulateProcessing(payment.providerPaymentIntentId);
    const afterPending = await syncPaymentStatus(provider, payment.id);
    expect(afterPending.state).toBe('inflight');
    expect(afterPending.holdTransactionId).toBeTruthy();

    const holdsDuring = await accountBalance(holds.id);
    expect(holdsDuring).toBe(holdsBefore - 10_000n); // debit reduces an asset's credit-minus-debit balance

    provider.simulateSucceeded(payment.providerPaymentIntentId);
    const afterSucceeded = await syncPaymentStatus(provider, payment.id);
    expect(afterSucceeded.state).toBe('succeeded');

    const holdsAfter = await accountBalance(holds.id);
    const clearingAfter = await accountBalance(clearing.id);
    expect(holdsAfter).toBe(holdsBefore); // hold fully reversed
    expect(clearingAfter).toBe(clearingBefore - 10_000n); // settlement debits clearing

    const events = await paymentEvents(payment.id);
    expect(events.map((e) => e.toState)).toEqual(['created', 'pending', 'inflight', 'succeeded']);
    expect(events.every((e) => e.applied)).toBe(true);
  });

  it('releases the hold with no payment transaction when a payment fails from inflight', async () => {
    const provider = new MockPaymentProvider();
    const holds = await getAccountByName('provider_holds');
    if (!holds) throw new Error('seed accounts missing');
    const holdsBefore = await accountBalance(holds.id);

    const payment = await createPayment(provider, 'mock', { amount: 5_000n, currency: 'INR' });
    await syncPaymentStatus(provider, payment.id); // requires_payment -> pending
    provider.simulateProcessing(payment.providerPaymentIntentId);
    await syncPaymentStatus(provider, payment.id);

    provider.simulateFailed(payment.providerPaymentIntentId);
    const final = await syncPaymentStatus(provider, payment.id);
    expect(final.state).toBe('failed');

    const holdsAfter = await accountBalance(holds.id);
    expect(holdsAfter).toBe(holdsBefore);
  });

  it('records an out-of-order event as unapplied instead of corrupting state', async () => {
    const provider = new MockPaymentProvider();
    const payment = await createPayment(provider, 'mock', { amount: 1_000n, currency: 'INR' });

    // Jump straight to succeeded from `created` on the provider side — illegal per the state machine.
    provider.simulateSucceeded(payment.providerPaymentIntentId);
    const result = await syncPaymentStatus(provider, payment.id);

    expect(result.state).toBe('created'); // not blindly applied
    const events = await paymentEvents(payment.id);
    const last = events[events.length - 1];
    expect(last.applied).toBe(false);
    expect(last.toState).toBe('succeeded');

    const stored = await getPayment(payment.id);
    expect(stored?.state).toBe('created');
  });
});
