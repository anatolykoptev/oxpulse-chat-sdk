/** @oxpulse/voice-core — headless voice player controller. */

export const VOICE_SPEEDS = [1, 1.5, 2] as const;
export type VoiceSpeed = (typeof VOICE_SPEEDS)[number];

const SPEED_STORAGE_KEY = 'oxpulse:voice-speed';

function isVoiceSpeed(n: number): n is VoiceSpeed {
  return (VOICE_SPEEDS as ReadonlyArray<number>).includes(n);
}

export function loadStoredSpeed(): VoiceSpeed {
  if (typeof sessionStorage === 'undefined') return 1;
  const raw = sessionStorage.getItem(SPEED_STORAGE_KEY);
  const n = raw === null ? NaN : Number(raw);
  return isVoiceSpeed(n) ? n : 1;
}

export function persistSpeed(s: VoiceSpeed): void {
  if (typeof sessionStorage === 'undefined') return;
  try { sessionStorage.setItem(SPEED_STORAGE_KEY, String(s)); }
  catch { /* quota / private mode — silent */ }
}

export function nextSpeed(curr: VoiceSpeed): VoiceSpeed {
  const idx = VOICE_SPEEDS.indexOf(curr);
  return VOICE_SPEEDS[(idx + 1) % VOICE_SPEEDS.length] ?? 1;
}

/** Apply a playback rate with preservesPitch set to true.
 *  iOS Safari + Android Chrome briefly stall decoding when
 *  playbackRate flips while paused-to-play transitions overlap.
 *  preservesPitch prevents the sample-rate quirk that some WebKit
 *  builds use as a fallback. The vendor prefix covers older WebKit. */
export function applyRate(el: HTMLAudioElement, rate: number): void {
  const a = el as HTMLAudioElement & { preservesPitch?: boolean; webkitPreservesPitch?: boolean };
  try { a.preservesPitch = true; } catch { /* readonly in some UA */ }
  try { a.webkitPreservesPitch = true; } catch { /* not supported */ }
  el.playbackRate = rate;
}

export type VoiceSource =
  | string
  | Blob
  | { load: () => Promise<string> };

export interface VoicePlayerOptions {
  /** The shell can provide the <audio> element; otherwise a detached one is created. */
  readonly audio?: HTMLAudioElement;
  /** Audio source: pass-through URL, a Blob, or an authenticated loader that returns the URL. */
  readonly source: VoiceSource;
  /** Optional fallback duration when the <audio> element cannot decode one. */
  readonly durationMs?: number;
  /** Optional initial speed; defaults to the persisted value or 1. */
  readonly speed?: VoiceSpeed;
}

export interface VoicePlayerState {
  readonly phase: 'idle' | 'playing' | 'paused' | 'ended' | 'error';
  readonly progress01: number;
  readonly currentMs: number;
  readonly durationMs: number;
  readonly speed: VoiceSpeed;
}

export interface VoicePlayer {
  play(): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  seek(progress01: number): void;
  setSpeed(rate: VoiceSpeed): void;
  destroy(): void;
  subscribe(listener: (state: VoicePlayerState) => void): () => void;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function createVoicePlayer(options: VoicePlayerOptions): VoicePlayer {
  const audio: HTMLAudioElement =
    options.audio ??
    (typeof document !== 'undefined' ? document.createElement('audio') : undefined as unknown as HTMLAudioElement);

  if (!audio) {
    throw new Error('createVoicePlayer requires an audio element or a DOM environment');
  }

  audio.preload = 'metadata';

  const source = options.source;
  let sourceType: 'string' | 'blob' | 'load';
  let loadPromise: Promise<void> = Promise.resolve();
  let durationMs = Number.isFinite(options.durationMs) && (options.durationMs ?? 0) > 0
    ? options.durationMs!
    : 0;
  let speed: VoiceSpeed = options.speed ?? loadStoredSpeed();
  let phase: VoicePlayerState['phase'] = 'idle';
  let destroyed = false;
  const listeners = new Set<(state: VoicePlayerState) => void>();

  applyRate(audio, speed);

  if (typeof source === 'string') {
    sourceType = 'string';
    audio.src = source;
  } else if (source instanceof Blob) {
    sourceType = 'blob';
    audio.src = URL.createObjectURL(source);
  } else {
    sourceType = 'load';
    loadPromise = source.load().then((url) => {
      if (!destroyed) audio.src = url;
    }).catch(() => {
      if (!destroyed) setPhase('error');
    });
  }

  function getState(): VoicePlayerState {
    const currentMs = Math.max(0, audio.currentTime * 1000);
    const progress01 = durationMs > 0 ? clamp01(currentMs / durationMs) : 0;
    return { phase, progress01, currentMs, durationMs, speed };
  }

  function notify(): void {
    const state = getState();
    for (const listener of listeners) {
      listener(state);
    }
  }

  function setPhase(next: VoicePlayerState['phase']): void {
    phase = next;
    notify();
  }

  function onPlay(): void {
    setPhase('playing');
  }

  function onPause(): void {
    setPhase(audio.ended ? 'ended' : 'paused');
  }

  function onEnded(): void {
    audio.currentTime = 0;
    setPhase('ended');
  }

  function onLoadedMetadata(): void {
    const d = audio.duration;
    if (Number.isFinite(d) && d > 0) {
      durationMs = Math.round(d * 1000);
    }
    notify();
  }

  function onTimeUpdate(): void {
    notify();
  }

  function onError(): void {
    setPhase('error');
  }

  audio.onplay = onPlay;
  audio.onpause = onPause;
  audio.onended = onEnded;
  audio.onloadedmetadata = onLoadedMetadata;
  audio.ontimeupdate = onTimeUpdate;
  audio.onerror = onError;

  async function play(): Promise<void> {
    if (destroyed) return;
    await loadPromise;
    if (destroyed) return;
    applyRate(audio, speed);
    if (audio.ended) {
      audio.currentTime = 0;
    }
    try {
      await audio.play();
    } catch {
      setPhase('error');
    }
  }

  function pause(): void {
    if (!audio.paused) {
      audio.pause();
    }
  }

  async function toggle(): Promise<void> {
    if (phase === 'playing') {
      pause();
    } else {
      await play();
    }
  }

  function seek(progress01: number): void {
    const frac = clamp01(progress01);
    let targetMs: number;
    if (durationMs > 0) {
      targetMs = frac * durationMs;
    } else if (Number.isFinite(audio.duration) && audio.duration > 0) {
      targetMs = frac * audio.duration * 1000;
    } else {
      return;
    }
    const targetSec = targetMs / 1000;
    if (Number.isFinite(targetSec)) {
      audio.currentTime = targetSec;
      notify();
    }
  }

  function setSpeed(rate: VoiceSpeed): void {
    speed = isVoiceSpeed(rate) ? rate : 1;
    applyRate(audio, speed);
    persistSpeed(speed);
    notify();
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    try { audio.pause(); } catch { /* ignore */ }

    // Revoke any blob: URL that is currently set as src. The player created it
    // for Blob sources and took ownership of the loader result for { load } sources.
    const src = audio.src;
    if (src && src.startsWith('blob:') && sourceType !== 'string') {
      try { URL.revokeObjectURL(src); } catch { /* ignore */ }
    }
    audio.src = '';

    audio.onplay = null;
    audio.onpause = null;
    audio.onended = null;
    audio.onloadedmetadata = null;
    audio.ontimeupdate = null;
    audio.onerror = null;

    listeners.clear();
  }

  function subscribe(listener: (state: VoicePlayerState) => void): () => void {
    listeners.add(listener);
    listener(getState());
    return () => {
      listeners.delete(listener);
    };
  }

  return { play, pause, toggle, seek, setSpeed, destroy, subscribe };
}
