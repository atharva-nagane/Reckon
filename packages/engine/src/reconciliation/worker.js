import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../logger.js';
import { resolveProvider } from '../payments/index.js';
import { createReconciliationEngine } from './engine.js';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
});

const QUEUE = 'reconciliation';
const RUN_EVERY_MS = Number(process.env.RECON_INTERVAL_MS ?? 60_000);
// window is 2x the interval so consecutive runs overlap; break dedup makes overlap harmless
const WINDOW_MS = RUN_EVERY_MS * 2;

async function main() {
  const { provider, name } = resolveProvider();
  const engine = createReconciliationEngine({ provider, providerName: name });

  const queue = new Queue(QUEUE, { connection });
  await queue.add('run-window', {}, { repeat: { every: RUN_EVERY_MS }, removeOnComplete: true, removeOnFail: 100 });

  const worker = new Worker(
    QUEUE,
    async () => {
      const now = new Date();
      const result = await engine.runWindow(new Date(now.getTime() - WINDOW_MS), new Date(now.getTime() + 60_000));
      if (result.breaksCreated > 0) logger.info(result, 'reconciliation run found drift');
    },
    { connection },
  );

  worker.on('failed', (_job, err) => logger.error({ err: err.message }, 'reconciliation run failed'));
  logger.info({ queue: QUEUE, everyMs: RUN_EVERY_MS, provider: name }, 'reconciliation worker started');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
