import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Database tests share an in-memory SQLite and trip on each other if
    // they run in parallel within the same file. Each test file is its
    // own worker, but inside one file we keep tests sequential by default;
    // suites that are explicitly pure-function can opt into concurrency
    // with describe.concurrent if they need it.
    sequence: { concurrent: false },
    // One worker per file is the default — DB tests build their own
    // in-memory instance, so cross-file interference isn't a concern.
    pool: 'threads',
  },
});
