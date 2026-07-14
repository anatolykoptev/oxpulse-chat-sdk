/**
 * attachments.ts — W2.2 slice 4: file-attachment helpers for @oxpulse/chat-widget.
 *
 * Ported and extended from web/src/lib/chat/attachments/attachments.ts.
 * Widget package is standalone — no runtime import from web/.
 *
 * Supports images, audio, and generic files (up to 50 MB SDK cap).
 * All validation is pure — no DOM access — so tests run under jsdom without stubs.
 */

// ── Constants ──────────────────────────────────────────────────────────────────

/** Whitelist of accepted image MIME types. */
export const ALLOWED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Whitelist of accepted audio MIME types. */
export const ALLOWED_AUDIO_MIMES: ReadonlySet<string> = new Set([
  'audio/webm',
  'audio/webm;codecs=opus',
  'audio/ogg',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/flac',
]);

/** 50 MB — matches SDK MAX_ATTACHMENT_BYTES cap. */
export const MAX_FILE_SIZE = 50 * 1024 * 1024;

/** Max image dimensions before rejection (sanity check only — compress handles downscale). */
export const MAX_IMAGE_DIMENSION = 8192;

/** Reply-snapshot text used when the target is image-only. */
export const IMAGE_REPLY_SNAPSHOT = '📷 Image';

/** Reply-snapshot text used when the target is a voice-only message. */
export const VOICE_REPLY_SNAPSHOT = '🎤 Voice message';

// ── Validate ───────────────────────────────────────────────────────────────────

/** Result of validating a file blob against the widget policy. */
export type ValidateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Sanitize a filename — return basename only (post-last path separator).
 * CM4: single-pass ../ replace left "....//etc" intact; basename-only approach
 * eliminates all path traversal by discarding everything before the last / or \.
 */
export function sanitizeFilename(name: string): string {
  // Take basename only (post-last separator) — eliminates all traversal variants
  const parts = name.split(/[\\/]/);
  const basename = parts[parts.length - 1] ?? '';
  // Strip null bytes and non-printable control chars
  const out = basename.replace(/\x00/g, '').replace(/[\x00-\x1f\x7f]/g, '');
  return out || 'file';
}

/**
 * Validate a file against the widget attachment policy.
 * Pure — takes only the fields it needs so tests can pass plain objects.
 *
 * Allowed MIME types: images (ALLOWED_IMAGE_MIMES), audio (ALLOWED_AUDIO_MIMES), application/pdf.
 * Size cap: MAX_FILE_SIZE (50 MB).
 */
export function validate(
  file: { readonly type: string; readonly size: number; readonly name?: string },
): ValidateResult {
  // Check MIME allow-list
  const mime = file.type;
  const isImage = ALLOWED_IMAGE_MIMES.has(mime);
  const isAudio = ALLOWED_AUDIO_MIMES.has(mime) || mime.startsWith('audio/');
  const isPdf = mime === 'application/pdf';
  if (!isImage && !isAudio && !isPdf) {
    return { ok: false, reason: `Unsupported file type: ${mime || 'unknown'}` };
  }

  // Size checks
  if (file.size <= 0) {
    return { ok: false, reason: 'Empty file' };
  }
  if (file.size > MAX_FILE_SIZE) {
    return { ok: false, reason: 'File too large — 50MB max' };
  }

  // Filename safety
  if (file.name !== undefined) {
    if (file.name.includes('\0')) {
      return { ok: false, reason: 'Invalid filename' };
    }
    if (/\.\.[\\/]/.test(file.name)) {
      return { ok: false, reason: 'Invalid filename' };
    }
  }

  return { ok: true };
}

// ── AttachmentMeta (widget-local, matches SDK bubble rendering needs) ──────────

/** Metadata shape for attachment rendering in message bubbles. */
export interface AttachmentMeta {
  id: string;
  url: string;
  mime: string;
  filename: string;
  sizeBytes: number;
  width?: number;
  height?: number;
}

// ── URL safety (CB1) ──────────────────────────────────────────────────────────

/**
 * CB1: Allowlist-based URL validation for attachment src/href assignments.
 * Prevents XSS via javascript: and data:text/html: URLs.
 * Only https?:, blob:, and safe data: image/audio prefixes are permitted.
 */
const SAFE_URL_RE = /^(https?:|blob:|data:image\/(png|jpe?g|gif|webp);|data:audio\/(mp3|mpeg|wav|ogg|webm);)/i;

export function isSafeAttachmentUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  return SAFE_URL_RE.test(url.trim());
}

// ── Image compress (browser-only) ──────────────────────────────────────────────

/** Result of client-side image compression. */
export interface CompressionResult {
  blob: Blob;
  dataUrl: string;
  width: number;
  height: number;
  originalBytes: number;
  compressedBytes: number;
  /** true → output ≥ input; original blob returned as-is */
  reused: boolean;
  encodingMime: string;
}

/** Compute target dimensions preserving aspect ratio. No upscale. Pure / testable. */
export function computeResizedDimensions(
  srcWidth: number,
  srcHeight: number,
  maxLongEdge: number,
): { width: number; height: number } {
  const longEdge = Math.max(srcWidth, srcHeight);
  if (longEdge <= maxLongEdge) {
    return { width: srcWidth, height: srcHeight };
  }
  const ratio = maxLongEdge / longEdge;
  return {
    width: Math.round(srcWidth * ratio),
    height: Math.round(srcHeight * ratio),
  };
}

/** Read a Blob into a data: URL via FileReader. */
function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === 'string') resolve(r);
      else reject(new Error('FileReader returned non-string'));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Compress an image blob to WebP (fallback: JPEG) at up to 1920px long edge.
 * Requires browser globals: createImageBitmap, HTMLCanvasElement.
 * Throws Error("decode-failed") if the source cannot be decoded.
 */
export async function compress(
  source: Blob,
  opts?: { maxLongEdge?: number; quality?: number },
): Promise<CompressionResult> {
  const maxLongEdge = opts?.maxLongEdge ?? 1920;
  const quality = opts?.quality ?? 0.78;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch {
    throw new Error('decode-failed');
  }

  const srcW = bitmap.width;
  const srcH = bitmap.height;

  // CM3: decompression bomb defense — reject images whose pixel area exceeds the
  // MAX_IMAGE_DIMENSION² cap before allocating canvas memory.
  if (srcW * srcH > MAX_IMAGE_DIMENSION * MAX_IMAGE_DIMENSION) {
    bitmap.close();
    throw new Error(
      `Image dimensions ${srcW}x${srcH} exceed MAX_IMAGE_DIMENSION ${MAX_IMAGE_DIMENSION}`,
    );
  }

  const { width, height } = computeResizedDimensions(srcW, srcH, maxLongEdge);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas-context-unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const encoded: Blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) { resolve(blob); return; }
        canvas.toBlob(
          (jpegBlob) => {
            if (jpegBlob) resolve(jpegBlob);
            else reject(new Error('toBlob-failed'));
          },
          'image/jpeg',
          0.85,
        );
      },
      'image/webp',
      quality,
    );
  });

  if (encoded.size >= source.size) {
    const originalDataUrl = await readBlobAsDataUrl(source);
    return {
      blob: source,
      dataUrl: originalDataUrl,
      width: srcW,
      height: srcH,
      originalBytes: source.size,
      compressedBytes: source.size,
      reused: true,
      encodingMime: source.type,
    };
  }

  const dataUrl = await readBlobAsDataUrl(encoded);
  return {
    blob: encoded,
    dataUrl,
    width,
    height,
    originalBytes: source.size,
    compressedBytes: encoded.size,
    reused: false,
    encodingMime: encoded.type,
  };
}

/**
 * Generate a thumbnail data URL from an image blob (max 64px long edge).
 * Returns null if browser lacks canvas support.
 */
/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export async function thumbnail(
  source: Blob,
  maxLongEdge = 64,
): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(source);
    const { width, height } = computeResizedDimensions(bitmap.width, bitmap.height, maxLongEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); return null; }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return canvas.toDataURL('image/webp', 0.6);
  } catch {
    return null;
  }
}

// ── Reply snapshot ─────────────────────────────────────────────────────────────

/** Attachment shape for replyBodySnapshotForMessage (duck-typed).
 *  Supports both the legacy `kind` discriminator and widget AttachmentMeta's `mime`. */
interface AttachmentRef {
  readonly kind?: string;
  readonly mime?: string;
}

/**
 * Compute the body excerpt to use for a reply-snapshot.
 * Ported from web/src/lib/chat/attachments/attachments.ts.
 * Widget extension: also inspects `mime` for AttachmentMeta rows that lack `kind`.
 */
export function replyBodySnapshotForMessage(
  msg: {
    readonly body: string;
    readonly attachments?: ReadonlyArray<AttachmentRef>;
  },
): string {
  if (msg.body.length > 0) return msg.body;
  const imageAttachment = msg.attachments?.find(
    (a) => a.kind === 'image' || a.mime?.startsWith('image/'),
  );
  if (imageAttachment !== undefined) return IMAGE_REPLY_SNAPSHOT;
  const voiceAttachment = msg.attachments?.find(
    (a) => a.kind === 'voice' || a.mime?.startsWith('audio/'),
  );
  if (voiceAttachment !== undefined) return VOICE_REPLY_SNAPSHOT;
  return msg.body;
}
