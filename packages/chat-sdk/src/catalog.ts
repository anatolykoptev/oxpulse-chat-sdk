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
// #195: reuse the rooms boundary-mapping pattern — do NOT hand-roll a parallel
// snake↔camel mapper. normalizeProductMeta is the shared product_meta validator
// used by both the message-row path (client.ts) and this catalog CRUD path.
import { normalizeProductMeta } from './client.js';

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

/** A product in the seller's catalog (camelCase SDK surface). */
export interface CatalogProduct {
	productRef: string;
	productMeta: ProductMeta;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
}

/**
 * #195: Result of GET /api/sdk/catalog/products. The wire envelope is
 * `{ products, has_more, next_cursor }` (snake_case); this is the mapped
 * camelCase surface returned to SDK consumers.
 */
export interface CatalogProductList {
	products: CatalogProduct[];
	hasMore: boolean;
	nextCursor?: string;
}

// ── Wire DTOs (snake_case — server contract, #195) ──────────────────────────
//
// Only the top-level envelope is snake_case; the nested `product_meta` blob
// (title/price/currency/imageUrl/productUrl) is legitimately camelCase on both
// sides. Mirrors the rooms DTO pattern in client.ts (RoomDTO / dtoToRoom).

/** Response DTO for a single product (POST/GET/PATCH). */
interface CatalogProductDTO {
	product_ref: string;
	product_meta: unknown;
	created_at: string;
	updated_at: string;
	archived_at: string | null;
}

/** Response DTO for GET /api/sdk/catalog/products. */
interface CatalogProductListDTO {
	products: CatalogProductDTO[];
	has_more: boolean;
	next_cursor?: string | null;
}

/** Request body for POST /api/sdk/catalog/products (snake_case). */
interface CreateProductRequestDTO {
	product_ref: string;
	product_meta: ProductMeta;
}

/** Request body for PATCH /api/sdk/catalog/products/:ref (snake_case). */
interface UpdateProductRequestDTO {
	product_meta: ProductMeta;
}

/**
 * #195: Map a snake_case product DTO to the camelCase `CatalogProduct` SDK
 * surface. Reuses `normalizeProductMeta` (client.ts) for the product_meta blob
 * so the catalog CRUD path and the message-row path share one validator —
 * never a blind `as unknown as CatalogProduct` cast that leaves productRef /
 * createdAt / archivedAt undefined.
 *
 * `product_meta` is normalized defensively: a malformed blob degrades to a
 * minimal valid ProductMeta rather than surfacing garbage / throwing. The
 * server validates product_meta on write, but the SDK receive boundary stays
 * defensive (peer-controlled shape on the message-row path).
 */
function dtoToCatalogProduct(dto: CatalogProductDTO): CatalogProduct {
	const meta = normalizeProductMeta(dto.product_meta);
	// Server-validated on write; if a row somehow lacks a usable product_meta,
	// fall back to an empty-but-typed shape rather than null (CatalogProduct
	// promises a non-null productMeta).
	const productMeta: ProductMeta = meta ?? { title: '', price: 0, currency: '', imageUrl: '', productUrl: '' };
	return {
		productRef: dto.product_ref,
		productMeta,
		createdAt: dto.created_at,
		updatedAt: dto.updated_at,
		archivedAt: dto.archived_at,
	};
}

/**
 * Build the `?limit=&cursor=` query string for listProducts. Empty when neither
 * param is supplied (no trailing `?`). Cursor is encoded — a malformed cursor
 * is surfaced by the server as a 400 → validation_error.
 */
function buildListQuery(limit?: number, cursor?: string): string {
	const params: string[] = [];
	if (limit != null) params.push(`limit=${encodeURIComponent(limit)}`);
	if (cursor != null) params.push(`cursor=${encodeURIComponent(cursor)}`);
	return params.length > 0 ? `?${params.join('&')}` : '';
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
 *   productMeta: { title: 'Widget', price: 19.99, currency: 'USD', imageUrl: '', productUrl: '' },
 * });
 *
 * // List all products
 * const { products, hasMore, nextCursor } = await catalog.listProducts();
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
		const baseUrl = args.baseUrl ?? '';
		// #206: defense-in-depth — the JWT rides as `Authorization: Bearer <jwt>`
		// on every request. An absolute `http://` baseUrl leaks it in cleartext
		// (passive MITM). Warn (non-breaking) for a non-https absolute scheme;
		// allow empty / relative / localhost / 127.0.0.1 (dev + same-origin).
		if (baseUrl) {
			try {
				const url = new URL(baseUrl);
				const isDevHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
				if (url.protocol !== 'https:' && !isDevHost) {
					console.warn(
						`[SDKCatalogClient] absolute baseUrl with non-https scheme "${url.protocol}" ` +
							'leaks the Bearer JWT in cleartext (passive MITM). Use https: ' +
							'or a relative URL, or use http://localhost for local dev.',
					);
				}
			} catch {
				// Relative URL (e.g. "/api") — fetch resolves against the page
				// origin; allowed (same-origin / proxied deployments).
			}
		}
		this.baseUrl = baseUrl;
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
		// #195: wire envelope is snake_case { product_ref, product_meta }.
		const body: CreateProductRequestDTO = {
			product_ref: args.productRef,
			product_meta: args.productMeta,
		};
		const resp = await this.request('POST', '/api/sdk/catalog/products', body, args.signal);
		return dtoToCatalogProduct(resp as CatalogProductDTO);
	}

	/**
	 * List active products in the seller's catalog (newest first), with
	 * cursor-based pagination.
	 *
	 * @param opts.limit   Max products to return (server-capped).
	 * @param opts.cursor  Opaque cursor from a prior `nextCursor` (next page).
	 * @param opts.signal  Optional AbortSignal to cancel the request.
	 * @returns `{ products, hasMore, nextCursor }` — mapped from the snake_case
	 *          `{ products, has_more, next_cursor }` envelope.
	 * @throws {SDKCatalogError} code='validation_error' on a malformed cursor (400).
	 * @throws {SDKCatalogError} on transport/auth errors.
	 */
	async listProducts(opts?: { limit?: number; cursor?: string; signal?: AbortSignal }): Promise<CatalogProductList> {
		const qs = buildListQuery(opts?.limit, opts?.cursor);
		const resp = await this.request('GET', `/api/sdk/catalog/products${qs}`, undefined, opts?.signal);
		const dto = resp as CatalogProductListDTO;
		return {
			products: dto.products.map(dtoToCatalogProduct),
			hasMore: dto.has_more,
			nextCursor: dto.next_cursor ?? undefined,
		};
	}

	/**
	 * Get a single product by product_ref.
	 *
	 * @throws {SDKCatalogError} code='not_found' if the product doesn't exist or is archived.
	 */
	async getProduct(productRef: string, signal?: AbortSignal): Promise<CatalogProduct> {
		const resp = await this.request('GET', `/api/sdk/catalog/products/${encodeURIComponent(productRef)}`, undefined, signal);
		return dtoToCatalogProduct(resp as CatalogProductDTO);
	}

	/**
	 * Update product_meta for an existing product.
	 *
	 * @throws {SDKCatalogError} code='not_found' if the product doesn't exist or is archived.
	 * @throws {SDKCatalogError} code='validation_error' if product_meta is invalid.
	 */
	async updateProduct(productRef: string, args: { productMeta: ProductMeta; signal?: AbortSignal }): Promise<CatalogProduct> {
		// #195: wire body is snake_case { product_meta } (no product_ref in PATCH).
		const body: UpdateProductRequestDTO = { product_meta: args.productMeta };
		const resp = await this.request('PATCH', `/api/sdk/catalog/products/${encodeURIComponent(productRef)}`, body, args.signal);
		return dtoToCatalogProduct(resp as CatalogProductDTO);
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
			// #206: guard resp.json() — an empty 2xx body (e.g. a 200 No Content
			// from a misconfigured server) throws a raw SyntaxError that would
			// escape the SDKCatalogError wrapper. Treat an empty/non-JSON body
			// as no content (mirrors the 204 path) instead.
			try {
				return await resp.json();
			} catch {
				return null;
			}
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
			// #206: 422 Unprocessable Entity is a validation error — without this
			// case it fell to `default → server_4xx`, mislabeling a validation
			// failure as a generic 4xx.
			case 422:
				throw new SDKCatalogError('validation_error', errBody, resp, 422);
			default:
				if (resp.status >= 500) {
					throw new SDKCatalogError('server_5xx', errBody, resp, resp.status);
				}
				throw new SDKCatalogError('server_4xx', errBody, resp, resp.status);
		}
	}
}
