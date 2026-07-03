/**
 * helpers.ts — shared vitest mocks for the chat-sdk unit tests.
 *
 * Extracted from plaintext-mode.test.ts / e2ee-downgrade-default-on.test.ts, which
 * had defined these verbatim. Keep test-only; not exported from the package index.
 */

import { vi } from 'vitest';
import type { CryptoProvider } from '../types.js';

export const TEST_BASE_URL = 'http://x';
export const TEST_JWT = 'test-token';
export const TEST_SENDER_UID = 'user-test-1';

/** A 200 send response `{ seq, msg_id }` for POST /api/sdk/messages. */
export function makeOkSendResponse(seq = 1, msgId = 'msg-001'): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ seq, msg_id: msgId }),
  } as unknown as Response;
}

/** A single-row list() response; optional `crypto_mode` in the envelope. */
export function makeListResponse(
  sealedB64: string,
  opts: { cryptoMode?: string; senderUid?: string } = {},
): Response {
  const body: Record<string, unknown> = {
    items: [
      {
        seq: 1,
        msg_id: 'msg-001',
        sender_uid: opts.senderUid ?? TEST_SENDER_UID,
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
  if (opts.cryptoMode !== undefined) {
    body['crypto_mode'] = opts.cryptoMode;
  }
  return new Response(JSON.stringify(body), { status: 200 });
}

// ── Mock EventSource ─────────────────────────────────────────────────────────

export interface MockESController {
  /** The stream URL (carries the subscribe ticket) — used to correlate a room. */
  readonly url: string;
  emitNamed(type: string, data: string): void;
  emitMessage(data: string): void;
  emitError(): void;
}

export interface MockESHandle {
  /** The most-recently constructed EventSource controller (single-room tests). */
  getLastController(): MockESController | null;
  /** Every EventSource controller constructed so far, in construction order. */
  getControllers(): MockESController[];
  /** First controller whose URL contains `urlSubstr` (multi-room tests). */
  findController(urlSubstr: string): MockESController | undefined;
}

export function installMockEventSource(): MockESHandle {
  const controllers: MockESController[] = [];

  class MockES {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    private _listeners: Map<string, Array<(ev: MessageEvent) => void>> = new Map();

    constructor(url: string) {
      const self = this;
      controllers.push({
        url,
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
      });
    }

    addEventListener(type: string, cb: (ev: MessageEvent) => void) {
      const arr = this._listeners.get(type) ?? [];
      arr.push(cb);
      this._listeners.set(type, arr);
    }

    close() {}
  }

  vi.stubGlobal('EventSource', MockES);
  return {
    getLastController: () => controllers[controllers.length - 1] ?? null,
    getControllers: () => controllers.slice(),
    findController: (urlSubstr: string) => controllers.find((c) => c.url.includes(urlSubstr)),
  };
}

// ── Crypto provider spy ──────────────────────────────────────────────────────

export type SpyCryptoProvider = CryptoProvider & { sealSpy: ReturnType<typeof vi.fn> };

/**
 * A CryptoProvider whose `seal` is a spy. By default `seal` prepends a 0x01 marker
 * byte so a *sealed* body is distinguishable from cleartext on the wire (used by the
 * downgrade tests). Pass a custom `sealImpl` for identity/other behaviour.
 */
export function makeSpyCryptoProvider(
  sealImpl?: (plain: ArrayBuffer) => Promise<ArrayBuffer>,
): SpyCryptoProvider {
  const impl =
    sealImpl ??
    (async (plain: ArrayBuffer) => {
      const src = new Uint8Array(plain);
      const out = new Uint8Array(src.length + 1);
      out[0] = 0x01; // sframe-ish marker — proves seal ran
      out.set(src, 1);
      return out.buffer;
    });
  const sealSpy = vi.fn(impl);
  return {
    sealSpy,
    seal: sealSpy,
    unseal: vi.fn(async (cipher: ArrayBuffer) => cipher),
  } as SpyCryptoProvider;
}

/** Flush microtasks N times (subscribe's async attach chain). */
export async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Decode a send fetch call's `sealed_b64` body back to a UTF-8 string. */
export function decodeSentBody(init: RequestInit): { sealedB64: string; asText: string } {
  const body = JSON.parse(init.body as string) as { sealed_b64: string };
  const bytes = Uint8Array.from(atob(body.sealed_b64), (c) => c.charCodeAt(0));
  return { sealedB64: body.sealed_b64, asText: new TextDecoder().decode(bytes) };
}
