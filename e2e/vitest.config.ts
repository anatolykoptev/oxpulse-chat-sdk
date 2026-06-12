import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    environment: 'node',
    // Allow long-running tests against a live server (30 s per test).
    testTimeout: 30_000,
  },
});
