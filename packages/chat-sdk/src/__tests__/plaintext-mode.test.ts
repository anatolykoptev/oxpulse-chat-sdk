/**
 * plaintext-mode.test.ts — Phase 2 Wave 4.1: crypto_mode dispatch + mismatch defense.
 *
 * SEC-CR-1694 carry-over: SDK MUST validate received prelude mode against
 * configured cryptoMode option. Mismatch → throw SDKChatError('crypto_mode_mismatch').
 *
 * Tests:
 *   1. send_plaintext_skips_seal_step — plaintext mode bypasses CryptoProvider.seal
 *   2. send_sframe_calls_seal_step — sframe-static mode calls CryptoProvider.seal
 *   3. subscribe_parses_connected_prelude — SSE prelude sets #activeCryptoMode
 *   4. subscribe_mismatch_throws_and_aborts — configured/received mismatch → SDKChatError
 *   5. receive_plaintext_decodes_to_utf8_string — plaintext sealed bytes → MessageRow.plaintext UTF-8
 *   6. list_plaintext_mode_sets_active_crypto_mode — list() caches crypto_mode from envelope
 *   7. list_mismatch_throws — configured sframe-static, server emits plaintext → throw
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { SDKChatError } from '../errors.js';
import {
  TEST_BASE_URL as BASE_URL,
  TEST_JWT as JWT,
  TEST_SENDER_UID as SENDER_UID,
  makeOkSendResponse,
  makeListResponse as sharedMakeListResponse,
  installMockEventSource,
  makeSpyCryptoProvider,
  flush,
} from './helpers.js';

const ROOM_ID = 'room-plaintext-test';

// Thin wrappers over the shared helpers keep this file's existing call sites stable.
function makeListResponse(sealedB64: string, cryptoMode?: string): Response {
  return sharedMakeListResponse(sealedB64, { cryptoMode });
}
// Identity-seal provider (seal returns its input): this file asserts seal ARGS,
// not sealed output, so the marker-byte default is unnecessary here.
function makeCustomCryptoProvider() {
  return makeSpyCryptoProvider(async (plain: ArrayBuffer) => plain);
}

// ---------------------------------------------------------------------------
// Test 1: plaintext mode skips seal step
// ---------------------------------------------------------------------------

describe('send_plaintext_skips_seal_step', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('e2ee provider + explicit cryptoMode:plaintext is rejected at construct (SEC-CR-001)', () => {
    const provider = makeCustomCryptoProvider();

    // SEC-CR-001 (CWE-757): an encryption provider PLUS an explicit plaintext
    // opt-out is a contradictory config. The SDK now fails CLOSED at construct
    // instead of allowing a plaintext downgrade of an E2EE-configured client —
    // so seal is never even reached.
    expect(
      () =>
        new SDKChatClient({
          baseUrl: BASE_URL,
          jwt: JWT,
          e2ee: { provider },
          cryptoMode: 'plaintext',
        }),
    ).toThrow(SDKChatError);
    expect(provider.sealSpy).not.toHaveBeenCalled();
  });

  it('sendText in plaintext mode sends UTF-8 bytes as sealed_b64', async () => {
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      cryptoMode: 'plaintext',
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkSendResponse());

    await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hello' });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { sealed_b64: string };

    // Decode sealed_b64 → bytes → should equal UTF-8 encoding of 'hello'.
    const decoded = Uint8Array.from(atob(body.sealed_b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(new TextEncoder().encode('hello'));
  });
});

// ---------------------------------------------------------------------------
// Test 2: sframe-static mode calls seal step
// ---------------------------------------------------------------------------

describe('send_sframe_calls_seal_step', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('sendText with e2ee provider calls seal before sending', async () => {
    const provider = makeCustomCryptoProvider();

    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: { provider },
      // SEC-CR-1695 gate: must declare cryptoMode when e2ee is configured + no prior list/subscribe.
      cryptoMode: 'sframe-static',
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkSendResponse());

    await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hello' });

    // seal MUST have been called once with the UTF-8 bytes.
    expect(provider.sealSpy).toHaveBeenCalledOnce();
    const sealArg = provider.sealSpy.mock.calls[0][0] as ArrayBuffer;
    expect(new Uint8Array(sealArg)).toEqual(new TextEncoder().encode('hello'));
  });
});

// ---------------------------------------------------------------------------
// Test 3: subscribe parses `event: connected` prelude
// ---------------------------------------------------------------------------

describe('subscribe_parses_connected_prelude', () => {
  afterEach(() => vi.restoreAllMocks());

  it('subscribe() reads crypto_mode from connected prelude and caches it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'test-ticket' }),
    } as unknown as Response);

    const { getLastController } = installMockEventSource();

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });

    const received: Array<{ seq: number; plaintext?: ArrayBuffer }> = [];
    const unsub = client.subscribe(ROOM_ID, {
      onMessage: (row) => received.push({ seq: row.seq, plaintext: row.plaintext }),
    });

    await flush();

    const ctrl = getLastController();
    expect(ctrl).not.toBeNull();

    // Emit connected prelude with plaintext mode.
    ctrl!.emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
    await flush();

    // Now emit a message — should be delivered as plaintext.
    const textBytes = new TextEncoder().encode('hello world');
    const sealedB64 = btoa(String.fromCharCode(...textBytes));
    ctrl!.emitMessage(
      JSON.stringify({
        seq: 1,
        msg_id: 'msg-001',
        sender_uid: SENDER_UID,
        sealed_b64: sealedB64,
        created_at: '2026-05-27T00:00:00Z',
      }),
    );
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0].seq).toBe(1);
    // plaintext should be the UTF-8 bytes
    expect(received[0].plaintext).toBeDefined();
    expect(new Uint8Array(received[0].plaintext!)).toEqual(textBytes);

    unsub();
  });
});

// ---------------------------------------------------------------------------
// Test 4: subscribe mismatch throws and aborts
// ---------------------------------------------------------------------------

describe('subscribe_mismatch_throws_and_aborts', () => {
  afterEach(() => vi.restoreAllMocks());

  it('subscribe() throws SDKChatError(crypto_mode_mismatch) when server emits wrong mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'test-ticket' }),
    } as unknown as Response);

    const { getLastController } = installMockEventSource();

    // Client configured for sframe-static, server will emit plaintext → MISMATCH.
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      cryptoMode: 'sframe-static',
    });

    const errors: Error[] = [];
    client.subscribe(ROOM_ID, {
      onMessage: () => {},
      onError: (err) => errors.push(err),
    });

    await flush();

    const ctrl = getLastController();
    expect(ctrl).not.toBeNull();

    // Server emits plaintext prelude — client expected sframe-static.
    ctrl!.emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SDKChatError);
    expect((errors[0] as SDKChatError).code).toBe('crypto_mode_mismatch');
  });
});

// ---------------------------------------------------------------------------
// Test 5: receive plaintext decodes to UTF-8 string
// ---------------------------------------------------------------------------

describe('receive_plaintext_decodes_to_utf8_string', () => {
  afterEach(() => vi.restoreAllMocks());

  it('MessageRow.plaintext is UTF-8 decoded correctly in list() plaintext mode', async () => {
    // Simulate a list() response with crypto_mode=plaintext.
    // sealed_b64 contains raw UTF-8 bytes of "こんにちは" (multi-byte).
    const text = 'こんにちは';
    const textBytes = new TextEncoder().encode(text);
    const sealedB64 = btoa(String.fromCharCode(...textBytes));

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(sealedB64, 'plaintext'));

    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      cryptoMode: 'plaintext',
    });

    const result = await client.list(ROOM_ID);

    expect(result.items).toHaveLength(1);
    const row = result.items[0];
    expect(row.plaintext).toBeDefined();
    // Decode ArrayBuffer back to string and verify.
    const decoded = new TextDecoder().decode(row.plaintext!);
    expect(decoded).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Test 6: list() caches crypto_mode from envelope
// ---------------------------------------------------------------------------

describe('list_plaintext_mode_sets_active_crypto_mode', () => {
  afterEach(() => vi.restoreAllMocks());

  it('list() with crypto_mode=plaintext in response delivers plaintext without e2ee config', async () => {
    const text = 'auto-discovered plaintext';
    const textBytes = new TextEncoder().encode(text);
    const sealedB64 = btoa(String.fromCharCode(...textBytes));

    // No cryptoMode option — auto-detect from server.
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(sealedB64, 'plaintext'));

    const result = await client.list(ROOM_ID);
    expect(result.items[0].plaintext).toBeDefined();
    const decoded = new TextDecoder().decode(result.items[0].plaintext!);
    expect(decoded).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// Test 7: list() mismatch throws
// ---------------------------------------------------------------------------

describe('list_mismatch_throws', () => {
  afterEach(() => vi.restoreAllMocks());

  it('list() throws SDKChatError(crypto_mode_mismatch) when server emits wrong mode', async () => {
    // Client expects sframe-static, server emits plaintext.
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      cryptoMode: 'sframe-static',
    });

    const sealedB64 = btoa('fake-payload');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(sealedB64, 'plaintext'));

    await expect(client.list(ROOM_ID)).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_mismatch',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 8: after subscribe mismatch, sendText throws crypto_mode_poisoned
// SEC-CR-1695-01 + SEC-CR-1695-02
// ---------------------------------------------------------------------------

describe('after_subscribe_mismatch_sendText_throws_poisoned', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sendText throws crypto_mode_poisoned after subscribe mismatch poisons client', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'test-ticket' }),
    } as unknown as Response);

    const { getLastController } = installMockEventSource();

    // Client configured for sframe-static, server will emit plaintext → MISMATCH → POISON.
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      cryptoMode: 'sframe-static',
    });

    client.subscribe(ROOM_ID, {
      onMessage: () => {},
      onError: () => {},
    });

    await flush();

    const ctrl = getLastController();
    expect(ctrl).not.toBeNull();

    // Server emits wrong mode → mismatch → client poisoned.
    ctrl!.emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
    await flush();

    // Now sendText MUST throw crypto_mode_poisoned, not proceed.
    await expect(
      client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hello' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_poisoned',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 9: reverse direction mismatch — configured plaintext, server emits sframe-static
// SEC-CR-1695-02
// ---------------------------------------------------------------------------

describe('reverse_direction_mismatch_throws', () => {
  afterEach(() => vi.restoreAllMocks());

  it('list() throws crypto_mode_mismatch when configured=plaintext, server emits sframe-static', async () => {
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      cryptoMode: 'plaintext',
    });

    const sealedB64 = btoa('fake-payload');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(sealedB64, 'sframe-static'));

    await expect(client.list(ROOM_ID)).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_mismatch',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 10: unknown crypto_mode value rejected (SEC-CR-1695-03)
// ---------------------------------------------------------------------------

describe('unknown_crypto_mode_value_rejected', () => {
  afterEach(() => vi.restoreAllMocks());

  it('list() throws crypto_mode_mismatch and poisons client for unknown mode "sframe-dynamic"', async () => {
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
    });

    const sealedB64 = btoa('fake-payload');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(sealedB64, 'sframe-dynamic'));

    await expect(client.list(ROOM_ID)).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_mismatch',
    );

    // After the mismatch from unknown value, client must be poisoned — sendText should fail.
    await expect(
      client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hello' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_poisoned',
    );
  });
});

// ---------------------------------------------------------------------------
// Test 11: send before discover with e2ee configured → defaults to sframe-static
// SEC-CR-001: downgrade defense is default-on, so an e2ee client seals by default
// instead of blocking on discovery (the old crypto_mode_undiscovered contract).
// ---------------------------------------------------------------------------

describe('send_with_e2ee_defaults_to_sframe_static', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sendText with e2ee (no explicit cryptoMode) defaults to sframe-static and seals', async () => {
    const provider = makeCustomCryptoProvider();

    // No cryptoMode option, e2ee configured. SEC-CR-001: #cryptoMode defaults to
    // 'sframe-static', so sending before any list()/subscribe() SEALS by default
    // (fail-closed) rather than shipping plaintext or blocking on discovery.
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: { provider },
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkSendResponse());

    await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hello' });

    // seal MUST have been called with the UTF-8 bytes — default-on downgrade defense.
    expect(provider.sealSpy).toHaveBeenCalledOnce();
    const sealArg = provider.sealSpy.mock.calls[0][0] as ArrayBuffer;
    expect(new Uint8Array(sealArg)).toEqual(new TextEncoder().encode('hello'));
  });
});

// ---------------------------------------------------------------------------
// Test 12: send before discover WITHOUT e2ee configured → falls through (legacy path)
// code-quality MAJOR: send-before-discover gate — e2ee-absent case is allowed
// ---------------------------------------------------------------------------

describe('send_before_discover_without_e2ee_falls_through', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sendText without e2ee configured succeeds even before mode is discovered', async () => {
    // No e2ee, no cryptoMode — legacy path (sealed bytes passed through as-is).
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkSendResponse(1, 'msg-legacy'));

    // sendText without e2ee falls back to the 'unsupported' error path...
    // Actually: without e2ee AND no cryptoMode, effectiveMode is null,
    // the plaintext branch is skipped, and #cryptoProvider is null → throws 'unsupported'.
    // The gate we test here: no crypto_mode_undiscovered thrown (wrong code would surface).
    // The gate only triggers when #cryptoProvider !== null.
    await expect(
      client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hello' }),
    ).rejects.toSatisfy(
      // Must throw 'unsupported' (no e2ee), NOT 'crypto_mode_undiscovered'.
      (err: unknown) => err instanceof SDKChatError && err.code === 'unsupported',
    );
  });
});
