import 'dotenv/config';
import { parseArgs } from 'node:util';
import { pool } from '../db/client.js';
import { createHarness, renderMatrix, score } from '../faults/harness.js';

/**
 * The verification matrix and the precision/recall scoring run. These
 * printed numbers are the only accuracy figures the project may quote —
 * they come from this actually running, never from prose.
 */
async function main() {
  const { values } = parseArgs({ options: { rounds: { type: 'string', default: '3' } } });
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds <= 0) {
    console.error(`--rounds must be a positive integer, got ${values.rounds}`);
    process.exit(1);
  }

  console.log('verification matrix — one scenario per fault:\n');
  const matrix = await createHarness().runMatrix();
  console.log(renderMatrix(matrix));
  const allPass = matrix.every((r) => r.pass);
  console.log(allPass ? '\nmatrix: all green' : '\nmatrix: FAILURES PRESENT');

  console.log(`\nprecision/recall — ${rounds} round(s) of mixed faults:\n`);
  const rows = await createHarness().runScoring(rounds);
  const s = score(rows);
  console.log(`  payments scored:   ${s.payments}`);
  console.log(`  true positives:    ${s.truePositives}`);
  console.log(`  false positives:   ${s.falsePositives}`);
  console.log(`  false negatives:   ${s.falseNegatives}`);
  console.log(`  precision:         ${(s.precision * 100).toFixed(1)}%`);
  console.log(`  recall:            ${(s.recall * 100).toFixed(1)}%`);
  console.log(`  auto-resolution:   ${(s.autoResolutionRate * 100).toFixed(1)}% of detected breaks`);

  await pool.end();
  process.exit(allPass && s.precision === 1 && s.recall === 1 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
