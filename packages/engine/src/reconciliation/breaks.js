import { pool } from '../db/client.js';

const COLUMNS = `id, recon_run_id, drift_class, severity, payment_ref, provider_snapshot, reckon_snapshot,
  status, resolution_action, resolution_transaction_id, resolved_by, created_at, resolved_at`;

function toBreakRow(row) {
  return {
    id: row.id,
    reconRunId: row.recon_run_id,
    driftClass: row.drift_class,
    severity: row.severity,
    paymentRef: row.payment_ref,
    providerSnapshot: row.provider_snapshot,
    reckonSnapshot: row.reckon_snapshot,
    status: row.status,
    resolutionAction: row.resolution_action,
    resolutionTransactionId: row.resolution_transaction_id,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Creates a break unless one of the same class is already open (or ignored)
 * for the same payment — re-running an overlapping window must not multiply
 * breaks a human is already looking at. A resolved break does not suppress:
 * the same drift recurring after resolution is a new break.
 */
export async function createBreak(input) {
  const { rows: existing } = await pool.query(
    `SELECT 1 FROM breaks WHERE drift_class = $1 AND payment_ref = $2 AND status IN ('open', 'ignored')`,
    [input.driftClass, input.paymentRef],
  );
  if (existing.length > 0) return null;

  const { rows } = await pool.query(
    `INSERT INTO breaks (recon_run_id, drift_class, severity, payment_ref, provider_snapshot, reckon_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${COLUMNS}`,
    [
      input.reconRunId,
      input.driftClass,
      input.severity,
      input.paymentRef,
      JSON.stringify(input.providerSnapshot),
      JSON.stringify(input.reckonSnapshot),
    ],
  );
  return toBreakRow(rows[0]);
}

export async function markAutoResolved(breakId, action, resolutionTransactionId) {
  await pool.query(
    `UPDATE breaks SET status = 'auto_resolved', resolution_action = $2, resolution_transaction_id = $3,
       resolved_by = 'reconciler', resolved_at = now()
     WHERE id = $1 AND status = 'open'`,
    [breakId, action, resolutionTransactionId ?? null],
  );
}

export async function resolveBreak(breakId, resolvedBy, action) {
  const { rows } = await pool.query(
    `UPDATE breaks SET status = 'resolved', resolution_action = $3, resolved_by = $2, resolved_at = now()
     WHERE id = $1 AND status = 'open'
     RETURNING ${COLUMNS}`,
    [breakId, resolvedBy, action],
  );
  return rows[0] ? toBreakRow(rows[0]) : null;
}

export async function ignoreBreak(breakId, resolvedBy) {
  const { rows } = await pool.query(
    `UPDATE breaks SET status = 'ignored', resolved_by = $2, resolved_at = now()
     WHERE id = $1 AND status = 'open'
     RETURNING ${COLUMNS}`,
    [breakId, resolvedBy],
  );
  return rows[0] ? toBreakRow(rows[0]) : null;
}

export async function getBreak(breakId) {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM breaks WHERE id = $1`, [breakId]);
  return rows[0] ? toBreakRow(rows[0]) : null;
}

export async function listBreaks(filter) {
  const conditions = [];
  const params = [];
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filter.driftClass) {
    params.push(filter.driftClass);
    conditions.push(`drift_class = $${params.length}`);
  }
  params.push(filter.limit ?? 200);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT ${COLUMNS} FROM breaks ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(toBreakRow);
}
