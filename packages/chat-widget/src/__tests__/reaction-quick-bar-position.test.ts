/**
 * reaction-quick-bar-position.test.ts — TDD RED phase (reactions quick-bar
 * redesign, reuse-update pass 2026-07-14).
 *
 * Tests: computeQuickBarPosition — pure above/below flip + own-message
 * right-anchor decision, ported from oxpulse-chat web's
 * `web/src/lib/chat/reactions/message-actions-helpers.ts::computePopoverPosition`
 * (same algorithm: above-preferred, flip below when insufficient room,
 * own messages anchor by right edge). The bar's own left/right viewport
 * width-clamp (F2/4C/DM3) is a SEPARATE, pre-existing concern layered on
 * top of this decision inside ReactionQuickBar#position — not ported here.
 */

import { describe, it, expect } from 'vitest';
import { computeQuickBarPosition } from '../utils/reaction-quick-bar-position.js';

describe('computeQuickBarPosition', () => {
  it('places_above_when_there_is_room', () => {
    const pos = computeQuickBarPosition({
      anchorRect: { top: 300, bottom: 340, left: 50, right: 150 },
      barHeight: 60,
      viewportTop: 0,
      isOwn: false,
    });
    expect(pos.placement).toBe('above');
    // top - barHeight - gap(8) = 300 - 60 - 8 = 232
    expect(pos.top).toBe(232);
  });

  it('flips_below_when_there_is_not_enough_room_above', () => {
    const pos = computeQuickBarPosition({
      anchorRect: { top: 20, bottom: 60, left: 50, right: 150 },
      barHeight: 60,
      viewportTop: 0,
      isOwn: false,
    });
    expect(pos.placement).toBe('below');
    // bottom + gap(8) = 60 + 8 = 68
    expect(pos.top).toBe(68);
  });

  it('uses_the_default_8px_gap', () => {
    const pos = computeQuickBarPosition({
      anchorRect: { top: 300, bottom: 340, left: 50, right: 150 },
      barHeight: 60,
      viewportTop: 0,
      isOwn: false,
    });
    const withExplicitGap = computeQuickBarPosition({
      anchorRect: { top: 300, bottom: 340, left: 50, right: 150 },
      barHeight: 60,
      viewportTop: 0,
      isOwn: false,
      gap: 8,
    });
    expect(pos.top).toBe(withExplicitGap.top);
  });

  it('respects_a_custom_gap', () => {
    const pos = computeQuickBarPosition({
      anchorRect: { top: 300, bottom: 340, left: 50, right: 150 },
      barHeight: 60,
      viewportTop: 0,
      isOwn: false,
      gap: 20,
    });
    expect(pos.top).toBe(300 - 60 - 20);
  });

  it('accounts_for_a_nonzero_viewportTop_scroll_offset', () => {
    // Room-above test is anchorRect.top - viewportTop >= barHeight + gap.
    // Same raw anchorRect.top as the flip-below case, but a smaller
    // viewportTop restores enough apparent room to place above.
    const pos = computeQuickBarPosition({
      anchorRect: { top: 100, bottom: 140, left: 50, right: 150 },
      barHeight: 60,
      viewportTop: 20,
      isOwn: false,
    });
    // 100 - 20 = 80 >= 60 + 8 (68) → room above
    expect(pos.placement).toBe('above');
  });

  it('other_message_anchors_by_left_edge', () => {
    const pos = computeQuickBarPosition({
      anchorRect: { top: 300, bottom: 340, left: 50, right: 150 },
      barHeight: 60,
      viewportTop: 0,
      isOwn: false,
    });
    expect(pos.left).toBe(50);
    expect(pos.right).toBeUndefined();
  });

  it('own_message_anchors_by_right_edge', () => {
    const pos = computeQuickBarPosition({
      anchorRect: { top: 300, bottom: 340, left: 50, right: 150 },
      barHeight: 60,
      viewportTop: 0,
      isOwn: true,
    });
    expect(pos.right).toBe(150);
    expect(pos.left).toBeUndefined();
  });
});
