/**
 * roster.ts — fetch the named-writer roster from the server.
 *
 * GET /api/sdk/roster?app_id=<app_id>&room_id=<room_id>
 * Response: { roster: Record<epid, display_name> }
 *
 * The roster endpoint requires the same SDK JWT the widget already uses
 * for message reads.  The returned Map<epid, displayName> is the client's
 * only source of truth for writer names; SSE `type:"roster"` events are
 * invalidation signals that trigger a re-fetch (they carry no data).
 */

import { SDKChatError } from './errors.js';
import { httpStatusToCode } from './utils.js';

/** Injectable fetch for tests. */
export interface FetchRosterOptions {
  baseUrl: string;
  appId: string;
  roomId: string;
  jwt: string;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the roster for a room.
 *
 * Returns a Map<epid, displayName> — empty on 404 (roster not yet seeded).
 * Throws SDKChatError on network or server error.
 */
export async function fetchRoster(opts: FetchRosterOptions): Promise<Map<string, string>> {
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

  const body = (await resp.json()) as { roster?: Record<string, string> };
  const map = new Map<string, string>();
  if (body.roster && typeof body.roster === 'object') {
    for (const [epid, name] of Object.entries(body.roster)) {
      if (typeof epid === 'string' && typeof name === 'string') {
        map.set(epid, name);
      }
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
export function rosterDisplayName(roster: Map<string, string>, epid: string): string {
  const name = roster.get(epid);
  if (name) return name;
  // Short-form fallback: up to 8 chars
  return epid.slice(0, 8);
}
