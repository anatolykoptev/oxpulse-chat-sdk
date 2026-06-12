// Unit tests for SDKPushClient.
// Run: cd packages/chat-sdk && node_modules/.bin/vitest run

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SDKPushClient, SDKPushError } from '../push';

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

// Guard: vitest env must expose globalThis so we can inject mocks. If
// Notification is already defined we shadow it; if missing we install it.
// Either way the tests must not silently vacuously pass.

function makePushSubscriptionMock(endpoint = 'https://fcm.example.com/sub/abc'): PushSubscription {
	const p256dh = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
	const auth = new Uint8Array([9, 10, 11, 12]);
	return {
		endpoint,
		expirationTime: null,
		options: { applicationServerKey: null, userVisibleOnly: true },
		getKey: vi.fn((name: string) => {
			if (name === 'p256dh') return p256dh.buffer;
			if (name === 'auth') return auth.buffer;
			return null;
		}),
		toJSON: vi.fn(() => ({ endpoint, keys: { p256dh: 'AQIDBA', auth: 'CQoL' } })),
		unsubscribe: vi.fn().mockResolvedValue(true),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(() => true),
	} as unknown as PushSubscription;
}

function makePushManagerMock(existing: PushSubscription | null = null): PushManager {
	// When existing===null, subscribe() is what creates a new sub — construct
	// it lazily inside the mock so callers control which object is returned.
	const newSub = makePushSubscriptionMock();
	return {
		getSubscription: vi.fn().mockResolvedValue(existing),
		subscribe: vi.fn().mockResolvedValue(newSub),
		permissionState: vi.fn().mockResolvedValue('granted'),
	} as unknown as PushManager;
}

function makeSwRegistrationMock(sub: PushSubscription | null = null): ServiceWorkerRegistration {
	return {
		pushManager: makePushManagerMock(sub),
	} as unknown as ServiceWorkerRegistration;
}

let swMessageListeners: Array<(ev: MessageEvent) => void> = [];

function installNavigatorMocks(opts: {
	hasServiceWorker?: boolean;
	swReg?: ServiceWorkerRegistration;
	hasPushManager?: boolean;
} = {}) {
	const { hasServiceWorker = true, swReg = makeSwRegistrationMock(), hasPushManager = true } = opts;

	if (!hasServiceWorker) {
		// Remove serviceWorker from navigator
		Object.defineProperty(globalThis, 'navigator', {
			value: { ...globalThis.navigator },
			writable: true,
			configurable: true,
		});
		const nav = globalThis.navigator as unknown as Record<string, unknown>;
		delete nav.serviceWorker;
		// Also remove PushManager so isSupported() returns false
		const gThis = globalThis as unknown as Record<string, unknown>;
		delete gThis.PushManager;
		return;
	}

	swMessageListeners = [];
	const swContainer = {
		ready: Promise.resolve(swReg),
		addEventListener: vi.fn((type: string, fn: EventListenerOrEventListenerObject) => {
			if (type === 'message') swMessageListeners.push(fn as (ev: MessageEvent) => void);
		}),
		removeEventListener: vi.fn((type: string, fn: EventListenerOrEventListenerObject) => {
			if (type === 'message') {
				const idx = swMessageListeners.indexOf(fn as (ev: MessageEvent) => void);
				if (idx !== -1) swMessageListeners.splice(idx, 1);
			}
		}),
	};
	Object.defineProperty(globalThis, 'navigator', {
		value: { ...globalThis.navigator, serviceWorker: swContainer },
		writable: true,
		configurable: true,
	});

	// Install or remove PushManager on globalThis
	if (hasPushManager) {
		Object.defineProperty(globalThis, 'PushManager', {
			value: class PushManager {},
			writable: true,
			configurable: true,
		});
	} else {
		const gThis = globalThis as unknown as Record<string, unknown>;
		delete gThis.PushManager;
	}
}

function installNotificationMock(permission: NotificationPermission = 'default') {
	const mock = {
		permission,
		requestPermission: vi.fn().mockResolvedValue('granted'),
	};
	Object.defineProperty(globalThis, 'Notification', {
		value: mock,
		writable: true,
		configurable: true,
	});
}

function dispatchSwMessage(data: unknown) {
	const ev = new MessageEvent('message', { data });
	for (const fn of [...swMessageListeners]) fn(ev);
}

// ---------------------------------------------------------------------------
// Pre-describe guard
// ---------------------------------------------------------------------------

if (typeof globalThis.MessageEvent === 'undefined') {
	throw new Error('vitest env must provide MessageEvent — missing global DOM API; run via: cd web && node_modules/.bin/vitest run');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SDKPushClient', () => {
	beforeEach(() => {
		// T1 fix: resetAllMocks FIRST, then install mocks — avoids partial state from
		// previous test leaking into the reset state.
		vi.resetAllMocks();
		installNotificationMock('default');
		installNavigatorMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// -------------------------------------------------------------------------
	// G1 — constructor guard against "Bearer " prefix
	// -------------------------------------------------------------------------
	describe('constructor()', () => {
		it('throws SDKPushError invalid_args (not unsupported) when jwt starts with "Bearer " (G1)', () => {
			expect(() => new SDKPushClient({ jwt: 'Bearer myrawtoken' })).toThrow(SDKPushError);
			let caught: SDKPushError | undefined;
			try {
				new SDKPushClient({ jwt: 'Bearer myrawtoken' });
			} catch (e) {
				caught = e as SDKPushError;
			}
			expect(caught).toBeDefined();
			expect(caught!.code).toBe('invalid_args');
			expect(caught!.message).toMatch(/must NOT include "Bearer "/);
		});

		it('accepts raw jwt without prefix', () => {
			expect(() => new SDKPushClient({ jwt: 'myrawtoken' })).not.toThrow();
		});
	});

	// -------------------------------------------------------------------------
	// 1. isSupported()
	// -------------------------------------------------------------------------
	describe('isSupported()', () => {
		it('returns true when Notification + serviceWorker + PushManager all present', () => {
			// mocks installed in beforeEach
			expect(SDKPushClient.isSupported()).toBe(true);
		});

		it('returns false when serviceWorker is missing', () => {
			installNavigatorMocks({ hasServiceWorker: false });
			expect(SDKPushClient.isSupported()).toBe(false);
		});

		it('returns false when PushManager is absent (C1 — Firefox<99 guard)', () => {
			// ServiceWorker present but PushManager missing (Firefox<99 scenario)
			installNavigatorMocks({ hasServiceWorker: true, hasPushManager: false });
			expect(SDKPushClient.isSupported()).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// C2 — requestPermission() Safari<16 callback-form path
	// -------------------------------------------------------------------------
	describe('requestPermission()', () => {
		it('resolves via modern Promise-returning API', async () => {
			installNotificationMock('default');
			// Modern: requestPermission returns a Promise
			const mockFn = vi.fn().mockReturnValue(Promise.resolve('granted'));
			(globalThis.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission =
				mockFn;

			const perm = await SDKPushClient.requestPermission();
			expect(perm).toBe('granted');
		});

		it('modern path uses Promise return value, NOT callback (C2 — no double-resolve race)', async () => {
			// Regression test for the bug: old code passed a callback AND awaited
			// the Promise. Some browsers fire the callback synchronously with a
			// stale/null value (or with `default` before the user decides), then
			// resolve the Promise later with the real verdict. Promise spec
			// ignores the second resolve, so the caller saw the callback's stale
			// value instead of the real result.
			//
			// We simulate that divergence: callback fires SYNCHRONOUSLY with
			// 'denied'; Promise resolves with 'granted'. Correct (post-fix) code
			// MUST return 'granted' (Promise path). Buggy code returns 'denied'.
			installNotificationMock('default');
			const mockFn = vi.fn().mockImplementation((cb?: (perm: NotificationPermission) => void) => {
				if (cb) cb('denied'); // legacy callback fires sync with stale value
				return Promise.resolve('granted'); // modern Promise resolves with truth
			});
			(globalThis.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission =
				mockFn;

			const perm = await SDKPushClient.requestPermission();
			// Post-fix: Promise wins (modern path).
			// Pre-fix: callback would fire first, Promise's second resolve ignored, perm would be 'denied'.
			expect(perm).toBe('granted');
			// Also: modern path must not double-invoke the API.
			expect(mockFn).toHaveBeenCalledTimes(1);
		});

		it('resolves via Safari<16 callback-form (returns undefined, fires callback)', async () => {
			installNotificationMock('default');
			// Safari<16: requestPermission accepts callback, returns undefined
			const mockFn = vi.fn().mockImplementation((cb?: (perm: NotificationPermission) => void) => {
				if (cb) cb('granted');
				return undefined; // Safari<16 returns undefined
			});
			(globalThis.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission =
				mockFn;

			const perm = await SDKPushClient.requestPermission();
			expect(perm).toBe('granted');
		});

		it('Safari<16 path calls requestPermission with a callback (not a probe without one)', async () => {
			installNotificationMock('default');
			// Verify the callback-based form is called (not a no-arg probe)
			let callbackReceived = false;
			const mockFn = vi.fn().mockImplementation((cb?: (perm: NotificationPermission) => void) => {
				if (cb) {
					callbackReceived = true;
					cb('default');
				}
				return undefined;
			});
			(globalThis.Notification as unknown as { requestPermission: ReturnType<typeof vi.fn> }).requestPermission =
				mockFn;

			await SDKPushClient.requestPermission();
			expect(callbackReceived).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// 2. getVapidPublicKey() — fetch + cache
	// -------------------------------------------------------------------------
	describe('getVapidPublicKey()', () => {
		it('GETs /api/sdk/push/vapid-public-key, parses public_key, caches for instance', async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ public_key: 'abc123_-xyz' }),
			});
			vi.stubGlobal('fetch', fetchMock);

			const client = new SDKPushClient({ jwt: 'test.jwt.token' });
			const key1 = await client.getVapidPublicKey();
			const key2 = await client.getVapidPublicKey(); // second call — must use cache

			expect(key1).toBe('abc123_-xyz');
			expect(key2).toBe('abc123_-xyz');
			// Only one network request despite two calls
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock).toHaveBeenCalledWith('/api/sdk/push/vapid-public-key');
		});
	});

	// -------------------------------------------------------------------------
	// 3. subscribe() happy path
	// -------------------------------------------------------------------------
	describe('subscribe() — happy path', () => {
		it('fetches VAPID, subscribes PushManager, POSTs to server, returns {endpoint, deviceId}', async () => {
			installNotificationMock('granted');
			const sub = makePushSubscriptionMock('https://fcm.example.com/sub/happy');
			const reg = makeSwRegistrationMock(null); // no existing subscription
			(reg.pushManager.subscribe as ReturnType<typeof vi.fn>).mockResolvedValue(sub);
			installNavigatorMocks({ swReg: reg });

			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({ public_key: 'dGVzdA' }), // base64url for "test"
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({ device_id: 'uuid-1234' }),
				});
			vi.stubGlobal('fetch', fetchMock);

			const client = new SDKPushClient({ jwt: 'rawjwt' });
			const result = await client.subscribe();

			expect(result.endpoint).toBe('https://fcm.example.com/sub/happy');
			expect(result.deviceId).toBe('uuid-1234');

			// Verify the POST was made with correct auth header
			const [postUrl, postInit] = fetchMock.mock.calls[1];
			expect(postUrl).toContain('/api/sdk/push/subscribe');
			expect((postInit as RequestInit).headers).toBeTruthy();
			const headers = new Headers((postInit as RequestInit).headers as HeadersInit);
			expect(headers.get('Authorization')).toBe('Bearer rawjwt');
		});
	});

	// -------------------------------------------------------------------------
	// 4. subscribe() reuses existing PushSubscription
	// -------------------------------------------------------------------------
	describe('subscribe() — reuses existing subscription', () => {
		it('skips pushManager.subscribe() when getSubscription() returns a subscription', async () => {
			installNotificationMock('granted');
			const existingSub = makePushSubscriptionMock('https://fcm.example.com/sub/existing');
			const reg = makeSwRegistrationMock(existingSub);
			installNavigatorMocks({ swReg: reg });

			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({ public_key: 'dGVzdA' }),
				})
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({ device_id: 'uuid-existing' }),
				});
			vi.stubGlobal('fetch', fetchMock);

			const client = new SDKPushClient({ jwt: 'tok' });
			const result = await client.subscribe();

			expect(result.endpoint).toBe('https://fcm.example.com/sub/existing');
			// pushManager.subscribe should NOT have been called (reuse path)
			expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
		});
	});

	// -------------------------------------------------------------------------
	// 5. subscribe() throws permission_denied and permission_required (D1)
	// -------------------------------------------------------------------------
	describe('subscribe() — permission checks', () => {
		it('throws SDKPushError code="permission_denied" when Notification.permission==="denied"', async () => {
			installNotificationMock('denied');

			const client = new SDKPushClient({ jwt: 'tok' });
			await expect(client.subscribe()).rejects.toSatisfy((err: unknown) => {
				return err instanceof SDKPushError && err.code === 'permission_denied';
			});
		});

		it('throws SDKPushError code="permission_required" when Notification.permission==="default" (D1)', async () => {
			installNotificationMock('default');

			const client = new SDKPushClient({ jwt: 'tok' });
			await expect(client.subscribe()).rejects.toSatisfy((err: unknown) => {
				return err instanceof SDKPushError && err.code === 'permission_required';
			});
		});
	});

	// -------------------------------------------------------------------------
	// 6. subscribe() error codes — server errors + subscription_invalid (D3)
	// -------------------------------------------------------------------------
	describe('subscribe() — server error codes', () => {
		it('throws SDKPushError code="server_4xx" on 401 from subscribe endpoint', async () => {
			installNotificationMock('granted');
			const sub = makePushSubscriptionMock();
			const reg = makeSwRegistrationMock(sub); // has existing sub — skip PushManager.subscribe
			installNavigatorMocks({ swReg: reg });

			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({ public_key: 'dGVzdA' }),
				})
				.mockResolvedValueOnce({
					ok: false,
					status: 401,
					json: async () => ({ error: 'unauthorized' }),
				});
			vi.stubGlobal('fetch', fetchMock);

			const client = new SDKPushClient({ jwt: 'bad.tok' });
			await expect(client.subscribe()).rejects.toSatisfy((err: unknown) => {
				return err instanceof SDKPushError && err.code === 'server_4xx';
			});
		});

		it('throws SDKPushError code="server_5xx" on 503 from subscribe endpoint', async () => {
			installNotificationMock('granted');
			const sub = makePushSubscriptionMock();
			const reg = makeSwRegistrationMock(sub);
			installNavigatorMocks({ swReg: reg });

			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					status: 200,
					json: async () => ({ public_key: 'dGVzdA' }),
				})
				.mockResolvedValueOnce({
					ok: false,
					status: 503,
					json: async () => ({ error: 'unavailable' }),
				});
			vi.stubGlobal('fetch', fetchMock);

			const client = new SDKPushClient({ jwt: 'tok' });
			await expect(client.subscribe()).rejects.toSatisfy((err: unknown) => {
				return err instanceof SDKPushError && err.code === 'server_5xx';
			});
		});

		it('throws SDKPushError code="subscription_invalid" when getKey() returns null (D3)', async () => {
			installNotificationMock('granted');

			// Sub whose getKey always returns null
			const badSub = {
				...makePushSubscriptionMock(),
				getKey: vi.fn().mockReturnValue(null),
			} as unknown as PushSubscription;
			const reg = makeSwRegistrationMock(badSub);
			installNavigatorMocks({ swReg: reg });

			const fetchMock = vi.fn().mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ public_key: 'dGVzdA' }),
			});
			vi.stubGlobal('fetch', fetchMock);

			const client = new SDKPushClient({ jwt: 'tok' });
			await expect(client.subscribe()).rejects.toSatisfy((err: unknown) => {
				return err instanceof SDKPushError && err.code === 'subscription_invalid';
			});
		});
	});

	// -------------------------------------------------------------------------
	// subscribe() — AbortError maps to permission_required
	// -------------------------------------------------------------------------
	describe('subscribe() — AbortError', () => {
		it('throws SDKPushError code="permission_required" when pushManager.subscribe throws AbortError', async () => {
			installNotificationMock('granted');
			const reg = makeSwRegistrationMock(null); // no existing sub — will call subscribe()
			const abortErr = new DOMException('Permission prompt closed', 'AbortError');
			(reg.pushManager.subscribe as ReturnType<typeof vi.fn>).mockRejectedValue(abortErr);
			installNavigatorMocks({ swReg: reg });

			const fetchMock = vi.fn().mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ public_key: 'dGVzdA' }),
			});
			vi.stubGlobal('fetch', fetchMock);

			const client = new SDKPushClient({ jwt: 'tok' });
			await expect(client.subscribe()).rejects.toSatisfy((err: unknown) => {
				return err instanceof SDKPushError && err.code === 'permission_required';
			});
		});
	});

	// -------------------------------------------------------------------------
	// currentSubscription() — wraps SW.ready rejection
	// -------------------------------------------------------------------------
	describe('currentSubscription()', () => {
		it('throws SDKPushError code="unsupported" when serviceWorker.ready rejects', async () => {
			// Override swContainer.ready to reject
			const rejectingSwContainer = {
				ready: Promise.reject(new Error('SW registration failed')),
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
			};
			Object.defineProperty(globalThis, 'navigator', {
				value: { ...globalThis.navigator, serviceWorker: rejectingSwContainer },
				writable: true,
				configurable: true,
			});

			const client = new SDKPushClient({ jwt: 'tok' });
			await expect(client.currentSubscription()).rejects.toSatisfy((err: unknown) => {
				return err instanceof SDKPushError && err.code === 'unsupported';
			});
		});
	});

	// 7. unsubscribe() — server DELETE first, then PushSubscription.unsubscribe()
	// -------------------------------------------------------------------------
	describe('unsubscribe()', () => {
		it('calls server DELETE then PushSubscription.unsubscribe() in that order', async () => {
			const sub = makePushSubscriptionMock('https://fcm.example.com/sub/del');
			const reg = makeSwRegistrationMock(sub);
			installNavigatorMocks({ swReg: reg });

			const callOrder: string[] = [];

			const fetchMock = vi.fn().mockImplementation(async () => {
				callOrder.push('server_delete');
				return { ok: true, status: 200, json: async () => ({}) };
			});
			vi.stubGlobal('fetch', fetchMock);
			(sub.unsubscribe as ReturnType<typeof vi.fn>).mockImplementation(async () => {
				callOrder.push('push_unsubscribe');
				return true;
			});

			const client = new SDKPushClient({ jwt: 'tok' });
			await client.unsubscribe();

			expect(callOrder).toEqual(['server_delete', 'push_unsubscribe']);

			const [deleteUrl, deleteInit] = fetchMock.mock.calls[0];
			expect(deleteUrl).toContain('/api/sdk/push/unsubscribe');
			expect((deleteInit as RequestInit).method).toBe('DELETE');
		});

		it('throws SDKPushError code="unsupported" when PushSubscription.unsubscribe() returns false (D4)', async () => {
			const sub = makePushSubscriptionMock('https://fcm.example.com/sub/refuse');
			const reg = makeSwRegistrationMock(sub);
			installNavigatorMocks({ swReg: reg });

			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({}),
			});
			vi.stubGlobal('fetch', fetchMock);

			// Browser refuses to remove the subscription
			(sub.unsubscribe as ReturnType<typeof vi.fn>).mockResolvedValue(false);

			const client = new SDKPushClient({ jwt: 'tok' });
			await expect(client.unsubscribe()).rejects.toSatisfy((err: unknown) => {
				return err instanceof SDKPushError && err.code === 'unsupported';
			});
		});

		it('still calls browser unsubscribe before rethrowing on non-410 server error (D5)', async () => {
			const sub = makePushSubscriptionMock('https://fcm.example.com/sub/err');
			const reg = makeSwRegistrationMock(sub);
			installNavigatorMocks({ swReg: reg });

			const fetchMock = vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				json: async () => ({}),
			});
			vi.stubGlobal('fetch', fetchMock);
			(sub.unsubscribe as ReturnType<typeof vi.fn>).mockResolvedValue(true);

			const client = new SDKPushClient({ jwt: 'tok' });
			await expect(client.unsubscribe()).rejects.toSatisfy((err: unknown) => {
				return err instanceof SDKPushError && err.code === 'server_5xx';
			});
			// Browser unsubscribe must still have been called
			expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
		});
	});

	// -------------------------------------------------------------------------
	// 8. attachSubscriptionChangeListener — onResubscribed
	// -------------------------------------------------------------------------
	describe('attachSubscriptionChangeListener()', () => {
		it('calls onResubscribed when newEndpoint is a string', async () => {
			const onResubscribed = vi.fn();
			const onLost = vi.fn();

			const client = new SDKPushClient({ jwt: 'tok' });
			client.attachSubscriptionChangeListener({ onResubscribed, onLost });

			dispatchSwMessage({
				type: 'push_subscription_changed',
				oldEndpoint: 'https://fcm.example.com/sub/old',
				newEndpoint: 'https://fcm.example.com/sub/new',
			});

			// Allow microtasks (handlers may be async)
			await Promise.resolve();

			expect(onResubscribed).toHaveBeenCalledWith('https://fcm.example.com/sub/new');
			expect(onLost).not.toHaveBeenCalled();
		});

		// -----------------------------------------------------------------------
		// 9. attachSubscriptionChangeListener — onLost
		// -----------------------------------------------------------------------
		it('calls onLost when newEndpoint is null', async () => {
			const onResubscribed = vi.fn();
			const onLost = vi.fn();

			const client = new SDKPushClient({ jwt: 'tok' });
			client.attachSubscriptionChangeListener({ onResubscribed, onLost });

			dispatchSwMessage({
				type: 'push_subscription_changed',
				oldEndpoint: 'https://fcm.example.com/sub/lost',
				newEndpoint: null,
			});

			await Promise.resolve();

			expect(onLost).toHaveBeenCalledWith('https://fcm.example.com/sub/lost');
			expect(onResubscribed).not.toHaveBeenCalled();
		});

		// -----------------------------------------------------------------------
		// 10. teardown removes listener — subsequent dispatch is a no-op
		// -----------------------------------------------------------------------
		it('teardown fn removes message listener — subsequent dispatch is a no-op', async () => {
			const onResubscribed = vi.fn();
			const onLost = vi.fn();

			const client = new SDKPushClient({ jwt: 'tok' });
			const teardown = client.attachSubscriptionChangeListener({ onResubscribed, onLost });

			// Fire once — should be received
			dispatchSwMessage({
				type: 'push_subscription_changed',
				oldEndpoint: 'https://fcm.example.com/sub/a',
				newEndpoint: 'https://fcm.example.com/sub/b',
			});
			await Promise.resolve();
			expect(onResubscribed).toHaveBeenCalledTimes(1);

			// Teardown — remove listener
			teardown();

			// Fire again — must be a no-op
			dispatchSwMessage({
				type: 'push_subscription_changed',
				oldEndpoint: 'https://fcm.example.com/sub/c',
				newEndpoint: 'https://fcm.example.com/sub/d',
			});
			await Promise.resolve();
			// Still only 1 call — listener was removed
			expect(onResubscribed).toHaveBeenCalledTimes(1);
		});

		it('forwards async rejection from onResubscribed to onError (C4)', async () => {
			const onResubscribed = vi.fn().mockRejectedValue(new Error('resubscribe failed'));
			const onLost = vi.fn();
			const onError = vi.fn();

			const client = new SDKPushClient({ jwt: 'tok' });
			client.attachSubscriptionChangeListener({ onResubscribed, onLost, onError });

			dispatchSwMessage({
				type: 'push_subscription_changed',
				oldEndpoint: 'https://fcm.example.com/sub/x',
				newEndpoint: 'https://fcm.example.com/sub/y',
			});

			// Drain the microtask queue so the .catch fires
			await Promise.resolve();
			await Promise.resolve();

			expect(onError).toHaveBeenCalledWith(expect.any(Error));
		});
	});
});
