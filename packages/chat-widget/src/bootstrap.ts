/**
 * @oxpulse/chat-widget — bootstrap origin check.
 *
 * Decodes (but does NOT verify) the JWT, extracts the `aud_origins` claim,
 * and matches it against window.location.origin BEFORE any network call.
 *
 * Security note: signature verification is the server's responsibility.
 * The client-side check prevents accidental misconfiguration, not
 * malicious embed (an attacker can trivially bypass client-side JS).
 *
 * Origin-match semantics mirror crates/sdk/src/origin_match.rs (W1.1):
 *   - Case-insensitive host + scheme comparison
 *   - `*.example.com` or `https://*.example.com` = subdomain wildcard, https-only, single-level
 *   - `http://localhost:*` = port wildcard (requires a port — no-port does NOT match)
 *   - `https://example.com` = exact match
 *   - `validate_allowlist_entry` rules: malformed entries never match
 */

import {
  WidgetError,
  OriginNotAllowedError,
  type WidgetConfig,
  type OriginCheckResult,
} from './types.js';

/** Minimal decoded JWT payload shape for our bootstrap check. */
interface JwtPayload {
  /** Allowed embed origins (glob patterns, e.g. "https://example.com", "http://localhost:*"). */
  aud_origins?: string[];
  /** Standard expiry (unix seconds). Client-side check; server is authoritative. */
  exp?: number;
  [key: string]: unknown;
}

/**
 * Decode JWT (Base64url → JSON) — no signature verification.
 *
 * Also checks the `exp` claim: if exp is in the past, throws WidgetError(JWT_EXPIRED).
 *
 * @throws WidgetError(JWT_MALFORMED) if the token is not a valid 3-part JWT.
 * @throws WidgetError(JWT_EXPIRED) if the exp claim is in the past.
 */
export function decodeJwtPayload(jwt: string): JwtPayload {
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    throw new WidgetError(
      'JWT_MALFORMED',
      'JWT must have exactly 3 parts (header.payload.signature)',
    );
  }
  const payloadB64 = parts[1];
  if (!payloadB64) {
    throw new WidgetError('JWT_MALFORMED', 'JWT payload part is empty');
  }
  let payload: JwtPayload;
  try {
    // base64url → base64 → decode → JSON.parse
    const b64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (b64.length % 4)) % 4;
    const padded = b64 + '='.repeat(padLen);
    // atob is available in browsers and Node.js >= 16 as a global
    const decoded = atob(padded);
    payload = JSON.parse(decoded) as JwtPayload;
  } catch (err) {
    if (err instanceof WidgetError) throw err;
    throw new WidgetError('JWT_MALFORMED', 'JWT payload is not valid base64url JSON');
  }

  // MINOR: client-side exp check — server is still authoritative
  if (typeof payload['exp'] === 'number') {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload['exp'] < nowSeconds) {
      throw new WidgetError('JWT_EXPIRED', 'JWT has expired (exp claim is in the past)');
    }
  }

  return payload;
}

/**
 * Normalise a subdomain wildcard pattern to bare form.
 *
 * Both `*.example.com` and `https://*.example.com` are accepted.
 * Returns the bare suffix (e.g. "example.com") if it's a subdomain pattern,
 * null otherwise.
 */
function extractSubdomainSuffix(pattern: string): string | null {
  const lower = pattern.toLowerCase();
  // Bare: *.example.com
  if (lower.startsWith('*.')) {
    const rest = lower.slice(2);
    if (!rest || rest.startsWith('.') || rest.includes('*')) return null;
    return rest;
  }
  // Widget-style: https://*.example.com
  if (lower.startsWith('https://*.')) {
    const rest = lower.slice('https://*.'.length);
    if (!rest || rest.startsWith('.') || rest.includes('*')) return null;
    return rest;
  }
  return null;
}

/**
 * Validate an allowlist entry per server rules (mirrors validate_allowlist_entry).
 * Returns false for entries that would be rejected by the server.
 */
function isValidAllowlistEntry(pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === '*') return false;
  const lower = pattern.toLowerCase();

  // Subdomain wildcard (bare or https:// prefixed)
  if (extractSubdomainSuffix(pattern) !== null) return true;

  // Must start with http:// or https://
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) return false;

  const afterScheme = lower.startsWith('https://') ? lower.slice(8) : lower.slice(7);
  if (!afterScheme) return false;

  // Port wildcard suffix: host:*
  if (afterScheme.endsWith(':*')) {
    const host = afterScheme.slice(0, -2);
    if (!host || host.includes('*')) return false;
    return true;
  }

  // No other wildcards
  if (afterScheme.includes('*')) return false;

  return true;
}

/**
 * Match an origin against a single pattern.
 *
 * Mirrors crates/sdk/src/origin_match.rs::matches semantics:
 *   - Case-insensitive (scheme + host)
 *   - `*.example.com` or `https://*.example.com` — subdomain wildcard, https-only, single-level
 *   - `http://localhost:*`  — port wildcard, REQUIRES actual port (no-port = no match)
 *   - `https://example.com` — exact match
 *   - Malformed entries → false (deny-loud)
 */
export function matchOriginPattern(origin: string, pattern: string): boolean {
  if (!isValidAllowlistEntry(pattern)) return false;

  // Normalise: trim trailing slash from origin
  const normOrigin = origin.replace(/\/$/, '').toLowerCase();
  const normPattern = pattern.toLowerCase();

  // ── Subdomain wildcard (bare *.example.com or https://*.example.com) ──────
  const subdomainSuffix = extractSubdomainSuffix(pattern);
  if (subdomainSuffix !== null) {
    // Must be https://
    const httpsPrefix = 'https://';
    if (!normOrigin.startsWith(httpsPrefix)) return false;
    const hostPart = normOrigin.slice(httpsPrefix.length);

    // Strip optional port from host part
    const colonIdx = hostPart.lastIndexOf(':');
    const hostNoPort =
      colonIdx !== -1 && hostPart.slice(colonIdx + 1).match(/^\d+$/)
        ? hostPart.slice(0, colonIdx)
        : hostPart;

    // Must be exactly <single-label>.<suffix> — no nested dots in label
    if (!hostNoPort.endsWith('.' + subdomainSuffix)) return false;
    const label = hostNoPort.slice(0, hostNoPort.length - subdomainSuffix.length - 1);
    return label.length > 0 && !label.includes('.');
  }

  // ── Port wildcard: scheme://host:* ────────────────────────────────────────
  if (normPattern.endsWith(':*')) {
    const prefix = normPattern.slice(0, -2); // e.g. "http://localhost"
    // Origin must be prefix:<digits> — requires actual port
    if (!normOrigin.startsWith(prefix + ':')) return false;
    const portPart = normOrigin.slice(prefix.length + 1);
    return portPart.length > 0 && /^\d+$/.test(portPart);
  }

  // ── Exact match (case-insensitive) ────────────────────────────────────────
  return normOrigin === normPattern;
}

/**
 * Check whether the current page origin is allowed by the JWT's aud_origins claim.
 *
 * Behaviour (M5 — security default):
 * - If aud_origins is missing and allowLegacyToken is false (default): DENY.
 * - If aud_origins is missing and allowLegacyToken is true: warn + pass-through.
 * - If aud_origins is empty array: deny all.
 * - Dev mode: localhost always passes when mode === 'inline' (or unset) and
 *   window.location.hostname === 'localhost'.
 * - Malformed patterns in aud_origins: console.warn + treated as never-match.
 *
 * @throws OriginNotAllowedError when origin is not in the allowlist.
 * @throws WidgetError(JWT_MALFORMED) when the JWT cannot be decoded.
 * @throws WidgetError(JWT_EXPIRED) when the JWT exp claim is in the past.
 */
export async function checkOrigin(config: WidgetConfig): Promise<OriginCheckResult> {
  let payload: JwtPayload;
  try {
    payload = decodeJwtPayload(config.jwt);
  } catch (err) {
    if (err instanceof WidgetError) throw err;
    throw new WidgetError('JWT_MALFORMED', 'Failed to decode JWT');
  }

  const currentOrigin =
    typeof window !== 'undefined' ? window.location.origin : 'http://localhost';

  // Dev-mode shortcut: localhost in inline mode always passes
  const isLocalhostDev =
    typeof window !== 'undefined' &&
    window.location.hostname === 'localhost' &&
    (config.mode === 'inline' || config.mode === undefined);

  if (isLocalhostDev) {
    return { allowed: true, matchedPattern: 'localhost-dev' };
  }

  // Missing aud_origins — M5: default DENY unless allowLegacyToken opt-in
  if (payload.aud_origins === undefined || payload.aud_origins === null) {
    if (config.allowLegacyToken === true) {
      console.warn(
        '[OxpulseChatWidget] JWT is missing aud_origins claim. ' +
          'Update your token-minting code to include allowed origins. ' +
          'Proceeding (allowLegacyToken=true backwards-compat mode).',
      );
      return { allowed: true, matchedPattern: 'aud_origins-missing-passthrough' };
    }
    // Default deny — operator must set allowLegacyToken:true to opt into legacy behaviour
    throw new WidgetError(
      'JWT_MALFORMED',
      'JWT is missing aud_origins claim. Set allowLegacyToken:true to allow pre-W1.1 tokens.',
    );
  }

  // Empty list → explicit deny
  if (payload.aud_origins.length === 0) {
    throw new OriginNotAllowedError(currentOrigin, []);
  }

  // Warn on malformed entries (deny-loud, not silent)
  const malformed = payload.aud_origins.filter((p) => !isValidAllowlistEntry(p));
  if (malformed.length > 0) {
    console.warn(
      `[OxpulseChatWidget] aud_origins contains malformed entries (will not match): ${malformed.join(', ')}`,
    );
  }

  // Check each pattern
  for (const pattern of payload.aud_origins) {
    if (matchOriginPattern(currentOrigin, pattern)) {
      return { allowed: true, matchedPattern: pattern };
    }
  }

  throw new OriginNotAllowedError(currentOrigin, payload.aud_origins);
}
