import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exclude build-artifact tests — they reference dist/ (gitignored, absent
    // in Stryker's sandbox) and test build output, not source logic.
    exclude: [
      'node_modules/**',
      '**/__tests__/csp-cleanliness.test.ts',
    ],
    environment: 'node',
  },
});
