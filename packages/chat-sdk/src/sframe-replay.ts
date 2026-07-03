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
 * Feature-detected + default-on: when IndexedDB is unavailable (SSR / Node without a polyfill /
 * private-mode quirks) the guard degrades to a no-op with a one-time warning, and the library's
 * in-memory window remains the only (session-scoped) defense — the guard never throws at
 * construct and never breaks a no-IDB runtime.
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

export interface DurableReplayGuardOptions {
  /** Namespace isolating independent key-spaces in the shared IDB store. Default 'default'. */
  namespace?: string;
  /** Max distinct recent CTRs tracked per (room, sender). Default 1024 (matches the library). */
  window?: number;
  /** Suppress the one-time no-IDB warning (e.g. when the caller has already surfaced it). */
  warnIfUnavailable?: boolean;
}

/**
 * Durable receiver-side replay window. One instance per provider; state is scoped per
 * (namespace, roomId, senderUid) so no cross-room / cross-key-space replay-window confusion.
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

  constructor(opts: DurableReplayGuardOptions = {}) {
    this.namespace = opts.namespace ?? 'default';
    this.window = opts.window !== undefined && opts.window > 0 ? opts.window : DEFAULT_WINDOW;
    this.available = idbAvailable();
    if (!this.available && opts.warnIfUnavailable !== false) {
      // One-time, matching the SDK's console.warn idiom. Not fatal: the library's in-memory
      // window still defends within a session; only cross-reload protection is unavailable.
      console.warn(
        '[chat-sdk] IndexedDB unavailable — durable cross-reload replay protection is disabled ' +
          '(SEC-CR-003); sframe falls back to the in-memory replay window (session-scoped only).',
      );
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
      } catch {
        // Read failure — start empty; write-through re-establishes the window.
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
    if (!this.available) return true;
    const win = await this.hydrate(roomId, senderUid);
    return !win.set.has(ctr.toString());
  }

  /**
   * Record an AEAD-authentic CTR as accepted and persist it (write-through). MUST be called
   * only AFTER a successful unseal, so a forged frame with a novel CTR cannot poison the window.
   */
  async accept(roomId: string, senderUid: string, ctr: bigint): Promise<void> {
    if (!this.available) return;
    const key = this.storeKey(roomId, senderUid);
    const win = await this.hydrate(roomId, senderUid);
    const ctrStr = ctr.toString();
    if (win.set.has(ctrStr)) return;

    win.set.add(ctrStr);
    win.order.push(ctrStr);
    while (win.order.length > this.window) {
      const evicted = win.order.shift();
      if (evicted !== undefined) win.set.delete(evicted);
    }

    const snapshot: PersistedWindow = { v: 1, seen: [...win.order] };
    // Serialize per guard; non-fatal on failure (in-memory window still defends this session).
    this.persistTail = this.persistTail
      .catch(() => undefined)
      .then(() => set(key, snapshot))
      .catch((err: unknown) => {
        if (!this.warnedPersistFail) {
          this.warnedPersistFail = true;
          console.warn(
            '[chat-sdk] failed to persist sframe replay window (SEC-CR-003); cross-reload ' +
              'replay protection may be degraded:',
            err,
          );
        }
      });
    await this.persistTail;
  }
}
