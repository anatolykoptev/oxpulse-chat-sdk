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
 * `--oxp-accent`, inactive from `--oxp-waveform-inactive` — a WCAG 1.4.11
 * audited token with separate light/dark values) — voice-core's app-neutral
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
  FLAT_FALLBACK_PEAKS,
  type VoicePlayer,
  type VoicePlayerState,
  type WaveformTheme,
  type VoiceSpeed,
  type VoiceSource,
} from '@oxpulse/voice-core';
import { formatDuration } from '../utils/list-helpers.js';
import { t, type Locale } from '../utils/i18n.js';
import type { AttachmentMeta } from '../utils/attachments.js';

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
  /** Locale for i18n ARIA strings (play/pause/speed/waveform/error). */
  readonly lang: Locale;
}

export interface VoiceBubble {
  /** The wrapper element to append into the bubble. */
  readonly el: HTMLElement;
  /** Tear down: destroy the player (revokes its objectURL) + null handlers.
   *  Idempotent. MUST be called on row eviction + widget destroy. */
  destroy(): void;
}

/** Resolve a CSS custom property from the canvas's computed style, falling
 *  back to the shadow host's computed style (the token is defined on :host).
 *  Returns '' when unavailable (jsdom / overridden tokens). Canvas2D fillStyle
 *  does not resolve CSS custom properties, so the live computed value is read
 *  here. */
export function resolveToken(el: HTMLElement, token: string): string {
  if (typeof window === 'undefined' || typeof getComputedStyle === 'undefined') {
    return '';
  }
  try {
    const v = getComputedStyle(el).getPropertyValue(token).trim();
    if (v) return v;
    // Fall back to the shadow host — :host is where the widget defines tokens.
    const root = el.getRootNode();
    if (root instanceof ShadowRoot && root.host) {
      const hv = getComputedStyle(root.host).getPropertyValue(token).trim();
      if (hv) return hv;
    }
  } catch {
    /* jsdom / overridden tokens — return '' */
  }
  return '';
}

/** Build a vanilla VoiceBubble over the headless player + static waveform. */
export function createVoiceBubble(opts: VoiceBubbleOptions): VoiceBubble {
  const att = opts.att;
  const hydrate = opts.hydrate;
  const signal = opts.signal;
  const lang = opts.lang;

  const wrap = document.createElement('div');
  wrap.className = 'oxp-voice-bubble';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', t('voiceBubbleGroupAria', lang));

  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  // Kept in the DOM (hidden) so the headless player can read/write it; the
  // shell owns the element per ADR-3. The native controls are NOT shown — the
  // play/pause + speed + seek affordances below replace them.
  audio.hidden = true;

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'oxp-voice-bubble-play';
  playBtn.setAttribute('aria-label', t('voicePlayAria', lang));
  playBtn.textContent = '▶';

  const canvas = document.createElement('canvas');
  canvas.className = 'oxp-voice-bubble-waveform';
  canvas.setAttribute('role', 'slider');
  canvas.setAttribute('aria-label', t('voiceWaveformSeekAria', lang));
  canvas.setAttribute('aria-valuemin', '0');
  canvas.setAttribute('aria-valuemax', '100');
  canvas.setAttribute('aria-valuenow', '0');
  // Keyboard-operable slider — Canvas2D has no native keyboard interaction.
  canvas.tabIndex = 0;
  // CSS controls the rendered size (width:100%, max-width:220px, height:36px);
  // renderStaticWaveform sets the backing-store from clientWidth × DPR. Give a
  // concrete fallback so jsdom + pre-layout paint don't degenerate to 0×0.
  canvas.width = 220;
  canvas.height = 36;

  const speedBtn = document.createElement('button');
  speedBtn.type = 'button';
  speedBtn.className = 'oxp-voice-bubble-speed';
  speedBtn.setAttribute('aria-label', t('voiceSpeedAria', lang));
  speedBtn.textContent = '1×';

  const durEl = document.createElement('span');
  durEl.className = 'oxp-attachment-audio-duration';
  durEl.textContent = formatDuration(att.durationMs ?? 0);

  // aria-live region for error announcements (screen-reader-only).
  const errorEl = document.createElement('span');
  errorEl.className = 'oxp-voice-bubble-error';
  errorEl.setAttribute('aria-live', 'assertive');
  errorEl.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);';

  wrap.appendChild(playBtn);
  wrap.appendChild(canvas);
  wrap.appendChild(speedBtn);
  wrap.appendChild(durEl);
  wrap.appendChild(errorEl);
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

  // Resolve theme tokens from the widget's CSS custom properties. Active from
  // --oxp-accent, inactive from --oxp-waveform-inactive (WCAG 1.4.11 audited).
  // Fallbacks: active → 'currentColor' (Canvas2D resolves it to the inherited
  //   color); inactive → 'rgba(0,0,0,0.55)' (the widget's light default for
  //   --oxp-waveform-inactive, used only in jsdom / pre-CSS-layout).
  const INACTIVE_FALLBACK = 'rgba(0,0,0,0.55)';
  let accent = resolveToken(canvas, '--oxp-accent') || 'currentColor';
  let inactive = resolveToken(canvas, '--oxp-waveform-inactive') || INACTIVE_FALLBACK;
  let theme: WaveformTheme = { active: accent, inactive };

  function paint(state: VoicePlayerState): void {
    // Re-resolve tokens lazily on first paint in case the canvas wasn't laid
    // out at construction (shadow root CSS applied after mount).
    if (accent === 'currentColor') {
      const resolved = resolveToken(canvas, '--oxp-accent');
      if (resolved) {
        accent = resolved;
        theme = { active: accent, inactive };
      }
    }
    if (inactive === INACTIVE_FALLBACK) {
      const resolved = resolveToken(canvas, '--oxp-waveform-inactive');
      if (resolved) {
        inactive = resolved;
        theme = { active: accent, inactive };
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
  let lastPhase: VoicePlayerState['phase'] = 'idle';

  const unsubscribe = player.subscribe((state) => {
    lastSpeed = state.speed;
    lastPhase = state.phase;
    if (state.phase === 'error') {
      // Distinct error affordance: disable play, announce via aria-live.
      playBtn.disabled = true;
      playBtn.setAttribute('aria-label', t('voicePlaybackErrorAria', lang));
      playBtn.textContent = '⚠';
      speedBtn.disabled = true;
      errorEl.textContent = t('voicePlaybackErrorAria', lang);
    } else {
      playBtn.disabled = false;
      speedBtn.disabled = false;
      errorEl.textContent = '';
      playBtn.textContent = state.phase === 'playing' ? '⏸' : '▶';
      playBtn.setAttribute('aria-pressed', String(state.phase === 'playing'));
      playBtn.setAttribute(
        'aria-label',
        state.phase === 'playing'
          ? t('voicePauseAria', lang)
          : t('voicePlayAria', lang),
      );
    }
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

  // Keyboard seek — role="slider" MUST be keyboard-operable (WCAG 2.1.1).
  // ArrowLeft/Right = ±5%, PageUp/Down = ±10%, Home/End = 0/100%.
  const onKeydown = (ev: KeyboardEvent): void => {
    if (lastPhase === 'error') return;
    const step = 0.05;
    const bigStep = 0.10;
    let next: number | null = null;
    switch (ev.key) {
      case 'ArrowLeft':  next = Math.max(0, currentProgress() - step); break;
      case 'ArrowRight': next = Math.min(1, currentProgress() + step); break;
      case 'PageDown':   next = Math.max(0, currentProgress() - bigStep); break;
      case 'PageUp':     next = Math.min(1, currentProgress() + bigStep); break;
      case 'Home':       next = 0; break;
      case 'End':        next = 1; break;
      default: return; // don't preventDefault for unrelated keys
    }
    ev.preventDefault();
    player.seek(next);
  };

  /** Read the current progress from the slider's aria-valuenow (set by paint). */
  function currentProgress(): number {
    const raw = canvas.getAttribute('aria-valuenow');
    const n = raw ? Number(raw) : 0;
    return Number.isFinite(n) ? n / 100 : 0;
  }

  playBtn.addEventListener('click', onPlay);
  canvas.addEventListener('click', onSeek);
  canvas.addEventListener('keydown', onKeydown);
  speedBtn.addEventListener('click', onSpeed);

  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    player.destroy();
    playBtn.removeEventListener('click', onPlay);
    canvas.removeEventListener('click', onSeek);
    canvas.removeEventListener('keydown', onKeydown);
    speedBtn.removeEventListener('click', onSpeed);
  }

  return { el: wrap, destroy };
}

/** Exported so tests can assert the speed cycle without importing voice-core's
 *  internal ordering. Matches VOICE_SPEEDS. */
export const VOICE_BUBBLE_SPEEDS = VOICE_SPEEDS;
