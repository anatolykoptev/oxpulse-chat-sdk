/**
 * csp-cleanliness.test.ts — build-time CSP guard for @oxpulse/chat-sdk.
 *
 * Scans the compiled bundle for eval() / new Function() usage that would
 * cause CSP violations under strict-dynamic without 'unsafe-eval'.
 *
 * RED: fails until `npm run build` produces dist/index.js.
 * GREEN: build clean → no eval surface in shipped artifact.
 *
 * If this test fails after a dependency bump, the new dep (or an update to
 * an existing one) introduced an eval path. Mitigations:
 *   - cbor-x: already using cbor-x/index-no-eval subpath (see wire-codec).
 *   - zod: set globalThis.__zod_globalConfig = { jitless: true } before boot.
 *   - Other: find the eval-emitting module and replace or configure it.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// dist/ is two directories up from src/__tests__/
const DIST_JS = resolve(__dirname, '../../dist/index.js');

describe('CSP cleanliness — built bundle', () => {
  test('dist/index.js exists (run npm run build first)', () => {
    let exists = false;
    try {
      readFileSync(DIST_JS);
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists, `dist/index.js not found at ${DIST_JS} — run: npm run build`).toBe(true);
  });

  test('built bundle has no eval() call', () => {
    const dist = readFileSync(DIST_JS, 'utf-8');
    // Match bare eval( but not identifiers ending with eval (e.g. "seval(")
    expect(dist).not.toMatch(/\beval\s*\(/);
  });

  test('built bundle has no new Function() call', () => {
    const dist = readFileSync(DIST_JS, 'utf-8');
    expect(dist).not.toMatch(/\bnew\s+Function\s*\(/);
  });

  test('built bundle has no Function("…") string-constructor call', () => {
    const dist = readFileSync(DIST_JS, 'utf-8');
    // Catches Function("return this") and similar patterns
    expect(dist).not.toMatch(/\bFunction\s*\(\s*['"`]/);
  });
});
