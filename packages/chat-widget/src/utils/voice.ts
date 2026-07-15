/**
 * @oxpulse/chat-widget — Voice recording helpers (P0).
 *
 * Ported from web/src/lib/chat/voice/voice.ts with the live waveform/peak
 * tap removed for this phase. Wraps MediaRecorder + getUserMedia with the
 * same production-hardened quirks:
 *   • mp4/AAC-first MIME negotiation (universal playback in 2026).
 *   • 60 s hard cap + 4 MB blob validation.
 *   • MediaRecorder timeslice 100 ms.
 *   • requestData() flush before recorder.stop() (Android/WebKit quirk).
 *   • iOS webkitAudioContext fallback.
 */

export const MAX_VOICE_MS = 60_000;
export const MAX_VOICE_BYTES = 4_000_000;

export interface VoiceRecorderResult {
  blob: Blob;
  durationMs: number;
  mime: string;
}

export type ValidateVoiceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function validateVoiceBlob(
  blob: { readonly size: number; readonly durationMs?: number },
): ValidateVoiceResult {
  if (blob.size <= 0) {
    return { ok: false, reason: 'Empty recording' };
  }
  if (blob.size > MAX_VOICE_BYTES) {
    return { ok: false, reason: 'Recording too large — 4 MB max' };
  }
  if (typeof blob.durationMs === 'number') {
    if (blob.durationMs <= 0) {
      return { ok: false, reason: 'Empty recording' };
    }
    if (blob.durationMs > MAX_VOICE_MS) {
      return { ok: false, reason: 'Recording too long — 60s max' };
    }
  }
  return { ok: true };
}

export function pickMime(): string {
  const candidates = [
    'audio/mp4',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/webm;codecs=opus',
    'audio/webm',
  ];
  for (const mime of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return '';
}

export interface VoiceRecorder {
  stop(): Promise<VoiceRecorderResult>;
  cancel(): void;
  durationMs(): number;
}

export async function createVoiceRecorder(): Promise<VoiceRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const mime = pickMime();
  const recorder = mime
    ? new MediaRecorder(stream, { mimeType: mime })
    : new MediaRecorder(stream);

  const chunks: Blob[] = [];
  recorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size > 0) chunks.push(ev.data);
  };

  const startTs = Date.now();
  recorder.start(100);

  let resolved = false;
  let cancelFlag = false;

  function stopStream(): void {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  const autoStopTimer = setTimeout(() => {
    if (!resolved && !cancelFlag) {
      recorder.stop();
    }
  }, MAX_VOICE_MS);

  const resultPromise = new Promise<VoiceRecorderResult>((resolve, reject) => {
    recorder.onstop = async () => {
      clearTimeout(autoStopTimer);
      stopStream();
      if (cancelFlag) {
        return;
      }
      const durationMs = Date.now() - startTs;
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || mime });
        resolve({ blob, durationMs, mime: blob.type });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    recorder.onerror = (ev) => {
      clearTimeout(autoStopTimer);
      stopStream();
      const errMsg =
        (ev as Event & { error?: { message?: string } }).error?.message ??
        'MediaRecorder error';
      reject(new Error(errMsg));
    };
  });

  return {
    stop(): Promise<VoiceRecorderResult> {
      if (!resolved && !cancelFlag && recorder.state !== 'inactive') {
        try {
          recorder.requestData();
        } catch {
          // not all UA versions implement requestData
        }
        recorder.stop();
      }
      return resultPromise;
    },

    cancel(): void {
      if (resolved || cancelFlag) return;
      cancelFlag = true;
      clearTimeout(autoStopTimer);
      if (recorder.state !== 'inactive') {
        recorder.onstop = () => {
          stopStream();
        };
        recorder.stop();
      } else {
        stopStream();
      }
    },

    durationMs(): number {
      return Date.now() - startTs;
    },
  };
}
