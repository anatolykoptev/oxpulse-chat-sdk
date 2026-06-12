/**
 * reactions.test.ts — SDKChatClient W3: sendReaction / removeReaction / getReactions / subscribe onReaction (v0.4.0).
 *
 * Verifies:
 *   - sendReaction POSTs to /api/sdk/messages/:room/:msg/reactions with {reaction} body
 *   - removeReaction sends DELETE to /api/sdk/messages/:room/:msg/reactions/:reaction
 *   - getReactions returns ReactionsResponse with counts + users
 *   - subscribe forwards reaction_add/reaction_remove mutation events to onReaction
 *   - reaction string >32 chars rejected by client before network call
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SDKChatClient } from '../client.js';

// ── Minimal mock fetch ────────────────────────────────────────────────────────

const BASE_URL = 'https://chat.example.com';
const JWT = 'test-jwt';
const ROOM_ID = 'room-react';
const MSG_ID = '00000000-0000-0000-0000-000000000042';

function makeClient() {
  return new SDKChatClient({ baseUrl: BASE_URL, jwt: JWT });
}

function fakeResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => '',
  } as unknown as Response;
}

describe('SDKChatClient — reactions (W3)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── sendReaction ───────────────────────────────────────────────────────────

  it('sendReaction POSTs reaction string in body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(null, 200)),
    );

    const client = makeClient();
    await client.sendReaction(ROOM_ID, MSG_ID, '👍');

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE_URL}/api/sdk/messages/${ROOM_ID}/${MSG_ID}/reactions`);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body['reaction']).toBe('👍');
  });

  // ── removeReaction ─────────────────────────────────────────────────────────

  it('removeReaction sends DELETE to /reactions/:reaction', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(null, 204)),
    );

    const client = makeClient();
    await client.removeReaction(ROOM_ID, MSG_ID, '👍');

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    // Emoji must be percent-encoded in the path.
    expect(url).toContain(`/api/sdk/messages/${ROOM_ID}/${MSG_ID}/reactions/`);
    expect(url).toContain(encodeURIComponent('👍'));
    expect(init?.method).toBe('DELETE');
  });

  // ── getReactions ───────────────────────────────────────────────────────────

  it('getReactions returns ReactionsResponse with counts + users', async () => {
    const serverPayload = {
      counts: { '👍': 2, '❤️': 1 },
      users: { '👍': ['alice', 'bob'], '❤️': ['carol'] },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(fakeResponse(serverPayload, 200)),
    );

    const client = makeClient();
    const result = await client.getReactions(ROOM_ID, MSG_ID);

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe(`${BASE_URL}/api/sdk/messages/${ROOM_ID}/${MSG_ID}/reactions`);

    expect(result.counts['👍']).toBe(2);
    expect(result.counts['❤️']).toBe(1);
    expect(result.users['👍']).toContain('alice');
    expect(result.users['👍']).toContain('bob');
    expect(result.users['❤️']).toContain('carol');
  });

  // ── subscribe onReaction ───────────────────────────────────────────────────

  it('subscribe forwards reaction mutation to onReaction', () => {
    // We test the SSE event dispatch logic without a real EventSource.
    // Build a fake EventSource that stores event listeners, then fire a
    // synthetic 'mutation' event carrying a reaction_add payload.

    type EventListenerMap = Record<string, (ev: MessageEvent) => void>;

    class FakeEventSource {
      url: string;
      listeners: EventListenerMap = {};
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;

      constructor(url: string) {
        this.url = url;
      }

      addEventListener(type: string, cb: (ev: MessageEvent) => void) {
        this.listeners[type] = cb;
      }

      close() {}
    }

    let capturedFakeES: FakeEventSource | null = null;

    vi.stubGlobal('EventSource', class {
      constructor(url: string) {
        capturedFakeES = new FakeEventSource(url);
        return capturedFakeES;
      }
    });

    // Stub fetch for the subscribe-ticket call.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ticket: 'test-ticket-uuid' }),
        text: async () => '',
      } as unknown as Response),
    );

    const receivedReactions: Array<{ op: string; reaction?: string; userId?: string }> = [];

    const client = makeClient();
    client.subscribe(ROOM_ID, {
      onMessage: () => {},
      onReaction: (ev) => {
        receivedReactions.push({ op: ev.op, reaction: ev.reaction, userId: ev.userId });
      },
    });

    // Allow the async subscribe-ticket fetch to complete, then fire the SSE event.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        if (!capturedFakeES) {
          throw new Error('EventSource was never constructed — subscribe did not attach');
        }

        const mutationListener = capturedFakeES.listeners['mutation'];
        expect(mutationListener).toBeDefined();

        // Fire a reaction_add mutation event.
        const payload = JSON.stringify({
          app_id: 'test-app',
          room_id: ROOM_ID,
          msg_id: MSG_ID,
          op: 'reaction_add',
          reaction: '🚀',
          user_id: 'alice',
        });
        mutationListener({ data: payload } as MessageEvent);

        expect(receivedReactions).toHaveLength(1);
        expect(receivedReactions[0]!.op).toBe('reaction_add');
        expect(receivedReactions[0]!.reaction).toBe('🚀');
        expect(receivedReactions[0]!.userId).toBe('alice');

        resolve();
      }, 50);
    });
  });

  // ── client-side validation ─────────────────────────────────────────────────

  it('reaction string >32 chars rejected by client before network call', async () => {
    const tooLong = 'x'.repeat(33);

    vi.stubGlobal('fetch', vi.fn());

    const client = makeClient();
    await expect(client.sendReaction(ROOM_ID, MSG_ID, tooLong)).rejects.toMatchObject({
      code: 'invalid_args',
    });

    // fetch must NOT have been called.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
