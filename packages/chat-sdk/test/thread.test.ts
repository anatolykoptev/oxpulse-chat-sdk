/**
 * @module sdkChat.thread.test
 *
 * W7 T5 vitest tests: SDKChatClient thread-related extensions.
 *
 * Covers:
 *   1. send() with threadRootMsgId passes thread_root_msg_id in POST body
 *      (wire-contract: toHaveProperty('thread_root_msg_id'))
 *   2. send() without threadRootMsgId does NOT include thread_root_msg_id
 *   3. getThread() calls GET /api/sdk/rooms/:room_id/threads/:root_msg_id
 *   4. getThread() returns MessageRow[] with threadRootMsgId field populated
 *   5. getThread() maps wire field thread_root_msg_id → MessageRow.threadRootMsgId
 *   6. getThread() throws SDKChatError on 401
 *   7. getThread() throws SDKChatError on 404
 *   8. getThread() throws SDKChatError on network failure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SDKChatClient, SDKChatError } from '@oxpulse/chat-sdk';

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	vi.stubGlobal('fetch', fetchMock);
	vi.stubGlobal('crypto', {
		randomUUID: () => '00000000-0000-4000-8000-000000000099',
	});
	fetchMock.mockReset();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
	return new SDKChatClient({
		jwt: 'test-token',
		baseUrl: '',
		appId: 'app_test',
	});
}

function makeOkResp(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	}) as Response;
}

function makeErrResp(status: number): Response {
	return new Response('{}', { status }) as Response;
}

const ROOT_MSG_ID = '11111111-0000-4000-8000-000000000001';
const ROOM_ID = 'room-test-42';

/** Build a wire-format thread reply DTO (server snake_case shape). */
function threadReplyDTO(
	seq: number,
	msgId: string,
	rootMsgId: string,
) {
	const sealed = new Uint8Array([1, 2, 3]);
	const sealedB64 = btoa(String.fromCharCode(...sealed));
	return {
		seq,
		msg_id: msgId,
		sender_uid: 'alice',
		sealed_b64: sealedB64,
		created_at: '2026-05-13T00:00:00Z',
		thread_root_msg_id: rootMsgId,
	};
}

// ---------------------------------------------------------------------------
// Tests: send() with threadRootMsgId
// ---------------------------------------------------------------------------

describe('SDKChatClient.send() thread wire-contract', () => {
	it('includes thread_root_msg_id in POST body when SendOpts.threadRootMsgId is set', async () => {
		const client = makeClient();

		// Server AppendResponse: {seq, msg_id, thread_root_msg_id?} — no sealed_b64.
		// send() response parsing: we intercept BEFORE dtoToRow via inspecting fetch call.
		// Mock returns minimal sealed_b64 so dtoToRow doesn't crash.
		const sealed = new Uint8Array([1, 2]);
		const sealedB64 = btoa(String.fromCharCode(...sealed));
		fetchMock.mockResolvedValueOnce(
			makeOkResp({
				seq: 5,
				msg_id: '00000000-0000-4000-8000-000000000002',
				sender_uid: 'alice',
				sealed_b64: sealedB64,
				created_at: '2026-05-13T00:00:00Z',
				thread_root_msg_id: ROOT_MSG_ID,
			}),
		);

		await client.send(ROOM_ID, {
			senderUid: 'alice',
			sealed: new Uint8Array([1, 2]).buffer,
			threadRootMsgId: ROOT_MSG_ID,
		});

		expect(fetchMock).toHaveBeenCalledOnce();
		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(init!.body as string);

		// Wire-contract assertion: body MUST contain thread_root_msg_id.
		expect(body).toHaveProperty('thread_root_msg_id', ROOT_MSG_ID);
	});

	it('does NOT include thread_root_msg_id in POST body when omitted', async () => {
		const client = makeClient();

		const sealed = new Uint8Array([1]);
		const sealedB64 = btoa(String.fromCharCode(...sealed));
		fetchMock.mockResolvedValueOnce(
			makeOkResp({
				seq: 1,
				msg_id: '00000000-0000-4000-8000-000000000003',
				sender_uid: 'alice',
				sealed_b64: sealedB64,
				created_at: '2026-05-13T00:00:00Z',
			}),
		);

		await client.send(ROOM_ID, {
			senderUid: 'alice',
			sealed: new Uint8Array([1]).buffer,
		});

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse(init!.body as string);

		// Wire-contract: omitting threadRootMsgId must NOT send the field.
		expect(body).not.toHaveProperty('thread_root_msg_id');
	});
});

// ---------------------------------------------------------------------------
// Tests: getThread()
// ---------------------------------------------------------------------------

describe('SDKChatClient.getThread()', () => {
	it('calls GET /api/sdk/rooms/:room_id/threads/:root_msg_id', async () => {
		const client = makeClient();

		fetchMock.mockResolvedValueOnce(makeOkResp([]));

		await client.getThread(ROOM_ID, ROOT_MSG_ID);

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url] = fetchMock.mock.calls[0];
		expect(String(url)).toContain(`/api/sdk/rooms/${ROOM_ID}/threads/${ROOT_MSG_ID}`);
	});

	it('sends Authorization header', async () => {
		const client = makeClient();
		fetchMock.mockResolvedValueOnce(makeOkResp([]));

		await client.getThread(ROOM_ID, ROOT_MSG_ID);

		const [, init] = fetchMock.mock.calls[0];
		expect((init!.headers as Record<string, string>)['Authorization']).toBe(
			'Bearer test-token',
		);
	});

	it('returns MessageRow[] with threadRootMsgId populated', async () => {
		const client = makeClient();

		const dtos = [
			threadReplyDTO(3, '22222222-0000-4000-8000-000000000001', ROOT_MSG_ID),
			threadReplyDTO(5, '22222222-0000-4000-8000-000000000002', ROOT_MSG_ID),
		];
		fetchMock.mockResolvedValueOnce(makeOkResp(dtos));

		const rows = await client.getThread(ROOM_ID, ROOT_MSG_ID);

		expect(rows).toHaveLength(2);
		// Wire-contract: threadRootMsgId must be mapped from thread_root_msg_id.
		expect(rows[0].threadRootMsgId).toBe(ROOT_MSG_ID);
		expect(rows[1].threadRootMsgId).toBe(ROOT_MSG_ID);
		expect(rows[0].seq).toBe(3);
		expect(rows[1].seq).toBe(5);
	});

	it('maps all MessageRow fields correctly', async () => {
		const client = makeClient();

		const dto = threadReplyDTO(7, '33333333-0000-4000-8000-000000000001', ROOT_MSG_ID);
		fetchMock.mockResolvedValueOnce(makeOkResp([dto]));

		const [row] = await client.getThread(ROOM_ID, ROOT_MSG_ID);

		expect(row.seq).toBe(7);
		expect(row.msgId).toBe('33333333-0000-4000-8000-000000000001');
		expect(row.senderUid).toBe('alice');
		expect(row.createdAt).toBe('2026-05-13T00:00:00Z');
		expect(row.threadRootMsgId).toBe(ROOT_MSG_ID);
		// sealed ArrayBuffer must be non-empty.
		expect(row.sealed.byteLength).toBeGreaterThan(0);
	});

	it('throws SDKChatError with code "unauthorized" on 401', async () => {
		const client = makeClient();
		fetchMock.mockResolvedValueOnce(makeErrResp(401));

		await expect(client.getThread(ROOM_ID, ROOT_MSG_ID)).rejects.toSatisfy(
			(e: SDKChatError) => e instanceof SDKChatError && e.code === 'unauthorized',
		);
	});

	it('throws SDKChatError with code "not_found" on 404', async () => {
		const client = makeClient();
		fetchMock.mockResolvedValueOnce(makeErrResp(404));

		await expect(client.getThread(ROOM_ID, ROOT_MSG_ID)).rejects.toSatisfy(
			(e: SDKChatError) => e instanceof SDKChatError && e.code === 'not_found',
		);
	});

	it('throws SDKChatError with code "network" on fetch rejection', async () => {
		const client = makeClient();
		fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

		await expect(client.getThread(ROOM_ID, ROOT_MSG_ID)).rejects.toSatisfy(
			(e: SDKChatError) => e instanceof SDKChatError && e.code === 'network',
		);
	});

	it('returns empty array for a root with no replies', async () => {
		const client = makeClient();
		fetchMock.mockResolvedValueOnce(makeOkResp([]));

		const rows = await client.getThread(ROOM_ID, ROOT_MSG_ID);
		expect(rows).toHaveLength(0);
	});
});
