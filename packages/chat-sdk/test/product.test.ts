/**
 * @module sdkChat.product.test
 *
 * W9 T4/T6 vitest tests: SDKChatClient product card extensions.
 *
 * Wire-contract tests:
 *   1. sendProductCard() POST body has `product_ref` field (snake_case)
 *   2. sendProductCard() POST body has `sealed_b64` field (from sealedBody)
 *   3. sendProductCard() response DTO includes `product_ref` field
 *   4. searchByProductRef() GET query has `product_ref` param
 *   5. searchByProductRef() with roomId adds `room_id` param
 *   6. searchByProductRef() maps response DTOs including product_ref field
 *   7. sendProductCard() without sealedBody omits sealed_b64 from body
 *   8. sendProductCard() throws SDKChatError on 401
 *   9. searchByProductRef() throws SDKChatError on 403
 *  10. Wire-contract: response from searchByProductRef has product_ref in each row
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
	return new SDKChatClient({ jwt: 'test-token', baseUrl: '', appId: 'app_test' });
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

const PRODUCT_REF = 'sku-vintage-mug-42';
const ROOM_ID = 'room-marketplace-1';

const VALID_PRODUCT_META = {
	title: 'Vintage Coffee Mug',
	price: 19.99,
	currency: 'USD',
	imageUrl: 'https://cdn.example.com/img/mug.jpg',
	productUrl: 'https://marketplace.example.com/listings/mug-123',
};

const MSG_ROW_WITH_PRODUCT_REF = {
	seq: 1,
	msg_id: '00000000-0000-4000-8000-000000000001',
	sender_uid: 'alice',
	sealed_b64: btoa('sealed'), // base64-encoded sealed bytes (wire-contract)
	created_at: '2026-05-14T00:00:00Z',
	product_ref: PRODUCT_REF,
};

// AppendResponse from sendProductCard — mirrors server AppendResponse shape.
const APPEND_RESP_WITH_PRODUCT_REF = {
	seq: 1,
	msg_id: '00000000-0000-4000-8000-000000000001',
	sender_uid: 'alice',
	sealed_b64: btoa('sealed'),
	created_at: '2026-05-14T00:00:00Z',
	product_ref: PRODUCT_REF,
	product_meta: VALID_PRODUCT_META,
};

// MessageRowDTO with product_meta — used for GET response wire-contract tests.
const MSG_ROW_WITH_PRODUCT_META = {
	...MSG_ROW_WITH_PRODUCT_REF,
	product_meta: VALID_PRODUCT_META,
};

// ---------------------------------------------------------------------------
// T4: sendProductCard() wire-contract tests
// ---------------------------------------------------------------------------

describe('SDKChatClient.sendProductCard()', () => {
	it('POST body contains product_ref field (snake_case)', async () => {
		fetchMock.mockResolvedValueOnce(
			makeOkResp(APPEND_RESP_WITH_PRODUCT_REF),
		);
		const client = makeClient();
		await client.sendProductCard(ROOM_ID, {
			productRef: PRODUCT_REF,
			productMeta: VALID_PRODUCT_META,
			senderUid: 'alice',
		});

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body).toHaveProperty('product_ref', PRODUCT_REF);
	});

	it('POST body contains room_id', async () => {
		fetchMock.mockResolvedValueOnce(
			makeOkResp(APPEND_RESP_WITH_PRODUCT_REF),
		);
		const client = makeClient();
		await client.sendProductCard(ROOM_ID, {
			productRef: PRODUCT_REF,
			productMeta: VALID_PRODUCT_META,
			senderUid: 'alice',
		});

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body).toHaveProperty('room_id', ROOM_ID);
	});

	it('POST body includes product_meta field with nested structure', async () => {
		fetchMock.mockResolvedValueOnce(
			makeOkResp(APPEND_RESP_WITH_PRODUCT_REF),
		);
		const client = makeClient();
		await client.sendProductCard(ROOM_ID, {
			productRef: PRODUCT_REF,
			productMeta: VALID_PRODUCT_META,
			senderUid: 'alice',
		});

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body).toHaveProperty('product_meta');
		expect(body.product_meta).toMatchObject({
			title: VALID_PRODUCT_META.title,
			price: VALID_PRODUCT_META.price,
			currency: VALID_PRODUCT_META.currency,
		});
	});

	it('POST body includes sealed_b64 when sealedBody provided', async () => {
		fetchMock.mockResolvedValueOnce(
			makeOkResp(APPEND_RESP_WITH_PRODUCT_REF),
		);
		const client = makeClient();
		const sealed = new Uint8Array([1, 2, 3]).buffer;
		await client.sendProductCard(ROOM_ID, {
			productRef: PRODUCT_REF,
			productMeta: VALID_PRODUCT_META,
			senderUid: 'alice',
			sealedBody: sealed,
		});

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body).toHaveProperty('sealed_b64');
	});

	it('POST body omits sealed_b64 when no sealedBody provided', async () => {
		fetchMock.mockResolvedValueOnce(
			makeOkResp(APPEND_RESP_WITH_PRODUCT_REF),
		);
		const client = makeClient();
		await client.sendProductCard(ROOM_ID, {
			productRef: PRODUCT_REF,
			productMeta: VALID_PRODUCT_META,
			senderUid: 'alice',
		});

		const [, init] = fetchMock.mock.calls[0];
		const body = JSON.parse((init as RequestInit).body as string);
		expect(body).not.toHaveProperty('sealed_b64');
	});

	it('response DTO includes product_ref field (wire-contract)', async () => {
		fetchMock.mockResolvedValueOnce(makeOkResp(MSG_ROW_WITH_PRODUCT_REF));
		const client = makeClient();
		const result = await client.sendProductCard(ROOM_ID, {
			productRef: PRODUCT_REF,
			productMeta: VALID_PRODUCT_META,
			senderUid: 'alice',
		});
		expect(result).toHaveProperty('productRef', PRODUCT_REF);
	});

	it('throws SDKChatError on 401', async () => {
		fetchMock.mockResolvedValueOnce(makeErrResp(401));
		const client = makeClient();
		await expect(
			client.sendProductCard(ROOM_ID, {
				productRef: PRODUCT_REF,
				productMeta: VALID_PRODUCT_META,
				senderUid: 'alice',
			}),
		).rejects.toBeInstanceOf(SDKChatError);
	});

	it('throws SDKChatError on network failure', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('Network error'));
		const client = makeClient();
		await expect(
			client.sendProductCard(ROOM_ID, {
				productRef: PRODUCT_REF,
				productMeta: VALID_PRODUCT_META,
				senderUid: 'alice',
			}),
		).rejects.toBeInstanceOf(SDKChatError);
	});

	it('response DTO includes product_meta field (wire-contract fix-round)', async () => {
		// C4 fix: server now returns product_meta in the response. Client must map it.
		fetchMock.mockResolvedValueOnce(makeOkResp(APPEND_RESP_WITH_PRODUCT_REF));
		const client = makeClient();
		const result = await client.sendProductCard(ROOM_ID, {
			productRef: PRODUCT_REF,
			productMeta: VALID_PRODUCT_META,
			senderUid: 'alice',
		});
		expect(result).toHaveProperty('productMeta');
		expect(result.productMeta).toMatchObject({
			title: VALID_PRODUCT_META.title,
			price: VALID_PRODUCT_META.price,
			currency: VALID_PRODUCT_META.currency,
		});
	});
});

// ---------------------------------------------------------------------------
// T4: searchByProductRef() wire-contract tests
// ---------------------------------------------------------------------------

describe('SDKChatClient.searchByProductRef()', () => {
	it('GET URL has product_ref query param', async () => {
		fetchMock.mockResolvedValueOnce(makeOkResp([]));
		const client = makeClient();
		await client.searchByProductRef(PRODUCT_REF);

		const [url] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('product_ref=');
		expect(String(url)).toContain(encodeURIComponent(PRODUCT_REF));
	});

	it('GET URL has room_id param when roomId option provided', async () => {
		fetchMock.mockResolvedValueOnce(makeOkResp([]));
		const client = makeClient();
		await client.searchByProductRef(PRODUCT_REF, { roomId: ROOM_ID });

		const [url] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('room_id=');
		expect(String(url)).toContain(encodeURIComponent(ROOM_ID));
	});

	it('GET URL omits room_id when no roomId provided (cross-room search)', async () => {
		fetchMock.mockResolvedValueOnce(makeOkResp([]));
		const client = makeClient();
		await client.searchByProductRef(PRODUCT_REF);

		const [url] = fetchMock.mock.calls[0];
		expect(String(url)).not.toContain('room_id=');
	});

	it('maps response DTOs — product_ref field present in each MessageRow', async () => {
		fetchMock.mockResolvedValueOnce(
			makeOkResp([MSG_ROW_WITH_PRODUCT_REF, { ...MSG_ROW_WITH_PRODUCT_REF, seq: 2 }]),
		);
		const client = makeClient();
		const rows = await client.searchByProductRef(PRODUCT_REF);

		expect(rows).toHaveLength(2);
		// Wire-contract: product_ref must be mapped from snake_case DTO to camelCase MessageRow.
		for (const row of rows) {
			expect(row).toHaveProperty('productRef', PRODUCT_REF);
		}
	});

	it('returns empty array when no matches', async () => {
		fetchMock.mockResolvedValueOnce(makeOkResp([]));
		const client = makeClient();
		const rows = await client.searchByProductRef('nonexistent-sku');
		expect(rows).toHaveLength(0);
	});

	it('throws SDKChatError on 403', async () => {
		fetchMock.mockResolvedValueOnce(makeErrResp(403));
		const client = makeClient();
		await expect(client.searchByProductRef(PRODUCT_REF)).rejects.toBeInstanceOf(SDKChatError);
	});

	it('throws SDKChatError on network failure', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('Network down'));
		const client = makeClient();
		await expect(client.searchByProductRef(PRODUCT_REF)).rejects.toBeInstanceOf(SDKChatError);
	});

	it('passes limit option in query params', async () => {
		fetchMock.mockResolvedValueOnce(makeOkResp([]));
		const client = makeClient();
		await client.searchByProductRef(PRODUCT_REF, { limit: 10 });

		const [url] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('limit=10');
	});

	it('GET response rows include product_meta field (wire-contract fix-round)', async () => {
		// C4 fix: server now returns product_meta in list/search responses.
		fetchMock.mockResolvedValueOnce(
			makeOkResp([MSG_ROW_WITH_PRODUCT_META, { ...MSG_ROW_WITH_PRODUCT_META, seq: 2 }]),
		);
		const client = makeClient();
		const rows = await client.searchByProductRef(PRODUCT_REF);

		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row).toHaveProperty('productMeta');
			expect(row.productMeta).not.toBeNull();
			expect(row.productMeta).toMatchObject({
				title: VALID_PRODUCT_META.title,
			});
		}
	});
});
