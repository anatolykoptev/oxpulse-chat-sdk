import { describe, it, expect } from 'vitest';
import { t, resolveLocale, lookupWithFallback, SUPPORTED_LOCALES, type Locale, type LocaleKey } from '../utils/i18n.js';

// Single source of truth for "every key" tests below — keep this in lockstep
// with the LocaleKey union in ../utils/i18n.ts. Shared by both tests so a new
// key can't silently skip one of the two exhaustiveness checks (code-review
// finding: a hand-maintained subset had drifted and missed ~16 keys).
const ALL_LOCALE_KEYS: LocaleKey[] = [
  'tombstone', 'unsealError', 'unsealErrorAria', 'senderYou', 'bubbleAriaLabel',
  'addReactionAria', 'retryLoadingMessagesAria', 'retry',
  'reactionsGroupAria', 'chooseReactionAria', 'youReactedSuffix',
  'composerPlaceholder', 'messageInputAria', 'sendMessageAria', 'send',
  'messageEmpty', 'sendingMessage', 'messageExceedsLimit', 'charactersRemaining',
  'retrySendingMessageAria', 'attachFilesAria',
  'chooseFilesToAttachAria', 'cancelUploadOfAria', 'uploadingProgressAria',
  'announceUploadingFile', 'announceFileUploaded', 'announceUploadFailedFile',
  'uploadFailed', 'queueUploadingCount', 'queueDoneCount', 'queueFailedCount',
  'attachmentUnavailableAria', 'imageAria', 'audioAria', 'fileAria',
  'sessionExpired', 'refresh', 'refreshSessionAria', 'connectionLostReconnecting',
  'connected', 'couldNotReconnect', 'reconnect', 'retryConnectionManuallyAria',
  'chatLoading',
  'roleBadgeModerator', 'roleBadgeOwner',
];

describe('lookupWithFallback', () => {
  it('returns the requested table value when present', () => {
    expect(lookupWithFallback({ greet: 'hi' }, { greet: 'hello' }, 'greet')).toBe('hi');
  });

  it('falls back to the fallback table when the key is missing from the requested table', () => {
    // Simulates translation drift: a new key shipped in `en` before its `ru`
    // row landed. Tested against fixture tables, independent of the
    // production data (which is always fully translated).
    expect(lookupWithFallback({}, { greet: 'hello' }, 'greet')).toBe('hello');
  });

  it('falls back to the raw key when missing from both tables (never returns undefined)', () => {
    expect(lookupWithFallback({}, {}, 'greet')).toBe('greet');
  });
});

describe('resolveLocale', () => {
  it('resolves an exact "ru" tag to ru', () => {
    expect(resolveLocale('ru')).toBe('ru');
  });

  it('resolves a regional "ru-RU" tag to ru (primary subtag match)', () => {
    expect(resolveLocale('ru-RU')).toBe('ru');
  });

  it('resolves an explicit "en" tag to en', () => {
    expect(resolveLocale('en')).toBe('en');
  });

  it('is case-insensitive on the primary subtag', () => {
    expect(resolveLocale('RU-ru')).toBe('ru');
  });

  it('falls back to en for an unsupported tag', () => {
    expect(resolveLocale('fr-FR')).toBe('en');
  });

  it('falls back to navigator.language when no override is given (jsdom default en-US)', () => {
    expect(resolveLocale(undefined)).toBe('en');
  });

  it('falls back to en for null', () => {
    expect(resolveLocale(null)).toBe('en');
  });

  it('SUPPORTED_LOCALES lists exactly en and ru', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'ru']);
  });
});

describe('t', () => {
  it('returns the English string for a known key', () => {
    expect(t('tombstone', 'en')).toBe('This message was deleted');
  });

  it('returns the Russian string for a known key', () => {
    expect(t('tombstone', 'ru')).toBe('Это сообщение удалено');
  });

  it('substitutes a single {placeholder}', () => {
    expect(t('charactersRemaining', 'en', { remaining: 5 })).toBe('5 characters remaining');
  });

  it('substitutes multiple {placeholders}', () => {
    expect(t('bubbleAriaLabel', 'en', { sender: 'Alice', time: '10:00', body: 'hi' }))
      .toBe('Message from Alice at 10:00: hi');
  });

  it('leaves an unmatched {placeholder} untouched rather than throwing', () => {
    expect(t('cancelUploadOfAria', 'en', {})).toBe('Cancel upload of {name}');
  });

  it('falls back to English when given a locale outside the closed Locale union', () => {
    // Cast bypasses the type system deliberately — Locale is a closed 'en'|'ru'
    // union, so this path is reachable only via an unsafe cast (e.g. a caller
    // that skipped resolveLocale()). Proves t() never throws on it.
    const unsupported = 'fr' as unknown as Locale;
    expect(t('tombstone', unsupported)).toBe('This message was deleted');
  });

  it('every LocaleKey used by t() resolves to a non-empty string in both locales', () => {
    for (const lang of SUPPORTED_LOCALES) {
      for (const key of ALL_LOCALE_KEYS) {
        expect(t(key, lang), `${lang}.${key}`).not.toBe('');
        expect(t(key, lang), `${lang}.${key} should not echo the raw key (missing translation)`).not.toBe(key);
      }
    }
  });

  it('en and ru render different text for every key (no untranslated copy-paste row)', () => {
    for (const key of ALL_LOCALE_KEYS) {
      expect(t(key, 'en'), key).not.toBe(t(key, 'ru'));
    }
  });
});
