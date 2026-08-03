/**
 * compression.test.ts — SDKChatClient compression option tests.
 *
 * Tests the encoding path for POST /api/sdk/messages without hitting the network.
 * fetch is mocked globally; dict loads are served from local FS.
 *
 * Server protocol reference (crates/sdk/src/wire_decode.rs):
 *   none   → Content-Type: application/json, plain JSON string body
 *   auto (large)  → Content-Type: application/octet-stream, body[0]=0xC6
 *   auto (small)  → Content-Type: application/json (below minCompressBytes)
 *   dict   → body[0]=0xC7, body[1]=0x00 (high byte), body[2]=dictId (u16 BE)
 *            dict IDs: 0x01=ru, 0x02=fa, 0x03=en
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Resolve through node_modules so the path works in Stryker's sandbox
// where __dirname points inside .stryker-tmp/. Resolving the main entry
// of @oxpulse/wire-codec and going up one dir reaches the package root
// (which contains dicts/). node_modules is copied to the sandbox by Stryker.
const require = createRequire(import.meta.url);
const wireCodecEntry = require.resolve('@oxpulse/wire-codec');
const DICTS_DIR = join(dirname(wireCodecEntry), '..', 'dicts');

// ── Mock fetch BEFORE any imports that may trigger dict loading ───────────────
// Intercepts /dicts/*.zstd → serves from local FS.
// All other requests → fake 200 with SDK response shape.

type CapturedCall = { url: string; init?: RequestInit };
const capturedCalls: CapturedCall[] = [];

const DICT_NAMES = ['zstd-dict-ru-v1', 'zstd-dict-fa-v1', 'zstd-dict-en-v1'] as const;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input.toString();

  for (const name of DICT_NAMES) {
    if (url.includes(`/dicts/${name}.zstd`)) {
      const buf = readFileSync(join(DICTS_DIR, `${name}.zstd`));
      const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      return new Response(u8, { status: 200 });
    }
  }

  capturedCalls.push({ url, init });
  return new Response(JSON.stringify({ seq: 1, msg_id: 'mock-id' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

// Import AFTER fetch mock is in place.
import { SDKChatClient } from '../client.js';
import { ensureWireCodecReady, encodeHttpBody } from '@oxpulse/wire-codec';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClient(opts: Partial<ConstructorParameters<typeof SDKChatClient>[0]> = {}) {
  return new SDKChatClient({ baseUrl: 'https://chat.example.com', jwt: 'tok', ...opts });
}

function lastCall(): CapturedCall {
  const c = capturedCalls[capturedCalls.length - 1];
  if (c === undefined) throw new Error('No fetch calls captured');
  return c;
}

/** Make a sealed ArrayBuffer of a given approximate JSON-serialized size. */
function makeSeal(targetJsonBytes: number): ArrayBuffer {
  // sealed_b64 ≈ base64(sealed) ≈ 4/3 * sealed.length
  // JSON wrapper overhead ~80 bytes for room_id + sender_uid + msg_id keys
  const sealBytes = Math.max(1, Math.floor((targetJsonBytes - 80) * 3 / 4));
  return new Uint8Array(sealBytes).fill(0xab).buffer;
}

beforeAll(async () => {
  await ensureWireCodecReady();
});

// ── Tests: compression:none ───────────────────────────────────────────────────

describe('compression:none (default)', () => {
  it('sends plain JSON with application/json Content-Type', async () => {
    const client = makeClient({ compression: 'none' });
    const sealed = makeSeal(1024);
    await client.send('room-1', { senderUid: 'u1', sealed });

    const call = lastCall();
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(typeof call.init?.body).toBe('string');
  });

  it('compression:none preserves request shape', async () => {
    const clientDefault = makeClient();
    const clientNone = makeClient({ compression: 'none' });
    const sealed = makeSeal(1024);

    const prevLen = capturedCalls.length;
    await clientDefault.send('r', { senderUid: 'u', sealed });
    await clientNone.send('r', { senderUid: 'u', sealed });

    const callA = capturedCalls[prevLen];
    const callB = capturedCalls[prevLen + 1];
    expect(typeof callA?.init?.body).toBe('string');
    expect(typeof callB?.init?.body).toBe('string');
    // JSON bodies are NOT byte-identical: msgId is randomised per send (the only mutable field).
    // Structural equivalence (same keys, same content-type) is what matters here.
    const parsedA = JSON.parse(callA?.init?.body as string) as Record<string, unknown>;
    const parsedB = JSON.parse(callB?.init?.body as string) as Record<string, unknown>;
    expect(Object.keys(parsedA).sort()).toEqual(Object.keys(parsedB).sort());
    const aHeaders = callA?.init?.headers as Record<string, string>;
    const bHeaders = callB?.init?.headers as Record<string, string>;
    expect(aHeaders['Content-Type']).toBe('application/json');
    expect(bHeaders['Content-Type']).toBe('application/json');
  });

  it('JSON body snapshot: expected keys present (back-compat lock)', async () => {
    const client = makeClient({ compression: 'none' });
    const sealed = new Uint8Array([1, 2, 3]).buffer;
    await client.send('snap-room', { senderUid: 'snap-user', sealed });

    const body = JSON.parse(lastCall().init!.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['msg_id', 'room_id', 'sealed_b64', 'sender_uid'].sort());
    expect(body['room_id']).toBe('snap-room');
    expect(body['sender_uid']).toBe('snap-user');
    expect(typeof body['sealed_b64']).toBe('string');
    expect(typeof body['msg_id']).toBe('string');
  });
});

// ── Tests: compression:auto ───────────────────────────────────────────────────

describe('compression:auto', () => {
  it('large payload (≥256 B) → octet-stream, body[0]=0xC6', async () => {
    const client = makeClient({ compression: 'auto' });
    const sealed = makeSeal(1024);
    await client.send('room-1', { senderUid: 'u1', sealed });

    const call = lastCall();
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/octet-stream');
    const body = call.init?.body as Uint8Array;
    expect(body).toBeInstanceOf(Uint8Array);
    expect(body[0]).toBe(0xc6);
  });

  it('small payload (<minCompressBytes=256) → falls back to plain JSON', async () => {
    const client = makeClient({ compression: 'auto', minCompressBytes: 256 });
    // sealed 30 B → JSON ~120 B → well below 256 B
    const sealed = new Uint8Array(30).fill(0).buffer;
    await client.send('room-1', { senderUid: 'u1', sealed });

    const call = lastCall();
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(typeof call.init?.body).toBe('string');
  });

  it('minCompressBytes:0 compresses even tiny payloads', async () => {
    const client = makeClient({ compression: 'auto', minCompressBytes: 0 });
    const sealed = new Uint8Array(1).buffer;
    await client.send('room-1', { senderUid: 'u1', sealed });

    const call = lastCall();
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/octet-stream');
    const body = call.init?.body as Uint8Array;
    expect(body[0]).toBe(0xc6);
  });
});

// ── Tests: compression:dict ───────────────────────────────────────────────────

describe('compression:dict', () => {
  it('ru dict → 0xC7 + u16 BE [0x00, 0x01]', async () => {
    const client = makeClient({ compression: 'dict', dictHint: 'zstd-dict-ru-v1', minCompressBytes: 0 });
    const sealed = makeSeal(1024);
    await client.send('room-1', { senderUid: 'u1', sealed });

    const call = lastCall();
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/octet-stream');
    const body = call.init?.body as Uint8Array;
    expect(body[0]).toBe(0xc7);
    expect(body[1]).toBe(0x00); // high byte of u16 BE
    expect(body[2]).toBe(0x01); // ru dict-id
  });

  it('fa dict → 0xC7 + u16 BE [0x00, 0x02]', async () => {
    const client = makeClient({ compression: 'dict', dictHint: 'zstd-dict-fa-v1', minCompressBytes: 0 });
    await client.send('room-1', { senderUid: 'u1', sealed: makeSeal(1024) });

    const body = lastCall().init?.body as Uint8Array;
    expect(body[0]).toBe(0xc7);
    expect(body[1]).toBe(0x00);
    expect(body[2]).toBe(0x02);
  });

  it('en dict → 0xC7 + u16 BE [0x00, 0x03]', async () => {
    const client = makeClient({ compression: 'dict', dictHint: 'zstd-dict-en-v1', minCompressBytes: 0 });
    await client.send('room-1', { senderUid: 'u1', sealed: makeSeal(1024) });

    const body = lastCall().init?.body as Uint8Array;
    expect(body[0]).toBe(0xc7);
    expect(body[1]).toBe(0x00);
    expect(body[2]).toBe(0x03);
  });

  it('small payload (<minCompressBytes) falls back to JSON even in dict mode', async () => {
    const client = makeClient({ compression: 'dict', minCompressBytes: 256 });
    const sealed = new Uint8Array(30).fill(0).buffer;
    await client.send('room-1', { senderUid: 'u1', sealed });

    const call = lastCall();
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(typeof call.init?.body).toBe('string');
  });
});

// ── Tests: encodeEnvelope / decodeEnvelope ────────────────────────────────────

describe('encodeEnvelope / decodeEnvelope', () => {
  it('none: round-trip through string', async () => {
    const client = makeClient({ compression: 'none' });
    const payload = { room_id: 'r', sender_uid: 'u', msg: 'hello' };
    const encoded = await client.encodeEnvelope(payload);
    expect(typeof encoded).toBe('string');
    const decoded = await client.decodeEnvelope(encoded as string);
    expect(decoded).toEqual(payload);
  });

  it('auto (minCompressBytes:0): round-trip through 0xC6 Uint8Array', async () => {
    const client = makeClient({ compression: 'auto', minCompressBytes: 0 });
    const payload = { room_id: 'r', data: 'x'.repeat(50) };
    const encoded = await client.encodeEnvelope(payload);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect((encoded as Uint8Array)[0]).toBe(0xc6);
    const decoded = await client.decodeEnvelope(encoded as Uint8Array);
    expect(decoded).toEqual(payload);
  });

  it('dict (minCompressBytes:0): round-trip through 0xC7 Uint8Array', async () => {
    const client = makeClient({ compression: 'dict', dictHint: 'zstd-dict-ru-v1', minCompressBytes: 0 });
    const payload = { room_id: 'r', data: 'y'.repeat(50) };
    const encoded = await client.encodeEnvelope(payload);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect((encoded as Uint8Array)[0]).toBe(0xc7);
    const decoded = await client.decodeEnvelope(encoded as Uint8Array);
    expect(decoded).toEqual(payload);
  });

  it('decodeEnvelope handles plain JSON string', async () => {
    const client = makeClient();
    const payload = { seq: 42, msg: 'hello' };
    const decoded = await client.decodeEnvelope(JSON.stringify(payload));
    expect(decoded).toEqual(payload);
  });

  it('decodeEnvelope handles plain JSON bytes ({-prefixed)', async () => {
    const client = makeClient();
    const payload = { seq: 2 };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const decoded = await client.decodeEnvelope(bytes);
    expect(decoded).toEqual(payload);
  });

  it('compression:none client decodes 0xC6 compressed frame without throwing', async () => {
    // Regression: #compression governs outgoing encoding only.
    // A server may respond with a compressed frame regardless of client mode.
    // decodeEnvelope must call ensureWireCodecReady() based on first byte, not #compression.
    const client = makeClient({ compression: 'none' });

    // Build a real 0xC6 frame using wire-codec directly.
    const payload = { seq: 99, msg: 'compressed-server-response' };
    const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
    const compressedFrame = encodeHttpBody(jsonBytes); // produces 0xC6 frame

    expect(compressedFrame[0]).toBe(0xc6);
    const decoded = await client.decodeEnvelope(compressedFrame);
    expect(decoded).toEqual(payload);
  });
});
