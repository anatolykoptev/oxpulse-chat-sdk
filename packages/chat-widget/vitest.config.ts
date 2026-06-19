import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as { version: string };

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
  define: {
    // Mirror the esbuild define so vitest tests run without a ReferenceError
    // on __WIDGET_VERSION__ in element.ts / iframe.ts.
    __WIDGET_VERSION__: JSON.stringify(pkg.version),
  },
});
