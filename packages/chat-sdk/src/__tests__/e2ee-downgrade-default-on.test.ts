/**
 * e2ee-downgrade-default-on.test.ts — SEC-CR-001 (CWE-757 protocol downgrade).
 *
 * Threat model: a MALICIOUS or COMPROMISED app-server — the exact adversary E2EE
 * exists to defend against — returns `crypto_mode: 'plaintext'` in the `connected`
 * SSE prelude or a `list()` response. A consumer that enabled `e2ee` but did NOT
 * ALSO explicitly set `cryptoMode: 'sframe-static'` would, before this fix, silently
 * transmit `TextEncoder().encode(text)` UNSEALED — cleartext the server (the attacker)
 * reads. TLS does not help: the server IS the endpoint. RFC 8446 §4.1.3 / OWASP ASVS
 * v5 V11 require downgrade protection to be DEFAULT-ON.
 *
 * Fix: when an `e2ee` provider is configured, `#cryptoMode` defaults to 'sframe-static'
 * (NOT null), so a server-emitted `plaintext` becomes a POISON-mismatch (throw + tear
 * down + refuse to send). The poison + discovered mode are scoped PER ROOM, so one
 * room's downgrade cannot brick sibling rooms on the same client.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SDKChatClient } from '../client.js';
import { SDKChatError } from '../errors.js';
import {
  TEST_BASE_URL as BASE_URL,
  TEST_JWT as JWT,
  TEST_SENDER_UID as SENDER_UID,
  makeOkSendResponse,
  makeListResponse,
  installMockEventSource,
  makeSpyCryptoProvider,
  flush,
  decodeSentBody,
} from './helpers.js';

const ROOM_ID = 'room-downgrade-test';
const SECRET = 'nuclear-launch-codes';

// The send POST hits EXACTLY `${baseUrl}/api/sdk/messages`; list() uses
// `/api/sdk/messages?<params>` and subscribe uses `/api/sdk/messages/subscribe*`,
// so an exact-URL match uniquely identifies a message send.
const SEND_URL = `${BASE_URL}/api/sdk/messages`;
function isSendCall(call: unknown[]): boolean {
  return String(call[0]) === SEND_URL;
}

// ---------------------------------------------------------------------------
// RED 1 — list()-driven downgrade is REFUSED when e2ee is configured
// ---------------------------------------------------------------------------

describe('SEC-CR-001 list()-driven downgrade refused (e2ee, no explicit cryptoMode)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('list() with server crypto_mode=plaintext throws crypto_mode_mismatch', async () => {
    const provider = makeSpyCryptoProvider();
    // e2ee configured, NO explicit cryptoMode — the vulnerable config.
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeListResponse(btoa('irrelevant-payload'), { cryptoMode: 'plaintext' }),
    );

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

  it('connected prelude crypto_mode=plaintext surfaces mismatch and poisons the room', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'test-ticket' }),
    } as unknown as Response);
    const { getLastController } = installMockEventSource();

    const provider = makeSpyCryptoProvider();
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

    // The room is now poisoned — sendText must refuse, never ship cleartext.
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
    const provider = makeSpyCryptoProvider();

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
// RED 4 — PER-ROOM ISOLATION: one room's downgrade must NOT brick siblings
// (the availability regression the pr-review-council flagged as untested)
// ---------------------------------------------------------------------------

describe('SEC-CR-001 per-room poison isolation (one room downgrade must not brick siblings)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('room A downgrade poisons ONLY room A; room B (honest sframe-static) still seals + sends', async () => {
    const ROOM_A = 'room-A-downgraded';
    const ROOM_B = 'room-B-honest';

    const provider = makeSpyCryptoProvider();
    const { findController } = installMockEventSource();

    // subscribe-ticket → a room-specific ticket so each room's EventSource URL is
    // distinguishable; send → ok.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (url: unknown, init?: unknown) => {
        const u = String(url);
        if (u.endsWith('/api/sdk/messages/subscribe-ticket')) {
          const parsed = JSON.parse((init as RequestInit).body as string) as { room_id: string };
          return {
            ok: true,
            status: 200,
            json: async () => ({ ticket: `ticket-${parsed.room_id}` }),
          } as unknown as Response;
        }
        if (u === SEND_URL) return makeOkSendResponse();
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      },
    );

    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });

    const errorsA: Error[] = [];
    const errorsB: Error[] = [];
    client.subscribe(ROOM_A, { onMessage: () => {}, onError: (e) => errorsA.push(e) });
    client.subscribe(ROOM_B, { onMessage: () => {}, onError: (e) => errorsB.push(e) });
    await flush();

    const ctrlA = findController(`ticket-${ROOM_A}`);
    const ctrlB = findController(`ticket-${ROOM_B}`);
    expect(ctrlA).toBeDefined();
    expect(ctrlB).toBeDefined();

    // Malicious server downgrades room A; room B's stream is honest sframe-static.
    ctrlA!.emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
    ctrlB!.emitNamed('connected', JSON.stringify({ crypto_mode: 'sframe-static' }));
    await flush();

    // Room A: its own downgrade surfaced + poisoned it; sendText refuses (no cleartext).
    expect(
      errorsA.some((e) => e instanceof SDKChatError && e.code === 'crypto_mode_mismatch'),
    ).toBe(true);
    await expect(
      client.sendText(ROOM_A, { senderUid: SENDER_UID, text: SECRET }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'crypto_mode_poisoned',
    );

    // Room B: NOT bricked by room A's poison — it seals + sends successfully.
    // (Against a client-scoped poison this await would throw crypto_mode_poisoned → RED.)
    expect(errorsB).toHaveLength(0);
    const res = await client.sendText(ROOM_B, { senderUid: SENDER_UID, text: SECRET });
    expect(res.seq).toBe(1);
    expect(provider.sealSpy).toHaveBeenCalled();

    // Ground truth: the ONLY send that reached the wire was room B's, and it's sealed.
    const sends = fetchSpy.mock.calls.filter(isSendCall);
    expect(sends.length).toBe(1); // room A never sent (refused)
    const { asText } = decodeSentBody(sends[0][1] as RequestInit);
    expect(asText).not.toBe(SECRET);
  });
});

// ---------------------------------------------------------------------------
// RED 5 — a poisoned room refuses EVERY content-bearing send entrypoint.
// (Exhaustive gate: send/sendText/batchAppend/sendProductCard/updateMessage/sendFile —
//  the writes that transmit a message/file payload the room's crypto_mode governs.
//  A future content-write method added without #assertRoomNotPoisoned should be added
//  to this enumeration and will fail here if left ungated.)
// ---------------------------------------------------------------------------

describe('SEC-CR-001 poisoned room refuses every content-bearing send entrypoint', () => {
  afterEach(() => vi.restoreAllMocks());

  async function poisonRoom(client: SDKChatClient, getLastController: () => { emitNamed(t: string, d: string): void } | null) {
    client.subscribe(ROOM_ID, { onMessage: () => {}, onError: () => {} });
    await flush();
    getLastController()!.emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
    await flush();
  }

  const isPoisoned = (e: unknown) => e instanceof SDKChatError && e.code === 'crypto_mode_poisoned';

  it('batchAppend / sendProductCard / updateMessage / sendFile all throw crypto_mode_poisoned', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'test-ticket' }),
    } as unknown as Response);
    const { getLastController } = installMockEventSource();

    const provider = makeSpyCryptoProvider();
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });
    await poisonRoom(client, getLastController);

    // send()/sendText() are already covered above; here the direct-fetch content writes:
    await expect(
      client.batchAppend(ROOM_ID, [
        { msgId: 'm1', sealed: new TextEncoder().encode('x').buffer as ArrayBuffer },
      ]),
    ).rejects.toSatisfy(isPoisoned);

    await expect(
      client.sendProductCard(ROOM_ID, {
        productRef: 'p1',
        productMeta: {
          title: 't',
          price: 1,
          currency: 'USD',
          imageUrl: 'http://x/i.png',
          productUrl: 'http://x/p',
        },
        senderUid: SENDER_UID,
      }),
    ).rejects.toSatisfy(isPoisoned);

    await expect(
      client.updateMessage(ROOM_ID, 'm1', {
        sealed: new TextEncoder().encode('edited').buffer as ArrayBuffer,
      }),
    ).rejects.toSatisfy(isPoisoned);

    await expect(
      client.sendFile(ROOM_ID, new Blob(['file-bytes']), {
        senderUid: SENDER_UID,
        sealed: new TextEncoder().encode('sealed').buffer as ArrayBuffer,
        sha256: 'deadbeef',
      }),
    ).rejects.toSatisfy(isPoisoned);
  });
});

// ---------------------------------------------------------------------------
// RED 6 — per-room crypto state lifecycle: discovered-mode evicted on last teardown,
// poison stays sticky (bounds unbounded growth without weakening fail-closed).
// ---------------------------------------------------------------------------

describe('SEC-CR-001 per-room crypto state lifecycle (evict mode on teardown, poison sticky)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('discovered crypto-mode is evicted on last teardown AND a post-eviction send re-seals', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: unknown) => {
      if (String(url) === SEND_URL) return makeOkSendResponse();
      return { ok: true, status: 200, json: async () => ({ ticket: 'test-ticket' }) } as unknown as Response;
    });
    const { getLastController } = installMockEventSource();

    const provider = makeSpyCryptoProvider();
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });

    const unsub = client.subscribe(ROOM_ID, { onMessage: () => {}, onError: () => {} });
    await flush();
    // Honest server mode → room discovers sframe-static (NOT poisoned).
    getLastController()!.emitNamed('connected', JSON.stringify({ crypto_mode: 'sframe-static' }));
    await flush();

    expect(client._roomCryptoStateSize().modes).toBe(1);
    expect(client._roomCryptoStateSize().poisoned).toBe(0);

    unsub();
    await flush();

    // Last subscriber gone → discovered-mode entry released (bounded growth).
    expect(client._roomCryptoStateSize().modes).toBe(0);

    // NIT-2 security corollary: after eviction, effectiveMode falls back to the
    // sframe-static DEFAULT (not plaintext) — a send still SEALS, never leaks cleartext.
    await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: SECRET });
    expect(provider.sealSpy).toHaveBeenCalled();
    const sendCall = fetchSpy.mock.calls.find(isSendCall);
    expect(sendCall).toBeDefined();
    const { asText } = decodeSentBody(sendCall![1] as RequestInit);
    expect(asText).not.toBe(SECRET);
  });

  it('poison survives teardown and re-subscribe (sticky fail-closed)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'test-ticket' }),
    } as unknown as Response);
    const { getLastController } = installMockEventSource();

    const provider = makeSpyCryptoProvider();
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });

    // Downgrade → poison. The mismatch tears the subscription down internally.
    client.subscribe(ROOM_ID, { onMessage: () => {}, onError: () => {} });
    await flush();
    getLastController()!.emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
    await flush();

    expect(client._roomCryptoStateSize().poisoned).toBe(1);

    // Poison is client-lifetime sticky: re-subscribing the poisoned room fails closed.
    expect(() => client.subscribe(ROOM_ID, { onMessage: () => {}, onError: () => {} })).toThrow(
      SDKChatError,
    );
    expect(client._roomCryptoStateSize().poisoned).toBe(1); // NOT evicted
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeListResponse(sealedB64, { cryptoMode: 'plaintext' }),
    );

    const result = await client.list(ROOM_ID);
    expect(result.items).toHaveLength(1);
    expect(new TextDecoder().decode(result.items[0].plaintext!)).toBe(text);
  });

  it('no e2ee provider — sendText in server-discovered plaintext mode sends UTF-8 bytes', async () => {
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });

    // Discover plaintext from a list() first.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValueOnce(makeListResponse(btoa('seed'), { cryptoMode: 'plaintext' }));
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
    const provider = makeSpyCryptoProvider();
    // e2ee, no explicit cryptoMode — now defaults to sframe-static.
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT, e2ee: { provider } });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    // list() confirms the honest server mode; must NOT throw.
    fetchSpy.mockResolvedValueOnce(makeListResponse(btoa('seed'), { cryptoMode: 'sframe-static' }));
    await expect(client.list(ROOM_ID)).resolves.toBeDefined();

    fetchSpy.mockResolvedValueOnce(makeOkSendResponse(3, 'msg-003'));
    await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: SECRET });

    expect(provider.sealSpy).toHaveBeenCalledOnce();
    const sendCall = fetchSpy.mock.calls.find(isSendCall);
    const { asText } = decodeSentBody(sendCall![1] as RequestInit);
    expect(asText).not.toBe(SECRET); // sealed, not cleartext
  });

  it('e2ee client can send immediately (default sframe-static) without prior discovery', async () => {
    const provider = makeSpyCryptoProvider();
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
    const provider = makeSpyCryptoProvider();
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
    const provider = makeSpyCryptoProvider();
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
