import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVoiceRecorder } from '../recorder.ts';

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

  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = 'audio/mp4';
  ondataavailable: ((ev: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? 'audio/mp4';
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
});
