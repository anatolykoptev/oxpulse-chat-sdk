/**
 * attachments.test.ts — W2.2 slice 4 TDD RED.
 *
 * Tests: validate, sanitizeFilename, ALLOWED_IMAGE_MIMES, ALLOWED_AUDIO_MIMES,
 *        MAX_FILE_SIZE, replyBodySnapshotForMessage, computeResizedDimensions.
 * Ported from web/src/lib/chat/attachments/attachments.test.ts and extended
 * for multi-type widget policy (images + audio + PDF).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  validate,
  sanitizeFilename,
  ALLOWED_IMAGE_MIMES,
  ALLOWED_AUDIO_MIMES,
  MAX_FILE_SIZE,
  IMAGE_REPLY_SNAPSHOT,
  VOICE_REPLY_SNAPSHOT,
  computeResizedDimensions,
  replyBodySnapshotForMessage,
  compress,
  MAX_IMAGE_DIMENSION,
} from '../utils/attachments.js';

// ── validate ──────────────────────────────────────────────────────────────────

describe('validate', () => {
  it('accepts all ALLOWED_IMAGE_MIMES at reasonable size', () => {
    for (const mime of ALLOWED_IMAGE_MIMES) {
      expect(validate({ type: mime, size: 50_000 })).toEqual({ ok: true });
    }
  });

  it('accepts all ALLOWED_AUDIO_MIMES at reasonable size', () => {
    for (const mime of ALLOWED_AUDIO_MIMES) {
      expect(validate({ type: mime, size: 50_000 })).toEqual({ ok: true });
    }
  });

  it('accepts application/pdf', () => {
    expect(validate({ type: 'application/pdf', size: 100_000 })).toEqual({ ok: true });
  });

  it('rejects unsupported MIME type (text/plain)', () => {
    const result = validate({ type: 'text/plain', size: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Unsupported/i);
  });

  it('rejects application/zip', () => {
    const result = validate({ type: 'application/zip', size: 1024 });
    expect(result.ok).toBe(false);
  });

  it('rejects empty file (size 0)', () => {
    const result = validate({ type: 'image/png', size: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/[Ee]mpty/);
  });

  it('accepts file exactly at MAX_FILE_SIZE cap', () => {
    expect(validate({ type: 'image/png', size: MAX_FILE_SIZE })).toEqual({ ok: true });
  });

  it('rejects file over MAX_FILE_SIZE cap', () => {
    const result = validate({ type: 'image/png', size: MAX_FILE_SIZE + 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/50MB/);
  });

  it('rejects filename with null byte', () => {
    const result = validate({ type: 'image/png', size: 100, name: 'foo\0bar.png' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/[Ii]nvalid/);
  });

  it('rejects filename with path traversal sequence', () => {
    const result = validate({ type: 'image/png', size: 100, name: '../../../etc/passwd' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/[Ii]nvalid/);
  });

  it('accepts safe filename without extension attack', () => {
    expect(validate({ type: 'image/jpeg', size: 100, name: 'photo.jpg' })).toEqual({ ok: true });
  });
});

// ── sanitizeFilename ──────────────────────────────────────────────────────────

describe('sanitizeFilename', () => {
  it('strips null bytes', () => {
    expect(sanitizeFilename('foo\0bar.png')).toBe('foobar.png');
  });

  it('strips path traversal ../  sequences', () => {
    // CM4: basename-only approach — returns last component after splitting on /\
    expect(sanitizeFilename('../../../etc/passwd')).toBe('passwd');
  });

  it('strips leading slash', () => {
    // CM4: basename-only returns last component
    expect(sanitizeFilename('/absolute/path.png')).toBe('path.png');
  });

  it('passes through normal filename', () => {
    expect(sanitizeFilename('photo.jpg')).toBe('photo.jpg');
  });

  it('returns "file" for empty result after stripping', () => {
    expect(sanitizeFilename('')).toBe('file');
  });
});

// ── MAX_FILE_SIZE ──────────────────────────────────────────────────────────────

describe('MAX_FILE_SIZE', () => {
  it('is 50 MB', () => {
    expect(MAX_FILE_SIZE).toBe(50 * 1024 * 1024);
  });
});

// ── computeResizedDimensions ──────────────────────────────────────────────────

describe('computeResizedDimensions', () => {
  it('no-ops when already within max', () => {
    expect(computeResizedDimensions(800, 600, 1920)).toEqual({ width: 800, height: 600 });
  });

  it('scales landscape image', () => {
    const r = computeResizedDimensions(3840, 2160, 1920);
    expect(r.width).toBe(1920);
    expect(r.height).toBe(1080);
  });

  it('scales portrait image', () => {
    const r = computeResizedDimensions(2160, 3840, 1920);
    expect(r.width).toBe(1080);
    expect(r.height).toBe(1920);
  });

  it('no-ops when exactly at max', () => {
    expect(computeResizedDimensions(1920, 1080, 1920)).toEqual({ width: 1920, height: 1080 });
  });
});

// ── CM3: compress rejects oversized dimensions ────────────────────────────────

describe('compress — decompression bomb defense', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects_image_exceeding_MAX_IMAGE_DIMENSION', async () => {
    // CM3: compress must check dimensions before canvas allocation
    const oversizeW = MAX_IMAGE_DIMENSION + 1;
    const oversizeH = MAX_IMAGE_DIMENSION + 1;
    const fakeBitmap = { width: oversizeW, height: oversizeH, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(fakeBitmap));

    const blob = new Blob(['fake'], { type: 'image/png' });
    await expect(compress(blob)).rejects.toThrow(/exceed|MAX_IMAGE_DIMENSION|too large/i);
  });

  it('accepts_image_within_max_dimension', async () => {
    // CM3: exactly MAX_IMAGE_DIMENSION x MAX_IMAGE_DIMENSION should NOT throw on dimension check
    const fakeBitmap = { width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, close: vi.fn() };
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(fakeBitmap));

    // Stub canvas + FileReader for the rest of compress()
    const mockCtx = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'high',
      drawImage: vi.fn(),
    };
    const smallBlob = new Blob(['x'], { type: 'image/webp' });
    const mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockCtx),
      toBlob: vi.fn().mockImplementation(
        (cb: (b: Blob | null) => void) => cb(smallBlob),
      ),
    };
    // Patch document.createElement only for 'canvas'
    const origCreate = globalThis.document?.createElement?.bind(globalThis.document);
    vi.spyOn(globalThis.document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'canvas') return mockCanvas as unknown as HTMLElement;
      return origCreate?.(tag);
    });

    class FakeReader {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      result: string = 'data:image/webp;base64,AA==';
      readAsDataURL() { setTimeout(() => this.onload?.(), 0); }
    }
    vi.stubGlobal('FileReader', FakeReader);

    const largeBlob = new Blob(['x'.repeat(100)], { type: 'image/png' });
    // Should not reject due to dimension check (exact boundary is ok)
    await expect(compress(largeBlob)).resolves.toBeDefined();
  });
});

// ── CM4: sanitizeFilename basename-only ───────────────────────────────────────

describe('sanitizeFilename — CM4 basename-only', () => {
  it('sanitizes_double_dot_double_slash', () => {
    // CM4: single-pass ../ replace leaves ....// intact; basename approach eliminates it
    const result = sanitizeFilename('....//....//evil');
    expect(result).not.toContain('/');
    expect(result).not.toContain('..');
    expect(result.length).toBeGreaterThan(0);
  });

  it('takes_basename_from_unix_path', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
  });

  it('takes_basename_from_windows_path', () => {
    expect(sanitizeFilename('C:\\Users\\user\\evil.png')).toBe('evil.png');
  });

  it('returns_file_for_slash_only', () => {
    expect(sanitizeFilename('/')).toBe('file');
    expect(sanitizeFilename('\\')).toBe('file');
  });
});

// ── replyBodySnapshotForMessage ───────────────────────────────────────────────

describe('replyBodySnapshotForMessage', () => {
  it('returns body verbatim when present', () => {
    expect(replyBodySnapshotForMessage({ body: 'hello' })).toBe('hello');
  });

  it('returns image fallback when body empty + image attached', () => {
    expect(
      replyBodySnapshotForMessage({
        body: '',
        attachments: [{ kind: 'image' }],
      }),
    ).toBe(IMAGE_REPLY_SNAPSHOT);
  });

  it('returns voice fallback when body empty + voice attached', () => {
    expect(
      replyBodySnapshotForMessage({
        body: '',
        attachments: [{ kind: 'voice' }],
      }),
    ).toBe(VOICE_REPLY_SNAPSHOT);
  });

  it('returns empty string when no body and no recognized attachment', () => {
    expect(
      replyBodySnapshotForMessage({
        body: '',
        attachments: [{ kind: 'file' }],
      }),
    ).toBe('');
  });

  it('returns empty string when no attachments', () => {
    expect(replyBodySnapshotForMessage({ body: '' })).toBe('');
  });
});
