/**
 * element-selfuid.test.ts — selfUid derivation from the JWT `sub` claim.
 *
 * The demo/partner embed regression this pins: without a `self-uid`
 * attribute the widget used to fall back to '' — so the visitor's OWN
 * messages rendered as "other" (left-aligned, avatar slot) instead of the
 * messenger-standard self alignment. selfUid now falls back to the JWT
 * `sub` claim; the explicit attribute still wins.
 *
 * Tests:
 *   unit — selfUidFromJwt: sub present / absent / non-string / malformed / null
 *   wiring — mounted element without self-uid attr: own message bubble gets
 *            data-self="true", another sender's gets data-self="false"
 *   wiring — explicit self-uid attribute overrides the JWT sub
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OxpulseChatElement, defineElement, selfUidFromJwt } from '../element.js';
import type { MessageListClient } from '../ui/message-list.js';

// Helper: make a valid JWT with aud_origins matching localhost (same shape
// as element-anon-read.test.ts).
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

const SELF_JWT = makeJwt({ aud_origins: ['http://localhost:*'], sub: 'u-self' });

function makeRow(msgId: string, senderUid: string) {
  return {
    seq: 1,
    msgId,
    senderUid,
    sealed: new ArrayBuffer(0),
    createdAt: new Date().toISOString(),
    threadRootMsgId: null,
    productRef: null,
    productMeta: null,
    text: `message from ${senderUid}`,
  };
}

function makeMockClient(rows: ReturnType<typeof makeRow>[]): MessageListClient & {
  sendText(roomId: string, text: string, _args?: unknown): Promise<{ msgId: string }>;
} {
  return {
    list: vi.fn().mockResolvedValue({ items: rows, hasNext: false }),
    subscribe: vi.fn().mockImplementation(() => () => {}),
    getReactions: vi.fn().mockResolvedValue({ counts: {}, users: {}, truncated: false }),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ msgId: 'mock-msg-id' }),
  };
}

describe('selfUidFromJwt (unit)', () => {
  it('returns the sub claim when present', () => {
    expect(selfUidFromJwt(SELF_JWT)).toBe('u-self');
  });

  it('returns undefined for a null jwt', () => {
    expect(selfUidFromJwt(null)).toBeUndefined();
  });

  it('returns undefined when sub is absent', () => {
    expect(selfUidFromJwt(makeJwt({ aud_origins: ['http://localhost:*'] }))).toBeUndefined();
  });

  it('returns undefined when sub is empty or non-string (fail soft)', () => {
    expect(selfUidFromJwt(makeJwt({ sub: '' }))).toBeUndefined();
    expect(selfUidFromJwt(makeJwt({ sub: 42 }))).toBeUndefined();
  });

  it('returns undefined for a malformed token instead of throwing', () => {
    expect(selfUidFromJwt('not-a-jwt')).toBeUndefined();
    expect(selfUidFromJwt('a.@@@invalid-base64@@@.c')).toBeUndefined();
  });
});

describe('OxpulseChatElement — selfUid wiring', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    defineElement();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    vi.clearAllMocks();
  });

  async function mountWith(attrs: Record<string, string>, rows: ReturnType<typeof makeRow>[]) {
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el._setCallbacks({ _createClient: () => makeMockClient(rows) });
    container.appendChild(el);
    // Wait for async bootstrap (origin check + client construction + first list()).
    await new Promise((r) => setTimeout(r, 80));
    return el;
  }

  it('no self-uid attribute: own message (jwt sub) is data-self=true, other is false', async () => {
    const el = await mountWith(
      { 'app-id': 'app1', 'room-id': 'room1', jwt: SELF_JWT },
      [makeRow('m-own', 'u-self'), makeRow('m-other', 'u-other')],
    );

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    const own = shadow!.querySelector('.oxp-bubble[data-msg-id="m-own"]');
    const other = shadow!.querySelector('.oxp-bubble[data-msg-id="m-other"]');
    expect(own, 'own bubble rendered').not.toBeNull();
    expect(other, 'other bubble rendered').not.toBeNull();
    expect(own!.getAttribute('data-self')).toBe('true');
    expect(other!.getAttribute('data-self')).toBe('false');
  });

  it('explicit self-uid attribute overrides the JWT sub', async () => {
    const el = await mountWith(
      { 'app-id': 'app1', 'room-id': 'room1', jwt: SELF_JWT, 'self-uid': 'attr-uid' },
      [makeRow('m-attr', 'attr-uid'), makeRow('m-jwt-sub', 'u-self')],
    );

    const shadow = el.shadowRoot;
    const attrOwn = shadow!.querySelector('.oxp-bubble[data-msg-id="m-attr"]');
    const jwtSub = shadow!.querySelector('.oxp-bubble[data-msg-id="m-jwt-sub"]');
    expect(attrOwn!.getAttribute('data-self')).toBe('true');
    // The jwt sub must NOT be treated as self when the attribute is set.
    expect(jwtSub!.getAttribute('data-self')).toBe('false');
  });

  // Bug 1 (independent audit, sibling gap to #39): #resolveConfig() computes
  // config.selfUid BEFORE anon-read / named-write minting runs in #bootstrap, so
  // it can never see a mint result. In anon-read mode there is no jwt attribute
  // at all (selfUidFromJwt(null) → undefined), so selfUid stayed unresolved even
  // though a real identity (anon mint userId, and/or the named-write JWT's sub)
  // became available moments later — the visitor's own echoed messages then
  // rendered as "other".
  describe('selfUid backfill from minted anon/write identity (no self-uid attr, no jwt attr)', () => {
    it('anon-read + named-write: a message from the write JWT sub renders data-self=true', async () => {
      const WRITE_JWT = makeJwt({ aud_origins: ['http://localhost:*'], sub: 'named-writer', write: true });
      const mintAnon = vi.fn().mockResolvedValue({
        token: makeJwt({ aud_origins: ['http://localhost:*'], sub: 'anon-001', anon: true }),
        userId: 'anon-uid-001',
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      });
      const mintWrite = vi.fn().mockResolvedValue(WRITE_JWT);

      const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
      el.setAttribute('app-id', 'app1');
      el.setAttribute('room-id', 'room1');
      el.setAttribute('allow-anon-read', '');
      el.setAttribute('allow-write', '');
      el.setAttribute('write-mint-endpoint', '/api/write-token');
      el._setCallbacks({
        _mintAnonReadToken: mintAnon,
        _mintNamedWriteToken: mintWrite,
        _createClient: () => makeMockClient([makeRow('m-own', 'named-writer'), makeRow('m-other', 'u-other')]),
      });
      container.appendChild(el);
      await new Promise((r) => setTimeout(r, 80));

      const shadow = el.shadowRoot;
      expect(shadow).not.toBeNull();
      const own = shadow!.querySelector('.oxp-bubble[data-msg-id="m-own"]');
      const other = shadow!.querySelector('.oxp-bubble[data-msg-id="m-other"]');
      expect(own, 'own bubble rendered').not.toBeNull();
      expect(other, 'other bubble rendered').not.toBeNull();
      expect(own!.getAttribute('data-self')).toBe('true');
      expect(other!.getAttribute('data-self')).toBe('false');
    });

    it('anon-read only (no named-write): a message from the anon mint userId renders data-self=true', async () => {
      const mintAnon = vi.fn().mockResolvedValue({
        token: makeJwt({ aud_origins: ['http://localhost:*'], sub: 'anon-002', anon: true }),
        userId: 'anon-uid-X',
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      });

      const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
      el.setAttribute('app-id', 'app1');
      el.setAttribute('room-id', 'room1');
      el.setAttribute('allow-anon-read', '');
      el._setCallbacks({
        _mintAnonReadToken: mintAnon,
        _createClient: () => makeMockClient([makeRow('m-own', 'anon-uid-X'), makeRow('m-other', 'u-other')]),
      });
      container.appendChild(el);
      await new Promise((r) => setTimeout(r, 80));

      const shadow = el.shadowRoot;
      expect(shadow).not.toBeNull();
      const own = shadow!.querySelector('.oxp-bubble[data-msg-id="m-own"]');
      const other = shadow!.querySelector('.oxp-bubble[data-msg-id="m-other"]');
      expect(own, 'own bubble rendered').not.toBeNull();
      expect(other, 'other bubble rendered').not.toBeNull();
      expect(own!.getAttribute('data-self')).toBe('true');
      expect(other!.getAttribute('data-self')).toBe('false');
    });
  });
});
