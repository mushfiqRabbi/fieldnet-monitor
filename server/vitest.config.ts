import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // API tests share one database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      TEST_MODE: '1',
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://fieldnet:fieldnet@localhost:5433/fieldnet_test',
    },
  },
});
