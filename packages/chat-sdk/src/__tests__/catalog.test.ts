import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SDKCatalogClient, SDKCatalogError } from '../catalog.js';
import type { ProductMeta } from '../types.js';

// #207: price is a JSON NUMBER now, not a host-pre-formatted string.
const validMeta: ProductMeta = {
	title: 'Widget',
	price: 19.99,
	currency: 'USD',
	imageUrl: 'https://example.com/img.png',
	productUrl: 'https://example.com/product',
};

function mockFetch(resp: Response | Error): ReturnType<typeof vi.fn> {
	return vi.fn().mockResolvedValue(resp) as unknown as ReturnType<typeof vi.fn>;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

// #195: the server emits a snake_case envelope. product_meta keys stay camelCase,
// but the top-level DTO uses product_ref / created_at / updated_at / archived_at.
function snakeProduct(overrides: Partial<{
	product_ref: string;
	title: string;
	price: number;
	currency: string;
	imageUrl: string;
	productUrl: string;
	created_at: string;
	updated_at: string;
	archived_at: string | null;
}> = {}) {
	return {
		product_ref: overrides.product_ref ?? 'sku-1',
		product_meta: {
			title: overrides.title ?? 'Widget',
			price: overrides.price ?? 19.99,
			currency: overrides.currency ?? 'USD',
			imageUrl: overrides.imageUrl ?? 'https://example.com/img.png',
			productUrl: overrides.productUrl ?? 'https://example.com/product',
		},
		created_at: overrides.created_at ?? '2026-07-16T00:00:00Z',
		updated_at: overrides.updated_at ?? '2026-07-16T00:00:00Z',
		archived_at: overrides.archived_at ?? null,
	};
}

/** Parse the JSON body of the Nth fetch call. */
function sentBody(callIndex = 0): Record<string, unknown> {
	const call = vi.mocked(fetch).mock.calls[callIndex];
	const init = call[1] as { body?: string };
	return JSON.parse(init.body ?? '{}');
}

describe('SDKCatalogClient', () => {
	let client: SDKCatalogClient;

	beforeEach(() => {
		client = new SDKCatalogClient({ jwt: 'test-jwt', baseUrl: 'https://chat.test' });
		vi.restoreAllMocks();
	});

	describe('constructor', () => {
		it('rejects jwt with Bearer prefix', () => {
			expect(() => new SDKCatalogClient({ jwt: 'Bearer abc' })).toThrow(SDKCatalogError);
		});

		it('accepts raw jwt', () => {
			const c = new SDKCatalogClient({ jwt: 'abc' });
			expect(c).toBeInstanceOf(SDKCatalogClient);
		});

		// #206b: defense-in-depth — an absolute http:// baseUrl leaks the
		// Bearer JWT in cleartext. Warn (non-breaking).
		it('#206b warns on absolute http:// baseUrl (non-localhost)', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			new SDKCatalogClient({ jwt: 'abc', baseUrl: 'http://chat.test' });
			expect(warn).toHaveBeenCalled();
			warn.mockRestore();
		});

		it('#206b does NOT warn on https absolute baseUrl', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			new SDKCatalogClient({ jwt: 'abc', baseUrl: 'https://chat.test' });
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});

		it('#206b does NOT warn on http://localhost (dev host)', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			new SDKCatalogClient({ jwt: 'abc', baseUrl: 'http://localhost:3000' });
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});

		it('#206b does NOT warn on http://127.0.0.1 (dev host)', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			new SDKCatalogClient({ jwt: 'abc', baseUrl: 'http://127.0.0.1:8080' });
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});

		it('#206b does NOT warn on empty or relative baseUrl', () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
			new SDKCatalogClient({ jwt: 'abc' });
			new SDKCatalogClient({ jwt: 'abc', baseUrl: '/api' });
			expect(warn).not.toHaveBeenCalled();
			warn.mockRestore();
		});
	});

	describe('createProduct', () => {
		it('sends POST with snake_case body { product_ref, product_meta } and returns mapped product', async () => {
			globalThis.fetch = mockFetch(jsonResponse(201, snakeProduct()));

			const result = await client.createProduct({ productRef: 'sku-1', productMeta: validMeta });

			// #195: request body MUST be snake_case — server rejects camelCase keys.
			const body = sentBody(0);
			expect(body).toHaveProperty('product_ref', 'sku-1');
			expect(body).toHaveProperty('product_meta');
			expect(body).not.toHaveProperty('productRef');
			expect(body).not.toHaveProperty('productMeta');

			// #195: response is mapped snake→camel (no blind cast → undefined fields).
			expect(result.productRef).toBe('sku-1');
			expect(result.createdAt).toBe('2026-07-16T00:00:00Z');
			expect(result.updatedAt).toBe('2026-07-16T00:00:00Z');
			expect(result.archivedAt).toBeNull();
			// #207: price stays a number through the mapper.
			expect(result.productMeta.price).toBe(19.99);
			expect(typeof result.productMeta.price).toBe('number');
			expect(result.productMeta.title).toBe('Widget');

			expect(fetch).toHaveBeenCalledWith(
				'https://chat.test/api/sdk/catalog/products',
				expect.objectContaining({
					method: 'POST',
					headers: expect.objectContaining({
						Authorization: 'Bearer test-jwt',
						'Content-Type': 'application/json',
					}),
				}),
			);
		});

		it('throws validation_error on 400', async () => {
			globalThis.fetch = mockFetch(jsonResponse(400, { error: 'title' }));
			await expect(
				client.createProduct({ productRef: 'sku-1', productMeta: validMeta }),
			).rejects.toMatchObject({ code: 'validation_error', status: 400 });
		});

		it('throws conflict on 409', async () => {
			globalThis.fetch = mockFetch(jsonResponse(409, { error: 'product_ref already exists' }));
			await expect(
				client.createProduct({ productRef: 'sku-1', productMeta: validMeta }),
			).rejects.toMatchObject({ code: 'conflict', status: 409 });
		});

		// #206a: 422 Unprocessable Entity is a validation error — without an
		// explicit case it fell to `default → server_4xx`, mislabeling it.
		it('#206a throws validation_error on 422 (not server_4xx)', async () => {
			globalThis.fetch = mockFetch(jsonResponse(422, { error: 'invalid product_meta' }));
			await expect(
				client.createProduct({ productRef: 'sku-1', productMeta: validMeta }),
			).rejects.toMatchObject({ code: 'validation_error', status: 422 });
		});
	});

	describe('listProducts', () => {
		it('sends GET and returns { products, hasMore, nextCursor } mapped from snake_case envelope', async () => {
			globalThis.fetch = mockFetch(
				jsonResponse(200, {
					products: [snakeProduct({ product_ref: 'sku-1' }), snakeProduct({ product_ref: 'sku-2', title: 'Gadget', price: 5 })],
					has_more: true,
					next_cursor: 'abc123',
				}),
			);

			const result = await client.listProducts();
			expect(result.products).toHaveLength(2);
			expect(result.hasMore).toBe(true);
			expect(result.nextCursor).toBe('abc123');
			// Mapping: camelCase fields populated (not undefined from a blind cast).
			expect(result.products[0].productRef).toBe('sku-1');
			expect(result.products[0].createdAt).toBe('2026-07-16T00:00:00Z');
			expect(result.products[1].productMeta.price).toBe(5);
			expect(typeof result.products[1].productMeta.price).toBe('number');
		});

		it('maps has_more:false + next_cursor:null to hasMore:false + nextCursor undefined', async () => {
			globalThis.fetch = mockFetch(
				jsonResponse(200, { products: [], has_more: false, next_cursor: null }),
			);
			const result = await client.listProducts();
			expect(result.products).toEqual([]);
			expect(result.hasMore).toBe(false);
			expect(result.nextCursor).toBeUndefined();
		});

		it('passes limit + cursor query params', async () => {
			globalThis.fetch = mockFetch(
				jsonResponse(200, { products: [], has_more: false, next_cursor: null }),
			);
			await client.listProducts({ limit: 50, cursor: 'abc123' });
			expect(fetch).toHaveBeenCalledWith(
				'https://chat.test/api/sdk/catalog/products?limit=50&cursor=abc123',
				expect.objectContaining({ method: 'GET' }),
			);
		});

		it('maps a malformed-cursor 400 to validation_error', async () => {
			globalThis.fetch = mockFetch(jsonResponse(400, { error: 'invalid cursor' }));
			await expect(client.listProducts({ cursor: 'bad' })).rejects.toMatchObject({
				code: 'validation_error',
				status: 400,
			});
		});
	});

	describe('getProduct', () => {
		it('sends GET with encoded ref and maps the snake_case response', async () => {
			globalThis.fetch = mockFetch(
				jsonResponse(200, snakeProduct({ product_ref: 'sku with space' })),
			);

			const result = await client.getProduct('sku with space');
			expect(result.productRef).toBe('sku with space');
			expect(result.productMeta.price).toBe(19.99);
			expect(fetch).toHaveBeenCalledWith(
				'https://chat.test/api/sdk/catalog/products/sku%20with%20space',
				expect.objectContaining({ method: 'GET' }),
			);
		});

		it('throws not_found on 404', async () => {
			globalThis.fetch = mockFetch(jsonResponse(404, { error: 'not found' }));
			await expect(client.getProduct('missing')).rejects.toMatchObject({ code: 'not_found' });
		});
	});

	describe('updateProduct', () => {
		it('sends PATCH with snake_case body { product_meta } and maps the response', async () => {
			globalThis.fetch = mockFetch(
				jsonResponse(200, snakeProduct({ price: 29.99, updated_at: '2026-07-16T01:00:00Z' })),
			);

			const result = await client.updateProduct('sku-1', {
				productMeta: { ...validMeta, price: 29.99 },
			});
			// #195: update body is { product_meta } (snake), NOT { productMeta }.
			const body = sentBody(0);
			expect(body).toHaveProperty('product_meta');
			expect(body).not.toHaveProperty('productMeta');
			expect(body).not.toHaveProperty('product_ref');

			expect(result.productMeta.price).toBe(29.99);
			expect(typeof result.productMeta.price).toBe('number');
			expect(result.updatedAt).toBe('2026-07-16T01:00:00Z');
		});
	});

	describe('deleteProduct', () => {
		it('sends DELETE and resolves on 204', async () => {
			globalThis.fetch = mockFetch(new Response(null, { status: 204 }));
			await client.deleteProduct('sku-1');
			expect(fetch).toHaveBeenCalledWith(
				'https://chat.test/api/sdk/catalog/products/sku-1',
				expect.objectContaining({ method: 'DELETE' }),
			);
		});

		it('throws not_found on 404', async () => {
			globalThis.fetch = mockFetch(jsonResponse(404, { error: 'not found' }));
			await expect(client.deleteProduct('missing')).rejects.toMatchObject({ code: 'not_found' });
		});
	});

	describe('network errors', () => {
		it('throws network error on fetch failure', async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));
			await expect(client.listProducts()).rejects.toMatchObject({ code: 'network' });
		});

		it('throws server_5xx on 500', async () => {
			globalThis.fetch = mockFetch(jsonResponse(500, { error: 'internal' }));
			await expect(client.listProducts()).rejects.toMatchObject({ code: 'server_5xx' });
		});

		// #206a: an empty 2xx body must not throw a raw SyntaxError that
		// escapes the SDKCatalogError wrapper. Without the guard,
		// resp.json() throws "Unexpected end of JSON input" → deleteProduct
		// rejects with a SyntaxError. With the guard, request() returns null
		// and deleteProduct resolves.
		it('#206a does not throw a raw SyntaxError on an empty 2xx body', async () => {
			globalThis.fetch = mockFetch(new Response(null, { status: 200 }));
			await expect(client.deleteProduct('sku-1')).resolves.toBeUndefined();
		});
	});
});
