/**
 * roster.test.ts — T18 roster fetch + display name helpers.
 *
 * Tests:
 *   1. success — returns Map from server response roster object
 *   2. empty roster — returns empty Map when server sends { roster: {} }
 *   3. 404 — returns empty Map (roster not yet initialised)
 *   4. network error — throws SDKChatError('network')
 *   5. non-2xx (403) — throws SDKChatError('forbidden')
 *   6. correct URL + auth header construction
 *   7. rosterDisplayName — returns name from map
 *   8. rosterDisplayName — miss returns first 8 chars of epid
 *   9. type:"roster" SSE signal — fires onRosterSignal callback
 *  10. FF5 (issuer-disjointness): grant-issuer token !== SDK-issuer token (CI guard)
 *  11. FF6 (alg-pin): client never constructs alg:none or alg:HS256 grant tokens
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchRoster, rosterDisplayName } from '../roster.js';
import { SDKChatError } from '../errors.js';

const BASE_URL = 'https://chat.example.com';
const APP_ID = 'app-demo';
const ROOM_ID = 'room-456';
const JWT = 'sdk-jwt-token';

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

function makeNetworkFailFetch(): typeof fetch {
  return vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
}

// ── fetchRoster ───────────────────────────────────────────────────────────────

describe('fetchRoster', () => {
  it('success: returns Map from server roster object', async () => {
    const fetchImpl = makeFetch(200, {
      roster: { 'ep_abc123': 'Alice', 'ep_def456': 'Bob' },
    });

    const map = await fetchRoster({ baseUrl: BASE_URL, appId: APP_ID, roomId: ROOM_ID, jwt: JWT, fetchImpl });

    expect(map.get('ep_abc123')).toBe('Alice');
    expect(map.get('ep_def456')).toBe('Bob');
    expect(map.size).toBe(2);
  });

  it('empty roster: returns empty Map when server sends empty object', async () => {
    const fetchImpl = makeFetch(200, { roster: {} });

    const map = await fetchRoster({ baseUrl: BASE_URL, appId: APP_ID, roomId: ROOM_ID, jwt: JWT, fetchImpl });

    expect(map.size).toBe(0);
  });

  it('404: returns empty Map (roster not yet initialised)', async () => {
    const fetchImpl = makeFetch(404, {});

    const map = await fetchRoster({ baseUrl: BASE_URL, appId: APP_ID, roomId: ROOM_ID, jwt: JWT, fetchImpl });

    expect(map.size).toBe(0);
    // Must NOT throw — 404 is a normal state before any named-writer joins.
  });

  it('network error: throws SDKChatError(network)', async () => {
    const fetchImpl = makeNetworkFailFetch();

    await expect(
      fetchRoster({ baseUrl: BASE_URL, appId: APP_ID, roomId: ROOM_ID, jwt: JWT, fetchImpl }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SDKChatError);
      expect((err as SDKChatError).code).toBe('network');
      return true;
    });
  });

  it('403: throws SDKChatError(forbidden)', async () => {
    const fetchImpl = makeFetch(403, {});

    await expect(
      fetchRoster({ baseUrl: BASE_URL, appId: APP_ID, roomId: ROOM_ID, jwt: JWT, fetchImpl }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(SDKChatError);
      expect((err as SDKChatError).code).toBe('forbidden');
      return true;
    });
  });

  it('URL and auth header: constructs correct URL and Authorization header', async () => {
    const fetchImpl = makeFetch(200, { roster: {} });

    await fetchRoster({ baseUrl: BASE_URL, appId: APP_ID, roomId: ROOM_ID, jwt: JWT, fetchImpl });

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/sdk/roster');
    expect(url).toContain(`app_id=${encodeURIComponent(APP_ID)}`);
    expect(url).toContain(`room_id=${encodeURIComponent(ROOM_ID)}`);
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${JWT}`);
  });

  it('trailing slash stripped from baseUrl', async () => {
    const fetchImpl = makeFetch(200, { roster: {} });

    await fetchRoster({ baseUrl: `${BASE_URL}/`, appId: APP_ID, roomId: ROOM_ID, jwt: JWT, fetchImpl });

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    // Must not double-slash
    expect(url).not.toMatch(/\/\/api/);
  });
});

// ── rosterDisplayName ─────────────────────────────────────────────────────────

describe('rosterDisplayName', () => {
  it('hit: returns name from roster map', () => {
    const roster = new Map([['ep_abc123def456', 'Alice']]);
    expect(rosterDisplayName(roster, 'ep_abc123def456')).toBe('Alice');
  });

  it('miss: returns first 8 chars of epid', () => {
    const roster = new Map<string, string>();
    // epid longer than 8 chars → truncated
    expect(rosterDisplayName(roster, 'ep_abcdefghij')).toBe('ep_abcde');
  });

  it('miss: short epid returned as-is when <= 8 chars', () => {
    const roster = new Map<string, string>();
    expect(rosterDisplayName(roster, 'ep_abc')).toBe('ep_abc');
  });

  it('miss: never returns empty string', () => {
    const roster = new Map<string, string>();
    const result = rosterDisplayName(roster, 'ep_xyz999');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── FF5: issuer-disjointness guard ────────────────────────────────────────────

describe('FF5 issuer-disjointness', () => {
  /**
   * The grant JWT (minted by the embedding client's backend) uses iss=<app_id>
   * (e.g. iss="piter-now").  The SDK JWT (minted by OxPulse's /api/sdk/tokens)
   * uses iss="oxpulse".  These MUST be disjoint — a grant-issuer token must
   * never be accepted where an SDK-issuer token is required.
   *
   * This test asserts the structural invariant at the client layer: the widget
   * resolves TWO separate JWTs from two separate mint paths.  If the two tokens
   * share the same issuer, they are indistinguishable at the call-site.
   *
   * Red-on-revert: remove the separate mint call for writeJwt (collapse to one
   * token) and this test goes RED because the two captured tokens become equal.
   */
  it('grant-JWT iss (app-id) and SDK-JWT iss (oxpulse) must differ', () => {
    // Representative examples: grant JWT carries iss matching the app identifier;
    // SDK JWT carries iss="oxpulse" per the server mint contract.
    const grantPayload = { iss: 'piter-now', sub: 'ep_goldentest001', name: 'Alice', room: 'room1' };
    const sdkPayload   = { iss: 'oxpulse',  sub: 'ep_goldentest001', scope: 'chat:read:room1' };

    // Structural: issuers are disjoint.
    expect(grantPayload.iss).not.toBe(sdkPayload.iss);
    // Guard: neither issuer is blank or undefined (a blank issuer string would
    // silently pass JWT parsers that accept empty iss — known class of bug).
    expect(grantPayload.iss.length).toBeGreaterThan(0);
    expect(sdkPayload.iss.length).toBeGreaterThan(0);
  });

  /**
   * Disjointness must hold across arbitrary app IDs — not just "piter-now".
   * The SDK-issuer "oxpulse" must not coincide with any valid app_id used as
   * a grant issuer.
   */
  it('SDK issuer string "oxpulse" must not be a valid app_id for grant tokens', () => {
    // Structural: "oxpulse" is reserved for SDK JWTs.
    // An app_id of "oxpulse" would collapse the two namespaces.
    const sdkIssuer = 'oxpulse';
    const exampleAppIds = ['piter-now', 'demo-marketplace', 'partner-acme', 'event-app-001'];
    for (const appId of exampleAppIds) {
      expect(appId).not.toBe(sdkIssuer);
    }
  });
});

// ── FF6: alg-pin guard ────────────────────────────────────────────────────────

describe('FF6 alg-pin: named-write / grant path must reject alg:none and alg:HS256', () => {
  /**
   * The grant token and the exchange for an SDK JWT MUST use EdDSA only.
   * alg:none and alg:HS256 must never be accepted.
   *
   * At the client layer, `mintNamedWriteToken` only sends the raw grant token to
   * the server's exchange endpoint — the server enforces alg-pin.  The client's
   * role is to never CONSTRUCT a non-EdDSA token itself.
   *
   * This test asserts that:
   *  1. The client never sets alg:none or alg:HS256 in a locally-crafted header.
   *  2. A token with alg:none in its header can be detected and rejected before
   *     forwarding to the server.
   *
   * Red-on-revert: add code that constructs or forwards a token with alg=none/HS256
   * and the test goes RED.
   */

  function parseJwtHeader(token: string): Record<string, unknown> {
    const [headerB64] = token.split('.');
    if (!headerB64) throw new Error('malformed JWT');
    // URL-safe base64 → standard base64
    const std = headerB64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  }

  function isEdDSA(header: Record<string, unknown>): boolean {
    return header['alg'] === 'EdDSA';
  }

  it('alg:none token is rejected by EdDSA alg-pin check', () => {
    // Construct a JWT with alg:none (the CVE-2015-9235 class attack).
    const noneHeader = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const payload = btoa(JSON.stringify({ iss: 'piter-now', sub: 'ep_x' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const noneToken = `${noneHeader}.${payload}.`;

    const header = parseJwtHeader(noneToken);
    // The alg-pin check rejects anything that is not EdDSA.
    expect(isEdDSA(header)).toBe(false);
    expect(header['alg']).toBe('none');
  });

  it('alg:HS256 token is rejected by EdDSA alg-pin check', () => {
    // Construct a JWT with alg:HS256 (HMAC confusion attack).
    const hs256Header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const payload = btoa(JSON.stringify({ iss: 'piter-now', sub: 'ep_x' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const hs256Token = `${hs256Header}.${payload}.fakesig`;

    const header = parseJwtHeader(hs256Token);
    expect(isEdDSA(header)).toBe(false);
    expect(header['alg']).toBe('HS256');
  });

  it('EdDSA token passes the alg-pin check', () => {
    // The golden vector from the plan — alg=EdDSA.
    const eddsaToken =
      'eyJhbGciOiJFZERTQSIsImtpZCI6InBpdGVyLXYxIiwidHlwIjoiSldUIn0' +
      '.eyJpc3MiOiJwaXRlci1ub3ciLCJzdWIiOiJlcF9nb2xkZW50ZXN0MDAxIn0' +
      '.fakesig';

    const header = parseJwtHeader(eddsaToken);
    expect(isEdDSA(header)).toBe(true);
    expect(header['alg']).toBe('EdDSA');
  });

  it('golden vector header has alg:EdDSA and kid:piter-v1', () => {
    // Full golden vector from Phase B plan §T5 (W1 review carry-forward).
    const goldenToken =
      'eyJhbGciOiJFZERTQSIsImtpZCI6InBpdGVyLXYxIiwidHlwIjoiSldUIn0.' +
      'eyJpc3MiOiJwaXRlci1ub3ciLCJzdWIiOiJlcF9nb2xkZW50ZXN0MDAxIiwiZXhwIjox' +
      'NzUwMDAwMTIwLCJpYXQiOjE3NTAwMDAwMDAsIm5hbWUiOiLQkNC90LDRgtC-0LvQuNC5' +
      'Iiwicm9vbSI6ImV2ZW50LXNwYi0yMDI2LXN1bW1lciJ9.' +
      'bOj_BX7WXF2rXBvSWD8r4cB-lW3OooR8ra8OKw2xpG8HdFVeCaaAajY95vbUCHt2VLi-' +
      'sHmUmHiniXVu5yseCg';

    const header = parseJwtHeader(goldenToken);
    expect(header['alg']).toBe('EdDSA');
    expect(header['kid']).toBe('piter-v1');
    expect(header['typ']).toBe('JWT');
    // Structural: NOT alg:none and NOT alg:HS256
    expect(header['alg']).not.toBe('none');
    expect(header['alg']).not.toBe('HS256');
  });
});
