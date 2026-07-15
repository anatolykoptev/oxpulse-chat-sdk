// Voice-record gesture for the composer — vanilla-TS port of the burner
// chat's voice-gesture.svelte.ts, adapted for a Shadow-DOM custom element
// (no framework runes, explicit listener lifecycle).
//
// Telegram/WhatsApp hold-to-record semantics on the mic button:
//   • pointerdown           → start(), capture the pointer
//   • pointermove up   > SLIDE_CANCEL_PX → willCancel (release = discard)
//   •           left > SLIDE_LOCK_PX     → lock (release capture, keep recording)
//   • pointerup (unlocked, held ≥ TAP_LOCK_MS) → willCancel ? cancel() : stop()
//   • pointerup (unlocked, held < TAP_LOCK_MS) → lock  (WhatsApp tap-to-lock —
//                              a mouse click / quick tap latches into recording
//                              with visible Stop/Cancel; the desktop path)
//   • pointerup (locked)    → no-op; finalize via the Stop button
//   • pointercancel         → cancel() unless locked
//   • keyboard Enter/Space  → start in locked mode (pointer gestures are not
//                              keyboard-operable — a11y path)
//
// The gesture owns ONLY pointer→intent mapping + lock/willCancel state. The
// composer owns the recorder, the analyser tap, the live-waveform RAF loop
// and all teardown ordering; it receives start/stop/cancel calls and
// lock/willCancel notifications through the VoiceGestureHost.

/** Vertical slide past this many px (upward) arms cancel-on-release. */
export const SLIDE_CANCEL_PX = 60;
/** Horizontal slide past this many px (leftward) latches locked recording. */
export const SLIDE_LOCK_PX = 80;
/** A press released faster than this auto-locks (WhatsApp) rather than
 *  finalizing — this is what makes a plain mouse click / tap start a
 *  recording with on-screen Stop/Cancel instead of a 0-second clip. */
const TAP_LOCK_MS = 250;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export interface VoiceGestureHost {
  /** Begin recording. Resolves true iff recording actually started. */
  start(): Promise<boolean>;
  /** Finalize the recording → pre-send preview. */
  stop(): void;
  /** Discard the recording. */
  cancel(): void;
  /** True while a recording is active (perm granted, not yet finalized). */
  isRecording(): boolean;
  /** Reflect lock state: swap the chip's slide-hint for Stop/Cancel controls. */
  onLockChange(locked: boolean): void;
  /** Reflect will-cancel state: red chip + "release to cancel" hint. */
  onWillCancelChange(willCancel: boolean): void;
}

export interface VoiceGesture {
  readonly locked: boolean;
  readonly willCancel: boolean;
  /** Finalize a locked recording (Stop button). */
  stopLocked(): void;
  /** Cancel a locked recording (Cancel button). */
  cancelLocked(): void;
  /** Remove all listeners. */
  destroy(): void;
}

export function createVoiceGesture(
  micBtn: HTMLElement,
  host: VoiceGestureHost,
): VoiceGesture {
  let locked = false;
  let willCancel = false;
  let pressOrigin: { pointerId: number; x: number; y: number; startedAt: number } | null = null;
  // getUserMedia is async: a mouse click's pointerup can fire before start()
  // resolves. `starting` gates that window; `pendingRelease` records the
  // release intent so it is replayed once recording is actually live.
  let starting = false;
  let pendingRelease: 'up' | 'cancel' | null = null;

  function setLocked(v: boolean): void {
    if (locked === v) return;
    locked = v;
    host.onLockChange(v);
  }
  function setWillCancel(v: boolean): void {
    if (willCancel === v) return;
    willCancel = v;
    host.onWillCancelChange(v);
  }

  function releaseCapture(pointerId: number | undefined): void {
    if (pointerId === undefined) return;
    try {
      micBtn.releasePointerCapture(pointerId);
    } catch {
      /* pointer already released / capture unsupported */
    }
  }

  /** Resolve an unlocked pointer release into lock / stop / cancel. */
  function finishUnlockedRelease(kind: 'up' | 'cancel'): void {
    const cancel = kind === 'cancel' || willCancel;
    const held = pressOrigin ? now() - pressOrigin.startedAt : Number.POSITIVE_INFINITY;
    const captureId = pressOrigin?.pointerId;
    setWillCancel(false);
    pressOrigin = null;
    releaseCapture(captureId);
    if (!host.isRecording()) return;
    // Quick tap → latch locked recording (Stop/Cancel buttons appear).
    if (!cancel && held < TAP_LOCK_MS) {
      setLocked(true);
      return;
    }
    if (cancel) host.cancel();
    else host.stop();
  }

  const onPointerDown = (ev: PointerEvent): void => {
    // Primary pointer / left mouse button only — ignore right-click + extra touches.
    if (!ev.isPrimary || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    if (host.isRecording() || starting) return;
    ev.preventDefault();
    setWillCancel(false);
    setLocked(false);
    pressOrigin = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, startedAt: now() };
    try {
      micBtn.setPointerCapture(ev.pointerId);
    } catch {
      /* capture unsupported — move/up still fire on the element */
    }
    starting = true;
    pendingRelease = null;
    void host.start().then((ok) => {
      starting = false;
      if (!ok) {
        const id = pressOrigin?.pointerId;
        pressOrigin = null;
        releaseCapture(id);
        setLocked(false);
        setWillCancel(false);
        pendingRelease = null;
        return;
      }
      // The user may have released / cancelled while the mic was being
      // acquired — replay that intent now that recording is live.
      if (pendingRelease) {
        const k = pendingRelease;
        pendingRelease = null;
        finishUnlockedRelease(k);
      }
    });
  };

  const onPointerMove = (ev: PointerEvent): void => {
    if (!pressOrigin || locked) return;
    const dy = ev.clientY - pressOrigin.y;
    const dx = ev.clientX - pressOrigin.x;
    setWillCancel(dy < -SLIDE_CANCEL_PX);
    if (dx < -SLIDE_LOCK_PX) {
      setWillCancel(false);
      const captureId = pressOrigin.pointerId;
      pressOrigin = null;
      releaseCapture(captureId);
      setLocked(true);
    }
  };

  const onPointerUp = (): void => {
    if (locked) return; // locked: finalize via the Stop button
    if (starting) {
      pendingRelease = 'up';
      return;
    }
    finishUnlockedRelease('up');
  };

  const onPointerCancel = (): void => {
    if (locked) return;
    if (starting) {
      pendingRelease = 'cancel';
      return;
    }
    finishUnlockedRelease('cancel');
  };

  // Keyboard a11y: pointer events don't fire on Enter/Space activation. Start
  // directly in locked mode so a keyboard user reaches Stop/Cancel via Tab.
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
    if (host.isRecording() || starting) return;
    ev.preventDefault();
    setWillCancel(false);
    starting = true;
    void host.start().then((ok) => {
      starting = false;
      if (ok) setLocked(true);
    });
  };

  micBtn.addEventListener('pointerdown', onPointerDown);
  micBtn.addEventListener('pointermove', onPointerMove);
  micBtn.addEventListener('pointerup', onPointerUp);
  micBtn.addEventListener('pointercancel', onPointerCancel);
  micBtn.addEventListener('keydown', onKeyDown);

  return {
    get locked() {
      return locked;
    },
    get willCancel() {
      return willCancel;
    },
    stopLocked(): void {
      if (!host.isRecording()) return;
      setLocked(false);
      host.stop();
    },
    cancelLocked(): void {
      if (!host.isRecording()) return;
      setLocked(false);
      host.cancel();
    },
    destroy(): void {
      micBtn.removeEventListener('pointerdown', onPointerDown);
      micBtn.removeEventListener('pointermove', onPointerMove);
      micBtn.removeEventListener('pointerup', onPointerUp);
      micBtn.removeEventListener('pointercancel', onPointerCancel);
      micBtn.removeEventListener('keydown', onKeyDown);
    },
  };
}
