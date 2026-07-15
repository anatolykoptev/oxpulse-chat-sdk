// pickMime() — MediaRecorder candidate selection.
//
// Voice messages travel as a recorded blob with a MIME type. Cross-browser
// playback is the constraint: audio/mp4 (AAC) decodes everywhere in 2026,
// audio/webm/opus is Chrome/Firefox-only. PR #170 reordered candidates so
// mp4 wins whenever the recorder supports it — a Chrome→Safari voice note
// was silently un-decodable before that change.
//
// We control which candidates are "supported" by stubbing
// `MediaRecorder.isTypeSupported`. The real browser stub doesn't exist
// in the vitest jsdom env so we install one for each test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pickMime } from '../recorder.ts';

interface FakeMediaRecorder {
  isTypeSupported: (mime: string) => boolean;
}

let originalMediaRecorder: unknown;

function installFakeRecorder(supported: ReadonlyArray<string>): void {
  const fake: FakeMediaRecorder = {
    isTypeSupported: (mime: string) => supported.includes(mime),
  };
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = fake;
}

beforeEach(() => {
  originalMediaRecorder = (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
});

afterEach(() => {
  if (originalMediaRecorder === undefined) {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  } else {
    (globalThis as { MediaRecorder?: unknown }).MediaRecorder = originalMediaRecorder;
  }
});

describe('pickMime', () => {
  it('returns the first supported MIME from the candidate list', () => {
    installFakeRecorder(['audio/webm']);
    expect(pickMime()).toBe('audio/webm');
  });

  it('returns "" when no candidate is supported', () => {
    installFakeRecorder([]);
    expect(pickMime()).toBe('');
  });

  it('returns "" when MediaRecorder is undefined', () => {
    delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
    expect(pickMime()).toBe('');
  });

  it('prefers audio/mp4 over webm when both are supported (PR #170)', () => {
    installFakeRecorder(['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']);
    expect(pickMime()).toBe('audio/mp4');
  });

  it('falls through to webm when only webm is supported', () => {
    installFakeRecorder(['audio/webm;codecs=opus', 'audio/webm']);
    expect(pickMime()).toBe('audio/webm;codecs=opus');
  });

  it('picks the explicit AAC-LC mp4 form when bare audio/mp4 is rejected', () => {
    installFakeRecorder(['audio/mp4;codecs=mp4a.40.2', 'audio/webm']);
    expect(pickMime()).toBe('audio/mp4;codecs=mp4a.40.2');
  });
});
