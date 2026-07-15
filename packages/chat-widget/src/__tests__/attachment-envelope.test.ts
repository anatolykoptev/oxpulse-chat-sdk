import { describe, it, expect } from 'vitest';
import {
  encodeAttachmentEnvelope,
  decodeAttachmentEnvelope,
  attachmentUrl,
  MAX_ATTACHMENTS,
} from '../utils/attachment-envelope.js';

// attachment-envelope.ts carries attachment metadata (attachmentId, mime,
// filename, size, dims) inside the plaintext message body — the write side
// (composerClient.sendFile) encodes it as the `sealed` bytes, the read side
// (element.ts row bridge) decodes it back before handing rows to MessageList.
// This closes the gap where chat-sdk's sendFile() discarded attachmentId when
// calling client.send() — see attachments.ts:163-167.

describe('encodeAttachmentEnvelope / decodeAttachmentEnvelope', () => {
  it('round-trips body + attachments through encode -> decode', () => {
    const buf = encodeAttachmentEnvelope('a caption', [
      { id: 'att-1', mime: 'image/webp', filename: 'photo.webp', sizeBytes: 1234, width: 800, height: 600 },
    ]);
    const text = new TextDecoder().decode(buf);
    const decoded = decodeAttachmentEnvelope(text);
    expect(decoded).toEqual({
      body: 'a caption',
      attachments: [
        { id: 'att-1', mime: 'image/webp', filename: 'photo.webp', sizeBytes: 1234, width: 800, height: 600 },
      ],
    });
  });

  it('round-trips an attachment without width/height (non-image)', () => {
    const buf = encodeAttachmentEnvelope('', [
      { id: 'att-2', mime: 'application/pdf', filename: 'doc.pdf', sizeBytes: 500 },
    ]);
    const decoded = decodeAttachmentEnvelope(new TextDecoder().decode(buf));
    expect(decoded?.attachments[0]?.width).toBeUndefined();
    expect(decoded?.attachments[0]?.height).toBeUndefined();
  });

  it('round-trips an audio attachment with durationMs', () => {
    const buf = encodeAttachmentEnvelope('', [
      { id: 'att-voice', mime: 'audio/mp4', filename: 'voice.mp4', sizeBytes: 1234, durationMs: 45_000 },
    ]);
    const decoded = decodeAttachmentEnvelope(new TextDecoder().decode(buf));
    expect(decoded?.attachments[0]?.durationMs).toBe(45_000);
  });

  it('round-trips an audio attachment with peaks (sender computes, receiver renders)', () => {
    const peaks = [0, 0.25, 0.5, 0.75, 1];
    const buf = encodeAttachmentEnvelope('', [
      { id: 'att-voice', mime: 'audio/mp4', filename: 'voice.mp4', sizeBytes: 1234, durationMs: 45_000, peaks },
    ]);
    const decoded = decodeAttachmentEnvelope(new TextDecoder().decode(buf));
    expect(decoded?.attachments[0]?.peaks).toEqual(peaks);
  });

  it('tolerates absence of peaks (legacy envelope → undefined, flat fallback)', () => {
    const buf = encodeAttachmentEnvelope('', [
      { id: 'att-voice', mime: 'audio/mp4', filename: 'voice.mp4', sizeBytes: 1234, durationMs: 45_000 },
    ]);
    const decoded = decodeAttachmentEnvelope(new TextDecoder().decode(buf));
    expect(decoded?.attachments[0]?.peaks).toBeUndefined();
  });

  it('drops non-finite/out-of-range peaks values from a hostile room peer', () => {
    const decoded = decodeAttachmentEnvelope(JSON.stringify({
      v: 1,
      t: 'att',
      body: '',
      attachments: [{
        id: 'hostile', mime: 'audio/mp4', filename: 'v.mp4', sizeBytes: 1,
        peaks: [0.5, NaN, -0.1, 1.5, 0.2, Infinity, 'x' as unknown as number],
      }],
    }));
    // Only the valid float[0,1] values survive; the field is kept (valid remain).
    expect(decoded?.attachments[0]?.peaks).toEqual([0.5, 0.2]);
  });

  it('drops the peaks field entirely when no valid values remain', () => {
    const decoded = decodeAttachmentEnvelope(JSON.stringify({
      v: 1,
      t: 'att',
      body: '',
      attachments: [{
        id: 'hostile', mime: 'audio/mp4', filename: 'v.mp4', sizeBytes: 1,
        peaks: [NaN, -1, 2, Infinity],
      }],
    }));
    expect(decoded?.attachments[0]?.peaks).toBeUndefined();
  });

  it('clamps peaks length to MAX_VOICE_PEAKS=64', () => {
    const huge = Array.from({ length: 100 }, (_, i) => (i % 101) / 100);
    const decoded = decodeAttachmentEnvelope(JSON.stringify({
      v: 1,
      t: 'att',
      body: '',
      attachments: [{
        id: 'big', mime: 'audio/mp4', filename: 'v.mp4', sizeBytes: 1,
        peaks: huge,
      }],
    }));
    expect(decoded?.attachments[0]?.peaks).toHaveLength(64);
  });

  it('drops_negative_or_nonfinite_durationMs', () => {
    const decoded = decodeAttachmentEnvelope(JSON.stringify({
      v: 1,
      t: 'att',
      body: '',
      attachments: [
        { id: 'bad', mime: 'audio/mp4', filename: 'v.mp4', sizeBytes: 1, durationMs: -1 },
      ],
    }));
    expect(decoded?.attachments[0]?.durationMs).toBeUndefined();
  });

  it('returns null for plain (non-JSON) chat text — backward compatible with existing messages', () => {
    expect(decodeAttachmentEnvelope('hello world')).toBeNull();
  });

  it('returns null for arbitrary JSON that is not our envelope shape', () => {
    expect(decodeAttachmentEnvelope(JSON.stringify({ hello: 'world' }))).toBeNull();
  });

  it('returns null for JSON missing the {v,t} discriminator (forward/backward safety)', () => {
    expect(decodeAttachmentEnvelope(JSON.stringify({ body: 'x', attachments: [{ id: 'a', mime: 'image/png', filename: 'f', sizeBytes: 1 }] }))).toBeNull();
  });

  it('returns null when attachments array is empty', () => {
    expect(decodeAttachmentEnvelope(JSON.stringify({ v: 1, t: 'att', body: 'x', attachments: [] }))).toBeNull();
  });

  it('drops a malformed attachment entry but keeps well-formed siblings', () => {
    const decoded = decodeAttachmentEnvelope(JSON.stringify({
      v: 1,
      t: 'att',
      body: '',
      attachments: [
        { id: 'ok', mime: 'image/png', filename: 'f.png', sizeBytes: 10 },
        { id: 'bad-missing-mime', filename: 'f2.png', sizeBytes: 10 },
      ],
    }));
    expect(decoded?.attachments).toHaveLength(1);
    expect(decoded?.attachments[0]?.id).toBe('ok');
  });

  it('clamps a hostile/absurd width and height to a sane maximum instead of trusting a room peer', () => {
    const decoded = decodeAttachmentEnvelope(JSON.stringify({
      v: 1,
      t: 'att',
      body: '',
      attachments: [{ id: 'a', mime: 'image/png', filename: 'f', sizeBytes: 1, width: 999999999, height: -5 }],
    }));
    expect(decoded?.attachments[0]?.width).toBe(20000);
    expect(decoded?.attachments[0]?.height).toBeUndefined();
  });

  it('clamps a hostile envelope carrying far more than MAX_ATTACHMENTS entries — a malicious room peer must not force N rendered bubbles', () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS + 50 }, (_, i) => ({
      id: `a${i}`, mime: 'image/png', filename: `f${i}.png`, sizeBytes: 1,
    }));
    const decoded = decodeAttachmentEnvelope(JSON.stringify({ v: 1, t: 'att', body: '', attachments }));
    expect(decoded?.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(decoded?.attachments[0]?.id).toBe('a0');
    expect(decoded?.attachments[MAX_ATTACHMENTS - 1]?.id).toBe(`a${MAX_ATTACHMENTS - 1}`);
  });
});

describe('attachmentUrl', () => {
  it('builds the GET /api/sdk/attachments/{id} download URL', () => {
    expect(attachmentUrl('https://chat.example.com', 'att-123')).toBe(
      'https://chat.example.com/api/sdk/attachments/att-123',
    );
  });

  it('URL-encodes the attachment id', () => {
    expect(attachmentUrl('https://chat.example.com', 'a/b c')).toBe(
      'https://chat.example.com/api/sdk/attachments/a%2Fb%20c',
    );
  });
});
