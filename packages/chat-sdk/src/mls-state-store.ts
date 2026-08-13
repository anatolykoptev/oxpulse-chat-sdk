/**
 * IndexedDB persistence for MLS ClientState.
 *
 * Stores serialized MLS ClientState per room so that MLS group membership
 * survives page reloads. Falls back to in-memory storage when IndexedDB
 * is unavailable (private browsing, SSR, legacy browsers).
 *
 * ## Schema
 * - Database: `oxpulse-mls-state`
 * - Object store: `client-states` (keyPath: `roomId`)
 * - Records: `{ roomId: string, state: Uint8Array, epoch: number, version: 1 }`
 *
 * ## Limitation
 * ts-mls does not currently expose a public serialize/deserialize API for
 * ClientState. Until it does, the state store stores placeholder bytes
 * and MLS state does NOT survive reload. This is a documented limitation —
 * the interface is in place so that when ts-mls adds serialization support,
 * only the serialize/deserialize calls need to be wired in.
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
      this.#switchToFallback();
      if (!this.#fallback.has(roomId)) this.#fallbackKeys.push(roomId);
      this.#fallback.set(roomId, state);
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
    } catch {
      this.#switchToFallback();
      return this.#fallback.get(roomId) ?? null;
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
    } catch {
      this.#switchToFallback();
      this.#fallback.delete(roomId);
      const idx = this.#fallbackKeys.indexOf(roomId);
      if (idx !== -1) this.#fallbackKeys.splice(idx, 1);
    }
  }

  async listRoomIds(): Promise<string[]> {
    if (this.#useFallback) {
      return [...this.#fallbackKeys];
    }
    try {
      const allKeys = await keys(this.#store);
      return allKeys.map((k) => String(k));
    } catch {
      this.#switchToFallback();
      return [...this.#fallbackKeys];
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
