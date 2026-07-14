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
 * by the widget. The web app's own attachment path (buildAttachmentFromBlob)
 * already uses this same convention — splat attachment metadata into the
 * application-level chat payload rather than the wire envelope — and the
 * server's product_ref/product_meta precedent (send()/rowToMessageRow)
 * confirms the wire deliberately leaves app-level metadata to clients.
 *
 * The {v,t} discriminator distinguishes an attachment envelope from an
 * ordinary plain-text message so decodeAttachmentEnvelope() never misfires
 * on a user typing JSON-shaped text, and stays extensible for a future
 * envelope version without breaking older widgets mid-room.
 */

/** Envelope wire version. Bump on a breaking shape change. */
const ENVELOPE_VERSION = 1;
/** Envelope type discriminator. */
const ENVELOPE_TYPE = 'att';

/** Sanity clamp for width/height — a room peer's plaintext body is untrusted input. */
const MAX_DIMENSION = 20000;

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
