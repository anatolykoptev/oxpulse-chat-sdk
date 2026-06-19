/**
 * CDN bundle smoke tests.
 *
 * These tests run AFTER `build:cdn` produces dist-cdn/index.js — they
 * verify the built artifact rather than TypeScript sources. The test file
 * is intentionally in src/__tests__/ so vitest picks it up.
 *
 * Falsification guarantee: reverting the `__WIDGET_VERSION__` define in
 * esbuild.cdn.mjs (or leaving WIDGET_VERSION = '0.1.0' in element.ts / iframe.ts)
 * causes these tests to fail — either the stale string appears or the injected
 * version is absent.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '../../package.json');
const bundlePath = path.resolve(__dirname, '../../dist-cdn/index.js');

// Read the expected version from package.json (source of truth).
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version: string };

describe('CDN bundle (dist-cdn/index.js)', () => {
  let bundle = '';

  beforeAll(() => {
    if (!fs.existsSync(bundlePath)) {
      throw new Error(
        `dist-cdn/index.js not found — run \`pnpm --filter @oxpulse/chat-widget build:cdn\` first.`
      );
    }
    bundle = fs.readFileSync(bundlePath, 'utf8');
  });

  it('contains the package.json version (version injected correctly)', () => {
    expect(bundle).toContain(pkg.version);
  });

  it('does NOT contain the stale hardcoded 0.1.0 version', () => {
    // This fails if WIDGET_VERSION = '0.1.0' was NOT replaced with __WIDGET_VERSION__
    // in element.ts or iframe.ts, or if the esbuild define was removed.
    expect(bundle).not.toContain('0.1.0');
  });

  it('references zstd.wasm as a relative sibling (not inlined)', () => {
    // The bundle must contain the relative URL so the browser fetches the wasm
    // from the CDN version directory — NOT a base64 data URL.
    expect(bundle).toContain('./zstd.wasm');
    expect(bundle).not.toMatch(/data:application\/wasm/);
  });

  it('defines <oxpulse-chat> via customElements (side-effect entry present)', () => {
    // src/index.ts calls _defineElement() which calls customElements.define().
    // If the side-effect was tree-shaken or the entry was wrong, this fails.
    expect(bundle).toContain('customElements');
  });
});
