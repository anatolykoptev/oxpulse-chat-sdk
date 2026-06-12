/**
 * reaction-types.test.ts — TDD RED phase (W2.2 slice 3)
 *
 * Ported from web/src/lib/chat/reactions/ReactionCluster.test.ts (cluster helpers part)
 * and adds coverage for reaction-types utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  REACTION_EMOJIS,
  isOwnReaction,
  reactionAriaLabel,
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
});
