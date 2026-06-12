/**
 * @module sdkChat.plaintext.test
 *
 * Phase 2 Wave 4.2: SvelteKit consumer-side integration tests for
 * chat-sdk plaintext mode. Exercises @oxpulse/chat-sdk at the
 * workspace import boundary — the same path a SvelteKit page would use.
 *
 * Wire-contract tests:
 *   1. plaintext_send_omits_e2ee_encrypt_call — CryptoProvider.seal NOT called
 *   2. plaintext_send_body_carries_utf8_sealed_b64 — sealed_b64 is raw UTF-8 base64
 *   3. plaintext_subscribe_parses_connected_prelude_event — SSE prelude sets mode;
 *      subsequent message is delivered with plaintext field
 *   4. plaintext_receive_yields_utf8_string_in_plaintext_field — list() response with
 *      crypto_mode:plaintext surfaces correct UTF-8 text in MessageRow.plaintext
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKChatClient, SDKChatError } from '@oxpulse/chat-sdk';
import type { CryptoProvider } from '@oxpulse/chat-sdk';

// ---------------------------------------------------------------------------
// Global fetch mock
// ---------------------------------------------------------------------------

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('crypto', {
		randomUUID: () => '00000000-0000-4000-8000-000000000099',
	});
	fetchMock.mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(opts?: { withE2ee?: boolean }) {
	if (opts?.withE2ee) {
		// Custom CryptoProvider whose seal is a spy — lets us assert it was NOT called.
		const sealSpy = vi.fn(async (plain: ArrayBuffer) => plain);
		const provider: CryptoProvider = { seal: sealSpy, unseal: vi.fn(async (c) => c) };
		const client = new SDKChatClient({
			jwt: 'test-token',
			baseUrl: '',
			appId: 'app_plaintext_test',
			cryptoMode: 'plaintext',
			e2ee: { provider },
		});
		return { client, sealSpy };
	}
	return {
		client: new SDKChatClient({
			jwt: 'test-token',
			baseUrl: '',
			appId: 'app_plaintext_test',
			cryptoMode: 'plaintext',
		}),
		sealSpy: null,
	};
}

function makeOkSendResp(seq = 1, msgId = '00000000-0000-4000-8000-000000000001'): Response {
	return new Response(JSON.stringify({ seq, msg_id: msgId }), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

function makeListResp(items: unknown[], cryptoMode = 'plaintext'): Response {
	return new Response(
		JSON.stringify({
			crypto_mode: cryptoMode,
			items,
			has_more: false,
			next_cursor: null,
		}),
		{
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		},
	);
}

/** Build a wire-format message row DTO in plaintext mode: sealed_b64 = base64(UTF-8(text)). */
function plaintextMsgDTO(text: string, seq = 1, msgId = '00000000-0000-4000-8000-000000000001') {
	const utf8Bytes = new TextEncoder().encode(text);
	const sealedB64 = btoa(String.fromCharCode(...utf8Bytes));
	return {
		seq,
		msg_id: msgId,
		sender_uid: 'alice',
		sealed_b64: sealedB64,
		created_at: '2026-05-27T00:00:00Z',
		thread_root_msg_id: null,
		product_ref: null,
		product_meta: null,
	};
}

// ---------------------------------------------------------------------------
// Flush microtasks — needed for subscribe's async attach() chain.
// ---------------------------------------------------------------------------

async function flush(rounds = 20): Promise<void> {
	for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// MockEventSource — mirrors the one used in packages/chat-sdk/__tests__
// ---------------------------------------------------------------------------

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

const ROOM_ID = 'room-plaintext-consumer-test';

// ---------------------------------------------------------------------------
// Test 1: plaintext_send_omits_e2ee_encrypt_call
// ---------------------------------------------------------------------------

describe('plaintext_send_omits_e2ee_encrypt_call', () => {
	it('sendText in plaintext mode does NOT call e2ee provider.seal', async () => {
		const { client, sealSpy } = makeClient({ withE2ee: true });

		fetchMock.mockResolvedValueOnce(makeOkSendResp());

		await client.sendText(ROOM_ID, { senderUid: 'alice', text: 'hello' });

		// Wire-contract: CryptoProvider.seal MUST NOT be called when cryptoMode='plaintext'.
		expect(sealSpy).not.toHaveBeenCalled();
	});

	it('sendText returns {seq, msgId} from server response', async () => {
		const { client } = makeClient();

		fetchMock.mockResolvedValueOnce(
			makeOkSendResp(7, 'aaaaaaaa-0000-4000-8000-000000000007'),
		);

		const result = await client.sendText(ROOM_ID, { senderUid: 'alice', text: 'hi' });

		expect(result.seq).toBe(7);
		expect(result.msgId).toBe('aaaaaaaa-0000-4000-8000-000000000007');
	});
});

// ---------------------------------------------------------------------------
// Test 2: plaintext_send_body_carries_utf8_sealed_b64
// ---------------------------------------------------------------------------

describe('plaintext_send_body_carries_utf8_sealed_b64', () => {
	it('POST body sealed_b64 decodes to the original UTF-8 text', async () => {
		const { client } = makeClient();
		fetchMock.mockResolvedValueOnce(makeOkSendResp());

		const TEXT = 'hello plaintext UTF-8';
		await client.sendText(ROOM_ID, { senderUid: 'alice', text: TEXT });

		expect(fetchMock).toHaveBeenCalledOnce();
		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string) as { sealed_b64: string };

		// Wire-contract: sealed_b64 must be present in the POST body.
		expect(body).toHaveProperty('sealed_b64');

		// Decode sealed_b64 → bytes → UTF-8 string must equal original text.
		const decoded = new TextDecoder().decode(
			Uint8Array.from(atob(body.sealed_b64), (c) => c.charCodeAt(0)),
		);
		expect(decoded).toBe(TEXT);
	});

	it('POST body has room_id and sender_uid fields', async () => {
		const { client } = makeClient();
		fetchMock.mockResolvedValueOnce(makeOkSendResp());

		await client.sendText(ROOM_ID, { senderUid: 'alice', text: 'x' });

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string);

		expect(body).toHaveProperty('room_id', ROOM_ID);
		expect(body).toHaveProperty('sender_uid', 'alice');
	});

	it('POST body carries Unicode text (multi-byte UTF-8) as sealed_b64', async () => {
		const { client } = makeClient();
		fetchMock.mockResolvedValueOnce(makeOkSendResp());

		const TEXT = 'Привет мир 🌍';
		await client.sendText(ROOM_ID, { senderUid: 'alice', text: TEXT });

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string) as { sealed_b64: string };

		const decoded = new TextDecoder().decode(
			Uint8Array.from(atob(body.sealed_b64), (c) => c.charCodeAt(0)),
		);
		expect(decoded).toBe(TEXT);
	});
});

// ---------------------------------------------------------------------------
// Test 3: plaintext_subscribe_parses_connected_prelude_event
// ---------------------------------------------------------------------------

describe('plaintext_subscribe_parses_connected_prelude_event', () => {
	it('subscribe() fires handler for message after plaintext prelude; plaintext field is UTF-8 ArrayBuffer', async () => {
		// Mock: subscribe-ticket fetch + list() (reconnect path) both return ok.
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ticket: 'test-ticket' }),
		} as unknown as Response);

		const { getLastController } = installMockEventSource();

		// No cryptoMode in constructor — client auto-discovers from prelude.
		const client = new SDKChatClient({
			jwt: 'test-token',
			baseUrl: '',
			appId: 'app_plaintext_test',
		});

		const received: Array<{ seq: number; plaintext: ArrayBuffer | undefined }> = [];
		const unsub = client.subscribe(ROOM_ID, {
			onMessage: (row) => received.push({ seq: row.seq, plaintext: row.plaintext }),
		});

		// Wait for async attach (ticket fetch → EventSource construction).
		await flush();

		const ctrl = getLastController();
		expect(ctrl).not.toBeNull();

		// Emit `event: connected` prelude with crypto_mode=plaintext.
		ctrl!.emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
		await flush();

		// Emit a message — server sends UTF-8 bytes as sealed_b64 in plaintext mode.
		const TEXT = 'plaintext message from SSE';
		const dto = plaintextMsgDTO(TEXT, 1);
		ctrl!.emitMessage(JSON.stringify({ ...dto }));
		await flush();

		// Wire-contract: handler must fire once; plaintext must be present and correct.
		expect(received).toHaveLength(1);
		expect(received[0].seq).toBe(1);
		expect(received[0].plaintext).toBeDefined();

		const decoded = new TextDecoder().decode(received[0].plaintext!);
		expect(decoded).toBe(TEXT);

		unsub();
	});

	it('subscribe() does not fire onError when plaintext prelude matches configured cryptoMode', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ticket: 'test-ticket' }),
		} as unknown as Response);

		const { getLastController } = installMockEventSource();

		const { client } = makeClient(); // cryptoMode: 'plaintext'

		const errors: Error[] = [];
		const unsub = client.subscribe(ROOM_ID, {
			onMessage: () => {},
			onError: (err) => errors.push(err),
		});

		await flush();

		const ctrl = getLastController();
		// Emit matching prelude — should not trigger error.
		ctrl!.emitNamed('connected', JSON.stringify({ crypto_mode: 'plaintext' }));
		await flush();

		expect(errors).toHaveLength(0);

		unsub();
	});

	it('subscribe() fires onError(SDKChatError) when prelude mode mismatches configured cryptoMode', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({ ticket: 'test-ticket' }),
		} as unknown as Response);

		const { getLastController } = installMockEventSource();

		// Configured plaintext, server emits sframe-static → mismatch.
		const { client } = makeClient(); // cryptoMode: 'plaintext'

		const errors: Error[] = [];
		const unsub = client.subscribe(ROOM_ID, {
			onMessage: () => {},
			onError: (err) => errors.push(err),
		});

		await flush();

		const ctrl = getLastController();
		ctrl!.emitNamed('connected', JSON.stringify({ crypto_mode: 'sframe-static' }));
		await flush();

		expect(errors).toHaveLength(1);
		expect(errors[0]).toBeInstanceOf(SDKChatError);
		expect((errors[0] as SDKChatError).code).toBe('crypto_mode_mismatch');

		unsub();
	});
});

// ---------------------------------------------------------------------------
// Test 4: plaintext_receive_yields_utf8_string_in_plaintext_field
// ---------------------------------------------------------------------------

describe('plaintext_receive_yields_utf8_string_in_plaintext_field', () => {
	it('list() with crypto_mode=plaintext sets MessageRow.plaintext to UTF-8 ArrayBuffer; unsealError is undefined', async () => {
		const TEXT = 'plaintext message body';
		const dto = plaintextMsgDTO(TEXT);

		fetchMock.mockResolvedValueOnce(makeListResp([dto]));

		const { client } = makeClient(); // cryptoMode: 'plaintext'
		const result = await client.list(ROOM_ID);

		expect(result.items).toHaveLength(1);
		const row = result.items[0];

		// Wire-contract: MessageRow.plaintext MUST be present.
		expect(row.plaintext).toBeDefined();
		// Wire-contract: unsealError MUST NOT be set — no unseal failure.
		expect(row.unsealError).toBeUndefined();

		// Decode ArrayBuffer → UTF-8 string must match original text.
		const decoded = new TextDecoder().decode(row.plaintext!);
		expect(decoded).toBe(TEXT);
	});

	it('list() with crypto_mode=plaintext preserves seq, msgId, senderUid from wire DTO', async () => {
		const dto = plaintextMsgDTO('hello', 5, 'bbbbbbbb-0000-4000-8000-000000000005');

		fetchMock.mockResolvedValueOnce(makeListResp([dto]));

		const { client } = makeClient();
		const result = await client.list(ROOM_ID);

		const row = result.items[0];
		expect(row.seq).toBe(5);
		expect(row.msgId).toBe('bbbbbbbb-0000-4000-8000-000000000005');
		expect(row.senderUid).toBe('alice');
	});

	it('list() with crypto_mode=plaintext handles multi-byte UTF-8 text (emoji, Cyrillic)', async () => {
		const TEXT = 'Привет 🌍 мир';
		const dto = plaintextMsgDTO(TEXT);

		fetchMock.mockResolvedValueOnce(makeListResp([dto]));

		const { client } = makeClient();
		const result = await client.list(ROOM_ID);

		const row = result.items[0];
		expect(row.plaintext).toBeDefined();
		const decoded = new TextDecoder().decode(row.plaintext!);
		expect(decoded).toBe(TEXT);
	});

	it('list() with multiple plaintext items decodes each independently', async () => {
		const items = [
			plaintextMsgDTO('first message', 1, 'cccccccc-0000-4000-8000-000000000001'),
			plaintextMsgDTO('second message', 2, 'cccccccc-0000-4000-8000-000000000002'),
			plaintextMsgDTO('third message', 3, 'cccccccc-0000-4000-8000-000000000003'),
		];

		fetchMock.mockResolvedValueOnce(makeListResp(items));

		const { client } = makeClient();
		const result = await client.list(ROOM_ID);

		expect(result.items).toHaveLength(3);
		for (const [i, row] of result.items.entries()) {
			expect(row.plaintext).toBeDefined();
			const decoded = new TextDecoder().decode(row.plaintext!);
			expect(decoded).toBe(items[i].seq === 1 ? 'first message' : i === 1 ? 'second message' : 'third message');
			expect(row.unsealError).toBeUndefined();
		}
	});
});
