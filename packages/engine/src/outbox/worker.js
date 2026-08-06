import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { logger } from '../logger.js';
import { drainOutbox } from './outbox.js';

const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // required by BullMQ workers
});

const QUEUE = 'outbox-drain';
const DRAIN_EVERY_MS = 2_000;

async function main() {
  const queue = new Queue(QUEUE, { connection });
  await queue.add('drain', {}, { repeat: { every: DRAIN_EVERY_MS }, removeOnComplete: true, removeOnFail: 100 });

  const worker = new Worker(
    QUEUE,
    async () => {
      const { delivered, failed } = await drainOutbox();
      if (delivered > 0 || failed > 0) logger.info({ delivered, failed }, 'outbox drained');
    },
    { connection },
  );

  worker.on('failed', (_job, err) => logger.error({ err: err.message }, 'outbox drain job failed'));
  logger.info({ queue: QUEUE, everyMs: DRAIN_EVERY_MS }, 'outbox worker started');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
