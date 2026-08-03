/**
 * sframe-unseal-abort.test.ts — SEC-CR-47-01 regression guard.
 *
 * The built-in sframe provider's unseal(sealed, ctx, signal?) honors the SDK's
 * per-row AbortSignal at await boundaries only (throwIfAborted at ENTRY and BEFORE
 * the atomic inner.unseal decrypt — NEVER after a successful decrypt). This guards
 * the SEC-CR-003 durable-replay integrity across that abort boundary:
 *
 *   (a) an aborted unseal must record NOTHING in the durable window — the frame was
 *       never delivered, so it must stay re-deliverable (no false replay-reject).
 *   (b) a non-aborted signal must NOT skip durable.accept — a decrypted frame is
 *       still recorded, so a genuine replay is still rejected.
 *
 * Non-vacuous: (b) asserts a real ReplayError, which only fires if the durable guard
 * is ACTIVE (IndexedDB + Web Locks present) — so a broken durable env fails loudly
 * instead of passing an empty test. Both are RED if a refactor moved throwIfAborted
 * to AFTER durable.accept (recording an aborted frame) or made a present-but-unaborted
 * signal short-circuit accept.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { clear } from 'idb-keyval';
import { createSFrameProvider } from '../sframe.js';
import { ReplayError } from 'sframe-ratchet/chat';
import type { SealContext } from '../types.js';

const CTX: SealContext = { roomId: 'room-abort-1', senderUid: 'user-abort-1' };
const enc = new TextEncoder();

function pt(s: string): ArrayBuffer {
  return enc.encode(s).buffer as ArrayBuffer;
}

async function makeHkdfKey(): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

beforeEach(async () => {
  await clear();
});

describe('SFrame unseal — AbortSignal honoring preserves durable-replay integrity (SEC-CR-47-01)', () => {
  it('an already-aborted unseal rejects WITHOUT recording — the frame stays re-deliverable', async () => {
    const key = await makeHkdfKey();
    const sender = createSFrameProvider({ getKey: async () => key, durableReplayNamespace: 'abort-test' });
    const receiver = createSFrameProvider({ getKey: async () => key, durableReplayNamespace: 'abort-test' });
    const frame = await sender.seal(pt('approve payment'), CTX);

    const ac = new AbortController();
    ac.abort(new Error('unseal deadline exceeded (5000ms)'));

    // Entry throwIfAborted fires before the library's check/decrypt/accept.
    await expect(receiver.unseal(frame, CTX, ac.signal)).rejects.toThrow(/deadline/);

    // Records nothing → a fresh unseal of the SAME frame SUCCEEDS (not a replay-reject).
    // If the abort path had wrongly called durable.accept, this would throw ReplayError.
    const view = await receiver.unseal(frame, CTX);
    expect(new Uint8Array(view)).toEqual(enc.encode('approve payment'));
  });

  it('a non-aborted signal still records the accepted CTR — a genuine replay is still rejected', async () => {
    const key = await makeHkdfKey();
    const sender = createSFrameProvider({ getKey: async () => key, durableReplayNamespace: 'abort-test' });
    const receiver = createSFrameProvider({ getKey: async () => key, durableReplayNamespace: 'abort-test' });
    const frame = await sender.seal(pt('hello world'), CTX);

    const ac = new AbortController(); // constructed but NEVER aborted

    const view = await receiver.unseal(frame, CTX, ac.signal);
    expect(new Uint8Array(view)).toEqual(enc.encode('hello world'));

    // The successful unseal recorded the CTR (accept was NOT skipped by the signal
    // being present-but-unaborted) → a replay of the same frame is rejected. This
    // also proves the durable guard is ACTIVE, so test (a) is not vacuous.
    await expect(receiver.unseal(frame, CTX)).rejects.toBeInstanceOf(ReplayError);
  });

  it('backward-compat: a 2-arg unseal call (no signal) is unchanged', async () => {
    const key = await makeHkdfKey();
    const sender = createSFrameProvider({ getKey: async () => key, durableReplayNamespace: 'abort-test' });
    const receiver = createSFrameProvider({ getKey: async () => key, durableReplayNamespace: 'abort-test' });
    const frame = await sender.seal(pt('no signal'), CTX);

    const view = await receiver.unseal(frame, CTX); // no 3rd arg
    expect(new Uint8Array(view)).toEqual(enc.encode('no signal'));
  });
});
