/**
 * e2ee.test.ts — W6: SFrame E2EE provider tests.
 *
 * TDD: tests written FIRST (RED), then implementation (GREEN).
 *
 * Tests:
 *   1. seal/unseal round-trip — plaintext 'hi' → sealed → unsealed → 'hi'
 *   2. sendText auto-seals via provider — POST body's sealed_b64 ≠ utf-8 of 'hi'
 *   3. sendText throws SDKChatError without e2ee — defensive guard
 *   4. list() post-decrypts rows when e2ee — result.items[0].plaintext === expected bytes
 *   --- M1 additions ---
 *   5. sendTextOptimistic seals before enqueue — body sealed_b64 ≠ plaintext
 *   6. sendOptimistic + e2ee configured → emits runtime warning on first call
 *   --- M2 additions ---
 *   7. list() preserves row with unsealError: 'auth' on tampered ciphertext
 *   8. list() flags unsealError: 'replay' on replayed sealed bytes
 *   --- M3 additions ---
 *   9. subscribe times out stuck unseal after 5s → delivers with unsealError: 'unknown'
 *   --- M6 additions ---
 *   10. wrong-key: provider A seals, provider B unseals → unsealError defined
 *   11. custom CryptoProvider instance (provider: CryptoProvider path)
 *   12. sendText with empty plaintext (text === '')
 *   13. sendText throws without e2ee (coverage check)
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSFrameProvider } from '../sframe.js';
import { SDKChatClient } from '../client.js';
import { SDKChatError } from '../errors.js';
import type { CryptoProvider, SealContext } from '../types.js';

const BASE_URL = 'http://x';
const JWT = 'test-token';
const ROOM_ID = 'room-test-1';
const SENDER_UID = 'user-test-1';

/** Create a shared HKDF base-key from 32 random bytes (demo-style). */
async function makeHkdfKey(): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return crypto.subtle.importKey(
    'raw',
    raw,
    'HKDF',
    false,
    ['deriveKey', 'deriveBits'],
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SFrame E2EE provider', () => {
  it('seal/unseal round-trip preserves plaintext', async () => {
    const key = await makeHkdfKey();
    const provider = createSFrameProvider({
      getKey: async (_roomId) => key,
    });

    const encoder = new TextEncoder();
    const plaintext = encoder.encode('hi').buffer as ArrayBuffer;

    const sealed = await provider.seal(plaintext, { roomId: ROOM_ID, senderUid: SENDER_UID });
    const unsealed = await provider.unseal(sealed, { roomId: ROOM_ID, senderUid: SENDER_UID });

    expect(new Uint8Array(unsealed)).toEqual(encoder.encode('hi'));
  });

  it('sendText auto-seals: POST body sealed_b64 is not utf-8 of the text', async () => {
    const key = await makeHkdfKey();
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: {
        provider: 'sframe',
        getKey: async (_roomId) => key,
      },
      // SEC-CR-1695 gate: must declare cryptoMode when e2ee is configured + no prior list/subscribe.
      cryptoMode: 'sframe-static',
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seq: 1, msg_id: 'm1' }),
        { status: 200 },
      ),
    );

    await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hi' });

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const bodyStr = call[1].body as string;
    const body = JSON.parse(bodyStr) as { sealed_b64: string };
    const sealedBytes = Uint8Array.from(atob(body.sealed_b64), (c) => c.charCodeAt(0));

    // Sealed bytes must NOT equal utf-8 encoding of 'hi'.
    const hiBytes = new TextEncoder().encode('hi');
    expect(sealedBytes).not.toEqual(hiBytes);

    // Sealed output must have overhead beyond plaintext (SFrame header + AEAD tag).
    expect(sealedBytes.length).toBeGreaterThan(hiBytes.length);
  });

  it('sendText throws SDKChatError with code unsupported when no e2ee config', async () => {
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
    });

    await expect(
      client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hi' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'unsupported',
    );
  });

  it('list() post-decrypts rows when e2ee is configured', async () => {
    const key = await makeHkdfKey();

    // Pre-encrypt a known plaintext so the mock response contains real ciphertext.
    const provider = createSFrameProvider({ getKey: async (_roomId) => key });
    const plaintext = new TextEncoder().encode('hello');
    const sealedBuf = await provider.seal(plaintext.buffer as ArrayBuffer, {
      roomId: ROOM_ID,
      senderUid: SENDER_UID,
    });
    const sealedB64 = btoa(String.fromCharCode(...new Uint8Array(sealedBuf)));

    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: {
        provider: 'sframe',
        getKey: async (_roomId) => key,
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [
            {
              seq: 1,
              msg_id: 'm1',
              sender_uid: SENDER_UID,
              sealed_b64: sealedB64,
              created_at: '2026-05-18T00:00:00Z',
              thread_root_msg_id: null,
              product_ref: null,
              product_meta: null,
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
        { status: 200 },
      ),
    );

    const result = await client.list(ROOM_ID);

    expect(result.items).toHaveLength(1);
    const row = result.items[0];
    expect(row.plaintext).toBeDefined();
    const decrypted = new Uint8Array(row.plaintext!);
    expect(decrypted).toEqual(new TextEncoder().encode('hello'));
  });
});

// ── M1: sendTextOptimistic + outbox bypass guard ──────────────────────────────

describe('sendTextOptimistic (M1: E2EE outbox bypass fix)', () => {
  it('sendTextOptimistic seals before enqueue — POST body sealed_b64 is not plaintext', async () => {
    const key = await makeHkdfKey();
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: {
        provider: 'sframe',
        getKey: async (_roomId) => key,
      },
      _testNoSleep: true,
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seq: 2, msg_id: 'm2' }),
        { status: 200 },
      ),
    );

    let pendingFired = false;
    let succeededResult: { seq: number; msgId: string } | null = null;

    const handle = client.sendTextOptimistic(ROOM_ID, { senderUid: SENDER_UID, text: 'hello' });
    handle
      .onPending(() => { pendingFired = true; })
      .onSucceeded((r) => { succeededResult = r; });

    await handle.done;

    expect(pendingFired).toBe(true);
    expect(succeededResult).not.toBeNull();
    expect(succeededResult!.seq).toBe(2);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { sealed_b64: string };
    const sealedBytes = Uint8Array.from(atob(body.sealed_b64), (c) => c.charCodeAt(0));
    const helloBytes = new TextEncoder().encode('hello');

    // Sealed bytes must NOT equal utf-8 encoding of 'hello'.
    expect(sealedBytes).not.toEqual(helloBytes);
    // Sealed output has overhead (SFrame header + AEAD tag).
    expect(sealedBytes.length).toBeGreaterThan(helloBytes.length);
  });

  it('sendOptimistic + e2ee configured → emits runtime warning on first call', async () => {
    const key = await makeHkdfKey();
    // Use a provider to seal so we have a valid sealed buffer
    const provider = createSFrameProvider({ getKey: async () => key });
    const sealed = await provider.seal(new TextEncoder().encode('raw').buffer as ArrayBuffer, {
      roomId: ROOM_ID,
      senderUid: SENDER_UID,
    });

    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: {
        provider: 'sframe',
        getKey: async (_roomId) => key,
      },
      _testNoSleep: true,
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seq: 3, msg_id: 'm3' }),
        { status: 200 },
      ),
    );

    const handle = client.sendOptimistic(ROOM_ID, { senderUid: SENDER_UID, sealed });
    await handle.done;

    // Warning must have been emitted (caller should use sendTextOptimistic instead)
    const warnCalls = warnSpy.mock.calls.flat().join(' ');
    expect(warnCalls).toMatch(/\[chat-sdk\]/);
    expect(warnCalls).toMatch(/e2ee/);

    warnSpy.mockRestore();
  });
});

// ── M2: list() preserves unseal-failed rows ───────────────────────────────────

describe('list() unseal error preservation (M2)', () => {
  it('preserves row with unsealError: auth on tampered ciphertext', async () => {
    const key = await makeHkdfKey();

    // Pre-encrypt valid ciphertext, then tamper a byte
    const provider = createSFrameProvider({ getKey: async () => key });
    const sealedBuf = await provider.seal(new TextEncoder().encode('secret').buffer as ArrayBuffer, {
      roomId: ROOM_ID,
      senderUid: SENDER_UID,
    });
    const tamperedBytes = new Uint8Array(sealedBuf.slice(0));
    // Flip the last byte (AEAD tag region)
    tamperedBytes[tamperedBytes.length - 1] ^= 0xff;
    const tamperedB64 = btoa(String.fromCharCode(...tamperedBytes));

    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: {
        provider: 'sframe',
        getKey: async (_roomId) => key,
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [{
            seq: 1, msg_id: 'm1', sender_uid: SENDER_UID,
            sealed_b64: tamperedB64,
            created_at: '2026-05-18T00:00:00Z',
            thread_root_msg_id: null, product_ref: null, product_meta: null,
          }],
          has_more: false, next_cursor: null,
        }),
        { status: 200 },
      ),
    );

    const result = await client.list(ROOM_ID);

    // Row must be preserved (not dropped)
    expect(result.items).toHaveLength(1);
    expect(result.items[0].unsealError).toBe('auth');
    expect(result.items[0].plaintext).toBeUndefined();
  });

  it('flags unsealError: replay on replayed sealed bytes (same CTR)', async () => {
    const key = await makeHkdfKey();

    // Create provider (will be reused by the client for both list calls)
    const externalProvider = createSFrameProvider({ getKey: async () => key });
    const sealedBuf = await externalProvider.seal(
      new TextEncoder().encode('msg').buffer as ArrayBuffer,
      { roomId: ROOM_ID, senderUid: SENDER_UID },
    );
    const sealedB64 = btoa(String.fromCharCode(...new Uint8Array(sealedBuf)));

    // Create client using the SAME provider instance (so replay window is shared)
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: { provider: externalProvider },
    });

    const mockRow = {
      seq: 1, msg_id: 'm1', sender_uid: SENDER_UID,
      sealed_b64: sealedB64,
      created_at: '2026-05-18T00:00:00Z',
      thread_root_msg_id: null, product_ref: null, product_meta: null,
    };

    // First list: should succeed (unseal OK, registers CTR in replay window)
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ items: [mockRow], has_more: false, next_cursor: null }),
        { status: 200 },
      ),
    );
    const result1 = await client.list(ROOM_ID);
    expect(result1.items[0].unsealError).toBeUndefined();
    expect(result1.items[0].plaintext).toBeDefined();

    // Second list with same sealed bytes: replay → row preserved with unsealError: 'replay'
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ items: [mockRow], has_more: false, next_cursor: null }),
        { status: 200 },
      ),
    );
    const result2 = await client.list(ROOM_ID);
    expect(result2.items).toHaveLength(1);
    expect(result2.items[0].unsealError).toBe('replay');
    expect(result2.items[0].plaintext).toBeUndefined();
  });
});

// ── M3: subscribe timeout on stuck unseal ────────────────────────────────────

describe('subscribe per-room decrypt chain (M3)', () => {
  it('subscribe times out stuck unseal after 5s — delivers with unsealError: unknown', async () => {
    vi.useFakeTimers();

    // Custom provider: unseal never resolves
    const mockProvider: CryptoProvider = {
      async seal(plaintext: ArrayBuffer, _ctx: SealContext): Promise<ArrayBuffer> { return plaintext; },
      async unseal(_sealed: ArrayBuffer, _ctx: SealContext, signal?: AbortSignal): Promise<ArrayBuffer> {
        // Hangs until the SDK's 5s deadline aborts the signal, then rejects — a
        // signal-honoring provider (fix/e2ee-unseal-cancel). The SDK now gates the
        // room's chain on this REAL settle, so the abort is what surfaces the row as
        // unsealError instead of abandoning a still-running unseal.
        return new Promise<ArrayBuffer>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      },
    };

    type EventListenerMap = Record<string, (ev: MessageEvent) => void>;
    class FakeEventSource {
      url: string;
      listeners: EventListenerMap = {};
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) { this.url = url; }
      addEventListener(type: string, cb: (ev: MessageEvent) => void) { this.listeners[type] = cb; }
      close() {}
    }
    let capturedES: FakeEventSource | null = null;
    vi.stubGlobal('EventSource', class {
      constructor(url: string) { capturedES = new FakeEventSource(url); return capturedES; }
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ ticket: 'test-ticket' }),
      text: async () => '',
    } as unknown as Response));

    const client = new SDKChatClient({
      baseUrl: BASE_URL, jwt: JWT,
      e2ee: { provider: mockProvider },
    });

    const receivedMessages: Array<{ seq: number; unsealError?: string }> = [];
    client.subscribe(ROOM_ID, {
      onMessage: (row) => {
        receivedMessages.push({ seq: row.seq, unsealError: row.unsealError });
      },
    });

    // Let ticket fetch + subscribe attach happen
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(capturedES).not.toBeNull();

    // Fire a synthetic SSE message
    const msgPayload = JSON.stringify({
      seq: 1, msg_id: 'm1', sender_uid: SENDER_UID,
      sealed_b64: btoa('fake'),
      created_at: '2026-05-18T00:00:00Z',
    });
    capturedES!.onmessage?.({ data: msgPayload } as MessageEvent);

    // Advance past 5s timeout
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5100);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // After timeout: message delivered with unsealError: 'unknown'
    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0].unsealError).toBe('unknown');
    expect(receivedMessages[0].seq).toBe(1);

    vi.useRealTimers();
  });
});

// ── M6: adversarial tests ─────────────────────────────────────────────────────

describe('E2EE adversarial cases (M6)', () => {
  it('wrong-key: provider A seals, provider B (different key) unseals → unsealError defined', async () => {
    const keyA = await makeHkdfKey();
    const keyB = await makeHkdfKey(); // different key

    const providerA = createSFrameProvider({ getKey: async () => keyA });
    const providerB = createSFrameProvider({ getKey: async () => keyB });

    const sealedBuf = await providerA.seal(
      new TextEncoder().encode('secret').buffer as ArrayBuffer,
      { roomId: ROOM_ID, senderUid: SENDER_UID },
    );
    const sealedB64 = btoa(String.fromCharCode(...new Uint8Array(sealedBuf)));

    // Client B uses keyB — cannot unseal what A sealed with keyA
    const clientB = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: { provider: providerB },
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [{
            seq: 1, msg_id: 'm1', sender_uid: SENDER_UID,
            sealed_b64: sealedB64,
            created_at: '2026-05-18T00:00:00Z',
            thread_root_msg_id: null, product_ref: null, product_meta: null,
          }],
          has_more: false, next_cursor: null,
        }),
        { status: 200 },
      ),
    );

    const result = await clientB.list(ROOM_ID);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].unsealError).toBeDefined();
    expect(result.items[0].plaintext).toBeUndefined();
  });

  it('custom CryptoProvider instance (provider: CryptoProvider path)', async () => {
    const key = await makeHkdfKey();
    const customProvider = createSFrameProvider({ getKey: async () => key });

    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: { provider: customProvider },
      // SEC-CR-1695 gate: must declare cryptoMode when e2ee is configured + no prior list/subscribe.
      cryptoMode: 'sframe-static',
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seq: 1, msg_id: 'mc1' }),
        { status: 200 },
      ),
    );

    // sendText should work via custom provider
    const result = await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'custom' });
    expect(result.seq).toBe(1);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { sealed_b64: string };
    const sealedBytes = Uint8Array.from(atob(body.sealed_b64), (c) => c.charCodeAt(0));
    expect(sealedBytes.length).toBeGreaterThan(new TextEncoder().encode('custom').length);
  });

  it('sendText with empty plaintext (text === empty string)', async () => {
    const key = await makeHkdfKey();
    const client = new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: {
        provider: 'sframe',
        getKey: async (_roomId) => key,
      },
      // SEC-CR-1695 gate: must declare cryptoMode when e2ee is configured + no prior list/subscribe.
      cryptoMode: 'sframe-static',
    });

    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ seq: 5, msg_id: 'mempty' }),
        { status: 200 },
      ),
    );

    // Empty text should seal to a non-empty ciphertext (header + tag overhead)
    const result = await client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: '' });
    expect(result.seq).toBe(5);

    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(call[1].body as string) as { sealed_b64: string };
    const sealedBytes = Uint8Array.from(atob(body.sealed_b64), (c) => c.charCodeAt(0));
    expect(sealedBytes.length).toBeGreaterThan(0);
  });

  it('sendText throws without e2ee (coverage check)', async () => {
    const client = new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });

    await expect(
      client.sendText(ROOM_ID, { senderUid: SENDER_UID, text: 'hi' }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof SDKChatError && err.code === 'unsupported',
    );
  });
});
