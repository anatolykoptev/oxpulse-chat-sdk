import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createVoicePlayer,
  nextSpeed,
  type VoicePlayer,
} from '../player.ts';

interface MockAudioState {
  phase: 'idle' | 'playing' | 'paused' | 'ended' | 'error';
  currentMs: number;
  progress01: number;
  durationMs: number;
  speed: number;
}

class MockAudio {
  src = '';
  currentTime = 0;
  duration = NaN;
  paused = true;
  ended = false;
  playbackRate = 1;
  preservesPitch = false;
  webkitPreservesPitch = false;
  controls = false;
  preload = '';
  playReject = false;

  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onerror: (() => void) | null = null;

  play = vi.fn(async () => {
    if (this.playReject) throw new Error('play failed');
    this.paused = false;
    this.ended = false;
    this.onplay?.();
  });

  pause = vi.fn(() => {
    this.paused = true;
    this.onpause?.();
  });
}

function makePlayer(audio: MockAudio): { player: VoicePlayer; states: MockAudioState[] } {
  const states: MockAudioState[] = [];
  const player = createVoicePlayer({
    audio: audio as unknown as HTMLAudioElement,
    source: 'data:audio/mp4;base64,xyz',
  });
  player.subscribe((state) => {
    states.push({
      phase: state.phase,
      currentMs: state.currentMs,
      progress01: state.progress01,
      durationMs: state.durationMs,
      speed: state.speed,
    });
  });
  return { player, states };
}

function lastState(states: MockAudioState[]): MockAudioState {
  return states[states.length - 1]!;
}

beforeEach(() => {
  vi.stubGlobal(
    'sessionStorage',
    {
      getItem: vi.fn(),
      setItem: vi.fn(),
    } as unknown as Storage,
  );
  const create = vi.fn(() => 'blob:mock');
  const revoke = vi.fn();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('createVoicePlayer', () => {
  it('play/pause/toggle drives the audio element and phase state', async () => {
    const audio = new MockAudio();
    audio.duration = 10;
    const { player, states } = makePlayer(audio);

    expect(lastState(states).phase).toBe('idle');

    await player.play();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(lastState(states).phase).toBe('playing');

    player.pause();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(lastState(states).phase).toBe('paused');

    await player.toggle();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(lastState(states).phase).toBe('playing');
  });

  it('seek maps progress01 to currentTime and updates currentMs', () => {
    const audio = new MockAudio();
    audio.duration = 10;
    const { player, states } = makePlayer(audio);
    audio.onloadedmetadata?.();

    player.seek(0.5);
    expect(audio.currentTime).toBe(5);
    expect(lastState(states).currentMs).toBe(5000);
    expect(lastState(states).progress01).toBeCloseTo(0.5, 5);
  });

  it('speed-cycle 1/1.5/2 persists to sessionStorage', () => {
    const audio = new MockAudio();
    const { player } = makePlayer(audio);

    player.setSpeed(1.5);
    expect(audio.playbackRate).toBe(1.5);
    expect(sessionStorage.setItem).toHaveBeenCalledWith('oxpulse:voice-speed', '1.5');

    player.setSpeed(2);
    expect(audio.playbackRate).toBe(2);
    expect(sessionStorage.setItem).toHaveBeenCalledWith('oxpulse:voice-speed', '2');
  });

  it('nextSpeed cycles 1 -> 1.5 -> 2 -> 1', () => {
    expect(nextSpeed(1)).toBe(1.5);
    expect(nextSpeed(1.5)).toBe(2);
    expect(nextSpeed(2)).toBe(1);
  });

  it('ended event resets phase to ended and currentMs to 0', () => {
    const audio = new MockAudio();
    audio.duration = 10;
    const { player, states } = makePlayer(audio);
    audio.onloadedmetadata?.();

    audio.currentTime = 10;
    audio.ended = true;
    audio.paused = true;
    audio.onended?.();

    expect(lastState(states).phase).toBe('ended');
    expect(lastState(states).currentMs).toBe(0);
    expect(lastState(states).progress01).toBe(0);
  });

  it('decode error falls back to error phase', async () => {
    const audio = new MockAudio();
    audio.playReject = true;
    const { player, states } = makePlayer(audio);

    await player.play();
    expect(lastState(states).phase).toBe('error');
  });

  it('decodedMs Infinity guard keeps fallback duration', () => {
    const audio = new MockAudio();
    const { player, states } = makePlayer(audio);

    audio.duration = Infinity;
    audio.onloadedmetadata?.();
    expect(lastState(states).durationMs).toBe(0);

    const audio2 = new MockAudio();
    const { player: player2, states: states2 } = makePlayer(audio2);
    audio2.duration = Infinity;
    audio2.onloadedmetadata?.();
    expect(lastState(states2).durationMs).toBe(0);
  });

  it('subscribe/unsubscribe works and stops callbacks after unsubscribe', () => {
    const audio = new MockAudio();
    const { player } = makePlayer(audio);
    const listener = vi.fn();
    const unsubscribe = player.subscribe(listener);

    expect(listener).toHaveBeenCalled();
    const callsBefore = listener.mock.calls.length;

    audio.paused = false;
    player.pause();
    expect(listener).toHaveBeenCalledTimes(callsBefore + 1);

    unsubscribe();
    audio.paused = false;
    player.pause();
    expect(listener).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it('destroy pauses, clears src, and removes all element handlers', () => {
    const audio = new MockAudio();
    const { player } = makePlayer(audio);

    player.destroy();
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.src).toBe('');
    expect(audio.onplay).toBeNull();
    expect(audio.onpause).toBeNull();
    expect(audio.onended).toBeNull();
    expect(audio.onloadedmetadata).toBeNull();
    expect(audio.ontimeupdate).toBeNull();
    expect(audio.onerror).toBeNull();
  });

  it('Blob source creates an objectURL and destroy revokes it', () => {
    const audio = new MockAudio();
    const blob = new Blob(['audio'], { type: 'audio/mp4' });
    const player = createVoicePlayer({
      audio: audio as unknown as HTMLAudioElement,
      source: blob,
    });

    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
    expect(audio.src).toBe('blob:mock');

    player.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('string source does not create or revoke objectURLs', () => {
    const audio = new MockAudio();
    const player = createVoicePlayer({
      audio: audio as unknown as HTMLAudioElement,
      source: 'data:audio/mp4;base64,xyz',
    });

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(audio.src).toBe('data:audio/mp4;base64,xyz');

    player.destroy();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it('load source is called before src is set and revoke happens on destroy', async () => {
    const audio = new MockAudio();
    const load = vi.fn().mockResolvedValue('blob:mock');
    const player = createVoicePlayer({
      audio: audio as unknown as HTMLAudioElement,
      source: { load },
    });

    expect(load).toHaveBeenCalledOnce();
    expect(audio.src).toBe('');

    await Promise.resolve();
    await Promise.resolve();
    expect(audio.src).toBe('blob:mock');

    player.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('destroyed player revokes pending load resolution', async () => {
    const audio = new MockAudio();
    const load = vi.fn().mockResolvedValue('blob:mock');
    const player = createVoicePlayer({
      audio: audio as unknown as HTMLAudioElement,
      source: { load },
    });
    player.destroy();

    await Promise.resolve();
    await Promise.resolve();
    expect(audio.src).toBe('');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });
});
