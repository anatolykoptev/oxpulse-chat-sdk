import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createVoiceRecorder,
  validateVoiceBlob,
  MAX_VOICE_MS,
  MAX_VOICE_BYTES,
  type VoiceRecorder,
} from '../recorder.ts';

class FakeMediaStream {
  readonly tracks = [{ stop: vi.fn() }];
  getTracks() {
    return this.tracks;
  }
}

class FakeMediaRecorder {
  static isTypeSupported(_mime: string): boolean {
    return true;
  }

  /** Last instance created — tests use it to dispatch dataavailable events. */
  static lastInstance: FakeMediaRecorder | null = null;

  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = 'audio/mp4';
  ondataavailable: ((ev: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'audio/mp4';
    FakeMediaRecorder.lastInstance = this;
  }

  start(_timeslice?: number): void {
    this.state = 'recording';
  }

  requestData(): void {
    // no-op in the fake; real MediaRecorder would fire ondataavailable
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
  }
}

class FakeFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob): void {
    this.result = `data:${blob.type || 'audio/mp4'};base64,AAAA`;
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal(
    'navigator',
    {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(
          new FakeMediaStream() as unknown as MediaStream,
        ),
      },
    } as unknown as Navigator,
  );
  vi.stubGlobal('FileReader', FakeFileReader);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('validateVoiceBlob', () => {
  it('rejects zero-size blobs', () => {
    expect(validateVoiceBlob({ size: 0 })).toEqual({ ok: false, reason: 'Empty recording' });
  });

  it('rejects negative-size blobs', () => {
    expect(validateVoiceBlob({ size: -1 })).toEqual({ ok: false, reason: 'Empty recording' });
  });

  it('rejects blobs exceeding MAX_VOICE_BYTES', () => {
    expect(validateVoiceBlob({ size: MAX_VOICE_BYTES + 1 })).toEqual({
      ok: false,
      reason: 'Recording too large — 4 MB max',
    });
  });

  it('accepts the boundary size (exactly MAX_VOICE_BYTES)', () => {
    expect(validateVoiceBlob({ size: MAX_VOICE_BYTES })).toEqual({ ok: true });
  });

  it('rejects zero/negative duration when durationMs is provided', () => {
    expect(validateVoiceBlob({ size: 100, durationMs: 0 })).toEqual({
      ok: false,
      reason: 'Empty recording',
    });
    expect(validateVoiceBlob({ size: 100, durationMs: -5 })).toEqual({
      ok: false,
      reason: 'Empty recording',
    });
  });

  it('rejects duration exceeding MAX_VOICE_MS', () => {
    expect(validateVoiceBlob({ size: 100, durationMs: MAX_VOICE_MS + 1 })).toEqual({
      ok: false,
      reason: 'Recording too long — 60s max',
    });
  });

  it('accepts the boundary duration (exactly MAX_VOICE_MS)', () => {
    expect(validateVoiceBlob({ size: 100, durationMs: MAX_VOICE_MS })).toEqual({ ok: true });
  });

  it('accepts a normal blob with size + duration', () => {
    expect(validateVoiceBlob({ size: 50_000, durationMs: 5_000 })).toEqual({ ok: true });
  });

  it('accepts a blob without durationMs (duration check skipped)', () => {
    expect(validateVoiceBlob({ size: 50_000 })).toEqual({ ok: true });
  });
});

describe('createVoiceRecorder', () => {
  it('stop() resolves with a result when cancel() is called before onstop fires', async () => {
    const recorder = await createVoiceRecorder();
    const stopPromise = recorder.stop();
    recorder.cancel();

    const result = await Promise.race([
      stopPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('stop hung')), 500),
      ),
    ]);

    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.mime).toBe('audio/mp4');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('auto-caps recording at 60s (MAX_VOICE_MS) via the auto-stop timer', async () => {
    vi.useFakeTimers();
    try {
      const recorder = await createVoiceRecorder();
      const fake = FakeMediaRecorder.lastInstance!;
      expect(fake.state).toBe('recording');

      // Advance past MAX_VOICE_MS — the auto-stop timer fires recorder.stop().
      vi.advanceTimersByTime(MAX_VOICE_MS);

      // recorder.stop() was called → state goes inactive + onstop queued.
      expect(fake.state).toBe('inactive');

      // Flush the microtask + FileReader readAsDataURL (also microtask-based).
      const result = await vi.runAllTimersAsync();
      void result;

      // The auto-stop resolves the result — verify it produced a blob.
      const settled = await Promise.race([
        recorder.stop().then((r) => r),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('auto-stop did not resolve')), 1000),
        ),
      ]);
      expect(settled.blob).toBeInstanceOf(Blob);
    } finally {
      vi.useRealTimers();
    }
  });

  it('onAutoStop delegates the cap-stop to the caller with no internal double-stop', async () => {
    vi.useFakeTimers();
    try {
      const stopSpy = vi.spyOn(FakeMediaRecorder.prototype, 'stop');
      let calls = 0;
      let rec!: VoiceRecorder;
      rec = await createVoiceRecorder(undefined, {
        onAutoStop: () => {
          calls++;
          void rec.stop(); // caller drives the stop (would close its tap first)
        },
      });
      vi.advanceTimersByTime(MAX_VOICE_MS);
      expect(calls).toBe(1);
      // The caller's stop() drove the single MediaRecorder.stop; the recorder's
      // internal safety net saw stopping=true and did NOT stop again.
      expect(stopSpy).toHaveBeenCalledTimes(1);
      await vi.runAllTimersAsync();
      stopSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('onAutoStop safety net still caps the recording if the caller ignores it', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      await createVoiceRecorder(undefined, {
        onAutoStop: () => {
          calls++; // caller ignores — does NOT stop
        },
      });
      const fake = FakeMediaRecorder.lastInstance!;
      vi.advanceTimersByTime(MAX_VOICE_MS);
      expect(calls).toBe(1);
      // Safety self-stop fired because the caller left it running.
      expect(fake.state).toBe('inactive');
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel() stops tracks without resolving the result promise', async () => {
    const stream = new FakeMediaStream();
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(stream as unknown as MediaStream);

    const recorder = await createVoiceRecorder();
    const fake = FakeMediaRecorder.lastInstance!;

    // cancel() without calling stop() first — the result promise must NOT resolve.
    recorder.cancel();

    // cancel() calls recorder.stop() which queues onstop via microtask —
    // flush it so stopStream() runs before we assert.
    await new Promise((r) => setTimeout(r, 0));

    // Tracks are stopped.
    expect(stream.tracks[0]!.stop).toHaveBeenCalled();

    // The stop() promise should hang (cancel replaced onstop with a no-op).
    const stopPromise = recorder.stop();
    const hung = await Promise.race([
      stopPromise.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), 100)),
    ]);
    expect(hung).toBe(true);
    expect(fake.state).toBe('inactive');
  });

  it('stop() stops every track in the stream', async () => {
    const multiTrackStream = {
      tracks: [{ stop: vi.fn() }, { stop: vi.fn() }, { stop: vi.fn() }],
      getTracks() { return this.tracks; },
    };
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(multiTrackStream as unknown as MediaStream);

    const recorder = await createVoiceRecorder();
    await recorder.stop();

    for (const track of multiTrackStream.tracks) {
      expect(track.stop).toHaveBeenCalledTimes(1);
    }
  });

  it('exposes the live getUserMedia stream so a caller can attach an analyser tap', async () => {
    const stream = new FakeMediaStream();
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(stream as unknown as MediaStream);

    const recorder = await createVoiceRecorder();

    // The returned recorder must expose the SAME stream instance the
    // recorder ships — attachAnalyserTap composes onto it without a second
    // getUserMedia grant.
    expect(recorder.stream).toBe(stream as unknown as MediaStream);
    await recorder.stop();
  });

  it('start → dataavailable → stop yields a blob containing the recorded chunks', async () => {
    const recorder = await createVoiceRecorder();
    const fake = FakeMediaRecorder.lastInstance!;

    // Simulate the UA firing ondataavailable with a chunk mid-recording.
    const chunk = new Blob(['hello-audio'], { type: 'audio/mp4' });
    fake.ondataavailable?.({ data: chunk } as unknown as BlobEvent);

    const result = await recorder.stop();
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.size).toBe(chunk.size);
    expect(result.mime).toBe('audio/mp4');
  });
});
