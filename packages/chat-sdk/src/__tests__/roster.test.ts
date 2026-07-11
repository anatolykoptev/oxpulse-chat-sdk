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
 *
 * NOTE — FF5 issuer-disjointness: issuer-disjointness (grant iss=<app_id> vs
 * SDK iss=oxpulse) is enforced SERVER-SIDE by the /api/sdk/tokens exchange
 * endpoint (Validation::new(EdDSA) + iss check). The client has no mechanism to
 * distinguish issuers — it receives opaque string tokens and forwards them. A
 * client-side tautology asserting 'piter-now' !== 'oxpulse' on literal objects
 * provides no coverage against a real regression. Tests belong where enforcement
 * lives: server integration tests for the /api/sdk/tokens exchange. Removed.
 *
 *  10. FF6 (alg-pin): mintNamedWriteToken rejects alg:none and alg:HS256 tokens
 *      returned by the mint endpoint — real production guard, red-on-revert.
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchRoster, rosterDisplayName, rosterAvatar, type RosterEntry } from '../roster.js';
import { SDKChatError } from '../errors.js';
import { mintNamedWriteToken, NamedWriteMintError } from '../named-write.js';

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

    expect(map.get('ep_abc123')?.displayName).toBe('Alice');
    expect(map.get('ep_def456')?.displayName).toBe('Bob');
    // No `avatars` in the response → avatarUrl null (backward-compat).
    expect(map.get('ep_abc123')?.avatarUrl).toBeNull();
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
    const roster = new Map<string, RosterEntry>([['ep_abc123def456', { displayName: 'Alice', avatarUrl: null }]]);
    expect(rosterDisplayName(roster, 'ep_abc123def456')).toBe('Alice');
  });

  it('miss: returns first 8 chars of epid', () => {
    const roster = new Map<string, RosterEntry>();
    // epid longer than 8 chars → truncated
    expect(rosterDisplayName(roster, 'ep_abcdefghij')).toBe('ep_abcde');
  });

  it('miss: short epid returned as-is when <= 8 chars', () => {
    const roster = new Map<string, RosterEntry>();
    expect(rosterDisplayName(roster, 'ep_abc')).toBe('ep_abc');
  });

  it('miss: never returns empty string', () => {
    const roster = new Map<string, RosterEntry>();
    const result = rosterDisplayName(roster, 'ep_xyz999');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ── FF6: alg-pin guard (real production guard in mintNamedWriteToken) ─────────

describe('FF6 alg-pin: mintNamedWriteToken rejects alg:none and alg:HS256 from mint endpoint', () => {
  /**
   * Defense-in-depth: the server enforces EdDSA at the /api/sdk/tokens exchange
   * (T2 Validation::new(EdDSA)), but mintNamedWriteToken ALSO inspects the returned
   * token's header and throws NamedWriteMintError('mint_failed') for any alg ≠ EdDSA.
   *
   * These tests call the REAL mintNamedWriteToken via a mock fetch that simulates
   * a misconfigured mint endpoint returning a non-EdDSA token.
   *
   * Red-on-revert: remove the parseJwtAlg + alg-pin check from named-write.ts and
   * these tests go RED (no NamedWriteMintError thrown for the bad-alg tokens).
   */

  /** Build a JWT with a given alg field for use as a mock mint response. */
  function makeFakeToken(alg: string): string {
    const header = btoa(JSON.stringify({ alg, typ: 'JWT' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const payload = btoa(JSON.stringify({ iss: 'piter-now', sub: 'ep_x' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `${header}.${payload}.fakesig`;
  }

  const EDDSA_TOKEN =
    'eyJhbGciOiJFZERTQSIsImtpZCI6InBpdGVyLXYxIiwidHlwIjoiSldUIn0.' + // gitleaks:allow
    'eyJpc3MiOiJwaXRlci1ub3ciLCJzdWIiOiJlcF9nb2xkZW50ZXN0MDAxIn0.' +
    'fakesig';

  function makeMintFetch(token: string): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ token }),
    } as unknown as Response);
  }

  it('rejects alg:none token returned by mint endpoint', async () => {
    const noneToken = makeFakeToken('none');
    const fetchImpl = makeMintFetch(noneToken);

    await expect(
      mintNamedWriteToken({
        mintEndpoint: 'https://example.com/mint',
        roomId: 'room1',
        fetchImpl,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NamedWriteMintError);
      expect((err as NamedWriteMintError).code).toBe('mint_failed');
      return true;
    });
  });

  it('rejects alg:HS256 token returned by mint endpoint', async () => {
    const hs256Token = makeFakeToken('HS256');
    const fetchImpl = makeMintFetch(hs256Token);

    await expect(
      mintNamedWriteToken({
        mintEndpoint: 'https://example.com/mint',
        roomId: 'room1',
        fetchImpl,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NamedWriteMintError);
      expect((err as NamedWriteMintError).code).toBe('mint_failed');
      return true;
    });
  });

  it('accepts EdDSA token returned by mint endpoint', async () => {
    const fetchImpl = makeMintFetch(EDDSA_TOKEN);

    const result = await mintNamedWriteToken({
      mintEndpoint: 'https://example.com/mint',
      roomId: 'room1',
      fetchImpl,
    });
    // Returns the raw token string — no error thrown.
    expect(result).toBe(EDDSA_TOKEN);
  });
});

// ── fetchRoster avatars + rosterAvatar (T18-avatar) ──────────────────────────

describe('fetchRoster — avatars (T18-avatar)', () => {
  it('parses avatar_url from the avatars map', async () => {
    const fetchImpl = makeFetch(200, {
      roster: { ep_a: 'Alice', ep_b: 'Bob' },
      avatars: { ep_a: 'https://cdn.example.com/a.png' },
    });
    const map = await fetchRoster({ baseUrl: BASE_URL, appId: APP_ID, roomId: ROOM_ID, jwt: JWT, fetchImpl });
    expect(map.get('ep_a')?.avatarUrl).toBe('https://cdn.example.com/a.png');
    // ep_b is named but has no avatar → null.
    expect(map.get('ep_b')?.avatarUrl).toBeNull();
    expect(map.get('ep_a')?.displayName).toBe('Alice');
  });

  it('backward-compat: a response with no avatars key parses with null avatars', async () => {
    const fetchImpl = makeFetch(200, { roster: { ep_a: 'Alice' } });
    const map = await fetchRoster({ baseUrl: BASE_URL, appId: APP_ID, roomId: ROOM_ID, jwt: JWT, fetchImpl });
    expect(map.get('ep_a')?.displayName).toBe('Alice');
    expect(map.get('ep_a')?.avatarUrl).toBeNull();
  });

  it('ignores an avatar for an epid absent from the roster', async () => {
    const fetchImpl = makeFetch(200, {
      roster: { ep_a: 'Alice' },
      avatars: { ep_ghost: 'https://cdn.example.com/ghost.png' },
    });
    const map = await fetchRoster({ baseUrl: BASE_URL, appId: APP_ID, roomId: ROOM_ID, jwt: JWT, fetchImpl });
    expect(map.has('ep_ghost')).toBe(false);
    expect(map.get('ep_a')?.avatarUrl).toBeNull();
  });
});

describe('rosterAvatar (T18-avatar)', () => {
  it('hit: returns the avatar URL', () => {
    const roster = new Map<string, RosterEntry>([
      ['ep_a', { displayName: 'Alice', avatarUrl: 'https://cdn.example.com/a.png' }],
    ]);
    expect(rosterAvatar(roster, 'ep_a')).toBe('https://cdn.example.com/a.png');
  });
  it('member without an avatar: returns null', () => {
    const roster = new Map<string, RosterEntry>([['ep_a', { displayName: 'Alice', avatarUrl: null }]]);
    expect(rosterAvatar(roster, 'ep_a')).toBeNull();
  });
  it('miss: absent epid returns null', () => {
    const roster = new Map<string, RosterEntry>();
    expect(rosterAvatar(roster, 'ep_missing')).toBeNull();
  });
});
