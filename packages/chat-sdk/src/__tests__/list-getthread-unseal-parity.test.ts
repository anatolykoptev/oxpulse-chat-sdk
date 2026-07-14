/**
 * list-getthread-unseal-parity.test.ts — pr-review-council MED-3.
 *
 * #unsealFetchedRows' docstring claimed "Used by list(), getThread() and
 * searchByProductRef()" but list() was never migrated to call it — it kept a
 * DIVERGENT inline copy of the plaintext/E2EE dispatch that, unlike the shared
 * helper, does NOT fall back to the client-configured `#cryptoMode` when a
 * room's crypto_mode has not yet been discovered (parity with send()'s
 * `#activeCryptoModeByRoom.get(roomId) ?? #cryptoMode` resolution — client.ts
 * ~648/661).
 *
 * Reproduces the divergence directly: a `cryptoMode: 'plaintext'` client (no
 * e2ee) hitting a server response that omits the `crypto_mode` envelope field
 * (room stays undiscovered — see validateAndResolveCryptoMode, received ===
 * undefined preserves the current — unset — active mode). getThread() (already
 * on #unsealFetchedRows) correctly falls back to the configured 'plaintext'
 * expectation and aliases sealed bytes to `.plaintext`. Pre-fix, list()'s
 * inline branch does NOT: mode-undiscovered + no crypto provider falls through
 * to its final `else { items = rawItems }`, leaving `.plaintext` unset — a
 * silent behavioral divergence from its documented sibling.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { TEST_BASE_URL, TEST_JWT, makeListResponse } from './helpers.js';

const ROOM_LIST = 'room-parity-list';
const ROOM_THREAD = 'room-parity-thread';

/** A getThread response: bare JSON array (server wire contract), sealed_b64 = plaintext bytes. */
function makeThreadResponse(sealedB64: string): Response {
  return new Response(
    JSON.stringify([
      {
        seq: 1,
        msg_id: 'root-1',
        sender_uid: 'user-parity',
        sealed_b64: sealedB64,
        created_at: '2026-06-01T00:00:00Z',
        thread_root_msg_id: null,
        product_ref: null,
        product_meta: null,
      },
    ]),
    { status: 200 },
  );
}

describe('list() / getThread() unseal-mode parity for an undiscovered room (MED-3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('list() resolves plaintext identically to getThread() when the room mode is not yet discovered', async () => {
    const text = 'parity-check-плейнтекст';
    const sealedB64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));

    const client = new SDKChatClient({
      baseUrl: TEST_BASE_URL,
      jwt: TEST_JWT,
      cryptoMode: 'plaintext',
    });

    // list()'s response omits `crypto_mode` entirely — validateAndResolveCryptoMode
    // preserves the (unset) active mode, so ROOM_LIST stays undiscovered even
    // after this same call resolves.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(sealedB64));
    const listResult = await client.list(ROOM_LIST);

    // getThread() never writes crypto_mode either (by design — see its docstring),
    // so ROOM_THREAD is undiscovered too.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeThreadResponse(sealedB64));
    const threadRows = await client.getThread(ROOM_THREAD, 'root-1');

    expect(listResult.items).toHaveLength(1);
    expect(threadRows).toHaveLength(1);

    const listPlaintext = listResult.items[0]!.plaintext;
    const threadPlaintext = threadRows[0]!.plaintext;

    // Both resolve via the configured cryptoMode:'plaintext' fallback and decode
    // to the same original text — proving list() no longer diverges from getThread().
    expect(listPlaintext).toBeInstanceOf(ArrayBuffer);
    expect(threadPlaintext).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(listPlaintext as ArrayBuffer)).toBe(text);
    expect(new TextDecoder().decode(threadPlaintext as ArrayBuffer)).toBe(text);
  });
});
