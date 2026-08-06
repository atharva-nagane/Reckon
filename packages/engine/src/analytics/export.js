import { pool } from '../db/client.js';

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}

export async function exportDataset(dataset) {
  if (dataset === 'payments') {
    const { rows } = await pool.query(
      `SELECT id, provider, provider_payment_intent_id, amount, currency, state, created_at, updated_at
       FROM payments ORDER BY created_at`,
    );
    return toCsv(rows);
  }

  if (dataset === 'breaks') {
    const { rows } = await pool.query(
      `SELECT id, drift_class, severity, payment_ref, status, resolution_action, resolved_by,
              created_at, resolved_at,
              EXTRACT(EPOCH FROM (resolved_at - created_at)) AS seconds_to_resolve
       FROM breaks ORDER BY created_at`,
    );
    return toCsv(rows);
  }

  if (dataset === 'recon_runs') {
    const { rows } = await pool.query(
      `SELECT id, window_from, window_to, started_at, finished_at, breaks_created, auto_resolved
       FROM recon_runs ORDER BY started_at`,
    );
    return toCsv(rows);
  }

  const { rows } = await pool.query(
    `SELECT t.id AS transaction_id, t.kind, t.external_ref, t.description, t.created_at,
            p.account_id, a.name AS account_name, p.direction, p.amount
     FROM ledger_transactions t
     JOIN postings p ON p.transaction_id = t.id
     JOIN accounts a ON a.id = p.account_id
     ORDER BY t.created_at, p.created_at`,
  );
  return toCsv(rows);
}
