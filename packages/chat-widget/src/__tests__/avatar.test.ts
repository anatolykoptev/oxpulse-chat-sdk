/**
 * avatar.test.ts — T18-avatar pure helpers + DOM factory.
 *
 * Covers:
 *   1. avatarInitials — 1-word, 2-word, extra whitespace, empty, unicode.
 *   2. avatarColor — deterministic, valid hsl, differs across seeds.
 *   3. createAvatarElement — <img> for http(s) url (src+alt via property),
 *      initials fallback for null, onerror → initials, javascript: rejected.
 */

import { describe, it, expect } from 'vitest';
import { avatarInitials, avatarColor, createAvatarElement } from '../ui/avatar.js';

describe('avatarInitials', () => {
  it('single word → first letter uppercased', () => {
    expect(avatarInitials('alice')).toBe('A');
  });
  it('two words → first letters of first and last', () => {
    expect(avatarInitials('Bob Smith')).toBe('BS');
  });
  it('extra whitespace collapses', () => {
    expect(avatarInitials('  carol   danvers  ')).toBe('CD');
  });
  it('empty → placeholder', () => {
    expect(avatarInitials('')).toBe('?');
    expect(avatarInitials('   ')).toBe('?');
  });
  it('unicode name → first code point (Cyrillic)', () => {
    expect(avatarInitials('Анатолий')).toBe('А');
  });
});

describe('avatarColor', () => {
  it('is deterministic for the same seed', () => {
    expect(avatarColor('ep_abc')).toBe(avatarColor('ep_abc'));
  });
  it('returns a well-formed hsl() string', () => {
    expect(avatarColor('ep_xyz')).toMatch(/^hsl\(\d{1,3}, 55%, 42%\)$/);
  });
  it('differs across distinct seeds (usually)', () => {
    expect(avatarColor('ep_a')).not.toBe(avatarColor('ep_zzzzz'));
  });
});

describe('createAvatarElement', () => {
  it('http(s) url → <img> with src + alt set via property', () => {
    const el = createAvatarElement({ name: 'Alice', avatarUrl: 'https://cdn.example.com/a.png', seed: 'ep_a' });
    const img = el.querySelector('img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('https://cdn.example.com/a.png');
    expect(img!.alt).toBe('Alice');
    // Container is not aria-hidden when it carries a labelled image.
    expect(el.getAttribute('aria-hidden')).toBeNull();
  });

  it('null url → initials circle, decorative (aria-hidden)', () => {
    const el = createAvatarElement({ name: 'Bob Smith', avatarUrl: null, seed: 'ep_b' });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('BS');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.style.backgroundColor).not.toBe('');
  });

  it('image error → swaps to initials fallback', () => {
    const el = createAvatarElement({ name: 'Carol', avatarUrl: 'https://cdn.example.com/x.png', seed: 'ep_c' });
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img).not.toBeNull();
    img.dispatchEvent(new Event('error'));
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('C');
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('javascript: url is rejected client-side → initials, no <img>', () => {
    const el = createAvatarElement({ name: 'Mallory', avatarUrl: 'javascript:alert(1)', seed: 'ep_m' });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('M');
  });

  it('data: url is rejected client-side → initials, no <img>', () => {
    const el = createAvatarElement({ name: 'Dave', avatarUrl: 'data:image/png;base64,AAAA', seed: 'ep_d' });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toBe('D');
  });
});
