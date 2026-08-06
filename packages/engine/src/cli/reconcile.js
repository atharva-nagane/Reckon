import 'dotenv/config';
import { parseArgs } from 'node:util';
import { pool } from '../db/client.js';
import { resolveProvider } from '../payments/index.js';
import { listBreaks } from '../reconciliation/breaks.js';
import { createReconciliationEngine } from '../reconciliation/engine.js';

/** On-demand reconciliation — `reckon reconcile --window <minutes>`. */
async function main() {
  const { values } = parseArgs({ options: { window: { type: 'string', default: '60' } } });
  const windowMinutes = Number(values.window);
  if (!Number.isInteger(windowMinutes) || windowMinutes <= 0) {
    console.error(`--window must be a positive integer of minutes, got ${values.window}`);
    process.exit(1);
  }

  const { provider, name } = resolveProvider();
  const engine = createReconciliationEngine({ provider, providerName: name });

  const now = new Date();
  const from = new Date(now.getTime() - windowMinutes * 60_000);
  const to = new Date(now.getTime() + 60_000);
  console.log(`reconciling ${name} window ${from.toISOString()} .. ${to.toISOString()}`);

  const result = await engine.runWindow(from, to);
  console.log(`run ${result.runId}: ${result.breaksCreated} break(s) created, ${result.autoResolved} auto-resolved`);

  const open = await listBreaks({ status: 'open' });
  if (open.length > 0) {
    console.log(`${open.length} open break(s) require review:`);
    for (const b of open) {
      console.log(`  [${b.severity}] ${b.driftClass} payment_ref=${b.paymentRef} (${b.id})`);
    }
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
