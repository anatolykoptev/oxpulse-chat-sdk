// dict-loader.test.ts — tests for the pluggable DictLoader API (PR #2).
//
// Each test cleans up after itself via _resetLoaderForTesting() so that
// module-level loader/cache state does not bleed across cases.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  type DictName,
  loadDict,
  getDictBytes,
  setDictLoader,
  setDictBaseUrl,
  _evictDictForTesting,
  _resetLoaderForTesting,
} from '../dicts.ts';

// Canned bytes used throughout these tests. 4 bytes chosen to be clearly
// distinguishable from a real zstd dict without needing the wasm codec.
const CANNED = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);

afterEach(() => {
  _resetLoaderForTesting();
});

describe('setDictLoader', () => {
  it('is called with the requested name and its result is returned', async () => {
    const calls: DictName[] = [];
    setDictLoader(async (name) => {
      calls.push(name);
      return CANNED;
    });

    const result = await loadDict('zstd-dict-ru-v1');
    expect(calls).toEqual(['zstd-dict-ru-v1']);
    expect(result).toEqual(CANNED);
  });

  it('result is cached — loader called only once for repeated requests', async () => {
    let callCount = 0;
    setDictLoader(async (_name) => {
      callCount++;
      return CANNED;
    });

    await loadDict('zstd-dict-fa-v1');
    await loadDict('zstd-dict-fa-v1');
    expect(callCount).toBe(1);
    expect(getDictBytes('zstd-dict-fa-v1')).toEqual(CANNED);
  });

  it('evicting a cached dict forces the loader to be called again', async () => {
    let callCount = 0;
    setDictLoader(async (_name) => {
      callCount++;
      return CANNED;
    });

    await loadDict('zstd-dict-en-v1');
    expect(callCount).toBe(1);

    _evictDictForTesting('zstd-dict-en-v1');
    expect(getDictBytes('zstd-dict-en-v1')).toBeUndefined();

    await loadDict('zstd-dict-en-v1');
    expect(callCount).toBe(2);
  });

  it('overriding the loader evicts the full cache', async () => {
    // Seed the cache with the first loader.
    setDictLoader(async (_name) => new Uint8Array([0x01]));
    await loadDict('zstd-dict-ru-v1');
    expect(getDictBytes('zstd-dict-ru-v1')).toBeDefined();

    // Installing a new loader must evict the cached entry.
    setDictLoader(async (_name) => CANNED);
    expect(getDictBytes('zstd-dict-ru-v1')).toBeUndefined();

    const result = await loadDict('zstd-dict-ru-v1');
    expect(result).toEqual(CANNED);
  });

  it('concurrent calls share one loader invocation (in-flight dedup)', async () => {
    let callCount = 0;
    let resolve!: (v: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((res) => {
      resolve = res;
    });
    setDictLoader(async (_name) => {
      callCount++;
      return pending;
    });

    // Kick off 5 concurrent loads without awaiting yet.
    const all = Promise.all([
      loadDict('zstd-dict-ru-v1'),
      loadDict('zstd-dict-ru-v1'),
      loadDict('zstd-dict-ru-v1'),
      loadDict('zstd-dict-ru-v1'),
      loadDict('zstd-dict-ru-v1'),
    ]);
    resolve(CANNED);
    const results = await all;

    expect(callCount).toBe(1);
    for (const r of results) {
      expect(r).toEqual(CANNED);
    }
  });
});

describe('setDictBaseUrl', () => {
  it('builds the correct URL and calls fetch', async () => {
    const fetchedUrls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);
      return new Response(CANNED, { status: 200 });
    }) as typeof fetch;

    try {
      setDictBaseUrl('https://cdn.example.com/assets');
      await loadDict('zstd-dict-ru-v1');
      expect(fetchedUrls).toEqual(['https://cdn.example.com/assets/zstd-dict-ru-v1.zstd']);
    } finally {
      globalThis.fetch = realFetch;
      _resetLoaderForTesting();
    }
  });

  it('treats fetch non-ok status as a thrown error', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    try {
      setDictBaseUrl('https://cdn.example.com/assets');
      await expect(loadDict('zstd-dict-fa-v1')).rejects.toThrow('404');
    } finally {
      globalThis.fetch = realFetch;
      _resetLoaderForTesting();
    }
  });
});

describe('default loader (back-compat)', () => {
  it('hits /dicts/${name}.zstd when no loader is configured', async () => {
    const fetchedUrls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchedUrls.push(url);
      return new Response(CANNED, { status: 200 });
    }) as typeof fetch;

    try {
      // _resetLoaderForTesting already called in afterEach; loader is null here.
      await loadDict('zstd-dict-en-v1');
      expect(fetchedUrls).toEqual(['/dicts/zstd-dict-en-v1.zstd']);
    } finally {
      globalThis.fetch = realFetch;
      _resetLoaderForTesting();
    }
  });

  it('back-compat: non-ok default fetch throws with the /dicts/ URL in message', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      return new Response(null, { status: 503 });
    }) as typeof fetch;

    try {
      await expect(loadDict('zstd-dict-ru-v1')).rejects.toThrow('/dicts/zstd-dict-ru-v1.zstd');
    } finally {
      globalThis.fetch = realFetch;
      _resetLoaderForTesting();
    }
  });
});

describe('loader swap during in-flight fetch', () => {
  it('discards stale bytes and returns new-loader bytes on retry', async () => {
    const BYTES_A = new Uint8Array([0xaa, 0xaa]);
    const BYTES_B = new Uint8Array([0xbb, 0xbb]);

    // Loader A: pauses until we trigger resolveA.
    let resolveA!: (b: Uint8Array) => void;
    const aPromise = new Promise<Uint8Array>((res) => { resolveA = res; });
    setDictLoader(async (_name) => aPromise);

    // Start load with loader A — do NOT await yet.
    const firstLoad = loadDict('zstd-dict-ru-v1');

    // While A is in-flight, install loader B and evict cache.
    setDictLoader(async (_name) => BYTES_B);

    // Now let A's fetch resolve.
    resolveA(BYTES_A);

    // The in-flight promise for A should reject with LOADER_SWAPPED_MID_FETCH.
    await expect(firstLoad).rejects.toThrow('loader swapped during fetch');

    // Cache must NOT contain A's stale bytes.
    expect(getDictBytes('zstd-dict-ru-v1')).toBeUndefined();

    // A fresh load uses loader B and caches B's bytes.
    const secondLoad = await loadDict('zstd-dict-ru-v1');
    expect(secondLoad).toEqual(BYTES_B);
    expect(getDictBytes('zstd-dict-ru-v1')).toEqual(BYTES_B);
  });
});
