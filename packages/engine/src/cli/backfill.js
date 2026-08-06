import 'dotenv/config';
import { parseArgs } from 'node:util';
import { pool } from '../db/client.js';
import { resolveProvider } from '../payments/index.js';
import { createEventProcessor } from '../webhooks/handler.js';

/**
 * `reckon backfill --since <ts>` — pulls the provider's event log for a
 * window and re-feeds it through the same idempotent processor the webhook
 * route uses. Safe to run any number of times, over any overlapping window:
 * already-processed events short-circuit as duplicates.
 */
async function main() {
  const { values } = parseArgs({ options: { since: { type: 'string' } } });
  if (!values.since) {
    console.error('usage: npm run backfill -- --since <ISO timestamp>');
    process.exit(1);
  }
  const since = new Date(values.since);
  if (Number.isNaN(since.getTime())) {
    console.error(`not a valid timestamp: ${values.since}`);
    process.exit(1);
  }

  const { provider, name } = resolveProvider();
  const processEvent = createEventProcessor({ providerName: name });

  const events = await provider.listEvents(since);
  console.log(`backfilling ${events.length} ${name} events since ${since.toISOString()}`);

  const counts = {};
  for (const event of events) {
    const outcome = await processEvent(event, {
      source: 'backfill',
      id: event.id,
      type: event.type,
      intent: { ...event.intent, amount: event.intent.amount.toString() },
    });
    counts[outcome] = (counts[outcome] ?? 0) + 1;
    console.log(`  ${event.id} ${event.type} -> ${outcome}`);
  }

  console.log('backfill complete:', counts);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
