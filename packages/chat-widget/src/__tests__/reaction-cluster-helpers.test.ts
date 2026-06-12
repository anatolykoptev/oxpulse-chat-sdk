/**
 * reaction-cluster-helpers.test.ts — TDD RED phase (W2.2 slice 3)
 *
 * Ported from web/src/lib/chat/reactions/ReactionCluster.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  shouldRenderCluster,
  isOwnChip,
  chipLabel,
  type ReactionTuple,
} from '../utils/reaction-cluster-helpers.js';

describe('shouldRenderCluster', () => {
  it('returns false for empty reactions', () => {
    expect(shouldRenderCluster([])).toBe(false);
  });

  it('returns true with one or more reactions', () => {
    const tuple: ReactionTuple = ['\u{1F44D}', ['peer-a']];
    expect(shouldRenderCluster([tuple])).toBe(true);
  });

  it('returns true with multiple reactions', () => {
    const t1: ReactionTuple = ['\u{1F44D}', ['peer-a']];
    const t2: ReactionTuple = ['❤️', ['peer-b', 'peer-c']];
    expect(shouldRenderCluster([t1, t2])).toBe(true);
  });
});

describe('isOwnChip', () => {
  it('returns false when selfPeerId is empty', () => {
    const tuple: ReactionTuple = ['\u{1F44D}', ['peer-a']];
    expect(isOwnChip(tuple, '')).toBe(false);
  });

  it('returns true when selfPeerId is in the peer list', () => {
    const tuple: ReactionTuple = ['\u{1F44D}', ['peer-a', 'self']];
    expect(isOwnChip(tuple, 'self')).toBe(true);
  });

  it('returns false when selfPeerId is absent', () => {
    const tuple: ReactionTuple = ['\u{1F44D}', ['peer-a']];
    expect(isOwnChip(tuple, 'self')).toBe(false);
  });

  it('returns false when peer list is empty', () => {
    const tuple: ReactionTuple = ['\u{1F44D}', []];
    expect(isOwnChip(tuple, 'self')).toBe(false);
  });
});

describe('chipLabel', () => {
  it('formats emoji + count with a single space', () => {
    const tuple: ReactionTuple = ['❤️', ['a', 'b']];
    expect(chipLabel(tuple)).toBe('❤️ 2');
  });

  it('formats single-peer count as 1', () => {
    const tuple: ReactionTuple = ['\u{1F525}', ['only']];
    expect(chipLabel(tuple)).toBe('\u{1F525} 1');
  });

  it('formats zero peers as 0', () => {
    const tuple: ReactionTuple = ['\u{1F44D}', []];
    expect(chipLabel(tuple)).toBe('\u{1F44D} 0');
  });
});
