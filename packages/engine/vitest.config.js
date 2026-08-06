import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['dotenv/config'],
    testTimeout: 15000,
    // Tests share one live Postgres instance and assert on account balance
    // deltas — file-level parallelism causes cross-file races on shared accounts.
    fileParallelism: false,
  },
});
