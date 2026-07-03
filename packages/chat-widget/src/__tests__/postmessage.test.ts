/**
 * postmessage.test.ts — TDD RED phase
 *
 * Tests: typed iframe ↔ parent postMessage protocol.
 * Cases per W2.1 spec:
 *  1. isParentMessage accepts valid 'init' message
 *  2. isParentMessage rejects malformed payloads
 *  3. isIframeMessage accepts valid messages
 *  4. isIframeMessage rejects malformed payloads
 *  5. Type guards reject messages with wrong namespace
 *  6. sendToParent posts to window.parent
 *  7. onParentMessage listener fires on valid message, ignores invalid
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isParentMessage,
  isIframeMessage,
} from '../postmessage.js';
import type { WidgetConfig } from '../types.js';

const NS = 'oxpulse-chat';

function validConfig(): WidgetConfig {
  return {
    appId: 'app1',
    jwt: 'hdr.payload.sig',
    roomId: 'room1',
  };
}

// ── isParentMessage ───────────────────────────────────────────────────────────

describe('isParentMessage', () => {
  it('accepts valid init message', () => {
    const msg = { ns: NS, type: 'init', config: validConfig() };
    expect(isParentMessage(msg)).toBe(true);
  });

  it('accepts valid refresh-token message', () => {
    const msg = { ns: NS, type: 'refresh-token', jwt: 'new.jwt.token' };
    expect(isParentMessage(msg)).toBe(true);
  });

  it('accepts valid set-theme light message', () => {
    const msg = { ns: NS, type: 'set-theme', theme: 'light' };
    expect(isParentMessage(msg)).toBe(true);
  });

  it('accepts valid set-theme dark message', () => {
    const msg = { ns: NS, type: 'set-theme', theme: 'dark' };
    expect(isParentMessage(msg)).toBe(true);
  });

  it('accepts valid set-theme auto message', () => {
    const msg = { ns: NS, type: 'set-theme', theme: 'auto' };
    expect(isParentMessage(msg)).toBe(true);
  });

  it('rejects message without ns', () => {
    const msg = { type: 'init', config: validConfig() };
    expect(isParentMessage(msg)).toBe(false);
  });

  it('rejects message with wrong ns', () => {
    const msg = { ns: 'other-ns', type: 'init', config: validConfig() };
    expect(isParentMessage(msg)).toBe(false);
  });

  it('rejects init message without config', () => {
    const msg = { ns: NS, type: 'init' };
    expect(isParentMessage(msg)).toBe(false);
  });

  it('rejects init message with config missing appId', () => {
    const msg = { ns: NS, type: 'init', config: { jwt: 'x', roomId: 'r' } };
    expect(isParentMessage(msg)).toBe(false);
  });

  it('rejects refresh-token without jwt', () => {
    const msg = { ns: NS, type: 'refresh-token' };
    expect(isParentMessage(msg)).toBe(false);
  });

  it('rejects set-theme with invalid theme value', () => {
    const msg = { ns: NS, type: 'set-theme', theme: 'solarized' };
    expect(isParentMessage(msg)).toBe(false);
  });

  it('rejects unknown type', () => {
    const msg = { ns: NS, type: 'explode', payload: true };
    expect(isParentMessage(msg)).toBe(false);
  });

  it('rejects null', () => {
    expect(isParentMessage(null)).toBe(false);
  });

  it('rejects string', () => {
    expect(isParentMessage('hello')).toBe(false);
  });

  it('rejects array', () => {
    expect(isParentMessage([])).toBe(false);
  });
});

// ── isIframeMessage ───────────────────────────────────────────────────────────

describe('isIframeMessage', () => {
  it('accepts valid ready message', () => {
    const msg = { ns: NS, type: 'ready', roomId: 'room1' };
    expect(isIframeMessage(msg)).toBe(true);
  });

  it('accepts valid error message', () => {
    const msg = { ns: NS, type: 'error', code: 'ORIGIN_NOT_ALLOWED', message: 'Not allowed' };
    expect(isIframeMessage(msg)).toBe(true);
  });

  it('accepts valid token-expired message', () => {
    const msg = { ns: NS, type: 'token-expired', roomId: 'room1' };
    expect(isIframeMessage(msg)).toBe(true);
  });

  it('accepts valid resize message', () => {
    const msg = { ns: NS, type: 'resize', height: 400 };
    expect(isIframeMessage(msg)).toBe(true);
  });

  it('accepts valid user-action send message', () => {
    const msg = { ns: NS, type: 'user-action', event: 'send' };
    expect(isIframeMessage(msg)).toBe(true);
  });

  it('accepts valid user-action reaction message', () => {
    const msg = { ns: NS, type: 'user-action', event: 'reaction' };
    expect(isIframeMessage(msg)).toBe(true);
  });

  it('accepts valid user-action typing message', () => {
    const msg = { ns: NS, type: 'user-action', event: 'typing' };
    expect(isIframeMessage(msg)).toBe(true);
  });

  it('rejects ready without roomId', () => {
    const msg = { ns: NS, type: 'ready' };
    expect(isIframeMessage(msg)).toBe(false);
  });

  it('rejects error without code', () => {
    const msg = { ns: NS, type: 'error', message: 'oops' };
    expect(isIframeMessage(msg)).toBe(false);
  });

  it('rejects resize with string height', () => {
    const msg = { ns: NS, type: 'resize', height: '400' };
    expect(isIframeMessage(msg)).toBe(false);
  });

  it('rejects user-action with unknown event', () => {
    const msg = { ns: NS, type: 'user-action', event: 'explode' };
    expect(isIframeMessage(msg)).toBe(false);
  });

  it('rejects message without ns', () => {
    const msg = { type: 'ready', roomId: 'room1' };
    expect(isIframeMessage(msg)).toBe(false);
  });

  it('rejects unknown type', () => {
    const msg = { ns: NS, type: 'unknown-message' };
    expect(isIframeMessage(msg)).toBe(false);
  });

  it('rejects null', () => {
    expect(isIframeMessage(null)).toBe(false);
  });
});

// ── M1: sendToParent requires expectedParentOrigin (targeted postMessage) ─────
// NOTE: sendToParent is now parameterized — module state is set via setParentOrigin().

import {
  sendToParent as _sendToParent,
  setParentOrigin,
  onParentMessage as _onParentMessage,
  sendRefreshTokenToIframe,
} from '../postmessage.js';

// ── M1: sendRefreshTokenToIframe requires an explicit target origin ───────────
// A bearer JWT must NEVER cross to '*'. Mirrors sendToParent's M1 discipline:
// no origin available → warn + DROP (never post).

describe('sendRefreshTokenToIframe — M1 explicit origin (no "*")', () => {
  function fakeIframe(): { iframe: HTMLIFrameElement; postMessage: ReturnType<typeof vi.fn> } {
    const postMessage = vi.fn();
    const iframe = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;
    return { iframe, postMessage };
  }

  it('DROPS (does not post) and warns when no target origin is provided', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { iframe, postMessage } = fakeIframe();
    // Empty/absent origin — old code fell back to '*'; hardened code must drop.
    sendRefreshTokenToIframe(iframe, 'new.jwt.token', '');
    expect(postMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sendRefreshTokenToIframe'));
    warnSpy.mockRestore();
  });

  it('DROPS (does not post) and warns when the target origin is the literal "*" wildcard', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { iframe, postMessage } = fakeIframe();
    // '*' is truthy but is a browser-level wildcard — the JWT must never be broadcast.
    sendRefreshTokenToIframe(iframe, 'new.jwt.token', '*');
    expect(postMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sendRefreshTokenToIframe'));
    warnSpy.mockRestore();
  });

  it('NEVER posts a JWT to the "*" wildcard origin', () => {
    const { iframe, postMessage } = fakeIframe();
    sendRefreshTokenToIframe(iframe, 'new.jwt.token', '');
    // Even if a future refactor re-introduced a post, it must not target '*'.
    expect(postMessage).not.toHaveBeenCalledWith(expect.anything(), '*');
  });

  it('posts the refresh-token to the concrete origin when provided', () => {
    const { iframe, postMessage } = fakeIframe();
    sendRefreshTokenToIframe(iframe, 'new.jwt.token', 'https://widget.example.com');
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ns: 'oxpulse-chat', type: 'refresh-token', jwt: 'new.jwt.token' }),
      'https://widget.example.com',
    );
    // and specifically NOT the wildcard
    expect(postMessage).not.toHaveBeenCalledWith(expect.anything(), '*');
  });
});

describe('sendToParent — M1 targeted origin', () => {
  let parentPostMessage: ReturnType<typeof vi.fn>;
  let originalParent: typeof window;

  beforeEach(() => {
    parentPostMessage = vi.fn();
    // Stub window.parent.postMessage
    Object.defineProperty(globalThis, 'parent', {
      value: { postMessage: parentPostMessage },
      writable: true,
      configurable: true,
    });
    // Reset module-level expectedParentOrigin between tests
    setParentOrigin(null);
  });

  afterEach(() => {
    setParentOrigin(null);
  });

  it('drops message and warns when no origin set (not initialised)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    _sendToParent({ type: 'ready', roomId: 'r1' });
    expect(parentPostMessage).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('sendToParent'));
    warnSpy.mockRestore();
  });

  it('targets the expected parent origin when set', () => {
    setParentOrigin('https://parent.example.com');
    _sendToParent({ type: 'ready', roomId: 'r1' });
    expect(parentPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ready', roomId: 'r1' }),
      'https://parent.example.com',
    );
  });
});

// ── M2: onParentMessage rejects messages from wrong origin ────────────────────

describe('onParentMessage — M2 event.origin check', () => {
  it('ignores messages from unexpected origin', () => {
    // Simulate ?origin=https://trusted.example.com in URL
    Object.defineProperty(globalThis, 'location', {
      value: {
        ...globalThis.location,
        search: '?origin=' + encodeURIComponent('https://trusted.example.com'),
      },
      writable: true,
      configurable: true,
    });

    const handler = vi.fn();
    const unsub = _onParentMessage(handler);

    // Dispatch a valid ParentMessage but from an untrusted origin
    const event = new MessageEvent('message', {
      data: { ns: 'oxpulse-chat', type: 'init', config: { appId: 'a', jwt: 'h.p.s', roomId: 'r' } },
      origin: 'https://attacker.com',
    });
    window.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
    unsub();

    // Restore
    Object.defineProperty(globalThis, 'location', {
      value: { ...globalThis.location, search: '' },
      writable: true,
      configurable: true,
    });
  });

  it('accepts messages from the expected origin', () => {
    Object.defineProperty(globalThis, 'location', {
      value: {
        ...globalThis.location,
        search: '?origin=' + encodeURIComponent('https://trusted.example.com'),
      },
      writable: true,
      configurable: true,
    });

    const handler = vi.fn();
    const unsub = _onParentMessage(handler);

    const event = new MessageEvent('message', {
      data: { ns: 'oxpulse-chat', type: 'init', config: { appId: 'a', jwt: 'h.p.s', roomId: 'r' } },
      origin: 'https://trusted.example.com',
    });
    window.dispatchEvent(event);

    expect(handler).toHaveBeenCalledOnce();
    unsub();

    Object.defineProperty(globalThis, 'location', {
      value: { ...globalThis.location, search: '' },
      writable: true,
      configurable: true,
    });
  });

  it('M2-residual: missing ?origin= rejects messages from ALL origins (fail-closed)', () => {
    // Reset location to no query param — simulates integrator forgetting ?origin=
    Object.defineProperty(globalThis, 'location', {
      value: { ...globalThis.location, search: '' },
      writable: true,
      configurable: true,
    });

    const handler = vi.fn();
    const unsub = _onParentMessage(handler);

    // Even a "trusted-looking" origin must be rejected when contract violated
    const event = new MessageEvent('message', {
      data: { ns: 'oxpulse-chat', type: 'init', config: { appId: 'a', jwt: 'h.p.s', roomId: 'r' } },
      origin: 'https://attacker.example.com',
    });
    window.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
    unsub();
  });
});
