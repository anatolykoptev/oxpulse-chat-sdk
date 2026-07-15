/** @oxpulse/voice-core — tap-less voice capture core. */

/** Maximum voice recording duration in milliseconds. */
export const MAX_VOICE_MS = 60_000;

/** Maximum voice blob size that will be accepted for sending.
 *  4 MB leaves comfortable headroom below the sealed-frame ceiling. */
export const MAX_VOICE_BYTES = 4_000_000;

/** Result produced when the user finishes a recording. */
export interface VoiceRecorderResult {
  /** The raw audio Blob (audio/mp4 or audio/webm depending on codec). */
  readonly blob: Blob;
  /** data: URL of the blob — useful for consumers that inline the audio on the wire. */
  readonly dataUrl: string;
  /** Actual recording duration in milliseconds. */
  readonly durationMs: number;
  /** MIME type of the blob (e.g. "audio/webm;codecs=opus"). */
  readonly mime: string;
  /** Downsampled waveform peaks (length ≤ MAX_VOICE_PEAKS, [0,1]).
   *  Empty when no extractPeaks callback is injected or decode fails. */
  readonly peaks: ReadonlyArray<number>;
}

/** Validate a voice blob against the wire policy. Pure — takes only the
 *  fields it needs so tests can pass a plain { size } object. */
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

/** Live recording controller returned by `createVoiceRecorder`. */
export interface VoiceRecorder {
  /** Stop recording and resolve the result. Idempotent. */
  stop(): Promise<VoiceRecorderResult>;
  /** Discard the recording without producing a result. Idempotent. */
  cancel(): void;
  /** Returns elapsed recording time in milliseconds. */
  durationMs(): number;
  /** The live microphone MediaStream backing this recording. Exposed so a
   *  caller can compose {@link attachAnalyserTap} onto the SAME stream the
   *  recorder ships — driving a live composer waveform without a second
   *  getUserMedia grant. The recorder stops these tracks on stop()/cancel();
   *  a tap MUST close its AudioContext (tap.stop()) BEFORE that happens. */
  readonly stream: MediaStream;
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

/** Pick the best supported MIME type for MediaRecorder.
 *
 *  Cross-browser playback is the constraint. audio/mp4 (AAC) is the
 *  only container that decodes on every desktop and mobile browser
 *  in 2026 — Safari can't play audio/webm/opus from a Chrome sender,
 *  so a Chrome→Safari voice message looked dead before this change.
 *  Order: mp4 first (universal playback), webm/opus second (smaller
 *  but Chrome/Firefox-only), bare webm last. Some Linux Chrome
 *  builds expose recording for opus only — they fall through. */
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

/** Acquire a microphone stream and start recording.
 *
 *  Throws if getUserMedia is unavailable or permission is denied — the
 *  caller catches and surfaces the error. */
export async function createVoiceRecorder(
  extractPeaks?: (blob: Blob) => Promise<ReadonlyArray<number>>,
  opts?: {
    /** Called when the internal MAX_VOICE_MS cap is hit, BEFORE the recorder
     *  stops its own tracks. Lets the caller tear down in order (e.g. close an
     *  analyser-tap AudioContext before the MediaStream tracks stop). The
     *  caller is expected to call stop()/cancel() synchronously; a guarded
     *  self-stop is the safety net if it doesn't. */
    onAutoStop?: () => void;
  },
): Promise<VoiceRecorder> {
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
  let stopping = false;

  function stopStream(): void {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }

  const autoStopTimer = setTimeout(() => {
    if (resolved || cancelFlag || stopping) return;
    // Let the caller close its own resources (e.g. an analyser tap) in the
    // correct order first; it should call stop()/cancel() synchronously.
    opts?.onAutoStop?.();
    // Safety net: if the caller did not stop/cancel, cap the recording here.
    if (!stopping && !cancelFlag) {
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
        const dataUrl = await readBlobAsDataUrl(blob);
        let peaks: ReadonlyArray<number> = [];
        if (extractPeaks) {
          try {
            peaks = await extractPeaks(blob);
          } catch {
            peaks = [];
          }
        }
        resolved = true;
        resolve({ blob, dataUrl, durationMs, mime: blob.type, peaks });
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
      stopping = true;
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
      if (resolved || cancelFlag || stopping) return;
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

    stream,
  };
}
