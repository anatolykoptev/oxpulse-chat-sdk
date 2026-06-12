/**
 * auth.test.ts — TDD RED phase (W2.2 slice 5)
 *
 * Tests: isAuthError() helper in utils/auth.ts
 */

import { describe, it, expect } from 'vitest';
import { isAuthError } from '../utils/auth.js';

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
});
