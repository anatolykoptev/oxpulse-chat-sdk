// wire-dicts.ts — shared zstd dictionary registry for the wire codec.
//
// Extracted from wire-codec.ts (FOLLOWUPS #12.5) once FA + EN dicts joined RU,
// pushing wire-codec past the 300-LOC hard escape. The codec module owns the
// encode/decode logic; this module owns the per-dict state (cache, fetch, name↔id
// maps, list of shipped dicts).
//
// Wire dict-id byte registry — STABLE: never renumber, these go on the wire.
//   0x01 = zstd-dict-ru-v1   (Phase 2.E.A)
//   0x02 = zstd-dict-fa-v1   (Phase 2.E.C)
//   0x03 = zstd-dict-en-v1   (Phase 2.E.D)
//
// All clients ship ALL three dictionaries (~48 KB total). Per-language gating
// would fingerprint the user's language at handshake; carrying every dict makes
// the dict-id leak benign — observer only learns "this client supports all
// Privacy design: dicts are
// topology-neutral (no per-user or per-language sub-negotiation at handshake).

import { WireCodecError } from "./errors.js";

/**
 * Named shared dictionaries available in this build.
 * DictName is intentionally separate from WireCap — it is a sub-option of the
 * cbor+zstd cap, negotiated independently in Phase 2.E.B (negotiateDict).
 */
export type DictName =
  | "zstd-dict-ru-v1"
  | "zstd-dict-fa-v1"
  | "zstd-dict-en-v1";

/** Dictionaries shipped in this build, in negotiation-priority order. */
export const ALL_DICTS: readonly DictName[] = [
  "zstd-dict-ru-v1",
  "zstd-dict-fa-v1",
  "zstd-dict-en-v1",
] as const;

/** Wire dict-id byte registry. Stable: never renumber — these go on the wire. */
export const DICT_NAME_TO_ID: Record<DictName, number> = {
  "zstd-dict-ru-v1": 0x01,
  "zstd-dict-fa-v1": 0x02,
  "zstd-dict-en-v1": 0x03,
};

export const DICT_ID_TO_NAME: Record<number, DictName> = {
  0x01: "zstd-dict-ru-v1",
  0x02: "zstd-dict-fa-v1",
  0x03: "zstd-dict-en-v1",
};

// ---------------------------------------------------------------------------
// Pluggable loader API (PR #2)
// ---------------------------------------------------------------------------

/**
 * A function that asynchronously resolves a named dictionary to its raw bytes.
 * Implementations may read from the filesystem, fetch from a CDN, load from a
 * bundled asset, etc.  Throw to signal failure; the caller will propagate.
 */
export type DictLoader = (name: DictName) => Promise<Uint8Array>;

// Active loader. null = use the built-in default fetch(/dicts/${name}.zstd).
let _loader: DictLoader | null = null;

// Generation counter — incremented on every setDictLoader() call.
// loadDict() snapshots this at IIFE creation; if it changes before the fetch
// completes, the result is discarded (stale-loader guard).
let _loaderGeneration = 0;

/**
 * Override the dict loader for all subsequent loadDict() calls.
 * The last call wins; setDictBaseUrl() is a convenience wrapper around this.
 * Clears the dict cache so that the new loader is used on next access
 * (full eviction is safe — dicts are immutable, so a reload just re-populates).
 * Also increments an internal generation counter so that any in-flight load
 * started with the old loader discards its result rather than polluting the
 * new-loader cache.
 */
export function setDictLoader(loader: DictLoader | null): void {
  _loader = loader;
  _loaderGeneration++;
  dictCache.clear();
  inFlight.clear();
}

/**
 * Convenience wrapper: configure a fetch-based loader pointing at `baseUrl`.
 * The resolved URL for a dict named `n` will be `${baseUrl}/${n}.zstd`.
 * Equivalent to calling setDictLoader() with a fetch implementation.
 * Calling this evicts the existing dict cache so the new base URL takes effect
 * on the next loadDict() call.
 */
export function setDictBaseUrl(baseUrl: string): void {
  setDictLoader(async (name: DictName): Promise<Uint8Array> => {
    const url = `${baseUrl}/${name}.zstd`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new WireCodecError(
        "DICT_FETCH_FAILED",
        `wire-dicts.loadDict: failed to fetch ${url} (${resp.status})`,
      );
    }
    return new Uint8Array(await resp.arrayBuffer());
  });
}

// ---------------------------------------------------------------------------
// Cache + load internals
// ---------------------------------------------------------------------------

// Process-local dict cache. NO eviction by design — at most 3 × 16 KiB = 48 KiB
// retained for the SW lifetime. Acceptable: dicts are small, immutable, and
// shipped as static assets versioned by SW CACHE bumps. Long-running sessions
// (hours) pay zero per-message dict overhead after the eager preload completes.
const dictCache = new Map<DictName, Uint8Array>();
// In-flight fetch dedup: concurrent loadDict callers join one network round-
// trip. Map holds the pending Promise; entry is cleared on settle so a
// transient-failed dict can be retried later.
const inFlight = new Map<DictName, Promise<Uint8Array>>();

/**
 * Fetch and cache a shared zstd dictionary by name.
 * Idempotent: subsequent calls return the cached bytes without re-fetching.
 * Concurrent calls share one in-flight fetch (no duplicate network round-trips).
 * Throws on fetch failure — caller (ensureWireCodecReady) swallows individual
 * failures so a missing dict silently degrades to the dictless 0xC6 path.
 *
 * Uses the configured DictLoader if set (see setDictLoader / setDictBaseUrl);
 * falls back to fetch(`/dicts/${name}.zstd`) to preserve existing web/ shim
 * behaviour when no loader is configured.
 *
 * Race safety: if setDictLoader() is called while a fetch is in flight, the
 * in-flight result is discarded (throws 'dict load aborted: loader swapped
 * during fetch') rather than written into the new-loader cache. The inFlight
 * entry is cleared in the finally block so callers can immediately retry with
 * the new loader.
 */
export async function loadDict(name: DictName): Promise<Uint8Array> {
  const cached = dictCache.get(name);
  if (cached !== undefined) return cached;
  const pending = inFlight.get(name);
  if (pending !== undefined) return pending;
  const fetchOnce = (async () => {
    // Capture both the generation and the loader reference at call time.
    // Using loaderAtStart ensures the fetch uses the exact function that was
    // active when loadDict() was called, not whatever _loader is when the
    // await resolves (which would be a second, subtler race).
    const generationAtStart = _loaderGeneration;
    const loaderAtStart = _loader;
    try {
      let buf: Uint8Array;
      if (loaderAtStart !== null) {
        buf = await loaderAtStart(name);
      } else {
        // Default: fetch from /dicts/ — preserves existing web/ shim behaviour.
        const resp = await fetch(`/dicts/${name}.zstd`);
        if (!resp.ok) {
          throw new WireCodecError(
            "DICT_FETCH_FAILED",
            `wire-dicts.loadDict: failed to fetch /dicts/${name}.zstd (${resp.status})`,
          );
        }
        buf = new Uint8Array(await resp.arrayBuffer());
      }
      // Guard: if the loader was swapped while we were awaiting, discard the
      // result — writing stale bytes into the new-loader cache would corrupt it.
      if (_loaderGeneration !== generationAtStart) {
        throw new WireCodecError(
          "LOADER_SWAPPED_MID_FETCH",
          "wire-dicts.loadDict: loader swapped during fetch — stale result discarded",
        );
      }
      dictCache.set(name, buf);
      return buf;
    } finally {
      inFlight.delete(name);
    }
  })();
  inFlight.set(name, fetchOnce);
  return fetchOnce;
}

/** Read the cached dict bytes, or undefined if not yet loaded. Sync accessor for
 *  the codec encode path: on cache-miss the encoder falls back to dictless 0xC6. */
export function getDictBytes(name: DictName): Uint8Array | undefined {
  return dictCache.get(name);
}

/** TEST-ONLY. Drops a single dict from the cache to exercise the encoder's
 *  fallback-to-0xC6 path. Never call from production code. */
export function _evictDictForTesting(name: DictName): void {
  dictCache.delete(name);
}

/** Test-only helper (leading `_` per convention, NOT in public barrel).
 *  Resets the loader to null (default fetch path) and clears the dict cache.
 *  Pair with setDictLoader() tests to avoid cross-test contamination of
 *  module-level state. Never call from production code. */
export function _resetLoaderForTesting(): void {
  _loader = null;
  _loaderGeneration = 0;
  dictCache.clear();
  inFlight.clear();
}
