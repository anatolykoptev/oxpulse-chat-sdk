/**
 * sframe-replay.ts — durable, cross-reload anti-replay for the SFrame chat provider.
 *
 * ## Why (SEC-CR-003, CWE-294 replay)
 * sframe-ratchet's receiver-side replay window is an in-memory bounded `Set` that is WIPED
 * on page reload. `ctrStrategy: 'monotonic-idb'` only persists the SENDER's CTR allocator —
 * NOT the receiver's replay defense (the `unseal` path checks a fresh in-memory window
 * regardless of strategy). So after a reload a malicious / compromised app-server can
 * re-serve an OLD authentic sealed frame under a fresh msg_id and it verifies (the ciphertext
 * is genuinely authentic, just old), rendering a stale message as new.
 *
 * ## What
 * This guard persists the set of already-accepted per-(room, sender) CTRs to IndexedDB (via
 * `idb-keyval`, the same store the outbox uses) so the replay defense survives a reload. The
 * CTR is read from the RFC 9605 §4.3 header via the library's own `parseHeader` — the header
 * is the AEAD AAD, so the CTR is authenticated (an attacker cannot alter it without failing
 * AEAD). The guard mirrors the library's in-memory bounded-set semantics exactly, just durable.
 *
 * ## Availability
 * Feature-detected + default-on. Durable persistence requires BOTH IndexedDB AND the Web Locks
 * API: when either is unavailable (SSR / Node without a polyfill / private-mode quirks / legacy
 * Safari <15.4 with no Web Locks) the guard degrades to a no-op with a one-time warning, and the
 * library's in-memory window remains the only (session-scoped) defense — the guard never throws
 * at construct and never breaks such a runtime. A `window` of 0 disables the durable window
 * (mirrors sframe-ratchet's `replayWindow: 0` debug switch).
 *
 * ## Concurrency
 * Same-realm writes are serialized by a promise chain; CROSS-tab writes are serialized by the
 * Web Locks API (the same `navigator.locks` pattern sframe-ratchet's monotonic-idb CTR allocator
 * uses), and each persist is a read-merge-write so a second tab's accepted CTRs are merged, not
 * clobbered. CR17-02: when the Web Locks API is absent the read-merge-write cannot be serialized
 * cross-tab (two tabs could interleave and silently drop a CTR), so durable persistence is gated
 * OFF entirely (via `available`) rather than run an unlocked RMW — an honest "no durable claim
 * without Web Locks" posture. The reachable persist path therefore ALWAYS holds the lock.
 */

import { get, set } from 'idb-keyval';

const KEY_PREFIX = 'sframe-replay';
const DEFAULT_WINDOW = 1024;

/** Persisted shape for one (room, sender) replay window. `seen` is oldest-first. */
interface PersistedWindow {
  v: 1;
  /** Accepted CTRs as decimal strings, oldest-first, bounded to the window size. */
  seen: string[];
}

/** In-memory mirror of a persisted window: a Set for O(1) checks + an order queue for eviction. */
interface MemWindow {
  set: Set<string>;
  order: string[];
}

/** Detect a usable IndexedDB without throwing under SSR / Node. */
function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/**
 * Detect a USABLE Web Locks API (cross-tab mutual exclusion), mirroring sframe-ratchet's
 * allocator. Probes `navigator.locks.request` as a function — a partial polyfill exposing
 * `navigator.locks` without `.request` must NOT pass (persistMerged calls `.request`
 * directly with no fallback).
 */
function locksAvailable(): boolean {
  try {
    return typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function';
  } catch {
    return false;
  }
}

/** Dedup keeping the LAST occurrence of each value, preserving that last-occurrence order. */
function dedupKeepLast(arr: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v === undefined || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  out.reverse();
  return out;
}

/**
 * Resolve the effective window size: `undefined` → default; `0` → disabled (matches the
 * library's `replayWindow: 0`); a negative (invalid) value → the secure default, not disabled.
 */
function resolveWindow(window: number | undefined): number {
  if (window === undefined || window < 0) return DEFAULT_WINDOW;
  return Math.trunc(window);
}

export interface DurableReplayGuardOptions {
  /** Namespace isolating independent key-spaces in the shared IDB store. Default 'default'. */
  namespace?: string;
  /**
   * Max distinct recent CTRs tracked per (room, sender). Default 1024 (matches the library).
   * `0` disables the durable window (mirrors sframe-ratchet's `replayWindow: 0`); a negative
   * value is treated as invalid and falls back to the default (it does NOT disable).
   */
  window?: number;
  /** Suppress the one-time no-IDB warning (e.g. when the caller has already surfaced it). */
  warnIfUnavailable?: boolean;
}

/**
 * Durable receiver-side replay window. One instance per provider; state is scoped per
 * (namespace, roomId, senderUid) so no cross-room / cross-key-space replay-window confusion.
 *
 * The caller SHOULD pass a per-tenant `namespace` (the SDK defaults it to the client's `appId`).
 * Two independent deployments sharing the same origin AND the same namespace (e.g. both omitting
 * appId → `'default'`) with a colliding (roomId, senderUid) would share a window and could
 * false-reject each other — give each deployment a distinct namespace/appId to avoid this.
 */
export class DurableReplayGuard {
  /** True when IndexedDB is present; when false every method is a safe no-op. */
  readonly available: boolean;

  private readonly namespace: string;
  private readonly window: number;
  private readonly mem = new Map<string, MemWindow>();
  private readonly hydrating = new Map<string, Promise<MemWindow>>();
  /** Serializes persist writes so interleaved snapshots cannot clobber each other. */
  private persistTail: Promise<void> = Promise.resolve();
  private warnedPersistFail = false;
  private warnedReadFail = false;

  constructor(opts: DurableReplayGuardOptions = {}) {
    this.namespace = opts.namespace ?? 'default';
    this.window = resolveWindow(opts.window);
    // Durable persistence requires BOTH IndexedDB (to store) AND the Web Locks API (to
    // serialize the cross-tab read-merge-write). CR17-02: on a legacy engine with IDB but no
    // Web Locks (Safari <15.4) the RMW would run UNLOCKED and two tabs could interleave and
    // silently drop a CTR (later replayable). Gate durable persistence OFF when either
    // capability is absent; the library's in-memory window still defends within a session
    // (only cross-reload protection is lost). Both capabilities are static per engine, so
    // sampling them once at construct is sound.
    const hasIdb = idbAvailable();
    const hasLocks = locksAvailable();
    this.available = hasIdb && hasLocks;
    if (opts.warnIfUnavailable !== false) {
      if (!hasIdb) {
        // One-time, matching the SDK's console.warn idiom.
        console.warn(
          '[chat-sdk] IndexedDB unavailable — durable cross-reload replay protection is disabled ' +
            '(SEC-CR-003); sframe falls back to the in-memory replay window (session-scoped only).',
        );
      } else if (!hasLocks) {
        console.warn(
          '[chat-sdk] Web Locks API unavailable (legacy engine, e.g. Safari <15.4) — durable ' +
            'cross-reload replay protection is disabled (CR17-02): the persist read-merge-write ' +
            'cannot be serialized cross-tab, so sframe falls back to the in-memory replay window ' +
            '(session-scoped only). Single-tab durable protection is forgone in exchange for an ' +
            'honest, uniform "no durable claim without Web Locks" posture.',
        );
      }
    }
  }

  private storeKey(roomId: string, senderUid: string): string {
    return `${KEY_PREFIX}|${this.namespace}|${roomId}|${senderUid}`;
  }

  /** Load (once) the persisted window for a (room, sender) into the in-memory mirror. */
  private hydrate(roomId: string, senderUid: string): Promise<MemWindow> {
    const key = this.storeKey(roomId, senderUid);
    const cached = this.mem.get(key);
    if (cached) return Promise.resolve(cached);
    const inflight = this.hydrating.get(key);
    if (inflight) return inflight;

    const p = (async (): Promise<MemWindow> => {
      let order: string[] = [];
      try {
        const persisted = await get<PersistedWindow>(key);
        if (persisted && persisted.v === 1 && Array.isArray(persisted.seen)) {
          order = persisted.seen.slice(-this.window);
        }
      } catch (err: unknown) {
        // IndexedDB is present but the read threw (private-mode / partitioned / quota-broken
        // storage): we start with an EMPTY window, so a frame accepted in a prior session
        // would not be caught. Surface that once rather than silently claiming protection.
        if (!this.warnedReadFail) {
          this.warnedReadFail = true;
          console.warn(
            '[chat-sdk] could not read the persisted sframe replay window (SEC-CR-003); ' +
              'cross-reload replay protection is unavailable this session:',
            err,
          );
        }
      }
      const win: MemWindow = { set: new Set(order), order };
      this.mem.set(key, win);
      this.hydrating.delete(key);
      return win;
    })();
    this.hydrating.set(key, p);
    return p;
  }

  /**
   * True if this (room, sender, ctr) has NOT been accepted before — i.e. it is safe to
   * proceed with AEAD verification. A false result means the CTR was already seen (replay).
   */
  async check(roomId: string, senderUid: string, ctr: bigint): Promise<boolean> {
    if (!this.available || this.window === 0) return true;
    const win = await this.hydrate(roomId, senderUid);
    return !win.set.has(ctr.toString());
  }

  /**
   * Record an AEAD-authentic CTR as accepted and persist it (write-through). MUST be called
   * only AFTER a successful unseal, so a forged frame with a novel CTR cannot poison the window.
   */
  async accept(roomId: string, senderUid: string, ctr: bigint): Promise<void> {
    if (!this.available || this.window === 0) return;
    const key = this.storeKey(roomId, senderUid);
    const win = await this.hydrate(roomId, senderUid);
    const ctrStr = ctr.toString();
    if (win.set.has(ctrStr)) return;

    win.set.add(ctrStr);
    win.order.push(ctrStr);
    this.trim(win);

    // Serialize same-realm writes via the chain; serialize cross-tab writes via Web Locks inside
    // persistMerged. Non-fatal on failure (the in-memory window still defends this session).
    this.persistTail = this.persistTail
      .catch(() => undefined)
      .then(() => this.persistMerged(key, win))
      .catch((err: unknown) => this.warnPersistFail(err));
    await this.persistTail;
  }

  /** Drop oldest CTRs until the in-memory window is within bound. */
  private trim(win: MemWindow): void {
    while (win.order.length > this.window) {
      const evicted = win.order.shift();
      if (evicted !== undefined) win.set.delete(evicted);
    }
  }

  /**
   * Read-merge-write the persisted window under a cross-tab exclusive lock (when available):
   * union the persisted CTRs (possibly from another tab) with this tab's in-memory window, dedup,
   * bound, persist, and reflect the union back into the in-memory mirror so this tab immediately
   * rejects a CTR another tab already accepted.
   */
  private async persistMerged(key: string, win: MemWindow): Promise<void> {
    // Reached only when `available` is true, which requires the Web Locks API (see the
    // constructor). So the read-merge-write ALWAYS runs under a cross-tab exclusive lock —
    // there is no unlocked fallback (CR17-02: an unlocked RMW could silently drop a CTR).
    const write = async (): Promise<void> => {
      let persistedSeen: string[] = [];
      try {
        const cur = await get<PersistedWindow>(key);
        if (cur && cur.v === 1 && Array.isArray(cur.seen)) persistedSeen = cur.seen;
      } catch {
        // Read failed inside the RMW — fall back to this tab's in-memory view only.
      }
      const merged = dedupKeepLast(persistedSeen.concat(win.order)).slice(-this.window);
      win.order = merged;
      win.set = new Set(merged);
      const payload: PersistedWindow = { v: 1, seen: merged };
      await set(key, payload);
    };

    await navigator.locks.request(`${KEY_PREFIX}-lock|${key}`, { mode: 'exclusive' }, write);
  }

  private warnPersistFail(err: unknown): void {
    if (!this.warnedPersistFail) {
      this.warnedPersistFail = true;
      console.warn(
        '[chat-sdk] failed to persist sframe replay window (SEC-CR-003); cross-reload ' +
          'replay protection may be degraded:',
        err,
      );
    }
  }
}
