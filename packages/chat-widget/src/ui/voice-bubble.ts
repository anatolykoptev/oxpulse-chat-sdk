/**
 * voice-bubble.ts — vanilla render shell over @oxpulse/voice-core's headless
 * player + static waveform renderer.
 *
 * Replaces the bare `<audio controls>` the widget previously rendered for
 * audio attachments (message-list.ts) and the native `<audio>` preview in the
 * composer. The shell OWNS the `<audio>` element (ADR-3: constructor-injection
 * — the shell creates/mounts/a11y, the controller reads/writes the ref) and
 * wires the player's `source` to the widget's EXISTING authenticated blob
 * loader (`hydrateMediaSrc` contract: hydrate(url, signal) → Blob). The player
 * never sees a raw attachment URL on the authed path — `source.load()` fetches
 * through hydrate, mints the objectURL, and hands the URL back to the player,
 * which sets `audio.src` and revokes it on `destroy()`.
 *
 * The widget supplies its OWN WaveformTheme built from its tokens (active from
 * `--oxp-accent`, inactive a low-alpha neutral) — voice-core's app-neutral
 * defaultWaveformTheme is deliberately NOT used so the waveform matches the
 * brand accent, not a generic currentColor.
 *
 * Blob-URL lifecycle (issue #67/#77/#82/#88 leak class): the objectURL the
 * `load` adapter mints is tracked via `trackObjectUrl` (so the widget's
 * eviction/destroy backstop can revoke it if the bubble's own destroy() is
 * missed) AND the player's `destroy()` revokes the URL it set as `audio.src`.
 * The caller MUST call `destroy()` on row eviction + widget destroy; double
 * revoke is idempotent.
 */

import {
  createVoicePlayer,
  renderStaticWaveform,
  xToProgress,
  nextSpeed,
  VOICE_SPEEDS,
  type VoicePlayer,
  type VoicePlayerState,
  type WaveformTheme,
  type VoiceSpeed,
  type VoiceSource,
} from '@oxpulse/voice-core';
import { formatDuration } from '../utils/list-helpers.js';
import type { AttachmentMeta } from '../utils/attachments.js';

/** Low-alpha neutral for unplayed waveform bars — independent of brand accent. */
const INACTIVE_BAR = 'rgba(128,128,128,0.28)';
/** Fallback accent when --oxp-accent cannot be resolved from computed style
 *  (e.g. jsdom test environment, or a host that overrode the theme tokens). */
const FALLBACK_ACCENT = '#0088cc';
/** Flat fallback waveform — a uniform low amplitude when no peaks are present. */
const FLAT_FALLBACK_PEAKS = new Array<number>(48).fill(0.12);

export interface VoiceBubbleOptions {
  /** The attachment metadata (url, mime, durationMs, peaks). */
  readonly att: AttachmentMeta;
  /** Authenticated blob loader — the GET /api/sdk/attachments/{id} route is
   *  JWT-authenticated. When present, the player sources audio through it
   *  (NEVER a raw attachment URL). When absent, falls back to the direct URL
   *  (test/mock environments — mirrors hydrateMediaSrc's no-hydrate branch). */
  readonly hydrate?: (url: string, signal?: AbortSignal) => Promise<Blob>;
  /** In-memory Blob source — used by the composer voice preview where the
   *  recording is already in memory (no fetch needed). The headless player
   *  creates + owns the objectURL from the Blob directly and revokes it on
   *  destroy(). Takes precedence over hydrate/att.url when present. */
  readonly blob?: Blob;
  /** Records any blob: URL the load adapter mints, so the widget's
   *  eviction/destroy backstop can revoke it. */
  readonly trackObjectUrl?: (url: string) => void;
  /** Abort signal — aborts an in-flight hydrate before .src is set. */
  readonly signal?: AbortSignal;
  /** Optional aria-label override for the play/pause button. */
  readonly ariaLabel?: string;
}

export interface VoiceBubble {
  /** The wrapper element to append into the bubble. */
  readonly el: HTMLElement;
  /** Tear down: destroy the player (revokes its objectURL) + null handlers.
   *  Idempotent. MUST be called on row eviction + widget destroy. */
  destroy(): void;
}

/** Resolve the brand accent color from the widget's --oxp-accent token.
 *  Canvas2D fillStyle does not resolve CSS custom properties, so the live
 *  computed value is read here. Falls back to FALLBACK_ACCENT when resolution
 *  yields nothing (jsdom / overridden tokens). */
function resolveAccent(el: HTMLElement): string {
  if (typeof window === 'undefined' || typeof getComputedStyle === 'undefined') {
    return FALLBACK_ACCENT;
  }
  try {
    const v = getComputedStyle(el).getPropertyValue('--oxp-accent').trim();
    return v || FALLBACK_ACCENT;
  } catch {
    return FALLBACK_ACCENT;
  }
}

/** Build a vanilla VoiceBubble over the headless player + static waveform. */
export function createVoiceBubble(opts: VoiceBubbleOptions): VoiceBubble {
  const att = opts.att;
  const hydrate = opts.hydrate;
  const signal = opts.signal;

  const wrap = document.createElement('div');
  wrap.className = 'oxp-voice-bubble';
  wrap.setAttribute('role', 'group');

  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  // Kept in the DOM (hidden) so the headless player can read/write it; the
  // shell owns the element per ADR-3. The native controls are NOT shown — the
  // play/pause + speed + seek affordances below replace them.
  audio.hidden = true;

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'oxp-voice-bubble-play';
  playBtn.setAttribute('aria-label', opts.ariaLabel ?? 'Play voice message');
  playBtn.textContent = '▶';

  const canvas = document.createElement('canvas');
  canvas.className = 'oxp-voice-bubble-waveform';
  canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-label', 'Voice waveform — click to seek');
  canvas.setAttribute('aria-valuemin', '0');
  canvas.setAttribute('aria-valuemax', '100');
  // Sized via CSS classes in theme.ts; give a concrete fallback so jsdom +
  // pre-layout paint don't degenerate to 0×0.
  canvas.width = 220;
  canvas.height = 36;

  const speedBtn = document.createElement('button');
  speedBtn.type = 'button';
  speedBtn.className = 'oxp-voice-bubble-speed';
  speedBtn.setAttribute('aria-label', 'Playback speed');
  speedBtn.textContent = '1×';

  const durEl = document.createElement('span');
  durEl.className = 'oxp-attachment-audio-duration';
  durEl.textContent = formatDuration(att.durationMs ?? 0);

  wrap.appendChild(playBtn);
  wrap.appendChild(canvas);
  wrap.appendChild(speedBtn);
  wrap.appendChild(durEl);
  wrap.appendChild(audio);

  // ── Source: Blob (composer preview) > authed loader > direct URL fallback ──
  const source: VoiceSource =
    opts.blob
      ? opts.blob // player creates + owns the objectURL, revokes on destroy
      : hydrate
        ? { load: async (): Promise<string> => {
            const blob = await hydrate(att.url, signal);
            if (signal?.aborted) {
              // Abort mid-flight: still return a URL so the player's load
              // promise resolves (the player checks `destroyed` before setting
              // .src and revokes a blob: URL it never assigned). Revoke here to
              // avoid leaking the aborted-fetch blob.
              const u = URL.createObjectURL(blob);
              URL.revokeObjectURL(u);
              return u;
            }
            const objectUrl = URL.createObjectURL(blob);
            opts.trackObjectUrl?.(objectUrl);
            return objectUrl;
          } }
        : att.url; // no-hydrate fallback (test/mock) — mirrors hydrateMediaSrc

  const player: VoicePlayer = createVoicePlayer({
    audio,
    source,
    durationMs: att.durationMs,
  });

  const peaks: ReadonlyArray<number> =
    att.peaks && att.peaks.length > 0 ? att.peaks : FLAT_FALLBACK_PEAKS;

  let accent = resolveAccent(canvas);
  let theme: WaveformTheme = { active: accent, inactive: INACTIVE_BAR };

  function paint(state: VoicePlayerState): void {
    // Re-resolve accent lazily on first paint in case the canvas wasn't laid
    // out at construction (shadow root CSS applied after mount).
    if (accent === FALLBACK_ACCENT) {
      const resolved = resolveAccent(canvas);
      if (resolved !== FALLBACK_ACCENT) {
        accent = resolved;
        theme = { active: accent, inactive: INACTIVE_BAR };
      }
    }
    renderStaticWaveform(canvas, peaks, state.progress01, theme);
    canvas.setAttribute('aria-valuenow', String(Math.round(state.progress01 * 100)));
  }

  function speedLabel(s: VoiceSpeed): string {
    return `${s}×`;
  }

  // Track the latest state so the speed button can read the current speed
  // without re-subscribing (the player exposes no getState()).
  let lastSpeed: VoiceSpeed = 1;

  const unsubscribe = player.subscribe((state) => {
    lastSpeed = state.speed;
    playBtn.textContent = state.phase === 'playing' ? '⏸' : '▶';
    playBtn.setAttribute('aria-pressed', String(state.phase === 'playing'));
    speedBtn.textContent = speedLabel(state.speed);
    if (state.durationMs > 0) {
      durEl.textContent = formatDuration(state.durationMs);
    }
    paint(state);
  });

  const onPlay = (): void => { void player.toggle(); };
  const onSeek = (ev: MouseEvent): void => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const progress = xToProgress(x, rect.width || canvas.clientWidth);
    player.seek(progress);
  };
  const onSpeed = (): void => { player.setSpeed(nextSpeed(lastSpeed)); };

  playBtn.addEventListener('click', onPlay);
  canvas.addEventListener('click', onSeek);
  speedBtn.addEventListener('click', onSpeed);

  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    player.destroy();
    playBtn.removeEventListener('click', onPlay);
    canvas.removeEventListener('click', onSeek);
    speedBtn.removeEventListener('click', onSpeed);
  }

  return { el: wrap, destroy };
}

/** Exported so tests can assert the speed cycle without importing voice-core's
 *  internal ordering. Matches VOICE_SPEEDS. */
export const VOICE_BUBBLE_SPEEDS = VOICE_SPEEDS;
