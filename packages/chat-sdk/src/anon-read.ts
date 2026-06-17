/**
 * mintAnonReadToken — client-side helper to mint an anon-read JWT.
 *
 * Calls POST /api/sdk/auth/anon-read-mint on the OxPulse backend.
 * Returns a short-lived (300 s) read-only token that can be passed
 * to SDKChatClient as `jwt` with `cryptoMode: 'plaintext'`.
 *
 * Throws AnonReadMintError on any non-2xx response.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AnonReadMintResult {
  /** Raw JWT — pass directly to SDKChatClient opts.jwt (no "Bearer " prefix). */
  token: string;
  /** Opaque anon user ID minted server-side (UUID). */
  userId: string;
  /** Unix timestamp (seconds) at which the token expires. */
  expiresAt: number;
}

export type AnonReadMintErrorCode =
  | 'not_anon_readable'
  | 'disabled'
  | 'rate_limited'
  | 'mint_failed';

export class AnonReadMintError extends Error {
  readonly code: AnonReadMintErrorCode;
  readonly status: number;

  constructor(code: AnonReadMintErrorCode, message: string, status: number) {
    super(message);
    this.name = 'AnonReadMintError';
    this.code = code;
    this.status = status;
  }
}

// ── Implementation ────────────────────────────────────────────────────────────

function statusToCode(status: number): AnonReadMintErrorCode {
  if (status === 403) return 'not_anon_readable';
  if (status === 503) return 'disabled';
  if (status === 429) return 'rate_limited';
  return 'mint_failed';
}

export async function mintAnonReadToken(opts: {
  baseUrl: string;
  appId: string;
  roomId: string;
  /** Injectable fetch implementation — defaults to globalThis.fetch. For tests. */
  fetchImpl?: typeof fetch;
}): Promise<AnonReadMintResult> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  const url = `${opts.baseUrl.replace(/\/$/, '')}/api/sdk/auth/anon-read-mint`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: opts.appId, room_id: opts.roomId }),
    });
  } catch (err) {
    throw new AnonReadMintError(
      'mint_failed',
      `anon-read-mint network error: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  if (!response.ok) {
    const code = statusToCode(response.status);
    throw new AnonReadMintError(
      code,
      `anon-read-mint failed with HTTP ${response.status}`,
      response.status,
    );
  }

  let body: { token: string; expires_at: number; user_id: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new AnonReadMintError(
      'mint_failed',
      'anon-read-mint: failed to parse response JSON',
      response.status,
    );
  }

  return {
    token: body.token,
    userId: body.user_id,
    expiresAt: body.expires_at,
  };
}
