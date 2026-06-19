/**
 * named-write.test.ts — mintNamedWriteToken unit tests.
 *
 * Tests:
 *   1. success — returns raw token string from 2xx response (EdDSA token)
 *   2. 401 — throws NamedWriteMintError with code 'unauthorized'
 *   3. 403 — throws NamedWriteMintError with code 'forbidden'
 *   4. 429 — throws NamedWriteMintError with code 'rate_limited'
 *   5. 500 — throws NamedWriteMintError with code 'mint_failed'
 *   6. request shape — POSTs to mintEndpoint with roomId in body
 *   7. 2xx with missing/non-string token — throws NamedWriteMintError (guard)
 *   8. alg-pin: 2xx with alg:none token — throws NamedWriteMintError (guard)
 *   9. alg-pin: 2xx with alg:HS256 token — throws NamedWriteMintError (guard)
 */

import { describe, it, expect, vi } from 'vitest';
import { mintNamedWriteToken, NamedWriteMintError } from '../named-write.js';

const MINT_ENDPOINT = 'https://api.example.com/tokens/named-write';
const ROOM_ID = 'room-xyz';

// Golden EdDSA-header token (Phase B plan §T5; alg=EdDSA, kid=piter-v1).
// The alg-pin guard reads only the header; the signature is a test placeholder.
const EDDSA_TOKEN =
  'eyJhbGciOiJFZERTQSIsImtpZCI6InBpdGVyLXYxIiwidHlwIjoiSldUIn0.' + // gitleaks:allow
  'eyJpc3MiOiJwaXRlci1ub3ciLCJzdWIiOiJlcF9nb2xkZW50ZXN0MDAxIn0.' +
  'fakesig';

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

/** Build a JWT with a given alg for testing the alg-pin guard. */
function makeTokenWithAlg(alg: string): string {
  const header = btoa(JSON.stringify({ alg, typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const payload = btoa(JSON.stringify({ iss: 'piter-now', sub: 'ep_x' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${payload}.fakesig`;
}

describe('mintNamedWriteToken', () => {
  it('success: returns EdDSA token string', async () => {
    const fetchImpl = makeFetch(200, { token: EDDSA_TOKEN });

    const result = await mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl });

    expect(result).toBe(EDDSA_TOKEN);
  });

  it('401: throws NamedWriteMintError with code unauthorized and status 401', async () => {
    const fetchImpl = makeFetch(401, {});

    await expect(
      mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NamedWriteMintError);
      const e = err as NamedWriteMintError;
      expect(e.code).toBe('unauthorized');
      expect(e.status).toBe(401);
      return true;
    });
  });

  it('403: throws NamedWriteMintError with code forbidden', async () => {
    const fetchImpl = makeFetch(403, {});

    await expect(
      mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NamedWriteMintError);
      const e = err as NamedWriteMintError;
      expect(e.code).toBe('forbidden');
      expect(e.status).toBe(403);
      return true;
    });
  });

  it('429: throws NamedWriteMintError with code rate_limited', async () => {
    const fetchImpl = makeFetch(429, {});

    await expect(
      mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NamedWriteMintError);
      const e = err as NamedWriteMintError;
      expect(e.code).toBe('rate_limited');
      expect(e.status).toBe(429);
      return true;
    });
  });

  it('500: throws NamedWriteMintError with code mint_failed', async () => {
    const fetchImpl = makeFetch(500, {});

    await expect(
      mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NamedWriteMintError);
      const e = err as NamedWriteMintError;
      expect(e.code).toBe('mint_failed');
      expect(e.status).toBe(500);
      return true;
    });
  });

  it('request shape: POSTs to mintEndpoint with roomId in body', async () => {
    const fetchImpl = makeFetch(200, { token: EDDSA_TOKEN });

    await mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl });

    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(MINT_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as Record<string, string>;
    expect(body['room_id']).toBe(ROOM_ID);
  });

  it('2xx with missing token → throws NamedWriteMintError (guard)', async () => {
    const fetchImpl = makeFetch(200, { not_a_token: 'oops' });

    await expect(
      mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NamedWriteMintError);
      const e = err as NamedWriteMintError;
      expect(e.code).toBe('mint_failed');
      return true;
    });
  });

  it('2xx with non-string token → throws NamedWriteMintError (guard)', async () => {
    const fetchImpl = makeFetch(200, { token: 42 });

    await expect(
      mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NamedWriteMintError);
      const e = err as NamedWriteMintError;
      expect(e.code).toBe('mint_failed');
      return true;
    });
  });

  it('alg-pin: 2xx with alg:none token → throws NamedWriteMintError', async () => {
    // Defense-in-depth: even if the mint endpoint returns alg:none (CVE-2015-9235 class),
    // mintNamedWriteToken rejects it before the token is used anywhere.
    // Red-on-revert: remove parseJwtAlg + alg-pin check from named-write.ts → no throw.
    const fetchImpl = makeFetch(200, { token: makeTokenWithAlg('none') });

    await expect(
      mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NamedWriteMintError);
      const e = err as NamedWriteMintError;
      expect(e.code).toBe('mint_failed');
      return true;
    });
  });

  it('alg-pin: 2xx with alg:HS256 token → throws NamedWriteMintError', async () => {
    // HMAC confusion attack class: HS256 token from a misconfigured mint endpoint.
    const fetchImpl = makeFetch(200, { token: makeTokenWithAlg('HS256') });

    await expect(
      mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl }),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(NamedWriteMintError);
      const e = err as NamedWriteMintError;
      expect(e.code).toBe('mint_failed');
      return true;
    });
  });
});
