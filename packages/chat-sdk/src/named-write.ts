/**
 * mintNamedWriteToken — client-side helper to mint a named-write JWT.
 *
 * POSTs to the client's own mint endpoint (NOT the OxPulse backend directly).
 * Returns the raw JWT string (no 'Bearer ' prefix) that can be passed to
 * SDKChatClient as `jwt`.
 *
 * Throws NamedWriteMintError on any non-2xx response or malformed body.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MintNamedWriteOptions {
  /** The client's OWN mint endpoint. */
  mintEndpoint: string;
  /** The event room key (event.slug). */
  roomId: string;
  /** ox_did (v4 UUID) — optional. */
  oxDid?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export type NamedWriteMintErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'mint_failed';

export class NamedWriteMintError extends Error {
  readonly code: NamedWriteMintErrorCode;
  readonly status: number;

  constructor(code: NamedWriteMintErrorCode, message: string, status: number) {
    super(message);
    this.name = 'NamedWriteMintError';
    this.code = code;
    this.status = status;
  }
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * Parse the `alg` field from a JWT header without validating the signature.
 * Returns the alg string, or null if the header is malformed.
 */
function parseJwtAlg(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const headerB64 = token.slice(0, dot);
  // URL-safe base64 → standard base64
  const std = headerB64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  try {
    const header = JSON.parse(atob(padded)) as Record<string, unknown>;
    const alg = header['alg'];
    return typeof alg === 'string' ? alg : null;
  } catch {
    return null;
  }
}

function statusToCode(status: number): NamedWriteMintErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  return 'mint_failed';
}

/** POST to the client's mint endpoint, return the named-write SDK JWT (raw string, no 'Bearer '). */
export async function mintNamedWriteToken(opts: MintNamedWriteOptions): Promise<string> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;

  const requestBody: Record<string, string> = { room_id: opts.roomId };
  if (opts.oxDid !== undefined) {
    requestBody['ox_did'] = opts.oxDid;
  }

  let response: Response;
  try {
    response = await fetchFn(opts.mintEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw new NamedWriteMintError(
      'mint_failed',
      `named-write-mint network error: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  if (!response.ok) {
    const code = statusToCode(response.status);
    throw new NamedWriteMintError(
      code,
      `named-write-mint failed with HTTP ${response.status}`,
      response.status,
    );
  }

  let body: { token: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new NamedWriteMintError(
      'mint_failed',
      'named-write-mint: failed to parse response JSON',
      response.status,
    );
  }

  // Guard the 2xx contract — a missing or non-string token would otherwise
  // surface as a silent `undefined` downstream (symmetric with the anon-read guard).
  if (typeof body.token !== 'string') {
    throw new NamedWriteMintError(
      'mint_failed',
      'named-write-mint: response missing or invalid token field',
      response.status,
    );
  }

  // Defense-in-depth alg-pin: the server-side exchange enforces EdDSA (T2
  // Validation::new(EdDSA)), but the client guards here as well so a misconfigured
  // mint endpoint returning alg:none or alg:HS256 is caught before the token is used.
  const algHeader = parseJwtAlg(body.token);
  if (algHeader !== 'EdDSA') {
    throw new NamedWriteMintError(
      'mint_failed',
      `named-write-mint: token alg must be EdDSA, got ${String(algHeader)}`,
      response.status,
    );
  }

  return body.token;
}
