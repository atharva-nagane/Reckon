import { pool, withTransaction } from '../db/client.js';
import { writeLedgerTransaction } from '../ledger/ledger.js';
import { logger } from '../logger.js';
import {
  applyPaymentTransition,
  getPaymentForUpdate,
  listPaymentsInWindow,
  mapProviderStatus,
} from '../payments/service.js';
import { legalPath } from '../payments/stateMachine.js';
import { createEventProcessor } from '../webhooks/handler.js';
import { createBreak, markAutoResolved } from './breaks.js';

/**
 * Settlement transactions still in force for a payment: kind='payment' rows
 * not cancelled by a reversal. Prior auto-resolutions appended reversals,
 * so re-running a window sees the corrected ledger, not the history.
 */
async function effectiveSettlements(paymentId) {
  const { rows } = await pool.query(
    `SELECT t.id,
            (SELECT p.amount::text FROM postings p JOIN accounts a ON a.id = p.account_id
              WHERE p.transaction_id = t.id AND p.direction = 'debit' AND a.name = 'provider_clearing'
              LIMIT 1) AS amount
     FROM ledger_transactions t
     WHERE t.kind = 'payment' AND t.external_ref = $1
       AND NOT EXISTS (
         SELECT 1 FROM ledger_transactions r WHERE r.kind = 'reversal' AND r.reverses_transaction_id = t.id
       )
     ORDER BY t.created_at`,
    [paymentId],
  );
  return rows.map((r) => ({ id: r.id, amount: BigInt(r.amount ?? '0') }));
}

function providerSnapshot(intent) {
  if (!intent) return { record: 'none' };
  return {
    intentId: intent.providerPaymentIntentId,
    status: intent.status,
    amount: intent.amount.toString(),
    currency: intent.currency,
  };
}

function reckonSnapshot(payment, settlements) {
  if (!payment) return { record: 'none' };
  return {
    paymentId: payment.id,
    state: payment.state,
    amount: payment.amount.toString(),
    holdTransactionId: payment.holdTransactionId,
    updatedAt: payment.updatedAt.toISOString(),
    settlements: settlements.map((s) => ({ transactionId: s.id, amount: s.amount.toString() })),
  };
}

/** Walks the payment along legal state-machine edges to `target`, writing each step's ledger effects. */
async function advancePayment(paymentId, target) {
  await withTransaction(async (client) => {
    let payment = await getPaymentForUpdate(client, paymentId);
    if (!payment) throw new Error(`unknown payment ${paymentId}`);
    const path = legalPath(payment.state, target);
    if (path === null) throw new Error(`no legal path ${payment.state} -> ${target}`);
    for (const step of path) {
      const result = await applyPaymentTransition(client, payment, step, { eventType: 'reconciliation' });
      if (!result.applied) throw new Error(`advance blocked at ${payment.state} -> ${step}: ${result.reason}`);
      payment = result.payment;
    }
  });
}

export function createReconciliationEngine(opts) {
  const pendingThresholdMs =
    opts.pendingThresholdMs ?? Number(process.env.RECON_PENDING_THRESHOLD_MS ?? 15 * 60_000);
  const holdThresholdMs = opts.holdThresholdMs ?? Number(process.env.RECON_HOLD_THRESHOLD_MS ?? 5 * 60_000);
  const processEvent = createEventProcessor({ providerName: opts.providerName });

  async function replayIntentEvents(intentId, windowFrom) {
    // events for an intent can precede the window's payment rows slightly; pad the lookback
    const since = new Date(windowFrom.getTime() - 60 * 60_000);
    const events = (await opts.provider.listEvents(since)).filter(
      (e) => e.intent.providerPaymentIntentId === intentId,
    );
    for (const event of events) {
      await processEvent(event, {
        source: 'reconciliation_replay',
        id: event.id,
        type: event.type,
        intent: { ...event.intent, amount: event.intent.amount.toString() },
      });
    }
  }

  async function reverseSettlement(extra, paymentId) {
    return withTransaction(async (client) => {
      const { rows: postings } = await client.query(
        'SELECT account_id, direction, amount FROM postings WHERE transaction_id = $1',
        [extra.id],
      );
      const txn = await writeLedgerTransaction(
        {
          kind: 'reversal',
          externalRef: paymentId,
          reversesTransactionId: extra.id,
          description: `reconciliation: reverse duplicate settlement ${extra.id}`,
          postings: postings.map((p) => ({
            accountId: p.account_id,
            direction: p.direction === 'debit' ? 'credit' : 'debit',
            amount: BigInt(p.amount),
          })),
        },
        client,
      );
      return txn.id;
    });
  }

  return {
    async runWindow(fromInclusive, toExclusive) {
      const { rows: runRows } = await pool.query(
        'INSERT INTO recon_runs (window_from, window_to) VALUES ($1, $2) RETURNING id',
        [fromInclusive, toExclusive],
      );
      const runId = runRows[0]?.id;
      if (!runId) throw new Error('failed to create recon run');

      // payment timestamps live on the DB clock; ages must be measured against
      // it, not Date.now() — the two clocks skew (observed: Docker VM drift)
      const { rows: nowRows } = await pool.query('SELECT now() AS db_now');
      const dbNow = nowRows[0]?.db_now.getTime() ?? Date.now();

      let breaksCreated = 0;
      let autoResolved = 0;

      const record = async (
        driftClass,
        severity,
        paymentRef,
        intent,
        payment,
        settlements,
        // absent for classes that must never auto-resolve; may only ever
        // append transactions, and throws to leave the break open when unsure
        resolve,
      ) => {
        const brk = await createBreak({
          reconRunId: runId,
          driftClass,
          severity,
          paymentRef,
          providerSnapshot: providerSnapshot(intent),
          reckonSnapshot: reckonSnapshot(payment, settlements),
        });
        if (!brk) return; // already open or ignored — don't multiply
        breaksCreated += 1;
        if (!resolve) return;
        try {
          const { action, transactionId } = await resolve();
          await markAutoResolved(brk.id, action, transactionId);
          autoResolved += 1;
        } catch (err) {
          logger.warn(
            { breakId: brk.id, driftClass, paymentRef, err: err instanceof Error ? err.message : String(err) },
            'auto-resolution failed — break left open',
          );
        }
      };

      const classify = async (intent, payment) => {
        if (!payment) {
          if (intent.status === 'succeeded') {
            // provider settled money Reckon has no payment for at all — a
            // replay can't invent the payment row, so this always flags
            await record('missing', 'high', intent.providerPaymentIntentId, intent, null, []);
          }
          // a non-settled provider intent with no local row moved no money; not a break
          return;
        }

        const settlements = await effectiveSettlements(payment.id);
        const age = dbNow - payment.updatedAt.getTime();

        if (intent.status === 'succeeded') {
          if (settlements.length === 0) {
            if (payment.state === 'inflight') {
              // reserved money whose resolution the provider has and we don't
              if (age > holdThresholdMs) {
                await record('unresolved_hold', 'high', payment.id, intent, payment, settlements, async () => {
                  await advancePayment(payment.id, 'succeeded');
                  return { action: 'provider_truth_applied' };
                });
              }
              return;
            }
            // Thresholded, unlike a bare rule: without it, every payment
            // whose webhook is milliseconds behind is a break.
            if (age > pendingThresholdMs) {
              await record('missing', 'high', payment.id, intent, payment, settlements, async () => {
                await replayIntentEvents(intent.providerPaymentIntentId, fromInclusive);
                if ((await effectiveSettlements(payment.id)).length > 0) return { action: 'backfill_replay' };
                // events were consumed while premature and dedupe now blocks
                // them — advance along legal edges instead, same ledger outcome
                await advancePayment(payment.id, 'succeeded');
                if ((await effectiveSettlements(payment.id)).length === 0) {
                  throw new Error('replay and advance both failed to produce a settlement');
                }
                return { action: 'state_machine_advance' };
              });
            }
            return;
          }

          if (settlements.length > 1) {
            const amountsAgree = settlements.every((s) => s.amount === settlements[0]?.amount);
            if (!amountsAgree) {
              // reversing the wrong copy would destroy evidence — a human picks
              await record('duplicate', 'high', payment.id, intent, payment, settlements);
              return;
            }
            await record('duplicate', 'high', payment.id, intent, payment, settlements, async () => {
              let lastReversal = '';
              for (const extra of settlements.slice(1)) {
                lastReversal = await reverseSettlement(extra, payment.id);
              }
              return { action: `reversed_${settlements.length - 1}_duplicate_settlement(s)`, transactionId: lastReversal };
            });
            return;
          }

          const settlement = settlements[0];
          if (settlement && settlement.amount !== intent.amount) {
            // highest severity, never auto-resolved — money is wrong
            await record('amount_mismatch', 'critical', payment.id, intent, payment, settlements);
            return;
          }

          if (payment.state !== 'succeeded') {
            // ledger settled but the state cache disagrees — internal inconsistency, human review
            await record('status_mismatch', 'medium', payment.id, intent, payment, settlements);
          }
          return;
        }

        const target = mapProviderStatus(intent.status);
        if (payment.state === target) return;

        const path = legalPath(payment.state, target);
        if (path === null) {
          // genuinely contradictory (e.g. Reckon succeeded, provider failed) — flag
          await record('status_mismatch', 'high', payment.id, intent, payment, settlements);
          return;
        }

        if (payment.state === 'inflight') {
          if (age > holdThresholdMs) {
            await record('unresolved_hold', 'high', payment.id, intent, payment, settlements, async () => {
              await advancePayment(payment.id, target);
              return { action: 'provider_truth_applied' };
            });
          }
          return;
        }

        if (age > pendingThresholdMs) {
          const isTerminal = target === 'failed';
          // stuck_pending when the provider reached a terminal state; a plain
          // stale-state lag otherwise — both advance along legal edges
          await record(
            isTerminal ? 'stuck_pending' : 'status_mismatch',
            isTerminal ? 'low' : 'medium',
            payment.id,
            intent,
            payment,
            settlements,
            async () => {
              await advancePayment(payment.id, target);
              return { action: 'provider_truth_applied' };
            },
          );
        }
      };

      const intents = await opts.provider.listPaymentIntents(fromInclusive, toExclusive);
      const payments = await listPaymentsInWindow(opts.providerName, fromInclusive, toExclusive);
      const paymentByIntent = new Map(payments.map((p) => [p.providerPaymentIntentId, p]));
      const intentIds = new Set(intents.map((i) => i.providerPaymentIntentId));

      for (const intent of intents) {
        await classify(intent, paymentByIntent.get(intent.providerPaymentIntentId));
      }

      for (const payment of payments) {
        if (intentIds.has(payment.providerPaymentIntentId)) continue;
        let intent;
        try {
          intent = await opts.provider.retrievePaymentIntent(payment.providerPaymentIntentId);
        } catch {
          const settlements = await effectiveSettlements(payment.id);
          if (payment.state === 'inflight') {
            // the hard case: reserved money the provider has no record of.
            // Never auto-resolve — a lost authorization needs a human.
            await record('unresolved_hold', 'critical', payment.id, null, payment, settlements);
          } else {
            await record('status_mismatch', 'medium', payment.id, null, payment, settlements);
          }
          continue;
        }
        await classify(intent, payment);
      }

      await pool.query('UPDATE recon_runs SET finished_at = now(), breaks_created = $2, auto_resolved = $3 WHERE id = $1', [
        runId,
        breaksCreated,
        autoResolved,
      ]);
      return { runId, breaksCreated, autoResolved };
    },
  };
}
