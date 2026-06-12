/**
 * attachments.ts — W4: File attachment helpers for @oxpulse/chat-sdk.
 *
 * E2EE-friendly: client encrypts the blob with the room SFrame key before
 * uploading; server stores ciphertext and never decrypts.
 *
 * Flow:
 *   1. presignAttachment — POST /api/sdk/attachments/presign
 *   2. PUT uploadUrl — upload the (encrypted) blob.
 *   3. client.send — send a sealed message referencing the attachment.
 *
 * sendFile() is a convenience wrapper that runs all three steps.
 */

import { SDKChatError } from "./errors.js";

/** Maximum attachment blob size enforced client-side before calling presign. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PresignArgs {
  /** MIME type of the blob (e.g. "image/png"). */
  mimeType: string;
  /** Byte size of the (encrypted) blob. */
  byteSize: number;
  /** SHA-256 hex digest of the plaintext (for deduplication). */
  sha256: string;
  /** Optional ThumbHash preview, base64-encoded. */
  thumbhashB64?: string;
}

export interface PresignResult {
  /** Server-assigned attachment UUID. */
  attachmentId: string;
  /** PUT-able URL (relative, 5-min TTL). */
  uploadUrl: string;
}

export interface SendFileArgs {
  /** Caller-assigned stable user identifier (passed through to send). */
  senderUid: string;
  /** E2EE-sealed ciphertext to include in the message payload. */
  sealed: ArrayBuffer;
  /** MIME type for the presign request. Falls back to blob.type. */
  mimeType?: string;
  /** SHA-256 hex of the plaintext. Required for deduplication metadata. */
  sha256: string;
  /** Optional ThumbHash preview, base64-encoded. */
  thumbhashB64?: string;
}

// ─── Minimal client interface ─────────────────────────────────────────────────

/** Duck-typed interface satisfied by SDKChatClient. */
interface AttachmentClient {
  readonly baseUrl: string;
  readonly jwt: string;
  send(
    roomId: string,
    args: { senderUid: string; sealed: ArrayBuffer; msgId?: string },
  ): Promise<{ seq: number; msgId: string }>;
}

// ─── Standalone helpers ───────────────────────────────────────────────────────

/**
 * POST /api/sdk/attachments/presign
 *
 * Returns a signed PUT URL and attachment_id.
 * Throws SDKChatError on network or server error.
 */
export async function presignAttachment(
  client: AttachmentClient,
  args: PresignArgs,
): Promise<PresignResult> {
  let resp: Response;
  try {
    resp = await fetch(`${client.baseUrl}/api/sdk/attachments/presign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${client.jwt}`,
      },
      body: JSON.stringify({
        mime_type: args.mimeType,
        byte_size: args.byteSize,
        sha256: args.sha256,
        thumbhash_b64: args.thumbhashB64 ?? null,
      }),
    });
  } catch (err) {
    throw new SDKChatError("network", `presign failed: ${String(err)}`);
  }

  if (!resp.ok) {
    throw new SDKChatError(
      "server_error",
      `presign failed: HTTP ${resp.status}`,
    );
  }

  const body = (await resp.json()) as { attachment_id: string; upload_url: string };
  return {
    attachmentId: body.attachment_id,
    uploadUrl: body.upload_url,
  };
}

/**
 * sendFile — presign → PUT → send sealed reference.
 *
 * Validates blob size client-side before touching the network.
 *
 * @param client   Object satisfying AttachmentClient interface.
 * @param roomId   Room to post the attachment message to.
 * @param blob     The (encrypted) blob to upload.
 * @param args     senderUid + sealed ciphertext + sha256.
 */
export async function sendFile(
  client: AttachmentClient,
  roomId: string,
  blob: Blob,
  args: SendFileArgs,
): Promise<{ seq: number; msgId: string }> {
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    throw new SDKChatError(
      "invalid_args",
      `attachment too large: ${blob.size} bytes exceeds ${MAX_ATTACHMENT_BYTES} byte limit`,
    );
  }

  const { uploadUrl } = await presignAttachment(client, {
    mimeType: args.mimeType ?? blob.type,
    byteSize: blob.size,
    sha256: args.sha256,
    thumbhashB64: args.thumbhashB64,
  });

  // PUT the blob to the signed URL (relative path — prepend base URL).
  const putUrl = uploadUrl.startsWith("/")
    ? `${client.baseUrl}${uploadUrl}`
    : uploadUrl;

  const putResp = await fetch(putUrl, {
    method: "PUT",
    body: blob,
    headers: {
      "Content-Type": args.mimeType ?? blob.type,
    },
  });

  if (!putResp.ok) {
    throw new SDKChatError(
      "server_error",
      `upload failed: ${putResp.status}`,
    );
  }

  // Wrap client.send in try/catch: if send fails after a successful PUT,
  // the attachment is orphaned on disk. Log a warning so operators can
  // identify and sweep orphaned presign rows (future sweeper worker).
  try {
    return await client.send(roomId, {
      senderUid: args.senderUid,
      sealed: args.sealed,
    });
  } catch (err) {
    console.warn(
      "[oxpulse/chat-sdk] sendFile: attachment uploaded but client.send failed " +
        "(orphaned presign row may exist). attachment upload_url was recorded.",
      err,
    );
    throw err;
  }
}
