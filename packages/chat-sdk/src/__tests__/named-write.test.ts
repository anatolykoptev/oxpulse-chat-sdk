/**
 * named-write.test.ts — mintNamedWriteToken unit tests.
 *
 * Tests:
 *   1. success — returns raw token string from 2xx response
 *   2. 401 — throws NamedWriteMintError with code 'unauthorized'
 *   3. 403 — throws NamedWriteMintError with code 'forbidden'
 *   4. 429 — throws NamedWriteMintError with code 'rate_limited'
 *   5. 500 — throws NamedWriteMintError with code 'mint_failed'
 *   6. request shape — POSTs to mintEndpoint with roomId in body
 *   7. 2xx with missing/non-string token — throws NamedWriteMintError (guard)
 */

import { describe, it, expect, vi } from 'vitest';
import { mintNamedWriteToken, NamedWriteMintError } from '../named-write.js';

const MINT_ENDPOINT = 'https://api.example.com/tokens/named-write';
const ROOM_ID = 'room-xyz';

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

describe('mintNamedWriteToken', () => {
  it('success: returns raw token string', async () => {
    const fetchImpl = makeFetch(200, { token: 'jwt.x.y' });

    const result = await mintNamedWriteToken({ mintEndpoint: MINT_ENDPOINT, roomId: ROOM_ID, fetchImpl });

    expect(result).toBe('jwt.x.y');
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
    const fetchImpl = makeFetch(200, { token: 'jwt.x.y' });

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
});
