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
import { generateUUID, backoffWithJitter, backoffMs } from '../utils.js';

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

/**
 * backoffWithJitter / backoffMs — ADR-009 backoff with ±20% jitter.
 *
 * `backoffWithJitter(attempt, schedule?, fallback?)` is the canonical SDK
 * backoff (mirrors web/src/lib/reconnect-backoff.ts). `backoffMs` is a thin
 * opt-out wrapper delegating to it with the default exponential schedule +
 * 30 s fallback. These tests pin the schedule lookup, fallback, jitter
 * bounds, custom-schedule passthrough, and the backward-compatible
 * `backoffMs` regression contract.
 */

/** ±20% jitter window for a base value: [base*0.8, base*1.2]. */
function jitterWindow(base: number): [number, number] {
  return [Math.round(base * 0.8), Math.round(base * 1.2)];
}

describe('backoffWithJitter (ADR-009)', () => {
  it('schedule lookup: attempt 0 → ~1000±20%, attempt 5 → ~30000±20%', () => {
    const [min0, max0] = jitterWindow(1000);
    const r0 = backoffWithJitter(0);
    expect(r0).toBeGreaterThanOrEqual(min0);
    expect(r0).toBeLessThanOrEqual(max0);

    const [min5, max5] = jitterWindow(30000);
    const r5 = backoffWithJitter(5);
    expect(r5).toBeGreaterThanOrEqual(min5);
    expect(r5).toBeLessThanOrEqual(max5);
  });

  it('fallback when attempt exceeds schedule length (attempt 10 → ~30000±20%)', () => {
    const [min, max] = jitterWindow(30000);
    const r = backoffWithJitter(10);
    expect(r).toBeGreaterThanOrEqual(min);
    expect(r).toBeLessThanOrEqual(max);
  });

  it('jitter bounds within ±20% across many samples for every schedule slot', () => {
    const schedule = [1000, 2000, 4000, 8000, 16000, 30000];
    for (let attempt = 0; attempt < schedule.length; attempt++) {
      const base = schedule[attempt]!;
      const [min, max] = jitterWindow(base);
      for (let i = 0; i < 50; i++) {
        const r = backoffWithJitter(attempt);
        expect(r).toBeGreaterThanOrEqual(min);
        expect(r).toBeLessThanOrEqual(max);
      }
    }
  });

  it('custom schedule + fallback are honoured', () => {
    const custom = [500, 1500, 5000];
    const customFallback = 9999;

    // attempt 0 → base 500
    const [min0, max0] = jitterWindow(500);
    const r0 = backoffWithJitter(0, custom, customFallback);
    expect(r0).toBeGreaterThanOrEqual(min0);
    expect(r0).toBeLessThanOrEqual(max0);

    // attempt 2 → base 5000
    const [min2, max2] = jitterWindow(5000);
    const r2 = backoffWithJitter(2, custom, customFallback);
    expect(r2).toBeGreaterThanOrEqual(min2);
    expect(r2).toBeLessThanOrEqual(max2);

    // attempt 3 → exceeds schedule → custom fallback 9999
    const [minF, maxF] = jitterWindow(customFallback);
    const rF = backoffWithJitter(3, custom, customFallback);
    expect(rF).toBeGreaterThanOrEqual(minF);
    expect(rF).toBeLessThanOrEqual(maxF);
  });
});

describe('backoffMs (regression — thin wrapper over backoffWithJitter)', () => {
  it('attempt 0 → ~1000±20% (same range as before refactor)', () => {
    const [min, max] = jitterWindow(1000);
    const r = backoffMs(0);
    expect(r).toBeGreaterThanOrEqual(min);
    expect(r).toBeLessThanOrEqual(max);
  });

  it('caps at 30000 (attempt 10 → ~30000±20%, never exceeds 30000*1.2)', () => {
    const [, max] = jitterWindow(30000);
    for (let i = 0; i < 50; i++) {
      const r = backoffMs(10);
      expect(r).toBeLessThanOrEqual(max);
    }
  });

  it('jitter ±20% across the full escalation curve', () => {
    const bases = [1000, 2000, 4000, 8000, 16000, 30000];
    for (let attempt = 0; attempt < bases.length; attempt++) {
      const [min, max] = jitterWindow(bases[attempt]!);
      for (let i = 0; i < 25; i++) {
        const r = backoffMs(attempt);
        expect(r).toBeGreaterThanOrEqual(min);
        expect(r).toBeLessThanOrEqual(max);
      }
    }
  });
});
