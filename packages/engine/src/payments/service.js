import { randomUUID } from 'node:crypto';
import { pool, withTransaction } from '../db/client.js';
import { getAccountByName, writeLedgerTransaction } from '../ledger/ledger.js';
import { evaluateTransition } from './stateMachine.js';

const FEE_BPS = 200n; // 2%, see docs/chart_of_accounts.md

function toPaymentRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    providerPaymentIntentId: row.provider_payment_intent_id,
    amount: BigInt(row.amount),
    currency: row.currency,
    state: row.state,
    holdTransactionId: row.hold_transaction_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Creates the local payment row and the provider PaymentIntent under one idempotency key. */
export async function createPayment(provider, providerName, input) {
  const idempotencyKey = `create:${randomUUID()}`;
  const intent = await provider.createPaymentIntent({
    amount: input.amount,
    currency: input.currency,
    idempotencyKey,
  });

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO payments (provider, provider_payment_intent_id, amount, currency, state, create_idempotency_key)
       VALUES ($1, $2, $3, $4, 'created', $5)
       RETURNING id, provider, provider_payment_intent_id, amount, currency, state, hold_transaction_id, created_at, updated_at`,
      [providerName, intent.providerPaymentIntentId, input.amount.toString(), input.currency, idempotencyKey],
    );
    const row = rows[0];
    await client.query(
      `INSERT INTO payment_events (payment_id, event_type, from_state, to_state, applied)
       VALUES ($1, 'created', NULL, 'created', true)`,
      [row.id],
    );
    return toPaymentRow(row);
  });
}

export async function getPayment(paymentId) {
  const { rows } = await pool.query(
    `SELECT id, provider, provider_payment_intent_id, amount, currency, state, hold_transaction_id, created_at, updated_at
     FROM payments WHERE id = $1`,
    [paymentId],
  );
  return rows[0] ? toPaymentRow(rows[0]) : null;
}

export async function listPayments(limit = 100) {
  const { rows } = await pool.query(
    `SELECT id, provider, provider_payment_intent_id, amount, currency, state, hold_transaction_id, created_at, updated_at
     FROM payments ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(toPaymentRow);
}

export async function listPaymentsInWindow(providerName, fromInclusive, toExclusive) {
  const { rows } = await pool.query(
    `SELECT id, provider, provider_payment_intent_id, amount, currency, state, hold_transaction_id, created_at, updated_at
     FROM payments WHERE provider = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at`,
    [providerName, fromInclusive, toExclusive],
  );
  return rows.map(toPaymentRow);
}

export async function paymentEvents(paymentId) {
  const { rows } = await pool.query(
    `SELECT event_type, from_state, to_state, applied, reason, occurred_at
     FROM payment_events WHERE payment_id = $1 ORDER BY occurred_at`,
    [paymentId],
  );
  return rows.map((r) => ({
    eventType: r.event_type,
    fromState: r.from_state,
    toState: r.to_state,
    applied: r.applied,
    reason: r.reason,
    occurredAt: r.occurred_at,
  }));
}

export function mapProviderStatus(status) {
  switch (status) {
    case 'requires_payment':
      return 'pending';
    case 'processing':
    case 'requires_capture':
      return 'inflight';
    case 'succeeded':
      return 'succeeded';
    case 'canceled':
    case 'failed':
      return 'failed';
    default:
      return undefined;
  }
}

/** Locks the payment row for the rest of the transaction — concurrent events for one payment serialize here. */
export async function getPaymentForUpdate(client, paymentId) {
  const { rows } = await client.query(
    `SELECT id, provider, provider_payment_intent_id, amount, currency, state, hold_transaction_id, created_at, updated_at
     FROM payments WHERE id = $1 FOR UPDATE`,
    [paymentId],
  );
  return rows[0] ? toPaymentRow(rows[0]) : null;
}

export async function getPaymentByIntentForUpdate(client, providerName, providerPaymentIntentId) {
  const { rows } = await client.query(
    `SELECT id, provider, provider_payment_intent_id, amount, currency, state, hold_transaction_id, created_at, updated_at
     FROM payments WHERE provider = $1 AND provider_payment_intent_id = $2 FOR UPDATE`,
    [providerName, providerPaymentIntentId],
  );
  return rows[0] ? toPaymentRow(rows[0]) : null;
}

/**
 * Applies one provider-observed state to a payment inside the caller's
 * transaction: validates the transition, writes ledger effects, updates the
 * state cache, and appends the payment_events row. Unapplied (stale/premature)
 * events are recorded, never dropped — reconciliation's out-of-order case
 * depends on that record existing.
 * Caller must hold the payment row lock (getPayment*ForUpdate).
 */
export async function applyPaymentTransition(client, payment, target, event) {
  const outcome = evaluateTransition(payment.state, target);
  const rawPayload = event.rawPayload === undefined ? null : JSON.stringify(event.rawPayload);

  if (!outcome.applied) {
    await client.query(
      `INSERT INTO payment_events (payment_id, event_type, from_state, to_state, applied, reason, provider_event_ref, raw_payload)
       VALUES ($1, $2, $3, $4, false, $5, $6, $7)`,
      [payment.id, event.eventType, payment.state, target, outcome.reason, event.providerEventRef ?? null, rawPayload],
    );
    return { applied: false, reason: outcome.reason, payment };
  }

  await applyLedgerEffects(client, payment, target);

  await client.query(`UPDATE payments SET state = $1, updated_at = now() WHERE id = $2`, [target, payment.id]);
  await client.query(
    `INSERT INTO payment_events (payment_id, event_type, from_state, to_state, applied, provider_event_ref, raw_payload)
     VALUES ($1, $2, $3, $4, true, $5, $6)`,
    [payment.id, event.eventType, payment.state, target, event.providerEventRef ?? null, rawPayload],
  );

  const updated = await client.query(
    `SELECT id, provider, provider_payment_intent_id, amount, currency, state, hold_transaction_id, created_at, updated_at
     FROM payments WHERE id = $1`,
    [payment.id],
  );
  return { applied: true, payment: toPaymentRow(updated.rows[0]) };
}

/**
 * Polls the provider and advances the local state machine to match. This was
 * the earliest-scoped driver; webhooks (src/webhooks/handler.js) are the
 * primary path and this remains the manual/demo fallback.
 */
export async function syncPaymentStatus(provider, paymentId) {
  const known = await getPayment(paymentId);
  if (!known) throw new Error(`unknown payment ${paymentId}`);

  const intent = await provider.retrievePaymentIntent(known.providerPaymentIntentId);
  const target = mapProviderStatus(intent.status);

  return withTransaction(async (client) => {
    const payment = await getPaymentForUpdate(client, paymentId);
    if (!payment) throw new Error(`unknown payment ${paymentId}`);
    const result = await applyPaymentTransition(client, payment, target, { eventType: 'provider_sync' });
    return result.payment;
  });
}

/** Ledger side-effects of entering/leaving `inflight`. */
async function applyLedgerEffects(client, payment, target) {
  const [providerHolds, customerLiability, providerClearing, revenue, fees] = await Promise.all([
    getAccountByName('provider_holds'),
    getAccountByName('customer_liability'),
    getAccountByName('provider_clearing'),
    getAccountByName('revenue'),
    getAccountByName('fees'),
  ]);
  if (!providerHolds || !customerLiability || !providerClearing || !revenue || !fees) {
    throw new Error('chart of accounts is missing required accounts — run migrations/seed');
  }

  if (target === 'inflight') {
    const hold = await writeLedgerTransaction(
      {
        kind: 'hold',
        externalRef: payment.id,
        description: `hold for payment ${payment.id}`,
        postings: [
          { accountId: providerHolds.id, direction: 'debit', amount: payment.amount },
          { accountId: customerLiability.id, direction: 'credit', amount: payment.amount },
        ],
      },
      client,
    );
    await client.query(`UPDATE payments SET hold_transaction_id = $1 WHERE id = $2`, [hold.id, payment.id]);
    return;
  }

  if (target === 'succeeded' && payment.state === 'inflight') {
    if (!payment.holdTransactionId) throw new Error(`payment ${payment.id} succeeded without a recorded hold`);

    await writeLedgerTransaction(
      {
        kind: 'reversal',
        externalRef: payment.id,
        reversesTransactionId: payment.holdTransactionId,
        description: `release hold for payment ${payment.id}`,
        postings: [
          { accountId: customerLiability.id, direction: 'debit', amount: payment.amount },
          { accountId: providerHolds.id, direction: 'credit', amount: payment.amount },
        ],
      },
      client,
    );

    const fee = (payment.amount * FEE_BPS) / 10_000n;
    const net = payment.amount - fee;
    const revenuePostings =
      fee > 0n
        ? [
            { accountId: revenue.id, direction: 'credit', amount: net },
            { accountId: fees.id, direction: 'credit', amount: fee },
          ]
        : [{ accountId: revenue.id, direction: 'credit', amount: net }];

    await writeLedgerTransaction(
      {
        kind: 'payment',
        externalRef: payment.id,
        description: `settlement for payment ${payment.id}`,
        postings: [{ accountId: providerClearing.id, direction: 'debit', amount: payment.amount }, ...revenuePostings],
      },
      client,
    );
    return;
  }

  if (target === 'failed' && payment.state === 'inflight') {
    if (!payment.holdTransactionId) throw new Error(`payment ${payment.id} failed out of inflight without a hold`);

    await writeLedgerTransaction(
      {
        kind: 'reversal',
        externalRef: payment.id,
        reversesTransactionId: payment.holdTransactionId,
        description: `release hold for payment ${payment.id} (failed)`,
        postings: [
          { accountId: customerLiability.id, direction: 'debit', amount: payment.amount },
          { accountId: providerHolds.id, direction: 'credit', amount: payment.amount },
        ],
      },
      client,
    );
  }

  // pending and failed-from-pending/created carry no ledger effect — no money was ever reserved.
}
