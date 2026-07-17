/**
 * @module sdkCatalog
 *
 * SDKCatalogClient — typed wrapper for seller product catalog CRUD.
 *
 * Server API: POST/GET/PATCH/DELETE /api/sdk/catalog/products[/:ref]
 * Auth: SDK JWT with scope catalog:read:* / catalog:write:* in
 *       Authorization: Bearer header.
 *
 * Pattern: separate class (mirrors SDKPushClient) — SDKChatClient is
 * already ~2900 lines; catalog is a distinct API surface.
 *
 * Product metadata (title, price, currency, imageUrl, productUrl) is
 * non-sensitive and server-visible — same E2EE-relaxed design as the
 * existing product card message kind (W9). See:
 *   docs/superpowers/plans/2026-05-13-marketplace-chat-roadmap.md:324
 */

import type { ProductMeta } from './types.js';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type SDKCatalogErrorCode =
	| 'invalid_args'
	| 'network'
	| 'aborted'
	| 'server_4xx'
	| 'server_5xx'
	| 'not_found'
	| 'conflict'
	| 'validation_error';

export class SDKCatalogError extends Error {
	readonly code: SDKCatalogErrorCode;
	readonly status: number;
	readonly cause: Error | Response | unknown;

	constructor(
		code: SDKCatalogErrorCode,
		message: string,
		cause: Error | Response | unknown,
		status = 0,
	) {
		super(message);
		this.name = 'SDKCatalogError';
		this.code = code;
		this.status = status;
		this.cause = cause;
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A product in the seller's catalog. */
export interface CatalogProduct {
	productRef: string;
	productMeta: ProductMeta;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
}

/** Response shape from GET /api/sdk/catalog/products. */
interface CatalogProductListDTO {
	products: CatalogProduct[];
}

/** Request body for POST /api/sdk/catalog/products. */
interface CreateProductRequest {
	productRef: string;
	productMeta: ProductMeta;
}

/** Request body for PATCH /api/sdk/catalog/products/:ref. */
interface UpdateProductRequest {
	productMeta: ProductMeta;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Typed wrapper for the seller product catalog API.
 *
 * Usage:
 * ```ts
 * import { SDKCatalogClient } from '@oxpulse/chat-sdk';
 *
 * const catalog = new SDKCatalogClient({
 *   baseUrl: 'https://chat.example.com',
 *   jwt: rawJwt, // NO "Bearer " prefix
 * });
 *
 * // Create a product
 * const product = await catalog.createProduct({
 *   productRef: 'sku-123',
 *   productMeta: { title: 'Widget', price: '19.99', currency: 'USD', imageUrl: '', productUrl: '' },
 * });
 *
 * // List all products
 * const { products } = await catalog.listProducts();
 *
 * // Send a product card in chat (using existing SDKChatClient)
 * chatClient.setProductCard(product.productRef, product.productMeta);
 * ```
 */
export class SDKCatalogClient {
	private readonly jwt: string;
	private readonly baseUrl: string;

	/**
	 * @param args.jwt    Raw SDK JWT with scope catalog:read:* and/or catalog:write:*.
	 *                    Do NOT include "Bearer " prefix — the wrapper adds it.
	 * @param args.baseUrl Optional URL prefix; default ''.
	 *
	 * @throws {SDKCatalogError} code='invalid_args' if jwt starts with "Bearer ".
	 */
	constructor(args: { jwt: string; baseUrl?: string }) {
		if (args.jwt.startsWith('Bearer ')) {
			throw new SDKCatalogError(
				'invalid_args',
				'jwt arg must NOT include "Bearer " prefix — pass raw token',
				new Error('bad jwt prefix'),
			);
		}
		this.jwt = args.jwt;
		this.baseUrl = args.baseUrl ?? '';
	}

	// ── CRUD ────────────────────────────────────────────────────────────────

	/**
	 * Create a new product in the seller's catalog.
	 *
	 * Idempotent: if a product with the same productRef already exists for
	 * this seller, returns the existing row (200 OK from server).
	 *
	 * @throws {SDKCatalogError} code='validation_error' if product_meta is invalid.
	 * @throws {SDKCatalogError} code='conflict' if product_ref is owned by another seller.
	 * @throws {SDKCatalogError} code='network' / 'server_4xx' / 'server_5xx' on transport errors.
	 */
	async createProduct(args: {
		productRef: string;
		productMeta: ProductMeta;
		signal?: AbortSignal;
	}): Promise<CatalogProduct> {
		const body: CreateProductRequest = {
			productRef: args.productRef,
			productMeta: args.productMeta,
		};
		const resp = await this.request('POST', '/api/sdk/catalog/products', body, args.signal);
		return resp as unknown as CatalogProduct;
	}

	/**
	 * List all active products in the seller's catalog (newest first).
	 *
	 * @param opts.limit Max products to return (default 500, max 1000).
	 * @param opts.signal Optional AbortSignal to cancel the request.
	 * @throws {SDKCatalogError} on transport/auth errors.
	 */
	async listProducts(opts?: { limit?: number; signal?: AbortSignal }): Promise<CatalogProduct[]> {
		const qs = opts?.limit != null ? `?limit=${encodeURIComponent(opts.limit)}` : '';
		const resp = await this.request('GET', `/api/sdk/catalog/products${qs}`, undefined, opts?.signal);
		return (resp as unknown as CatalogProductListDTO).products;
	}

	/**
	 * Get a single product by product_ref.
	 *
	 * @throws {SDKCatalogError} code='not_found' if the product doesn't exist or is archived.
	 */
	async getProduct(productRef: string, signal?: AbortSignal): Promise<CatalogProduct> {
		const resp = await this.request('GET', `/api/sdk/catalog/products/${encodeURIComponent(productRef)}`, undefined, signal);
		return resp as unknown as CatalogProduct;
	}

	/**
	 * Update product_meta for an existing product.
	 *
	 * @throws {SDKCatalogError} code='not_found' if the product doesn't exist or is archived.
	 * @throws {SDKCatalogError} code='validation_error' if product_meta is invalid.
	 */
	async updateProduct(productRef: string, args: { productMeta: ProductMeta; signal?: AbortSignal }): Promise<CatalogProduct> {
		const body: UpdateProductRequest = { productMeta: args.productMeta };
		const resp = await this.request('PATCH', `/api/sdk/catalog/products/${encodeURIComponent(productRef)}`, body, args.signal);
		return resp as unknown as CatalogProduct;
	}

	/**
	 * Soft-delete (archive) a product. Messages referencing this product_ref
	 * still render because they carry a product_meta snapshot.
	 *
	 * @throws {SDKCatalogError} code='not_found' if the product doesn't exist or is already archived.
	 */
	async deleteProduct(productRef: string, signal?: AbortSignal): Promise<void> {
		await this.request('DELETE', `/api/sdk/catalog/products/${encodeURIComponent(productRef)}`, undefined, signal);
	}

	// ── Internal fetch wrapper ──────────────────────────────────────────────

	private async request(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		let resp: Response;
		try {
			resp = await fetch(`${this.baseUrl}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${this.jwt}`,
					'Content-Type': 'application/json',
				},
				body: body != null ? JSON.stringify(body) : undefined,
				signal,
			});
		} catch (err) {
			// Distinguish intentional abort from network failure.
			if (err instanceof DOMException && err.name === 'AbortError') {
				throw new SDKCatalogError(
					'aborted',
					`catalog ${method} ${path} aborted`,
					err,
				);
			}
			throw new SDKCatalogError(
				'network',
				`catalog ${method} ${path} network error`,
				err,
			);
		}

		// 204 No Content — DELETE success.
		if (resp.status === 204) return null;

		// 2xx with body.
		if (resp.ok) {
			return resp.json();
		}

		// Error responses.
		let errBody: string;
		try {
			const json = await resp.json();
			errBody = json?.error ?? resp.statusText;
		} catch {
			errBody = resp.statusText;
		}

		switch (resp.status) {
			case 400:
				throw new SDKCatalogError('validation_error', errBody, resp, 400);
			case 403:
				throw new SDKCatalogError('server_4xx', errBody, resp, 403);
			case 404:
				throw new SDKCatalogError('not_found', errBody, resp, 404);
			case 409:
				throw new SDKCatalogError('conflict', errBody, resp, 409);
			case 413:
				throw new SDKCatalogError('validation_error', errBody, resp, 413);
			default:
				if (resp.status >= 500) {
					throw new SDKCatalogError('server_5xx', errBody, resp, resp.status);
				}
				throw new SDKCatalogError('server_4xx', errBody, resp, resp.status);
		}
	}
}
