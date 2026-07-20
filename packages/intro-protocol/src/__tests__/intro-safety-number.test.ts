import { describe, it, expect } from 'vitest';
import { deriveSafetyNumber } from '../intro-safety-number.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePubkey(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i * 7) & 0xff;
  return bytes;
}

// ---------------------------------------------------------------------------
// deriveSafetyNumber
// ---------------------------------------------------------------------------

describe('deriveSafetyNumber', () => {
  it('produces a 60-digit string in 12 groups of 5 separated by spaces', () => {
    const sn = deriveSafetyNumber(makePubkey(1), makePubkey(2), new Uint8Array(32));
    const digits = sn.replace(/ /g, '');
    expect(digits.length).toBe(60);
    expect(/^\d+$/.test(digits)).toBe(true);
    const groups = sn.split(' ');
    expect(groups.length).toBe(12);
    for (const g of groups) expect(g.length).toBe(5);
  });

  it('is symmetric: swap(alice, bob) → identical output', () => {
    const alice = makePubkey(1);
    const bob = makePubkey(2);
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    expect(deriveSafetyNumber(alice, bob, mk)).toBe(deriveSafetyNumber(bob, alice, mk));
  });

  it('is deterministic for the same inputs', () => {
    const alice = makePubkey(1);
    const bob = makePubkey(2);
    const mk = new Uint8Array(32);
    for (let i = 0; i < 32; i++) mk[i] = i;
    expect(deriveSafetyNumber(alice, bob, mk)).toBe(deriveSafetyNumber(alice, bob, mk));
  });

  it('differs when the master key changes', () => {
    const alice = makePubkey(1);
    const bob = makePubkey(2);
    const mk1 = new Uint8Array(32);
    const mk2 = new Uint8Array(32);
    mk2[0] = 1;
    expect(deriveSafetyNumber(alice, bob, mk1)).not.toBe(deriveSafetyNumber(alice, bob, mk2));
  });

  it('differs when a pubkey changes', () => {
    const mk = new Uint8Array(32);
    const a = makePubkey(1);
    const b = makePubkey(2);
    const c = makePubkey(3);
    expect(deriveSafetyNumber(a, b, mk)).not.toBe(deriveSafetyNumber(a, c, mk));
  });

  it('produces a stable, known format (12 groups, all numeric)', () => {
    const sn = deriveSafetyNumber(makePubkey(100), makePubkey(200), new Uint8Array(32).fill(0xab));
    expect(sn).toMatch(/^\d{5}( \d{5}){11}$/);
  });
});
