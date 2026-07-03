/**
 * e2ee-downgrade-default-on.test.ts — SEC-CR-001 (CWE-757 protocol downgrade).
 *
 * Threat model: a MALICIOUS or COMPROMISED app-server — the exact adversary
 * E2EE exists to defend against — returns `crypto_mode: 'plaintext'` in the
 * `connected` SSE prelude or a `list()` response. A consumer that enabled
 * `e2ee` but did NOT ALSO explicitly set `cryptoMode: 'sframe-static'` would,
 * before this fix, silently transmit `TextEncoder().encode(text)` UNSEALED —
 * cleartext the server (the attacker) reads. TLS does not help: the server IS
 * the endpoint. RFC 8446 §4.1.3 / OWASP ASVS v5 V11 require downgrade
 * protection to be DEFAULT-ON.
 *
 * Fix: when an `e2ee` provider is configured, `#cryptoMode` defaults to
 * 'sframe-static' (NOT null), so a server-emitted `plaintext` becomes a
 * POISON-mismatch (throw + tear down + refuse to send) instead of an accepted
 * downgrade. When `e2ee` is NOT configured, plaintext stays a valid
 * auto-detected mode (default null preserved).
 *
 * These tests are RED against main 9aad0c1 (downgrade accepted, cleartext on
 * the wire) and GREEN after the default-on fix.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { SDKChatError } from '../errors.js';
import type { CryptoProvider } from '../types.js';

const BASE_URL = 'http://x';
const JWT = 'test-token';
const ROOM_ID = 'room-downgrade-test';
const SENDER_UID = 'user-test-1';
const SECRET = 'nuclear-launch-codes';

// ---------------------------------------------------------------------------
// Helpers (mirrors plaintext-mode.test.ts harness)
// ---------------------------------------------------------------------------

function makeOkSendResponse(seq = 1, msgId = 'msg-001'): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ seq, msg_id: msgId }),
  } as unknown as Response;
}

function makeListResponse(sealedB64: string, cryptoMode?: string): Response {
  const body: Record<string, unknown> = {
    items: [
      {
        seq: 1,
        msg_id: 'msg-001',
        sender_uid: SENDER_UID,
        sealed_b64: sealedB64,
        created_at: '2026-05-27T00:00:00Z',
        thread_root_msg_id: null,
        product_ref: null,
        product_meta: null,
      },
    ],
    has_more: false,
    next_cursor: null,
  };
  if (cryptoMode !== undefined) {
    body['crypto_mode'] = cryptoMode;
  }
  return new Response(JSON.stringify(body), { status: 200 });
}

function makeCustomCryptoProvider(): CryptoProvider & { sealSpy: ReturnType<typeof vi.fn> } {
  // seal() marks its output so any *sealed* body is distinguishable from cleartext.
  const sealSpy = vi.fn(async (plain: ArrayBuffer) => {
    const src = new Uint8Array(plain);
    const out = new Uint8Array(src.length + 1);
    out[0] = 0x01; // sframe-ish marker byte — proves seal ran
    out.set(src, 1);
    return out.buffer;
  });
  return {
    sealSpy,
    seal: sealSpy,
    unseal: vi.fn(async (cipher: ArrayBuffer) => cipher),
  } as CryptoProvider & { sealSpy: ReturnType<typeof vi.fn> };
}

interface MockESController {
  emitNamed(type: string, data: string): void;
  emitMessage(data: string): void;
  emitError(): void;
}

function installMockEventSource(): { getLastController: () => MockESController | null } {
  let lastController: MockESController | null = null;
  class MockES {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    private _listeners: Map<string, Array<(ev: MessageEvent) => void>> = new Map();
    constructor(_url: string) {
      const self = this;
      lastController = {
        emitNamed: (type: string, data: string) => {
          const cbs = self._listeners.get(type) ?? [];
          const ev = Object.assign(new Event(type), { data }) as MessageEvent;
          for (const cb of cbs) cb(ev);
        },
        emitMessage: (data: string) => {
          self.onmessage?.({ data } as MessageEvent);
        },
        emitError: () => {
          self.onerror?.(new Event('error'));
        },
      };
    }
    addEventListener(type: string, cb: (ev: MessageEvent) => void) {
      const arr = this._listeners.get(type) ?? [];
      arr.push(cb);
      this._listeners.set(type, arr);
    }
    close() {}
  }
  vi.stubGlobal('EventSource', MockES);
  return { getLastController: () => lastController };
}

async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// The send POST hits EXACTLY `${baseUrl}/api/sdk/messages`; list() uses
// `/api/sdk/messages?<params>` and subscribe uses `/api/sdk/messages/subscribe*`,
// so an exact-URL match uniquely identifies a message send.
const SEND_URL = `${BASE_URL}/api/sdk/messages`;
function isSendCall(call: unknown[]): boolean {
  return String(call[0]) === SEND_URL;
}

/** Decode a send fetch call's sealed_b64 back to a UTF-8 string. */
function decodeSentBody(init: RequestInit): { sealedB64: string; asText: string } {
  const body = JSON.parse(init.body as string) as { sealed_b64: string };
  const bytes = Uint8Array.from(atob(body.sealed_b64), (c) => c.charCodeAt(0));
  return { sealedB64: body.sealed_b64, asText: new TextDecoder().decode(bytes) };
}

// ---------------------------------------------------------------------------
// RED 1 — list()-driven downgrade is REFUSED when e2ee is configured
// ---------------------------------------------------------------------------

describe('SEC-CR-001 list()-driven downgrade refused (e2ee, no explicit cryptoMode)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('list() with server crypto_mode=plaintext throws crypto_mode_mismatch', async () => {
    const provider = makeCustomCryptoProvider();
    // e2ee configured, NO explicit cryptoMode — the vulnerable config.
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });

    const sealedB64 = btoa('irrelevant-payload');
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(sealedB64, 'plaintext'));

    // Default-on downgrade defense: configured mode is pinned to sframe-static,
    // so a server 'plaintext' is a mismatch, not an accepted downgrade.
    await expect(client.list(ROOM_ID)).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_mismatch',
    );
  });
});

// ---------------------------------------------------------------------------
// RED 2 — prelude-driven downgrade poisons; sendText then refuses
// ---------------------------------------------------------------------------

describe('SEC-CR-001 prelude-driven downgrade poisons + sendText refuses', () => {
  afterEach(() => vi.restoreAllMocks());

  it('connected prelude crypto_mode=plaintext surfaces mismatch and poisons the client', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'test-ticket' }),
    } as unknown as Response);
    const { getLastController } = installMockEventSource();

    const provider = makeCustomCryptoProvider();
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });

    const errors: Error[] = [];
    client.subscribe(ROOM_ID, { onMessage: () => {}, onError: (e) => errors.push(e) });
    await flush();

    const ctrl = getLastController();
    expect(ctrl).not.toBeNull();

    // Malicious server tries to downgrade the E2EE room to plaintext.
    ctrl!.emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
    await flush();

    expect(
      errors.some((e) => e instanceof SDKChatError && e.code === 'crypto_mode_mismatch'),
    ).toBe(true);

    // Client is now poisoned — sendText must refuse, never ship cleartext.
    await expect(
      client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: SECRET }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_poisoned',
    );
  });
});

// ---------------------------------------------------------------------------
// RED 3 — GROUND TRUTH: cleartext must NEVER reach the wire
// ---------------------------------------------------------------------------

describe('SEC-CR-001 cleartext never on the wire under a server downgrade', () => {
  afterEach(() => vi.restoreAllMocks());

  it('no /api/sdk/messages send carries the plaintext SECRET after a server plaintext signal', async () => {
    const { getLastController } = installMockEventSource();
    const provider = makeCustomCryptoProvider();

    // fetch handles: subscribe ticket, subscribe stream, and any send attempt.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      if (String(url) === SEND_URL) return makeOkSendResponse(); // the message-send POST only
      // ticket / subscribe handshake
      return { ok: true, status: 200, json: async () => ({ ticket: 'test-ticket' }) } as unknown as Response;
    });

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    client.subscribe(ROOM_ID, { onMessage: () => {}, onError: () => {} });
    await flush();

    // Server attempts the downgrade.
    getLastController()!.emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
    await flush();

    // A consumer tries to send a secret. It MUST either be sealed or refused —
    // under NO circumstance may the raw SECRET appear in a POST body.
    try {
      await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: SECRET });
    } catch {
      // refusal is an acceptable fail-closed outcome
    }

    const sends = fetchSpy.mock.calls.filter(isSendCall);
    for (const call of sends) {
      const init = call[1] as RequestInit;
      const { asText } = decodeSentBody(init);
      expect(asText).not.toBe(SECRET); // cleartext on the wire = confidentiality break
    }
  });
});

// ---------------------------------------------------------------------------
// GREEN regression (a) — no-e2ee client still uses plaintext normally
// ---------------------------------------------------------------------------

describe('SEC-CR-001 regression: no-e2ee client keeps plaintext auto-detect', () => {
  afterEach(() => vi.restoreAllMocks());

  it('no e2ee provider — server crypto_mode=plaintext is accepted and delivered', async () => {
    const text = 'plaintext room is fine without e2ee';
    const sealedB64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)));

    // No e2ee, no cryptoMode — plaintext is a legitimate, intended mode.
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeListResponse(sealedB64, 'plaintext'));

    const result = await client.list(ROOM_ID);
    expect(result.items).toHaveLength(1);
    expect(new TextDecoder().decode(result.items[0].plaintext!)).toBe(text);
  });

  it('no e2ee provider — sendText in server-discovered plaintext mode sends UTF-8 bytes', async () => {
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });

    // Discover plaintext from a list() first.
    const sealedB64 = btoa('seed');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(makeListResponse(sealedB64, 'plaintext'));
    await client.list(ROOM_ID);

    fetchSpy.mockResolvedValueOnce(makeOkSendResponse(2, 'msg-002'));
    await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hello' });

    const sendCall = fetchSpy.mock.calls.find(isSendCall);
    expect(sendCall).toBeDefined();
    const { asText } = decodeSentBody(sendCall![1] as RequestInit);
    expect(asText).toBe('hello'); // plaintext room legitimately ships cleartext
  });
});

// ---------------------------------------------------------------------------
// GREEN regression (b) — e2ee client + honest sframe-static server still works
// ---------------------------------------------------------------------------

describe('SEC-CR-001 regression: e2ee client with honest sframe-static server', () => {
  afterEach(() => vi.restoreAllMocks());

  it('server crypto_mode=sframe-static — sendText seals and ships ciphertext (no cleartext)', async () => {
    const provider = makeCustomCryptoProvider();
    // e2ee, no explicit cryptoMode — now defaults to sframe-static.
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // list() confirms the honest server mode; must NOT throw.
    fetchSpy.mockResolvedValueOnce(makeListResponse(btoa('seed'), 'sframe-static'));
    await expect(client.list(ROOM_ID)).resolves.toBeDefined();

    fetchSpy.mockResolvedValueOnce(makeOkSendResponse(3, 'msg-003'));
    await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: SECRET });

    expect(provider.sealSpy).toHaveBeenCalledOnce();
    const sendCall = fetchSpy.mock.calls.find(isSendCall);
    const { asText } = decodeSentBody(sendCall![1] as RequestInit);
    expect(asText).not.toBe(SECRET); // sealed, not cleartext
  });

  it('e2ee client can send immediately (default sframe-static) without prior discovery', async () => {
    const provider = makeCustomCryptoProvider();
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(makeOkSendResponse());
    await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hi' });

    expect(provider.sealSpy).toHaveBeenCalledOnce(); // seals by default, no undiscovered throw
    const { asText } = decodeSentBody(fetchSpy.mock.calls[0]![1] as RequestInit);
    expect(asText).not.toBe('hi');
  });
});

// ---------------------------------------------------------------------------
// GREEN regression (c) — explicit cryptoMode:'plaintext' + e2ee is contradictory
// ---------------------------------------------------------------------------

describe('SEC-CR-001 explicit plaintext + e2ee is rejected at construct', () => {
  it('constructing with e2ee provider AND cryptoMode:plaintext throws invalid_args', () => {
    const provider = makeCustomCryptoProvider();
    expect(
      () =>
        new SDKChatClient({
          baseUrl: BASE_URL,
          jwt: JWT,
          e2ee: { provider },
          cryptoMode: 'plaintext',
        }),
    ).toThrow(SDKChatError);
  });

  it('the contradictory-config throw carries code invalid_args', () => {
    const provider = makeCustomCryptoProvider();
    let caught: unknown;
    try {
      new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider }, cryptoMode: 'plaintext' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SDKChatError);
    expect((caught as SDKChatError).code).toBe('invalid_args');
  });
});
