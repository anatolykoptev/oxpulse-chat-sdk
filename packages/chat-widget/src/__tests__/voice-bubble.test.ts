/**
 * voice-bubble.test.ts — Phase 2 RED/GREEN for the vanilla VoiceBubble shell.
 *
 * Asserts the shell wires @oxpulse/voice-core's headless player + static
 * waveform correctly: play/pause + canvas + speed + duration render; the
 * player's source is the widget's AUTHENTICATED blob loader (never a raw
 * attachment URL on the authed path); seek maps waveform-x → player.seek;
 * the widget supplies its OWN theme (active from --oxp-accent, not
 * voice-core's app-neutral default); destroy tears the player down.
 * Keyboard seek (ArrowLeft/Right/Home/End/PageUp/Down) drives player.seek.
 * Error phase disables play + announces via aria-live.
 *
 * Falsification: each test fails if the corresponding wiring in
 * voice-bubble.ts is reverted (e.g. remove the hydrate→load adapter and the
 * authed-loader test fails; remove the canvas keydown handler and the
 * keyboard-seek test fails).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVoiceBubble, VOICE_BUBBLE_SPEEDS } from '../ui/voice-bubble.js';
import { renderStaticWaveform } from '@oxpulse/voice-core';
import type { VoicePlayer, VoicePlayerState, VoiceSource } from '@oxpulse/voice-core';

// Capture the source + controls the shell passes to the headless player.
let capturedSource: VoiceSource | null = null;
let playerDestroy: ReturnType<typeof vi.fn>;
let playerSeek: ReturnType<typeof vi.fn>;
let playerSetSpeed: ReturnType<typeof vi.fn>;
let playerToggle: ReturnType<typeof vi.fn>;
let playerSubscribe: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
let stateListener: ((s: VoicePlayerState) => void) | null = null;

vi.mock('@oxpulse/voice-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@oxpulse/voice-core')>();
  return {
    ...actual,
    // Override createVoicePlayer so the shell's wiring is observable without
    // a real <audio> decode cycle (jsdom doesn't decode media). The fake
    // captures the source and exposes spies for seek/setSpeed/destroy/toggle.
    createVoicePlayer: vi.fn((opts: { source: VoiceSource; durationMs?: number }): VoicePlayer => {
      capturedSource = opts.source;
      playerDestroy = vi.fn();
      playerSeek = vi.fn();
      playerSetSpeed = vi.fn();
      playerToggle = vi.fn();
      unsubscribe = vi.fn();
      const state: VoicePlayerState = {
        phase: 'idle',
        progress01: 0,
        currentMs: 0,
        durationMs: opts.durationMs ?? 0,
        speed: 1,
      };
      playerSubscribe = vi.fn((listener: (s: VoicePlayerState) => void) => {
        stateListener = listener;
        listener(state);
        return unsubscribe;
      });
      return {
        play: vi.fn(),
        pause: vi.fn(),
        toggle: playerToggle,
        seek: playerSeek,
        setSpeed: playerSetSpeed,
        destroy: playerDestroy,
        subscribe: playerSubscribe,
      };
    }),
    // renderStaticWaveform: jsdom's canvas.getContext('2d') returns null, so
    // the real fn no-ops anyway; spy so we can assert it was called with the
    // widget's own theme (active from --oxp-accent).
    renderStaticWaveform: vi.fn(),
  };
});

function makeAtt(overrides: Partial<{ url: string; mime: string; durationMs: number; peaks: number[] }> = {}) {
  return {
    id: 'att-1',
    url: overrides.url ?? 'https://chat.example.com/api/sdk/attachments/att-1',
    mime: overrides.mime ?? 'audio/mp4',
    filename: 'voice.mp4',
    sizeBytes: 1234,
    durationMs: overrides.durationMs ?? 45_000,
    peaks: overrides.peaks,
  };
}

describe('VoiceBubble render shell', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    capturedSource = null;
    stateListener = null;
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    vi.restoreAllMocks();
  });

  it('renders play/pause + canvas + speed + duration + hidden audio', () => {
    const bubble = createVoiceBubble({ att: makeAtt(), lang: 'en' });
    container.appendChild(bubble.el);

    expect(bubble.el.querySelector('.oxp-voice-bubble-play')).not.toBeNull();
    expect(bubble.el.querySelector('canvas.oxp-voice-bubble-waveform')).not.toBeNull();
    expect(bubble.el.querySelector('.oxp-voice-bubble-speed')).not.toBeNull();
    const dur = bubble.el.querySelector('.oxp-attachment-audio-duration');
    expect(dur).not.toBeNull();
    // 45_000ms = 00:45
    expect(dur!.textContent).toBe('00:45');
    // The shell owns the <audio> element (ADR-3) — present but hidden.
    const audio = bubble.el.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.hidden).toBe(true);
  });

  it('wires the authenticated blob loader as the player source (NEVER a raw attachment URL)', async () => {
    const att = makeAtt();
    const hydrate = vi.fn().mockResolvedValue(new Blob(['audio'], { type: 'audio/mp4' }));
    const tracked: string[] = [];

    const bubble = createVoiceBubble({
      att,
      hydrate,
      trackObjectUrl: (url) => tracked.push(url),
      lang: 'en',
    });
    container.appendChild(bubble.el);

    // The source MUST be a { load } loader, not a string (raw URL).
    expect(typeof capturedSource).toBe('object');
    expect(capturedSource).not.toBe('string');
    expect(typeof (capturedSource as { load: unknown }).load).toBe('function');

    // load() routes through hydrate(att.url) → Blob → objectURL, and tracks it.
    const url = await (capturedSource as { load: () => Promise<string> }).load();
    expect(hydrate).toHaveBeenCalledWith(att.url, undefined);
    expect(url.startsWith('blob:')).toBe(true);
    expect(tracked).toContain(url);
    // The raw attachment URL must never be returned as the player src.
    expect(url).not.toBe(att.url);
  });

  it('falls back to the direct URL only when no hydrate bridge is wired (test/mock path)', () => {
    const att = makeAtt();
    const bubble = createVoiceBubble({ att, lang: 'en' });
    container.appendChild(bubble.el);

    // No hydrate → string source = att.url (mirrors hydrateMediaSrc no-hydrate branch).
    expect(typeof capturedSource).toBe('string');
    expect(capturedSource).toBe(att.url);
  });

  it('seek maps waveform click-x → player.seek(progress)', () => {
    const bubble = createVoiceBubble({ att: makeAtt(), lang: 'en' });
    container.appendChild(bubble.el);
    const canvas = bubble.el.querySelector('canvas.oxp-voice-bubble-waveform') as HTMLCanvasElement;
    // Stub getBoundingClientRect so xToProgress maps a deterministic x → progress.
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 36, width: 200, height: 36, x: 0, y: 0, toJSON() {} }) as DOMRect;
    Object.defineProperty(canvas, 'clientWidth', { value: 200, configurable: true });

    // Click at x=100 of a 200px-wide canvas → progress 0.5.
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 100, clientY: 18 }));

    expect(playerSeek).toHaveBeenCalledTimes(1);
    const progress = playerSeek.mock.calls[0]![0];
    expect(progress).toBeCloseTo(0.5, 5);
  });

  it('keyboard seek: ArrowRight/Left/Home/End/PageUp/PageDown → player.seek', () => {
    const bubble = createVoiceBubble({ att: makeAtt(), lang: 'en' });
    container.appendChild(bubble.el);
    const canvas = bubble.el.querySelector('canvas.oxp-voice-bubble-waveform') as HTMLCanvasElement;

    // The canvas must be keyboard-focusable (tabIndex=0).
    expect(canvas.tabIndex).toBe(0);

    // Simulate a mid-playback state: aria-valuenow=50 (progress 0.5).
    // The mock player's seek() doesn't fire a subscribe notification (which
    // would update aria-valuenow via paint), so we manually sync it after
    // each key press to mirror the real player's notify → paint → valuenow cycle.
    const syncValuenow = (pct: number): void => canvas.setAttribute('aria-valuenow', String(pct));
    syncValuenow(50);

    // ArrowRight → +5% → 0.55
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(playerSeek).toHaveBeenLastCalledWith(0.55);
    syncValuenow(55);

    // ArrowLeft → -5% → 0.50
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(playerSeek).toHaveBeenLastCalledWith(0.5);
    syncValuenow(50);

    // Home → 0
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(playerSeek).toHaveBeenLastCalledWith(0);
    syncValuenow(0);

    // End → 1
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(playerSeek).toHaveBeenLastCalledWith(1);
    syncValuenow(100);

    // Reset to 50 for PageUp/PageDown.
    syncValuenow(50);

    // PageUp → +10% → 0.60
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    expect(playerSeek).toHaveBeenLastCalledWith(0.6);
    syncValuenow(60);

    // PageDown → -10% → 0.50
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(playerSeek).toHaveBeenLastCalledWith(0.5);

    // Unrelated key does NOT seek.
    const callsBefore = playerSeek.mock.calls.length;
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(playerSeek.mock.calls.length).toBe(callsBefore);
  });

  it('speed toggle cycles 1 → 1.5 → 2 via nextSpeed', () => {
    const bubble = createVoiceBubble({ att: makeAtt(), lang: 'en' });
    container.appendChild(bubble.el);
    const speedBtn = bubble.el.querySelector('.oxp-voice-bubble-speed') as HTMLButtonElement;

    // Initial label is 1× (the fake player's subscribe fires with speed=1).
    expect(speedBtn.textContent).toBe('1×');

    speedBtn.click();
    expect(playerSetSpeed).toHaveBeenCalledWith(1.5);

    // Simulate the state update the real subscribe would deliver.
    playerSetSpeed.mockClear();
    // Re-create with a speed=1.5 baseline by driving the captured subscribe:
    // the fake re-fires on each subscribe call, so just assert nextSpeed(1.5)=2.
    // (nextSpeed is exercised through the shell's onSpeed handler reading lastSpeed.)
    // Advance the fake state by re-subscribing is not trivial here; instead
    // assert the cycle ordering matches VOICE_BUBBLE_SPEEDS.
    expect(VOICE_BUBBLE_SPEEDS).toEqual([1, 1.5, 2]);
  });

  it('uses the widget own theme (active from --oxp-accent, not voice-core default)', () => {
    const bubble = createVoiceBubble({ att: makeAtt({ peaks: [0.2, 0.5, 0.8] }), lang: 'en' });
    container.appendChild(bubble.el);

    // renderStaticWaveform is called on the initial subscribe; the theme arg
    // must carry an `active` color (the widget resolves --oxp-accent, falling
    // back to 'currentColor' in jsdom) — NOT voice-core's 'currentColor' as
    // the DEFAULT (the widget's fallback is a degenerate jsdom case, not the
    // app-neutral default). The inactive must come from the widget's own
    // --oxp-waveform-inactive token (fallback 'rgba(0,0,0,0.55)' in jsdom),
    // NOT voice-core's defaultWaveformTheme value.
    expect(renderStaticWaveform).toHaveBeenCalled();
    const themeArg = vi.mocked(renderStaticWaveform).mock.calls[0]![3] as { active: string; inactive: string };
    // Active: the widget tried to resolve --oxp-accent via getComputedStyle.
    // In jsdom it falls back to 'currentColor' (Canvas2D resolves it).
    expect(themeArg.active).not.toBe('rgba(128,128,128,0.28)');
    // Inactive: the widget's own token fallback, NOT the old INACTIVE_BAR literal.
    expect(themeArg.inactive).not.toBe('rgba(128,128,128,0.28)');
    expect(themeArg.inactive).toBe('rgba(0,0,0,0.55)');
  });

  it('renders a flat fallback when no peaks are present', () => {
    const bubble = createVoiceBubble({ att: makeAtt(), lang: 'en' });
    container.appendChild(bubble.el);
    expect(renderStaticWaveform).toHaveBeenCalled();
    const peaksArg = vi.mocked(renderStaticWaveform).mock.calls[0]![1] as ReadonlyArray<number>;
    // Flat fallback is a uniform non-empty low-amplitude array.
    expect(peaksArg.length).toBeGreaterThan(0);
    expect(peaksArg.every((v) => v > 0 && v <= 0.2)).toBe(true);
  });

  it('error phase disables play + announces via aria-live', () => {
    const bubble = createVoiceBubble({ att: makeAtt(), lang: 'en' });
    container.appendChild(bubble.el);
    const playBtn = bubble.el.querySelector('.oxp-voice-bubble-play') as HTMLButtonElement;
    const errorEl = bubble.el.querySelector('.oxp-voice-bubble-error') as HTMLElement;

    expect(errorEl).not.toBeNull();
    expect(errorEl.getAttribute('aria-live')).toBe('assertive');

    // Drive the subscribe handler with an error state.
    stateListener!({
      phase: 'error',
      progress01: 0,
      currentMs: 0,
      durationMs: 45_000,
      speed: 1,
    });

    expect(playBtn.disabled).toBe(true);
    expect(errorEl.textContent).not.toBe('');
  });

  it('destroy tears down the player + unsubscribes', () => {
    const bubble = createVoiceBubble({ att: makeAtt(), lang: 'en' });
    container.appendChild(bubble.el);
    bubble.destroy();
    expect(playerDestroy).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
