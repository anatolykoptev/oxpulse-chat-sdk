/**
 * tsc-dist version guard — npm consumer safety.
 *
 * Verifies that the tsc (npm) build output does NOT contain a bare
 * `__WIDGET_VERSION__` identifier. Without the `typeof` guard added in
 * element.ts / iframe.ts, tsc emits `const WIDGET_VERSION = __WIDGET_VERSION__;`
 * verbatim, which causes `ReferenceError: __WIDGET_VERSION__ is not defined`
 * when an npm consumer imports the package without esbuild define substitution.
 *
 * Falsification: revert element.ts:27 back to
 *   `const WIDGET_VERSION = __WIDGET_VERSION__;`
 * (removing the `typeof` guard), rebuild with `pnpm build`, and this test
 * fails — dist/element.js will contain the bare identifier.
 *
 * Prerequisite: run `pnpm --filter @oxpulse/chat-widget build` before this test.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../dist');

const elementDistPath = path.join(distDir, 'element.js');
const iframeDistPath = path.join(distDir, 'iframe.js');

describe('tsc npm dist — __WIDGET_VERSION__ guard', () => {
  let elementDist = '';
  let iframeDist = '';

  beforeAll(() => {
    if (!fs.existsSync(elementDistPath)) {
      throw new Error(
        `dist/element.js not found — run \`pnpm --filter @oxpulse/chat-widget build\` first.`
      );
    }
    if (!fs.existsSync(iframeDistPath)) {
      throw new Error(
        `dist/iframe.js not found — run \`pnpm --filter @oxpulse/chat-widget build\` first.`
      );
    }
    elementDist = fs.readFileSync(elementDistPath, 'utf8');
    iframeDist = fs.readFileSync(iframeDistPath, 'utf8');
  });

  it('dist/element.js: no bare __WIDGET_VERSION__ identifier (would ReferenceError on import)', () => {
    // A bare `__WIDGET_VERSION__` (not inside `typeof`) would crash npm consumers.
    // The typeof guard must appear so the fallback '0.0.0-dev' takes effect when
    // no bundler substitution is present.
    //
    // Matches the bare reference but NOT the typeof guard pattern.
    // typeof __WIDGET_VERSION__ !== "undefined" ? __WIDGET_VERSION__ : ... is safe;
    // we check that the guard form is present and the unsafe bare assignment is absent.
    expect(elementDist).not.toMatch(/=\s*__WIDGET_VERSION__\s*;/);
  });

  it('dist/element.js: typeof guard present (fallback wired)', () => {
    expect(elementDist).toContain('typeof __WIDGET_VERSION__');
  });

  it('dist/iframe.js: no bare __WIDGET_VERSION__ identifier (would ReferenceError on import)', () => {
    expect(iframeDist).not.toMatch(/=\s*__WIDGET_VERSION__\s*;/);
  });

  it('dist/iframe.js: typeof guard present (fallback wired)', () => {
    expect(iframeDist).toContain('typeof __WIDGET_VERSION__');
  });

  it('dist/element.js: fallback "0.0.0-dev" present (guard has a value)', () => {
    expect(elementDist).toContain('0.0.0-dev');
  });

  it('dist/iframe.js: fallback "0.0.0-dev" present (guard has a value)', () => {
    expect(iframeDist).toContain('0.0.0-dev');
  });
});
