/**
 * role-badge.test.ts — P5 roster privileged-role badge.
 *
 * Covers:
 *   1. roleBadgeLabel — i18n default per role/lang, config override wins,
 *      empty/non-string override falls back to the i18n default.
 *   2. createRoleBadgeElement — label via textContent (XSS-safe), data-role
 *      attribute, class name.
 */

import { describe, it, expect } from 'vitest';
import { roleBadgeLabel, createRoleBadgeElement } from '../ui/role-badge.js';

describe('roleBadgeLabel', () => {
  it('moderator, en, no override → "mod"', () => {
    expect(roleBadgeLabel({ role: 'moderator', lang: 'en' })).toBe('mod');
  });

  it('owner, en, no override → "owner"', () => {
    expect(roleBadgeLabel({ role: 'owner', lang: 'en' })).toBe('owner');
  });

  it('moderator, ru, no override → localized label', () => {
    expect(roleBadgeLabel({ role: 'moderator', lang: 'ru' })).toBe('модератор');
  });

  it('config override wins over the i18n default', () => {
    expect(
      roleBadgeLabel({ role: 'moderator', lang: 'en', roleLabels: { moderator: 'Seller' } }),
    ).toBe('Seller');
  });

  it('override for a different role does not affect this one — falls back to i18n', () => {
    expect(
      roleBadgeLabel({ role: 'owner', lang: 'en', roleLabels: { moderator: 'Seller' } }),
    ).toBe('owner');
  });

  it('empty-string override falls back to the i18n default', () => {
    expect(
      roleBadgeLabel({ role: 'moderator', lang: 'en', roleLabels: { moderator: '' } }),
    ).toBe('mod');
  });
});

describe('createRoleBadgeElement', () => {
  it('renders the label via textContent (XSS-safe) and carries data-role', () => {
    const el = createRoleBadgeElement({ role: 'owner', lang: 'en' });
    expect(el.className).toBe('oxp-role-badge');
    expect(el.getAttribute('data-role')).toBe('owner');
    expect(el.textContent).toBe('owner');
  });

  it('a <script>-bearing override renders inert as literal text, never parsed', () => {
    const xss = '<script>window.__badgeXssHit=1</script>';
    const el = createRoleBadgeElement({ role: 'moderator', lang: 'en', roleLabels: { moderator: xss } });
    expect(el.textContent).toContain('<script>');
    expect(el.querySelector('script')).toBeNull();
    expect((window as unknown as Record<string, unknown>)['__badgeXssHit']).toBeUndefined();
  });
});
