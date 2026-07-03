/**
 * sframe-config-wiring.test.ts — SEC-CR-003 / task #38: the anti-replay config surface must be
 * reachable through the PUBLIC client config (E2EEOptions 'sframe' variant), not only via the
 * custom-provider escape hatch. Asserts SDKChatClient forwards the options to createSFrameProvider
 * and defaults the durable namespace to the client's appId.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the provider factory so we can assert exactly what the client forwards.
const stubProvider = {
  seal: vi.fn(async () => new ArrayBuffer(0)),
  unseal: vi.fn(async () => new ArrayBuffer(0)),
  dispose: vi.fn(),
};
vi.mock('../sframe.js', () => ({
  createSFrameProvider: vi.fn(() => stubProvider),
}));

import { SDKChatClient } from '../client.js';
import { createSFrameProvider } from '../sframe.js';

const BASE_URL = 'http://x';
const JWT = 'test-token';
const getKey = async (): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveKey', 'deriveBits']);

beforeEach(() => {
  vi.mocked(createSFrameProvider).mockClear();
});

describe('sframe config surface wired through SDKChatClient', () => {
  it('forwards ctrStrategy / ctrKeyspace / replayWindow / durableReplay* to createSFrameProvider', () => {
    new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      e2ee: {
        provider: 'sframe',
        getKey,
        ctrStrategy: 'monotonic-idb',
        ctrKeyspace: 'ks-app',
        replayWindow: 512,
        durableReplay: true,
        durableReplayNamespace: 'tenant-x',
        durableReplayWindow: 256,
      },
    });

    expect(createSFrameProvider).toHaveBeenCalledTimes(1);
    expect(createSFrameProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        ctrStrategy: 'monotonic-idb',
        ctrKeyspace: 'ks-app',
        replayWindow: 512,
        durableReplay: true,
        durableReplayNamespace: 'tenant-x',
        durableReplayWindow: 256,
      }),
    );
  });

  it('defaults durableReplayNamespace to the client appId when not set explicitly', () => {
    new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      appId: 'demo_marketplace',
      e2ee: { provider: 'sframe', getKey },
    });

    expect(createSFrameProvider).toHaveBeenCalledWith(
      expect.objectContaining({ durableReplayNamespace: 'demo_marketplace' }),
    );
  });

  it('an explicit durableReplayNamespace overrides the appId default', () => {
    new SDKChatClient({
      baseUrl: BASE_URL,
      jwt: JWT,
      appId: 'demo_marketplace',
      e2ee: { provider: 'sframe', getKey, durableReplayNamespace: 'explicit-ns' },
    });

    expect(createSFrameProvider).toHaveBeenCalledWith(
      expect.objectContaining({ durableReplayNamespace: 'explicit-ns' }),
    );
  });
});
