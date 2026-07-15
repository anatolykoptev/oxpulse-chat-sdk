import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createVoiceRecorder,
  pickMime,
  validateVoiceBlob,
  MAX_VOICE_MS,
  MAX_VOICE_BYTES,
} from '../utils/voice.js';

interface MockTrack {
  stop: ReturnType<typeof vi.fn>;
}

interface MockStream {
  getTracks: () => MockTrack[];
}

function makeMockStream(): MockStream {
  const track: MockTrack = { stop: vi.fn() };
  return {
    getTracks: () => [track],
  };
}

class MockMediaRecorder {
  static isTypeSupported = vi.fn(() => false);
  static lastInstance: MockMediaRecorder | null = null;

  stream: MediaStream;
  options: MediaRecorderOptions | undefined;
  state = 'inactive';
  mimeType = '';
  ondataavailable: ((ev: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  requestData = vi.fn(() => {
    if (this.ondataavailable) {
      this.ondataavailable({ data: new Blob(['chunk'], { type: this.mimeType }) } as BlobEvent);
    }
  });

  stop = vi.fn(() => {
    this.state = 'inactive';
    if (this.onstop) this.onstop();
  });

  start(timeslice?: number) {
    this.state = 'recording';
  }

  constructor(stream: MediaStream, options?: MediaRecorderOptions) {
    this.stream = stream;
    this.options = options;
    this.mimeType = options?.mimeType ?? '';
    MockMediaRecorder.lastInstance = this;
  }
}

function installMocks() {
  const getUserMedia = vi.fn().mockResolvedValue(makeMockStream() as unknown as MediaStream);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('MediaRecorder', MockMediaRecorder as unknown as typeof MediaRecorder);
}

function restoreMocks() {
  vi.unstubAllGlobals();
  MockMediaRecorder.lastInstance = null;
}

describe('pickMime', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers_mp4_aac_then_webm_opus_then_bare_webm', () => {
    // When all candidates are supported, mp4/AAC must win over webm/opus.
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: vi.fn(() => true),
    } as unknown as typeof MediaRecorder);
    expect(pickMime()).toBe('audio/mp4');
  });

  it('falls_back_to_mp4_aac_explicit_profile', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: vi.fn((mime: string) => mime === 'audio/mp4;codecs=mp4a.40.2'),
    } as unknown as typeof MediaRecorder);
    expect(pickMime()).toBe('audio/mp4;codecs=mp4a.40.2');
  });

  it('falls_back_to_webm_opus', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: vi.fn((mime: string) => mime === 'audio/webm;codecs=opus'),
    } as unknown as typeof MediaRecorder);
    expect(pickMime()).toBe('audio/webm;codecs=opus');
  });

  it('falls_back_to_bare_webm', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: vi.fn((mime: string) => mime === 'audio/webm'),
    } as unknown as typeof MediaRecorder);
    expect(pickMime()).toBe('audio/webm');
  });

  it('returns_empty_string_when_nothing_supported', () => {
    vi.stubGlobal('MediaRecorder', {
      isTypeSupported: vi.fn(() => false),
    } as unknown as typeof MediaRecorder);
    expect(pickMime()).toBe('');
  });
});

describe('validateVoiceBlob', () => {
  it('rejects_zero_size', () => {
    expect(validateVoiceBlob({ size: 0 }).ok).toBe(false);
  });

  it('rejects_over_4MB', () => {
    expect(validateVoiceBlob({ size: MAX_VOICE_BYTES + 1 }).ok).toBe(false);
  });

  it('rejects_zero_duration', () => {
    expect(validateVoiceBlob({ size: 100, durationMs: 0 }).ok).toBe(false);
  });

  it('rejects_negative_duration', () => {
    expect(validateVoiceBlob({ size: 100, durationMs: -1 }).ok).toBe(false);
  });

  it('rejects_over_60s', () => {
    expect(validateVoiceBlob({ size: 100, durationMs: MAX_VOICE_MS + 1 }).ok).toBe(false);
  });

  it('accepts_exactly_60s_and_4MB', () => {
    expect(validateVoiceBlob({ size: MAX_VOICE_BYTES, durationMs: MAX_VOICE_MS }).ok).toBe(true);
  });

  it('accepts_normal_recording', () => {
    expect(validateVoiceBlob({ size: 100, durationMs: 5_000 }).ok).toBe(true);
  });

  it('accepts_without_duration_field', () => {
    expect(validateVoiceBlob({ size: 100 }).ok).toBe(true);
  });
});

describe('createVoiceRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreMocks();
  });

  it('start_dataavailable_stop_yields_blob', async () => {
    MockMediaRecorder.isTypeSupported.mockReturnValue(true);
    vi.setSystemTime(0);

    const recorder = await createVoiceRecorder();
    expect(recorder).toBeTruthy();

    vi.setSystemTime(5_000);
    const result = await recorder.stop();

    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.mime).toBe('audio/mp4');
    expect(result.durationMs).toBe(5_000);

    const mediaRecorder = MockMediaRecorder.lastInstance;
    expect(mediaRecorder).not.toBeNull();
    expect(mediaRecorder!.requestData).toHaveBeenCalled();
    expect(mediaRecorder!.stop).toHaveBeenCalled();
    expect(mediaRecorder!.requestData.mock.invocationCallOrder![0]).toBeLessThan(
      mediaRecorder!.stop.mock.invocationCallOrder![0],
    );
  });

  it('auto_caps_at_60s_via_fake_timers', async () => {
    MockMediaRecorder.isTypeSupported.mockReturnValue(true);
    vi.setSystemTime(0);

    const recorder = await createVoiceRecorder();
    const mediaRecorder = MockMediaRecorder.lastInstance!;

    vi.advanceTimersByTime(MAX_VOICE_MS);

    // The auto-stop timer must fire recorder.stop before the caller calls voiceRecorder.stop()
    expect(mediaRecorder.stop).toHaveBeenCalled();

    const result = await recorder.stop();
    expect(result.durationMs).toBe(MAX_VOICE_MS);
  });

  it('cancel_stops_tracks_without_resolving', async () => {
    MockMediaRecorder.isTypeSupported.mockReturnValue(true);
    vi.setSystemTime(0);

    const recorder = await createVoiceRecorder();
    const mediaRecorder = MockMediaRecorder.lastInstance!;

    recorder.cancel();

    expect(mediaRecorder.stop).toHaveBeenCalled();
    const tracks = MockMediaRecorder.lastInstance?.stream.getTracks() as MockTrack[];
    expect(tracks[0].stop).toHaveBeenCalled();

    // Stop should return the unresolved promise (cancel discarded it)
    const race = await Promise.race([
      recorder.stop(),
      Promise.resolve('not-resolved'),
    ]);
    expect(race).toBe('not-resolved');
  });

  it('stop_stops_every_track', async () => {
    MockMediaRecorder.isTypeSupported.mockReturnValue(true);
    vi.setSystemTime(0);

    const recorder = await createVoiceRecorder();
    const mediaRecorder = MockMediaRecorder.lastInstance!;

    await recorder.stop();

    expect(mediaRecorder.stop).toHaveBeenCalled();
    const tracks = MockMediaRecorder.lastInstance?.stream.getTracks() as MockTrack[];
    expect(tracks.length).toBeGreaterThan(0);
    for (const track of tracks) {
      expect(track.stop).toHaveBeenCalled();
    }
  });
});
