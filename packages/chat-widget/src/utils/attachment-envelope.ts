/**
 * attachment-envelope.ts — carries attachment metadata inside the plaintext
 * message body.
 *
 * Root cause this closes: chat-sdk's sendFile() (attachments.ts:120-176)
 * presigns an attachment (getting attachmentId) then calls
 * client.send(roomId, {senderUid, sealed}) — but never forwards attachmentId
 * into the sealed payload or any sibling wire field. chat-sdk's SendArgs /
 * MessageRow / rowToMessageRow have no attachments field at all, so a stored
 * blob is structurally unlinked from any message once uploaded.
 *
 * Fix (widget-owned, zero chat-sdk changes): since this widget always runs
 * cryptoMode:'plaintext', the `sealed` bytes are UTF-8 text fully controlled
 * by the widget. Note this does NOT match the web app's own attachment path
 * (`web/src/lib/chat/attachments/attachments.ts`'s `buildAttachmentFromBlob`)
 * — that carries attachments as a SCHEMA'D first-class message field
 * (`web/domain/schema.ts:185`, `{kind, url: dataUrl, size, ...}`), which is
 * structurally incompatible with this envelope. This widget has no
 * equivalent schema'd field to reuse (and no ability to add one — that would
 * be a server change, out of reach from this package), so it falls back to
 * riding the one channel it fully controls end-to-end: the plaintext body.
 * The server's product_ref/product_meta precedent (send()/rowToMessageRow)
 * at least confirms the wire deliberately leaves SOME app-level metadata to
 * clients, so this is not unprecedented in kind — just a different shape
 * than the web app's.
 *
 * The {v,t} discriminator distinguishes an attachment envelope from an
 * ordinary plain-text message so decodeAttachmentEnvelope() never misfires
 * on a user typing JSON-shaped text, and stays extensible for a future
 * envelope version without breaking older widgets mid-room.
 *
 * Old-client-renders-JSON compat (accepted, documented — no behavior change
 * needed): a client running an OLDER widget build that predates this
 * envelope would render the raw `{"v":1,"t":"att",...}` JSON as literal chat
 * text instead of an attachment bubble, for any message an upgraded peer
 * sends after this ships. Accepted, given the CDN distribution model
 * (docs/RUNBOOK-widget-cdn.md, docs/embedding.md:60-63): a pinned version URL
 * (`/widget/<semver>/index.js`) is served `Cache-Control: immutable,
 * max-age=31536000` and NEVER auto-upgrades — an embedder pinned to an old
 * version stays on it until they edit their own `<script src>` — while
 * `/widget/latest/index.js` (served without `immutable`) rolls forward on
 * the next publish. Either way this is an existing, accepted embedder-driven
 * upgrade cadence this feature doesn't change or need to solve — it's the
 * SAME exposure any other widget-version-skew already has (e.g. a new
 * reaction emoji an old client can't render), not a new failure mode this
 * envelope introduces. A first-class wire field (server-side) would remove
 * the skew entirely for THIS feature specifically; tracked as a separate
 * follow-up, not solved here.
 */

/** Envelope wire version. Bump on a breaking shape change. */
const ENVELOPE_VERSION = 1;
/** Envelope type discriminator. */
const ENVELOPE_TYPE = 'att';

/** Sanity clamp for width/height — a room peer's plaintext body is untrusted input. */
const MAX_DIMENSION = 20000;

/**
 * Max attachments rendered from one envelope — a room peer's plaintext body
 * is untrusted input; without a cap a hostile message claiming hundreds of
 * attachment entries would force MessageList to render that many bubbles
 * (each triggering an authenticated fetchAttachmentBlob call) per message.
 * Exported so tests can assert against it without hardcoding the number.
 */
export const MAX_ATTACHMENTS = 10;

export interface EnvelopeAttachment {
  id: string;
  mime: string;
  filename: string;
  sizeBytes: number;
  width?: number;
  height?: number;
}

export interface AttachmentEnvelope {
  body: string;
  attachments: EnvelopeAttachment[];
}

/** Encode a caption + attachment list as the UTF-8 `sealed` bytes for client.send(). */
export function encodeAttachmentEnvelope(
  body: string,
  attachments: readonly EnvelopeAttachment[],
): ArrayBuffer {
  const payload = { v: ENVELOPE_VERSION, t: ENVELOPE_TYPE, body, attachments };
  return new TextEncoder().encode(JSON.stringify(payload)).buffer;
}

/** Clamp a possibly attacker-controlled numeric dimension to a positive finite integer, or undefined. */
function clampDimension(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.round(value), MAX_DIMENSION);
}

/** Validate + normalize one raw attachment entry. Returns null when malformed. */
function parseAttachment(value: unknown): EnvelopeAttachment | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id === '') return null;
  if (typeof v.mime !== 'string' || v.mime === '') return null;
  if (typeof v.filename !== 'string') return null;
  if (typeof v.sizeBytes !== 'number' || !Number.isFinite(v.sizeBytes) || v.sizeBytes < 0) return null;
  return {
    id: v.id,
    mime: v.mime,
    filename: v.filename,
    sizeBytes: v.sizeBytes,
    width: clampDimension(v.width),
    height: clampDimension(v.height),
  };
}

/**
 * Decode a plaintext message body as an attachment envelope.
 * Returns null when the string is not a well-formed envelope of OUR shape —
 * callers must fall back to treating the original string as the plain body.
 * This is the read-side inverse of encodeAttachmentEnvelope(), applied to
 * every room member's message stream (not just the sender's own optimistic UI).
 */
export function decodeAttachmentEnvelope(plaintext: string): AttachmentEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== ENVELOPE_VERSION || p.t !== ENVELOPE_TYPE) return null;
  if (typeof p.body !== 'string') return null;
  if (!Array.isArray(p.attachments)) return null;

  const attachments: EnvelopeAttachment[] = [];
  for (const raw of p.attachments) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    const att = parseAttachment(raw);
    if (att) attachments.push(att);
  }
  if (attachments.length === 0) return null;

  return { body: p.body, attachments };
}

/**
 * Build the GET /api/sdk/attachments/{id} download URL (server: JWT-authenticated —
 * callers must fetch with an Authorization header, not assign this directly to
 * `<img src>`; see MessageListClient.fetchAttachmentBlob).
 */
export function attachmentUrl(baseUrl: string, attachmentId: string): string {
  return `${baseUrl}/api/sdk/attachments/${encodeURIComponent(attachmentId)}`;
}
