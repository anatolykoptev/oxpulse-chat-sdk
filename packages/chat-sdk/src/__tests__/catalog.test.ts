import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SDKCatalogClient, SDKCatalogError } from '../catalog.js';
import type { ProductMeta } from '../types.js';

const validMeta: ProductMeta = {
	title: 'Widget',
	price: '19.99',
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
	});

	describe('createProduct', () => {
		it('sends POST with correct body and returns product', async () => {
			const product = {
				productRef: 'sku-1',
				productMeta: validMeta,
				createdAt: '2026-07-16T00:00:00Z',
				updatedAt: '2026-07-16T00:00:00Z',
				archivedAt: null,
			};
			globalThis.fetch = mockFetch(jsonResponse(201, product));

			const result = await client.createProduct({ productRef: 'sku-1', productMeta: validMeta });

			expect(result.productRef).toBe('sku-1');
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
	});

	describe('listProducts', () => {
		it('sends GET and returns products array', async () => {
			const products = [
				{ productRef: 'sku-1', productMeta: validMeta, createdAt: '', updatedAt: '', archivedAt: null },
			];
			globalThis.fetch = mockFetch(jsonResponse(200, { products }));

			const result = await client.listProducts();
			expect(result).toHaveLength(1);
			expect(result[0].productRef).toBe('sku-1');
		});

		it('passes limit query param', async () => {
			globalThis.fetch = mockFetch(jsonResponse(200, { products: [] }));
			await client.listProducts({ limit: 50 });
			expect(fetch).toHaveBeenCalledWith(
				'https://chat.test/api/sdk/catalog/products?limit=50',
				expect.objectContaining({ method: 'GET' }),
			);
		});
	});

	describe('getProduct', () => {
		it('sends GET with encoded ref', async () => {
			const product = {
				productRef: 'sku with space',
				productMeta: validMeta,
				createdAt: '',
				updatedAt: '',
				archivedAt: null,
			};
			globalThis.fetch = mockFetch(jsonResponse(200, product));

			const result = await client.getProduct('sku with space');
			expect(result.productRef).toBe('sku with space');
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
		it('sends PATCH with product_meta body', async () => {
			const product = {
				productRef: 'sku-1',
				productMeta: { ...validMeta, price: '29.99' },
				createdAt: '',
				updatedAt: '2026-07-16T01:00:00Z',
				archivedAt: null,
			};
			globalThis.fetch = mockFetch(jsonResponse(200, product));

			const result = await client.updateProduct('sku-1', {
				productMeta: { ...validMeta, price: '29.99' },
			});
			expect(result.productMeta.price).toBe('29.99');
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
	});
});
