import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createVoiceGesture, type VoiceGestureHost, type VoiceGesture } from '../ui/voice-gesture.js';

// jsdom has no PointerEvent / setPointerCapture; dispatch a generic Event with
// the pointer fields the gesture reads, and stub the capture methods.
function ptr(
  type: string,
  props: Partial<{
    clientX: number;
    clientY: number;
    pointerId: number;
    isPrimary: boolean;
    button: number;
    pointerType: string;
  }> = {},
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, {
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    isPrimary: true,
    button: 0,
    pointerType: 'touch',
    ...props,
  });
  return ev;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Flush the microtask queue so the gesture's `host.start().then(...)` runs. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createVoiceGesture', () => {
  let micBtn: HTMLButtonElement;
  let gesture: VoiceGesture;
  let host: VoiceGestureHost & {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    onLockChange: ReturnType<typeof vi.fn>;
    onWillCancelChange: ReturnType<typeof vi.fn>;
  };
  let recording: boolean;
  let startDeferred: ReturnType<typeof deferred<boolean>>;
  let nowVal: number;

  beforeEach(() => {
    vi.spyOn(performance, 'now').mockImplementation(() => nowVal);
    nowVal = 0;
    recording = false;
    startDeferred = deferred<boolean>();

    micBtn = document.createElement('button');
    micBtn.setPointerCapture = vi.fn();
    micBtn.releasePointerCapture = vi.fn();
    document.body.appendChild(micBtn);

    host = {
      start: vi.fn(() => startDeferred.promise),
      stop: vi.fn(),
      cancel: vi.fn(),
      isRecording: vi.fn(() => recording),
      onLockChange: vi.fn(),
      onWillCancelChange: vi.fn(),
    };
    gesture = createVoiceGesture(micBtn, host);
  });

  afterEach(() => {
    gesture.destroy();
    micBtn.remove();
    vi.restoreAllMocks();
  });

  /** Resolve start(true) and mark recording live, then flush. */
  async function grantMic(): Promise<void> {
    recording = true;
    startDeferred.resolve(true);
    await tick();
  }

  it('a quick tap latches locked recording (WhatsApp), never finalizes', async () => {
    micBtn.dispatchEvent(ptr('pointerdown'));
    expect(host.start).toHaveBeenCalledOnce();
    // Release before the mic grant resolves — held time is tiny.
    micBtn.dispatchEvent(ptr('pointerup'));
    await grantMic();

    expect(host.onLockChange).toHaveBeenLastCalledWith(true);
    expect(gesture.locked).toBe(true);
    expect(host.stop).not.toHaveBeenCalled();
    expect(host.cancel).not.toHaveBeenCalled();
  });

  it('a quick tap during a SLOW mic grant still locks (no ~0s Empty-recording clip)', async () => {
    // Cold-permission grant: pointerdown, a fast physical release, THEN the mic
    // resolves 800ms later. `held` measured from pointerdown would be > 250ms →
    // wrongly finalize a near-0s clip. Must latch locked instead.
    nowVal = 0;
    micBtn.dispatchEvent(ptr('pointerdown'));
    micBtn.dispatchEvent(ptr('pointerup'));
    nowVal = 800; // grant latency
    await grantMic();

    expect(gesture.locked).toBe(true);
    expect(host.onLockChange).toHaveBeenLastCalledWith(true);
    expect(host.stop).not.toHaveBeenCalled();
    expect(host.cancel).not.toHaveBeenCalled();
  });

  it('a slide-up cancel DURING a slow mic grant discards — never locks a live mic', async () => {
    // Regression guard: on a cold grant, a slide-up-past-threshold then lift
    // sends pendingRelease='up' while willCancel is set. It must discard, not
    // latch a locked live recording.
    nowVal = 0;
    micBtn.dispatchEvent(ptr('pointerdown', { clientY: 200 }));
    micBtn.dispatchEvent(ptr('pointermove', { clientY: 200 - 100 })); // dy = -100 → willCancel
    expect(gesture.willCancel).toBe(true);
    micBtn.dispatchEvent(ptr('pointerup')); // pendingRelease='up', willCancel true
    nowVal = 800;
    await grantMic();

    expect(host.cancel).toHaveBeenCalledOnce();
    expect(gesture.locked).toBe(false);
    expect(gesture.willCancel).toBe(false);
    expect(host.stop).not.toHaveBeenCalled();
  });

  it('a long hold released finalizes (stop → preview), unlocked', async () => {
    nowVal = 0;
    micBtn.dispatchEvent(ptr('pointerdown'));
    await grantMic();
    nowVal = 300; // held > TAP_LOCK_MS (250)
    micBtn.dispatchEvent(ptr('pointerup'));

    expect(host.stop).toHaveBeenCalledOnce();
    expect(host.cancel).not.toHaveBeenCalled();
    expect(gesture.locked).toBe(false);
  });

  it('slide up past the cancel threshold arms cancel, release discards', async () => {
    micBtn.dispatchEvent(ptr('pointerdown', { clientY: 200 }));
    await grantMic();
    micBtn.dispatchEvent(ptr('pointermove', { clientY: 200 - 100 })); // dy = -100
    expect(host.onWillCancelChange).toHaveBeenLastCalledWith(true);
    expect(gesture.willCancel).toBe(true);

    nowVal = 300;
    micBtn.dispatchEvent(ptr('pointerup'));
    expect(host.cancel).toHaveBeenCalledOnce();
    expect(host.stop).not.toHaveBeenCalled();
  });

  it('slide left past the lock threshold latches locked recording', async () => {
    micBtn.dispatchEvent(ptr('pointerdown', { clientX: 200 }));
    await grantMic();
    micBtn.dispatchEvent(ptr('pointermove', { clientX: 200 - 100 })); // dx = -100

    expect(host.onLockChange).toHaveBeenLastCalledWith(true);
    expect(gesture.locked).toBe(true);
    // A release while locked must NOT finalize — the Stop button does that.
    micBtn.dispatchEvent(ptr('pointerup'));
    expect(host.stop).not.toHaveBeenCalled();
    expect(host.cancel).not.toHaveBeenCalled();
  });

  it('keyboard Enter starts recording directly in locked mode (a11y)', async () => {
    micBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.start).toHaveBeenCalledOnce();
    await grantMic();
    expect(host.onLockChange).toHaveBeenLastCalledWith(true);
    expect(gesture.locked).toBe(true);
  });

  it('a denied mic grant leaves no locked/willCancel state', async () => {
    micBtn.dispatchEvent(ptr('pointerdown'));
    micBtn.dispatchEvent(ptr('pointerup'));
    recording = false;
    startDeferred.resolve(false); // permission denied
    await tick();

    expect(gesture.locked).toBe(false);
    expect(gesture.willCancel).toBe(false);
    expect(host.stop).not.toHaveBeenCalled();
    expect(host.cancel).not.toHaveBeenCalled();
  });

  it('ignores right-click and non-primary pointers', () => {
    micBtn.dispatchEvent(ptr('pointerdown', { button: 2, pointerType: 'mouse' }));
    micBtn.dispatchEvent(ptr('pointerdown', { isPrimary: false }));
    expect(host.start).not.toHaveBeenCalled();
  });

  it('stopLocked finalizes and clears lock; cancelLocked discards and clears lock', async () => {
    // Enter locked mode.
    micBtn.dispatchEvent(ptr('pointerdown', { clientX: 200 }));
    await grantMic();
    micBtn.dispatchEvent(ptr('pointermove', { clientX: 0 }));
    expect(gesture.locked).toBe(true);

    gesture.stopLocked();
    expect(host.stop).toHaveBeenCalledOnce();
    expect(host.onLockChange).toHaveBeenLastCalledWith(false);
    expect(gesture.locked).toBe(false);
  });

  it('cancelLocked discards a locked recording', async () => {
    micBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await grantMic();
    expect(gesture.locked).toBe(true);

    gesture.cancelLocked();
    expect(host.cancel).toHaveBeenCalledOnce();
    expect(gesture.locked).toBe(false);
  });

  it('pointercancel discards an unlocked recording', async () => {
    micBtn.dispatchEvent(ptr('pointerdown'));
    await grantMic();
    nowVal = 300;
    micBtn.dispatchEvent(ptr('pointercancel'));
    expect(host.cancel).toHaveBeenCalledOnce();
  });

  it('destroy removes all listeners', async () => {
    gesture.destroy();
    micBtn.dispatchEvent(ptr('pointerdown'));
    micBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(host.start).not.toHaveBeenCalled();
  });
});
