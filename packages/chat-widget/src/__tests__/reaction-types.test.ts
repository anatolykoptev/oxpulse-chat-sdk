/**
 * reaction-types.test.ts — TDD RED phase (W2.2 slice 3)
 *
 * Ported from web/src/lib/chat/reactions/ReactionCluster.test.ts (cluster helpers part)
 * and adds coverage for reaction-types utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  REACTION_EMOJIS,
  HEART_EMOJI,
  isOwnReaction,
  reactionAriaLabel,
  reactionButtonAriaLabel,
} from '../utils/reaction-types.js';

describe('REACTION_EMOJIS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(REACTION_EMOJIS)).toBe(true);
    expect(REACTION_EMOJIS.length).toBeGreaterThan(0);
  });

  it('contains exactly 6 emojis matching the standard set', () => {
    expect(REACTION_EMOJIS.length).toBe(6);
  });

  it('includes thumbs up', () => {
    expect(REACTION_EMOJIS).toContain('\u{1F44D}');
  });

  it('includes heart', () => {
    expect(REACTION_EMOJIS).toContain('❤️');
  });

  it('HEART_EMOJI is the same heart the set contains — the heart-first tap target never drifts from the shared set', () => {
    expect(HEART_EMOJI).toBe('❤️');
    expect(REACTION_EMOJIS).toContain(HEART_EMOJI);
  });

  it('includes fire', () => {
    expect(REACTION_EMOJIS).toContain('\u{1F525}');
  });
});

describe('isOwnReaction', () => {
  it('returns false for undefined ownReactions', () => {
    expect(isOwnReaction('👍', undefined)).toBe(false);
  });

  it('returns false for empty ownReactions', () => {
    expect(isOwnReaction('👍', [])).toBe(false);
  });

  it('returns true when emoji is in ownReactions', () => {
    expect(isOwnReaction('\u{1F44D}', ['\u{1F44D}', '❤️'])).toBe(true);
  });

  it('returns false when emoji is not in ownReactions', () => {
    expect(isOwnReaction('\u{1F525}', ['\u{1F44D}', '❤️'])).toBe(false);
  });

  it('returns true for single-element match', () => {
    expect(isOwnReaction('❤️', ['❤️'])).toBe(true);
  });
});

describe('reactionAriaLabel', () => {
  it('returns a string starting with "React with"', () => {
    const label = reactionAriaLabel('\u{1F44D}');
    expect(label).toMatch(/^React with/);
  });

  it('returns "React with thumbs up" for 👍', () => {
    expect(reactionAriaLabel('\u{1F44D}')).toBe('React with thumbs up');
  });

  it('returns "React with heart" for ❤️', () => {
    expect(reactionAriaLabel('❤️')).toBe('React with heart');
  });

  it('returns "React with fire" for 🔥', () => {
    expect(reactionAriaLabel('\u{1F525}')).toBe('React with fire');
  });

  it('returns "React with emoji" for unknown emoji', () => {
    expect(reactionAriaLabel('🦄')).toBe('React with emoji');
  });

  // i18n follow-up: lang defaults to 'en' (all assertions above stay green
  // unchanged); lang='ru' localizes the same emoji set.
  it('returns the Russian label for lang="ru"', () => {
    expect(reactionAriaLabel('\u{1F44D}', 'ru')).toBe('Реакция «палец вверх»');
    expect(reactionAriaLabel('❤️', 'ru')).toBe('Реакция «сердце»');
  });

  it('falls back to the Russian "emoji" label for an unknown emoji in ru', () => {
    expect(reactionAriaLabel('🦄', 'ru')).toBe('Реакция «эмодзи»');
  });
});

describe('reactionButtonAriaLabel', () => {
  it('composes emoji + singular count in English', () => {
    expect(reactionButtonAriaLabel('❤️', 1, false)).toBe('React with heart, 1 reaction');
  });

  it('composes emoji + plural count in English', () => {
    expect(reactionButtonAriaLabel('❤️', 3, false)).toBe('React with heart, 3 reactions');
  });

  it('appends the "you reacted" suffix when isOwn', () => {
    expect(reactionButtonAriaLabel('❤️', 3, true)).toBe('React with heart, 3 reactions, you reacted');
  });

  it('applies Russian grammatical plural forms (1 / 2-4 / 5+)', () => {
    expect(reactionButtonAriaLabel('❤️', 1, false, 'ru')).toBe('Реакция «сердце», 1 реакция');
    expect(reactionButtonAriaLabel('❤️', 3, false, 'ru')).toBe('Реакция «сердце», 3 реакции');
    expect(reactionButtonAriaLabel('❤️', 5, false, 'ru')).toBe('Реакция «сердце», 5 реакций');
  });

  it('applies the ru 11-14 exception (mod-100 wins over mod-10)', () => {
    expect(reactionButtonAriaLabel('❤️', 11, false, 'ru')).toBe('Реакция «сердце», 11 реакций');
    expect(reactionButtonAriaLabel('❤️', 21, false, 'ru')).toBe('Реакция «сердце», 21 реакция');
  });

  it('appends the Russian "you reacted" suffix when isOwn', () => {
    expect(reactionButtonAriaLabel('❤️', 3, true, 'ru')).toBe('Реакция «сердце», 3 реакции, вы отреагировали');
  });
});
