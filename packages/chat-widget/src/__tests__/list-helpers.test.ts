import { describe, it, expect } from 'vitest';
import { tombstoneText, unsealErrorText, unsealErrorAriaText, isSelf } from '../utils/list-helpers.js';

// i18n wire-in (U2 follow-up): before this change, `tombstoneText` /
// `unsealErrorText` / `unsealErrorAriaText` took no `lang` argument at all —
// the `lang` constructor/attribute option was accepted by the widget but
// never read for strings. These tests are the RED→GREEN proof: run against
// pre-wire-in `main`, the `lang:'ru'` assertions fail (functions ignore the
// argument and always render English).

describe('tombstoneText', () => {
  it('renders English by default', () => {
    expect(tombstoneText('everyone')).toBe('This message was deleted');
  });

  it('renders English for lang="en"', () => {
    expect(tombstoneText('everyone', 'en')).toBe('This message was deleted');
  });

  it('renders Russian for lang="ru"', () => {
    expect(tombstoneText('everyone', 'ru')).toBe('Это сообщение удалено');
  });

  it('falls back to English for an unknown lang', () => {
    expect(tombstoneText('everyone', 'fr' as never)).toBe('This message was deleted');
  });

  it('scope does not change the wording (self vs everyone, same precedent as before)', () => {
    expect(tombstoneText('self', 'ru')).toBe(tombstoneText('everyone', 'ru'));
  });
});

describe('unsealErrorText (visible, with lock glyph)', () => {
  it('renders English by default', () => {
    expect(unsealErrorText()).toBe("\u{1F512} This message couldn't be decrypted");
  });

  it('renders Russian for lang="ru"', () => {
    expect(unsealErrorText('ru')).toBe('\u{1F512} Это сообщение не удалось расшифровать');
  });

  it('falls back to English for an unknown lang', () => {
    expect(unsealErrorText('fr' as never)).toBe("\u{1F512} This message couldn't be decrypted");
  });
});

describe('unsealErrorAriaText (screen-reader variant, no glyph)', () => {
  it('renders English by default', () => {
    expect(unsealErrorAriaText()).toBe("This message couldn't be decrypted");
  });

  it('renders Russian for lang="ru"', () => {
    expect(unsealErrorAriaText('ru')).toBe('Это сообщение не удалось расшифровать');
  });

  it('never includes the lock glyph in either locale (screen readers already announce "locked")', () => {
    expect(unsealErrorAriaText('en')).not.toContain('\u{1F512}');
    expect(unsealErrorAriaText('ru')).not.toContain('\u{1F512}');
  });
});

// isSelf: the single guarded self-identity compare for message-list.ts (independent
// audit, sibling gap to PR #39). Mirrors hasOwnHeart's non-empty guard above — a row
// must never read as "self" merely because both senderUid and selfUid are unresolved
// empty strings.
describe('isSelf', () => {
  it('returns false when both senderUid and selfUid are empty (never false-positive on unresolved identity)', () => {
    expect(isSelf('', '')).toBe(false);
  });

  it('returns false when selfUid is empty, even if senderUid is non-empty', () => {
    expect(isSelf('x', '')).toBe(false);
  });

  it('returns true when senderUid matches a non-empty selfUid', () => {
    expect(isSelf('x', 'x')).toBe(true);
  });

  it('returns false when senderUid and selfUid are both non-empty but differ', () => {
    expect(isSelf('x', 'y')).toBe(false);
  });
});
