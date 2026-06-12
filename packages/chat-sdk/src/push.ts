/**
 * @module sdkPush
 *
 * SDKPushClient — typed wrapper for Web Push subscribe/unsubscribe flow.
 *
 * Spec: docs/superpowers/plans/2026-05-13-w3-push-notifications.md T9
 * Server API: POST/DELETE /api/sdk/push/{subscribe,unsubscribe}
 *             GET /api/sdk/push/vapid-public-key
 *
 * Auth: SDK JWT with scope push:write:* in Authorization: Bearer header.
 * Key encoding: browser ArrayBuffer keys (p256dh, auth) → base64url before POST.
 *               Server VAPID public key (base64url) → Uint8Array for PushManager.
 *
 * VAPID public key endpoint is intentionally unauthenticated — the public key
 * is non-secret per RFC 8292 §3.  Only subscribe/unsubscribe require Bearer JWT.
 */

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type SDKPushErrorCode =
	| 'unsupported'
	| 'invalid_args'
	| 'permission_denied'
	| 'permission_required'
	| 'no_vapid_key'
	| 'network'
	| 'server_4xx'
	| 'server_5xx'
	| 'subscription_invalid';

export class SDKPushError extends Error {
	readonly code: SDKPushErrorCode;
	readonly cause: Error | Response | unknown;

	constructor(code: SDKPushErrorCode, message: string, cause: Error | Response | unknown) {
		super(message);
		this.name = 'SDKPushError';
		this.code = code;
		this.cause = cause;
	}
}

// ---------------------------------------------------------------------------
// Base64url helpers (inline — no external dep)
// ---------------------------------------------------------------------------

/** ArrayBuffer → base64url string (no padding). */
function arrayBufferToBase64url(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let bin = '';
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url string → Uint8Array<ArrayBuffer> (used to feed applicationServerKey). */
function base64urlToUint8Array(s: string): Uint8Array<ArrayBuffer> {
	const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
	const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
	const buf = new ArrayBuffer(bin.length);
	const out = new Uint8Array(buf);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface SubscribeResult {
	endpoint: string;
	/** Server-returned device UUID. */
	deviceId: string;
}

export interface SubscriptionChangeListenerOpts {
	/** Called when SW rotated the subscription to a new endpoint. */
	onResubscribed: (newEndpoint: string) => void | Promise<void>;
	/** Called when the new subscription is null (permission revoked / VAPID changed). */
	onLost: (oldEndpoint: string | null) => void | Promise<void>;
	/** Called when onResubscribed or onLost rejects. Defaults to console.error. */
	onError?: (err: unknown) => void;
}

export class SDKPushClient {
	private readonly jwt: string;
	private readonly baseUrl: string;
	private vapidCache: string | null = null;

	/**
	 * @param args.jwt    Raw SDK JWT with scope push:write:* — do NOT include "Bearer " prefix.
	 *                    The wrapper adds the prefix. Passing a pre-prefixed token throws.
	 * @param args.baseUrl Optional URL prefix; default ''.
	 *
	 * @throws {SDKPushError} code='invalid_args' if jwt starts with "Bearer ".
	 */
	constructor(args: { jwt: string; baseUrl?: string }) {
		if (args.jwt.startsWith('Bearer ')) {
			throw new SDKPushError(
				'invalid_args',
				'jwt arg must NOT include "Bearer " prefix — pass raw token',
				new Error('bad jwt prefix')
			);
		}
		this.jwt = args.jwt;
		this.baseUrl = args.baseUrl ?? '';
	}

	// -------------------------------------------------------------------------
	// Static helpers
	// -------------------------------------------------------------------------

	/**
	 * Returns true when Notification API + ServiceWorker + PushManager are all present.
	 * Firefox<99 has serviceWorker without PushManager — both checks required.
	 *
	 * **Caveat:** iOS Safari < 16.4 (and PWA-in-WKWebView on older iOS) returns `true` here
	 * but `subscribe()` will reject — Apple did not implement Web Push until iOS 16.4
	 * (March 2023). Callers integrating PWAs on older iOS should also gate UX on a
	 * `userAgent` sniff if this matters.
	 */
	static isSupported(): boolean {
		return (
			typeof globalThis.Notification !== 'undefined' &&
			typeof navigator !== 'undefined' &&
			'serviceWorker' in navigator &&
			navigator.serviceWorker != null &&
			'PushManager' in globalThis
		);
	}

	/** Returns current Notification.permission. */
	static permission(): NotificationPermission {
		return Notification.permission;
	}

	/**
	 * Requests notification permission from the user.
	 *
	 * Handles Safari<16 which uses the legacy callback-form of
	 * Notification.requestPermission() (returns undefined instead of Promise).
	 *
	 * Implementation note: we probe by calling without a callback first.
	 * If the return value is a Promise (modern path), we return it directly —
	 * this ensures requestPermission() is called exactly once.
	 * If it returns undefined (Safari<16 callback path), we re-call with a
	 * callback. The browser only shows the permission prompt once per user
	 * gesture, so the no-arg probe on Safari<16 is a no-op (returns undefined
	 * without prompting); the callback-form call is the one that actually
	 * prompts.
	 *
	 * @returns Promise that resolves to 'granted' | 'denied' | 'default'.
	 *
	 * @throws {SDKPushError} code='unsupported' if Notification API is absent.
	 *
	 * @example
	 * const perm = await SDKPushClient.requestPermission();
	 * if (perm !== 'granted') { // show UI explaining why push is needed }
	 */
	static requestPermission(): Promise<NotificationPermission> {
		// Modern browsers (Chrome, Firefox, Safari≥16) return a Promise.
		// Return it directly — avoids the double-resolve race that occurs when
		// both the callback and the Promise settle the same resolve().
		const probe = Notification.requestPermission();
		if (probe instanceof Promise) return probe;

		// Safari<16 callback fallback: probe returned undefined, re-call with
		// the callback form to actually display the permission prompt.
		return new Promise<NotificationPermission>((resolve) => {
			Notification.requestPermission(resolve);
		});
	}

	// -------------------------------------------------------------------------
	// VAPID public key
	// -------------------------------------------------------------------------

	/**
	 * Fetches VAPID public key from server.
	 * Result is cached per client instance — only one network request per instance.
	 *
	 * The /api/sdk/push/vapid-public-key endpoint is intentionally unauthenticated:
	 * the VAPID public key is non-secret per RFC 8292 §3. subscribe/unsubscribe
	 * carry the Bearer JWT; this endpoint does not.
	 *
	 * @throws {SDKPushError} code='network' | 'server_4xx' | 'server_5xx' | 'no_vapid_key'
	 *
	 * @example
	 * const key = await client.getVapidPublicKey();
	 */
	async getVapidPublicKey(): Promise<string> {
		if (this.vapidCache !== null) return this.vapidCache;

		let resp: Response;
		try {
			resp = await fetch(`${this.baseUrl}/api/sdk/push/vapid-public-key`);
		} catch (err) {
			throw new SDKPushError('network', 'Failed to fetch VAPID public key', err);
		}

		if (!resp.ok) {
			const code = resp.status >= 500 ? 'server_5xx' : 'server_4xx';
			throw new SDKPushError(code, `VAPID key fetch returned HTTP ${resp.status}`, resp);
		}

		const body = (await resp.json()) as { public_key?: string };
		if (!body.public_key) {
			throw new SDKPushError('no_vapid_key', 'Server returned no public_key field', resp);
		}

		this.vapidCache = body.public_key;
		return this.vapidCache;
	}

	// -------------------------------------------------------------------------
	// Subscribe
	// -------------------------------------------------------------------------

	/**
	 * Subscribes to Web Push notifications.
	 *
	 * Caller MUST call `requestPermission()` and await `'granted'` before `subscribe()`.
	 * If permission is not yet granted this method throws with code='permission_required'.
	 *
	 * Flow:
	 *   1. Permission check — throws permission_denied if denied, permission_required if
	 *      not yet granted.
	 *   2. Fetch VAPID key (cached).
	 *   3. navigator.serviceWorker.ready → pushManager.getSubscription() (reuse if present).
	 *   4. If no existing subscription: pushManager.subscribe({userVisibleOnly, applicationServerKey}).
	 *   5. POST /api/sdk/push/subscribe with base64url-encoded keys.
	 *   6. Return {endpoint, deviceId}.
	 *
	 * @throws {SDKPushError} code='permission_denied' | 'permission_required' | 'unsupported'
	 *                              | 'network' | 'server_4xx' | 'server_5xx' | 'subscription_invalid'
	 *
	 * Note on AbortError: on iOS, `AbortError` from `pushManager.subscribe()` maps to
	 * `code='permission_required'` (not `'network'`) — the prompt closed without the
	 * user explicitly granting or denying. Callers should prompt the user to try again.
	 *
	 * @example
	 * const perm = await SDKPushClient.requestPermission();
	 * if (perm === 'granted') {
	 *   const { endpoint, deviceId } = await client.subscribe();
	 * }
	 */
	async subscribe(opts?: { userAgent?: string }): Promise<SubscribeResult> {
		if (Notification.permission === 'denied') {
			throw new SDKPushError(
				'permission_denied',
				'Notification permission is denied — user must reset browser permissions',
				new Error('permission denied')
			);
		}

		if (Notification.permission !== 'granted') {
			throw new SDKPushError(
				'permission_required',
				'Call requestPermission() before subscribe()',
				new Error('permission not granted')
			);
		}

		const vapidPub = await this.getVapidPublicKey();
		const applicationServerKey = base64urlToUint8Array(vapidPub);

		let reg: ServiceWorkerRegistration;
		try {
			reg = await navigator.serviceWorker.ready;
		} catch (err) {
			throw new SDKPushError('unsupported', 'ServiceWorker not ready', err);
		}

		let sub: PushSubscription | null;
		try {
			sub = await reg.pushManager.getSubscription();
		} catch (err) {
			throw new SDKPushError('network', 'Failed to get existing PushSubscription', err);
		}

		if (!sub) {
			try {
				sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
			} catch (err) {
				// Browser may throw DOMException if permission was revoked mid-flow.
				// Note: DOMException does not extend Error in all environments (e.g. jsdom),
				// so we read .name via a type-safe helper rather than `instanceof Error`.
				const domName = (err as { name?: string })?.name;
				if (domName === 'NotAllowedError') {
					throw new SDKPushError('permission_denied', 'PushManager.subscribe denied', err);
				}
				// On iOS, AbortError fires when the permission prompt closes without
				// user interaction (timeout, app backgrounded). Semantically this means
				// the user did not grant permission, not a network error.
				if (domName === 'AbortError') {
					throw new SDKPushError('permission_required', 'PushManager.subscribe aborted — permission prompt closed without user action', err);
				}
				throw new SDKPushError('network', 'PushManager.subscribe failed', err);
			}
		}

		const p256dhBuf = sub.getKey('p256dh');
		const authBuf = sub.getKey('auth');
		if (!p256dhBuf || !authBuf) {
			throw new SDKPushError(
				'subscription_invalid',
				'PushSubscription.getKey() returned null — browser does not support required keys',
				new Error('missing push keys')
			);
		}

		const body: Record<string, string> = {
			endpoint: sub.endpoint,
			p256dh: arrayBufferToBase64url(p256dhBuf),
			auth: arrayBufferToBase64url(authBuf),
		};
		if (opts?.userAgent) body.ua = opts.userAgent;

		let postResp: Response;
		try {
			postResp = await fetch(`${this.baseUrl}/api/sdk/push/subscribe`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.jwt}`,
				},
				body: JSON.stringify(body),
			});
		} catch (err) {
			throw new SDKPushError('network', 'Failed to POST /api/sdk/push/subscribe', err);
		}

		if (!postResp.ok) {
			const code = postResp.status >= 500 ? 'server_5xx' : 'server_4xx';
			throw new SDKPushError(
				code,
				`Subscribe endpoint returned HTTP ${postResp.status}`,
				postResp
			);
		}

		const result = (await postResp.json()) as { device_id?: string };
		if (!result.device_id) {
			throw new SDKPushError('server_4xx', 'Server response missing device_id', postResp);
		}

		return { endpoint: sub.endpoint, deviceId: result.device_id };
	}

	// -------------------------------------------------------------------------
	// Unsubscribe
	// -------------------------------------------------------------------------

	/**
	 * Unsubscribes from Web Push.
	 *
	 * Server DELETE is called first to handle 410-style stale cleanup.
	 * For non-410 server errors (401/429/5xx) we still call PushSubscription.unsubscribe()
	 * browser-side before rethrowing — a browser subscription leak is worse than server
	 * inconsistency: the server can be reconciled via admin tooling, but a leaked browser
	 * subscription causes perpetual delivery attempts.
	 *
	 * @throws {SDKPushError} code='unsupported' | 'network' | 'server_4xx' | 'server_5xx'
	 *
	 * @example
	 * await client.unsubscribe();
	 */
	async unsubscribe(): Promise<void> {
		let reg: ServiceWorkerRegistration;
		try {
			reg = await navigator.serviceWorker.ready;
		} catch (err) {
			throw new SDKPushError('unsupported', 'ServiceWorker not ready', err);
		}

		const sub = await reg.pushManager.getSubscription();
		if (!sub) return; // Nothing to unsubscribe

		// Server first — inform backend even before browser-side removal
		let deleteResp: Response;
		let serverError: SDKPushError | null = null;
		try {
			deleteResp = await fetch(`${this.baseUrl}/api/sdk/push/unsubscribe`, {
				method: 'DELETE',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.jwt}`,
				},
				body: JSON.stringify({ endpoint: sub.endpoint }),
			});

			if (!deleteResp.ok) {
				const code = deleteResp.status >= 500 ? 'server_5xx' : 'server_4xx';
				serverError = new SDKPushError(
					code,
					`Unsubscribe endpoint returned HTTP ${deleteResp.status}`,
					deleteResp
				);
			}
		} catch (err) {
			// Network failure — still attempt browser-side removal to avoid leak,
			// then rethrow the original network error.
			serverError = new SDKPushError('network', 'Failed to DELETE /api/sdk/push/unsubscribe', err);
		}

		// Browser second — always attempt to remove local subscription.
		// Avoids perpetual delivery attempts even if server call failed.
		const removed = await sub.unsubscribe();
		if (!removed) {
			throw new SDKPushError(
				'unsupported',
				'Browser refused to remove PushSubscription',
				new Error('unsubscribe() returned false')
			);
		}

		// Now rethrow server error if any (after browser sub is cleaned up)
		if (serverError !== null) throw serverError;
	}

	// -------------------------------------------------------------------------
	// Current subscription
	// -------------------------------------------------------------------------

	/**
	 * Returns the current PushSubscription or null if not subscribed.
	 *
	 * @throws {SDKPushError} code='unsupported' if ServiceWorker is not ready.
	 *
	 * @example
	 * const sub = await client.currentSubscription();
	 * if (sub) console.log(sub.endpoint);
	 */
	async currentSubscription(): Promise<PushSubscription | null> {
		const reg = await navigator.serviceWorker.ready.catch((e) => {
			throw new SDKPushError('unsupported', 'Service Worker not ready', e);
		});
		return reg.pushManager.getSubscription();
	}

	// -------------------------------------------------------------------------
	// SW push_subscription_changed listener
	// -------------------------------------------------------------------------

	/**
	 * Wires the SW `pushsubscriptionchange` consumer.
	 *
	 * The SW posts `{type:'push_subscription_changed', oldEndpoint, newEndpoint}`
	 * to all clients (web/static/sw.js). When `newEndpoint !== null`, calls
	 * `onResubscribed`; when `newEndpoint === null` (permission revoked / VAPID
	 * changed), calls `onLost`.
	 *
	 * Returns a teardown function that removes the message listener.
	 *
	 * Async rejections from `onResubscribed` / `onLost` are forwarded to
	 * `opts.onError` (defaults to `console.error`) so they are never silently lost.
	 *
	 * @throws Never (errors in callbacks are forwarded to opts.onError).
	 *
	 * @example
	 * const teardown = client.attachSubscriptionChangeListener({
	 *   onResubscribed: async (ep) => { await reRegister(ep); },
	 *   onLost: (old) => showResubscribeBanner(),
	 *   onError: (err) => reportError(err),
	 * });
	 * // later:
	 * teardown();
	 */
	attachSubscriptionChangeListener(opts: SubscriptionChangeListenerOpts): () => void {
		const onErr = opts.onError ?? console.error;

		const handler = (ev: MessageEvent) => {
			const data = ev.data as {
				type?: string;
				oldEndpoint?: string | null;
				newEndpoint?: string | null;
			} | null;

			if (!data || data.type !== 'push_subscription_changed') return;

			if (data.newEndpoint != null) {
				Promise.resolve(opts.onResubscribed(data.newEndpoint)).catch(onErr);
			} else {
				Promise.resolve(opts.onLost(data.oldEndpoint ?? null)).catch(onErr);
			}
		};

		navigator.serviceWorker.addEventListener('message', handler);
		return () => navigator.serviceWorker.removeEventListener('message', handler);
	}
}
