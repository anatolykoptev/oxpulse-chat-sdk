/**
 * IndexedDB persistence for MLS ClientState.
 *
 * MLS ClientState is serialized via `clientStateEncoder`/`clientStateDecoder`
 * (ts-mls 2.0) and persisted to IndexedDB. Group state survives page reloads.
 *
 * ## Schema
 * - Database: `oxpulse-mls-state`
 * - Object store: `client-states` (keyPath: `roomId`)
 * - Records: `{ roomId: string, state: Uint8Array, epoch: number, version: 1 }`
 */

import { get, set, del, keys, createStore, type UseStore } from 'idb-keyval';

/**
 * Interface for MLS state persistence.
 * Implementations: IndexedDB-backed (default), in-memory (fallback).
 */
export interface MLSStateStore {
  /** Save serialized ClientState for a room. */
  saveClientState(roomId: string, state: Uint8Array): Promise<void>;
  /** Load serialized ClientState for a room. Returns null if not found. */
  loadClientState(roomId: string): Promise<Uint8Array | null>;
  /** Delete ClientState for a room. */
  deleteClientState(roomId: string): Promise<void>;
  /** List all room IDs with stored state. */
  listRoomIds(): Promise<string[]>;
}

/** Record shape stored in IndexedDB. */
interface StateRecord {
  roomId: string;
  state: Uint8Array;
  epoch: number;
  version: number;
}

/**
 * IndexedDB-backed MLS state store.
 *
 * Uses idb-keyval with a custom store for namespacing.
 * Falls back to in-memory when IndexedDB is unavailable.
 */
export class IdbMlsStateStore implements MLSStateStore {
  readonly #store: UseStore;
  readonly #fallback = new Map<string, Uint8Array>();
  readonly #fallbackKeys: string[] = [];
  #useFallback = false;
  #fallbackWarned = false;

  constructor(dbName = 'oxpulse-mls-state') {
    this.#store = createStore(`${dbName}/client-states`, 'client-states');

    // Detect IndexedDB availability (private browsing, SSR, legacy browsers).
    // The check is deferred — we only switch to fallback on first failed operation.
  }

  async saveClientState(roomId: string, state: Uint8Array): Promise<void> {
    if (this.#useFallback) {
      if (!this.#fallback.has(roomId)) this.#fallbackKeys.push(roomId);
      this.#fallback.set(roomId, state);
      return;
    }
    try {
      const record: StateRecord = { roomId, state, epoch: 0, version: 1 };
      await set(roomId, record, this.#store);
    } catch (err) {
      if (isPermanentIdbError(err)) {
        this.#switchToFallback();
        if (!this.#fallback.has(roomId)) this.#fallbackKeys.push(roomId);
        this.#fallback.set(roomId, state);
      } else {
        // Transient error (QuotaExceeded, transient IDB lock) — don't
        // switch to fallback; surface so the caller can retry or report.
        throw err;
      }
    }
  }

  async loadClientState(roomId: string): Promise<Uint8Array | null> {
    if (this.#useFallback) {
      return this.#fallback.get(roomId) ?? null;
    }
    try {
      const record = await get<StateRecord>(roomId, this.#store);
      if (!record) return null;
      return record.state;
    } catch (err) {
      if (isPermanentIdbError(err)) {
        console.warn(`MLSStateStore: IndexedDB read failed for room ${roomId}:`, err);
        this.#switchToFallback();
        return this.#fallback.get(roomId) ?? null;
      }
      throw err;
    }
  }

  async deleteClientState(roomId: string): Promise<void> {
    if (this.#useFallback) {
      this.#fallback.delete(roomId);
      const idx = this.#fallbackKeys.indexOf(roomId);
      if (idx !== -1) this.#fallbackKeys.splice(idx, 1);
      return;
    }
    try {
      await del(roomId, this.#store);
    } catch (err) {
      if (isPermanentIdbError(err)) {
        this.#switchToFallback();
        this.#fallback.delete(roomId);
        const idx = this.#fallbackKeys.indexOf(roomId);
        if (idx !== -1) this.#fallbackKeys.splice(idx, 1);
      } else {
        // Transient error — surface to caller for retry (IDB still viable).
        throw err;
      }
    }
  }

  async listRoomIds(): Promise<string[]> {
    if (this.#useFallback) {
      return [...this.#fallbackKeys];
    }
    try {
      const allKeys = await keys(this.#store);
      return allKeys.map((k) => String(k));
    } catch (err) {
      if (isPermanentIdbError(err)) {
        this.#switchToFallback();
        return [...this.#fallbackKeys];
      }
      throw err;
    }
  }

  #switchToFallback(): void {
    if (this.#useFallback) return;
    this.#useFallback = true;
    if (!this.#fallbackWarned) {
      this.#fallbackWarned = true;
      console.warn(
        'MLSStateStore: IndexedDB unavailable — falling back to in-memory storage. ' +
        'MLS state will NOT survive page reload in this session.',
      );
    }
  }
}

/**
 * In-memory MLS state store (for testing or environments without IndexedDB).
 */
export class InMemoryMlsStateStore implements MLSStateStore {
  readonly #map = new Map<string, Uint8Array>();
  readonly #keyOrder: string[] = [];

  async saveClientState(roomId: string, state: Uint8Array): Promise<void> {
    if (!this.#map.has(roomId)) this.#keyOrder.push(roomId);
    this.#map.set(roomId, state);
  }

  async loadClientState(roomId: string): Promise<Uint8Array | null> {
    return this.#map.get(roomId) ?? null;
  }

  async deleteClientState(roomId: string): Promise<void> {
    this.#map.delete(roomId);
    const idx = this.#keyOrder.indexOf(roomId);
    if (idx !== -1) this.#keyOrder.splice(idx, 1);
  }

  async listRoomIds(): Promise<string[]> {
    return [...this.#keyOrder];
  }
}

/**
 * Create the default IndexedDB-backed MLS state store.
 * Falls back to in-memory when IndexedDB is unavailable.
 */
export function createIdbMlsStateStore(): MLSStateStore {
  return new IdbMlsStateStore();
}

/**
 * Classify an IndexedDB error as permanent (IDB unavailable — switch to
 * in-memory fallback) or transient (quota exceeded, lock contention —
 * surface to caller for retry).
 *
 * Permanent: SecurityError (private browsing blocks IDB), ReferenceError
 * (SSR / no `indexedDB` global), TypeError (no IDB factory).
 * Transient: QuotaExceededError, AbortError, ConstraintError, DataError,
 * NotFoundError, TransactionInactiveError, VersionError, InvalidStateError
 * (connection closing — recoverable by reopening), and any unknown
 * DOMException (safer to retry than to abandon IDB).
 */
function isPermanentIdbError(err: unknown): boolean {
  if (err instanceof DOMException) {
    // SecurityError: private browsing blocks IDB entirely — permanent
    if (err.name === 'SecurityError') return true;
    // All other DOMException names are transient (quota, abort, constraint,
    // data error, not found, inactive tx, version, invalid state, unknown).
    // Defaulting to transient is safer: a retry may succeed, and a truly
    // permanent failure will recur and eventually trigger fallback.
    return false;
  }
  // ReferenceError: `indexedDB` is not defined (SSR, legacy browser)
  if (err instanceof ReferenceError) return true;
  // TypeError: null/undefined access (no IDB factory)
  if (err instanceof TypeError) return true;
  // Unknown error type — treat as transient (retry-friendly)
  return false;
}
