import { withTransaction } from '../db/client.js';
import { logger } from '../logger.js';

/** Must be called inside the same transaction as the state change it announces. */
export async function insertOutbox(client, topic, payload) {
  await client.query('INSERT INTO outbox (topic, payload) VALUES ($1, $2)', [topic, JSON.stringify(payload)]);
}

const MAX_ATTEMPTS = 10;

/**
 * Real alerting integrations are a later seam. Delivery POSTs to
 * OUTBOX_SINK_URL when configured, otherwise emits a structured log — an
 * honest no-op sink, not a fake integration.
 */
export async function deliverToSink(topic, payload) {
  const url = process.env.OUTBOX_SINK_URL;
  if (url) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic, payload }),
    });
    if (!res.ok) throw new Error(`outbox sink responded ${res.status}`);
    return;
  }
  logger.info({ topic, payload }, 'outbox delivery');
}

/**
 * Claims and delivers pending rows one at a time. SKIP LOCKED lets concurrent
 * workers coexist; delivering inside the claiming transaction means a crash
 * after delivery but before commit redelivers — outbox side-effects are
 * at-least-once by design, so sinks must tolerate duplicates.
 */
export async function drainOutbox(deliver = deliverToSink) {
  let delivered = 0;
  let failed = 0;
  const attemptedThisDrain = [];

  for (;;) {
    const done = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT id, topic, payload, attempts FROM outbox
         WHERE status = 'pending' AND id != ALL($1::uuid[])
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [attemptedThisDrain],
      );
      const row = rows[0];
      if (!row) return true;
      attemptedThisDrain.push(row.id);

      try {
        await deliver(row.topic, row.payload);
        await client.query(
          `UPDATE outbox SET status = 'delivered', attempts = attempts + 1, delivered_at = now() WHERE id = $1`,
          [row.id],
        );
        delivered += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const exhausted = row.attempts + 1 >= MAX_ATTEMPTS;
        await client.query(
          `UPDATE outbox SET status = $2, attempts = attempts + 1, last_error = $3 WHERE id = $1`,
          [row.id, exhausted ? 'failed' : 'pending', message],
        );
        failed += 1;
        logger.warn({ outboxId: row.id, attempts: row.attempts + 1, err: message }, 'outbox delivery failed');
      }
      return false;
    });
    if (done) break;
  }

  return { delivered, failed };
}
