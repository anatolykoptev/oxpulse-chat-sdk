/**
 * utils.test.ts — F13: generateUUID must fail CLOSED when no CSPRNG is available.
 *
 * generateUUID is a public export used for message ids (and, being public, potentially for
 * nonces / session ids by external consumers). Before the fix it silently fell back to
 * `Math.floor(Math.random() * 256)` — a non-CSPRNG — when both crypto.randomUUID and
 * crypto.getRandomValues were absent. This test pins the fail-closed contract: it THROWS
 * rather than return weak randomness.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { generateUUID } from '../utils.js';

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function setCrypto(value: unknown): void {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true });
}

describe('generateUUID (F13 fail-closed CSPRNG)', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, 'crypto', saved);
  });

  it('throws when neither crypto.randomUUID nor crypto.getRandomValues is available', () => {
    // A runtime exposing `crypto` but without any CSPRNG entry (the old Math.random branch).
    setCrypto({});
    expect(() => generateUUID()).toThrow(/no cryptographically-secure RNG/i);
  });

  it('throws when the global crypto object is entirely absent', () => {
    setCrypto(undefined);
    expect(() => generateUUID()).toThrow(/no cryptographically-secure RNG/i);
  });

  it('positive control: uses crypto.getRandomValues (no randomUUID) and returns a valid v4', () => {
    // Only getRandomValues present → the byte-fill path runs and must produce a well-formed v4.
    setCrypto({
      getRandomValues: (arr: Uint8Array): Uint8Array => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) & 0xff;
        return arr;
      },
    });
    const id = generateUUID();
    expect(id).toMatch(UUID_V4_RE);
  });

  it('positive control: prefers crypto.randomUUID when present', () => {
    const fixed = '11111111-2222-4333-8444-555555555555';
    setCrypto({ randomUUID: (): string => fixed });
    expect(generateUUID()).toBe(fixed);
  });
});
