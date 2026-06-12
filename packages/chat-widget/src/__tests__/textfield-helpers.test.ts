// TextField pure-helper tests — ported verbatim from
// web/src/lib/chat/composer/textfield-helpers.test.ts.
// Validates the cap-counter threshold, Cmd/Ctrl+Enter detection,
// and autogrow height clamp.

import { describe, it, expect } from 'vitest';
import {
  shouldShowCounter,
  isCmdEnter,
  autogrowHeightPx,
} from '../utils/textfield-helpers.js';

const MAX = 16384;

describe('shouldShowCounter', () => {
  it('returns false when len is well below the threshold', () => {
    expect(shouldShowCounter(0, MAX)).toBe(false);
    expect(shouldShowCounter(100, MAX)).toBe(false);
  });

  it('returns false at the 90 % boundary (strictly greater than)', () => {
    const ninety = Math.floor(MAX * 0.9);
    expect(shouldShowCounter(ninety, MAX)).toBe(false);
  });

  it('returns true once len crosses 90 % of cap', () => {
    const ninety = Math.floor(MAX * 0.9);
    expect(shouldShowCounter(ninety + 1, MAX)).toBe(true);
    expect(shouldShowCounter(MAX, MAX)).toBe(true);
  });

  it('works for arbitrary caps', () => {
    expect(shouldShowCounter(91, 100)).toBe(true);
    expect(shouldShowCounter(90, 100)).toBe(false);
  });
});

describe('isCmdEnter', () => {
  // Construct plain shape — vitest runs these helper tests in node env
  // without DOM. The helper only reads `.key`, `.metaKey`, `.ctrlKey`.
  function ev(init: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }): KeyboardEvent {
    return init as unknown as KeyboardEvent;
  }

  it('returns true for Cmd+Enter (metaKey)', () => {
    expect(isCmdEnter(ev({ key: 'Enter', metaKey: true }))).toBe(true);
  });

  it('returns true for Ctrl+Enter (ctrlKey)', () => {
    expect(isCmdEnter(ev({ key: 'Enter', ctrlKey: true }))).toBe(true);
  });

  it('returns false for plain Enter (no modifier)', () => {
    expect(isCmdEnter(ev({ key: 'Enter' }))).toBe(false);
  });

  it('returns false for Cmd+other-key', () => {
    expect(isCmdEnter(ev({ key: 'a', metaKey: true }))).toBe(false);
  });

  it('returns false for Shift+Enter (shift is not a send modifier)', () => {
    expect(isCmdEnter(ev({ key: 'Enter', shiftKey: true }))).toBe(false);
  });

  it('ignores_cmd_enter_during_ime_composition', () => {
    // isComposing=true (CJK composition) must suppress the shortcut
    const composingEv = { key: 'Enter', metaKey: true, isComposing: true } as unknown as KeyboardEvent;
    expect(isCmdEnter(composingEv)).toBe(false);
  });

  it('ignores_cmd_enter_when_keyCode_229', () => {
    // keyCode 229 = IME processing key on some browsers
    const imeEv = { key: 'Enter', metaKey: true, isComposing: false, keyCode: 229 } as unknown as KeyboardEvent;
    expect(isCmdEnter(imeEv)).toBe(false);
  });
});

describe('autogrowHeightPx', () => {
  it('returns scrollHeight when below the cap', () => {
    expect(autogrowHeightPx(40, 144)).toBe(40);
  });

  it('clamps at the cap', () => {
    expect(autogrowHeightPx(200, 144)).toBe(144);
  });

  it('returns 0 when scrollHeight is 0', () => {
    expect(autogrowHeightPx(0, 144)).toBe(0);
  });

  it('returns the cap when scrollHeight equals cap', () => {
    expect(autogrowHeightPx(144, 144)).toBe(144);
  });
});
