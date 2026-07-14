/**
 * auth.test.ts — TDD RED phase (W2.2 slice 5)
 *
 * Tests: isAuthError() helper in utils/auth.ts
 */

import { describe, it, expect } from 'vitest';
import { isAuthError, classifyWriteFailureReason } from '../utils/auth.js';

describe('isAuthError', () => {
  it('detects_err_status_401', () => {
    expect(isAuthError({ status: 401 })).toBe(true);
  });

  it('detects_err_status_403', () => {
    expect(isAuthError({ status: 403 })).toBe(true);
  });

  it('detects_message_token_expired', () => {
    expect(isAuthError({ message: 'token expired' })).toBe(true);
  });

  it('detects_message_expired_case_insensitive', () => {
    expect(isAuthError({ message: 'JWT Token Expired' })).toBe(true);
  });

  it('detects_message_invalid_token', () => {
    expect(isAuthError({ message: 'invalid token' })).toBe(true);
  });

  it('detects_message_unauthorized', () => {
    expect(isAuthError({ message: 'unauthorized' })).toBe(true);
  });

  it('detects_kind_auth_expired', () => {
    expect(isAuthError({ kind: 'auth_expired' })).toBe(true);
  });

  it('rejects_network_error_status_0', () => {
    expect(isAuthError({ status: 0 })).toBe(false);
  });

  it('rejects_status_500', () => {
    expect(isAuthError({ status: 500 })).toBe(false);
  });

  it('rejects_validation_error', () => {
    expect(isAuthError({ status: 422, message: 'validation failed' })).toBe(false);
  });

  it('rejects_null', () => {
    expect(isAuthError(null)).toBe(false);
  });

  it('rejects_undefined', () => {
    expect(isAuthError(undefined)).toBe(false);
  });

  it('rejects_plain_string', () => {
    expect(isAuthError('some error')).toBe(false);
  });

  it('rejects_network_kind', () => {
    expect(isAuthError({ kind: 'network', status: 0 })).toBe(false);
  });

  // ── CM6: tighten patterns — false-positive cases ─────────────────────────────

  it('rejects_session_expired_cache_false_positive', () => {
    // "expired" substring too broad — "this session expired (cache)" is NOT an auth error
    expect(isAuthError({ message: 'this session expired (cache)' })).toBe(false);
  });

  it('rejects_offer_expired_false_positive', () => {
    // "expired" substring matches "offer expired" — must NOT be auth error
    expect(isAuthError({ message: 'offer expired' })).toBe(false);
  });

  it('rejects_expiry_in_context_false_positive', () => {
    // "subscription will expire soon" — NOT an auth error
    expect(isAuthError({ message: 'subscription will expire soon' })).toBe(false);
  });

  it('still_detects_token_expired_with_word_boundary', () => {
    expect(isAuthError({ message: 'token expired' })).toBe(true);
  });

  it('still_detects_jwt_expired', () => {
    expect(isAuthError({ message: 'jwt expired' })).toBe(true);
  });

  it('still_detects_authentication_failed', () => {
    expect(isAuthError({ message: 'authentication failed' })).toBe(true);
  });

  it('still_detects_authentication_required', () => {
    expect(isAuthError({ message: 'authentication required' })).toBe(true);
  });

  it('still_detects_invalid_token_with_boundary', () => {
    expect(isAuthError({ message: 'invalid token provided' })).toBe(true);
  });

  // ── Write-401 fix (issue #78): isAuthError absorbs the raw SDKChatError
  // shape (statusCode/code) directly, so call sites no longer hand-build a
  // { status, kind } bridge object before calling this (that bridging used
  // to live only in element.ts's handleSubscribeError; extended here rather
  // than copied a 2nd/3rd time into message-list.ts + the composer wiring).

  it('detects_statusCode_401', () => {
    expect(isAuthError({ statusCode: 401 })).toBe(true);
  });

  it('detects_statusCode_403', () => {
    expect(isAuthError({ statusCode: 403 })).toBe(true);
  });

  it('detects_code_unauthorized', () => {
    expect(isAuthError({ code: 'unauthorized' })).toBe(true);
  });

  it('detects_code_forbidden', () => {
    expect(isAuthError({ code: 'forbidden' })).toBe(true);
  });

  it('rejects_code_network', () => {
    expect(isAuthError({ code: 'network' })).toBe(false);
  });
});

describe('classifyWriteFailureReason', () => {
  // ── Write-401 fix (issue #78): coarse reason bucket for the write-failure
  // telemetry hook (onWriteError / oxpulse-chat:write-error detail.reason).

  it('classifies_statusCode_401_as_auth_expired', () => {
    expect(classifyWriteFailureReason({ statusCode: 401, code: 'unauthorized' })).toBe('auth_expired');
  });

  it('classifies_code_network_as_network', () => {
    expect(classifyWriteFailureReason({ code: 'network' })).toBe('network');
  });

  it('classifies_plain_error_as_other', () => {
    expect(classifyWriteFailureReason(new Error('boom'))).toBe('other');
  });

  it('auth_takes_priority_over_network_kind', () => {
    // A shape that could plausibly read as both — auth must win: an expired
    // token is actionable (refresh + retry), a transient network blip isn't.
    expect(
      classifyWriteFailureReason({ statusCode: 401, code: 'unauthorized', kind: 'network' }),
    ).toBe('auth_expired');
  });
});
