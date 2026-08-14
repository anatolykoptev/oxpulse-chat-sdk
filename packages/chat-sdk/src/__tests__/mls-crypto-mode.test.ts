/**
 * mls-crypto-mode.test.ts — an MLS client must be able to talk to an MLS room.
 *
 * `#cryptoMode` is the client's declared expectation and
 * `validateAndResolveCryptoMode` compares it to the server's value with `!==`.
 * The default was `hasE2ee ? 'sframe-static' : null`, keyed on the PRESENCE of a
 * provider rather than on which one — so a client configured `provider: 'mls'`
 * declared `sframe-static`, the server's `'mls'` could never equal it, and the
 * downgrade defense fired on the client's own correct mode: room poisoned, every
 * send refused. Fail-closed, so not a downgrade — but the feature could not work
 * in the configuration its own docs describe unless the caller ALSO passed
 * `cryptoMode: 'mls'`, which nothing in `E2EEOptions` asks for.
 *
 * RED before the fix: `list()` rejects with crypto_mode_mismatch
 * (configured=sframe-static received=mls).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { SDKChatError } from '../errors.js';
import { TEST_BASE_URL as BASE_URL, TEST_JWT as JWT, makeListResponse as sharedMakeListResponse } from './helpers.js';

const ROOM_ID = 'room-mls-mode-test';
const makeListResponse = (b64: string, cryptoMode?: string) => sharedMakeListResponse(b64, { cryptoMode });

function mlsClient(extra: Record<string, unknown> = {}) {
  return new SDKChatClient({
    baseUrl: BASE_URL,
    jwt: JWT,
    e2ee: {
      provider: 'mls',
      mls: {
        identityKey: {} as CryptoKey,
        credential: 'basic',
        uid: 'u-mls-test',
        keyPackageDirectoryUrl: `${BASE_URL}/keypackages`,
      },
    },
    ...extra,
  } as never);
}

describe('mls client vs mls room', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts a server crypto_mode of "mls" without an explicit cryptoMode option', async () => {
    const client = mlsClient();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(btoa('payload'), 'mls'));
    await expect(client.list(ROOM_ID)).resolves.toBeDefined();
  });

  it('still rejects a real downgrade to plaintext', async () => {
    const client = mlsClient();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(btoa('payload'), 'plaintext'));
    await expect(client.list(ROOM_ID)).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_mismatch',
    );
  });

  it('still rejects a swap to sframe-static', async () => {
    const client = mlsClient();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(btoa('payload'), 'sframe-static'));
    await expect(client.list(ROOM_ID)).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_mismatch',
    );
  });

  it('leaves the sframe default alone', async () => {
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: { provider: 'sframe', getKey: async () => new Uint8Array(32) },
    } as never);
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(btoa('payload'), 'mls'));
    await expect(client.list(ROOM_ID)).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_mismatch',
    );
  });
});
