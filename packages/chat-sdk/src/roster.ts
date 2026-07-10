/**
 * roster.ts — fetch the named-writer roster from the server.
 *
 * GET /api/sdk/roster?app_id=<app_id>&room_id=<room_id>
 * Response: { roster: Record<epid, display_name>, avatars?: Record<epid, avatar_url> }
 *
 * The roster endpoint requires the same SDK JWT the widget already uses
 * for message reads.  The returned Map<epid, RosterEntry> is the client's
 * only source of truth for writer names + avatars; SSE `type:"roster"` events
 * are invalidation signals that trigger a re-fetch (they carry no data).
 *
 * The `avatars` map is ADDITIVE (T18-avatar): a server that predates avatar
 * support simply omits it, and every member's `avatarUrl` resolves to `null`.
 */

import { SDKChatError } from './errors.js';
import { httpStatusToCode } from './utils.js';

/**
 * One roster member: their display name plus an optional avatar URL.
 *
 * `avatarUrl` is `null` when the member has no avatar (the common case) or
 * when talking to a server that predates avatar support.
 */
export interface RosterEntry {
  displayName: string;
  avatarUrl: string | null;
}

/** Injectable fetch for tests. */
export interface FetchRosterOptions {
  baseUrl: string;
  appId: string;
  roomId: string;
  jwt: string;
  fetchImpl?: typeof fetch;
}

/** Raw wire shape of GET /api/sdk/roster. */
interface RosterResponseBody {
  roster?: Record<string, string>;
  avatars?: Record<string, string>;
}

/**
 * Fetch the roster for a room.
 *
 * Returns a Map<epid, RosterEntry> — empty on 404 (roster not yet seeded).
 * Throws SDKChatError on network or server error.
 */
export async function fetchRoster(
  opts: FetchRosterOptions,
): Promise<Map<string, RosterEntry>> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;

  const params = new URLSearchParams({ app_id: opts.appId, room_id: opts.roomId });
  const url = `${opts.baseUrl.replace(/\/$/, '')}/api/sdk/roster?${params}`;

  let resp: Response;
  try {
    resp = await fetchFn(url, {
      headers: { Authorization: `Bearer ${opts.jwt}` },
    });
  } catch (err) {
    throw new SDKChatError('network', `fetchRoster failed: ${String(err)}`);
  }

  // 404 = roster not yet initialised (no writers have joined) — return empty map.
  if (resp.status === 404) {
    return new Map();
  }

  if (!resp.ok) {
    throw new SDKChatError(
      httpStatusToCode(resp.status),
      `fetchRoster HTTP ${resp.status}`,
      resp.status,
    );
  }

  const body = (await resp.json()) as RosterResponseBody;
  const map = new Map<string, RosterEntry>();
  const avatars = body.avatars && typeof body.avatars === 'object' ? body.avatars : undefined;
  if (body.roster && typeof body.roster === 'object') {
    for (const [epid, name] of Object.entries(body.roster)) {
      if (typeof epid !== 'string' || typeof name !== 'string') continue;
      const rawAvatar = avatars ? avatars[epid] : undefined;
      const avatarUrl = typeof rawAvatar === 'string' && rawAvatar.length > 0 ? rawAvatar : null;
      map.set(epid, { displayName: name, avatarUrl });
    }
  }
  return map;
}

/**
 * Return the display name for an epid from the roster map.
 * Miss fallback: first 8 chars of the epid (e.g. "ep_12345" → "ep_12345").
 * Never blank, never the raw full epid when it is long.
 *
 * XSS note: callers MUST assign via textContent (not innerHTML).
 */
export function rosterDisplayName(roster: Map<string, RosterEntry>, epid: string): string {
  const entry = roster.get(epid);
  if (entry && entry.displayName) return entry.displayName;
  // Short-form fallback: up to 8 chars
  return epid.slice(0, 8);
}

/**
 * Return the avatar URL for an epid from the roster map, or `null` when the
 * member has no avatar (or is absent from the roster).
 *
 * Security note: the URL is caller-supplied roster data. Callers MUST assign
 * it via `img.src` (the property), never via innerHTML, and should treat it as
 * untrusted (the server validates the scheme, but be defensive).
 */
export function rosterAvatar(roster: Map<string, RosterEntry>, epid: string): string | null {
  return roster.get(epid)?.avatarUrl ?? null;
}
