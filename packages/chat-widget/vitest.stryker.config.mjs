import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

// Stryker-only vitest config: mirrors the main vitest.config.ts (jsdom +
// __WIDGET_VERSION__ define) but runs in Stryker's sandbox. The main config
// can't be reused directly because Stryker's tempDir sandbox doesn't copy
// tsconfig.json, which Vite 8's oxc transformer requires for .ts files.
// This config uses environment: jsdom to match the main config.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    // Exclude build-artifact tests — they reference dist/ and dist-cdn/
    // (gitignored, absent in Stryker's sandbox) and test build output.
    exclude: [
      'node_modules/**',
      '**/__tests__/cdn-bundle.test.ts',
      '**/__tests__/tsc-dist-version.test.ts',
      '**/__tests__/browser-regex-compat.test.ts',
    ],
  },
  define: {
    __WIDGET_VERSION__: JSON.stringify(pkg.version),
  },
});
