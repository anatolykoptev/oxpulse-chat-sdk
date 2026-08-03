/**
 * @oxpulse/chat-widget — Shared floating-picker dismiss + focus-trap wiring.
 *
 * Deduplicated from EmojiPicker and ProductPicker (#203) — the two had
 * byte-identical ~60-line clones of the outside-pointerdown dismiss, the
 * Escape + Tab focus-trap (same `'input, button:not([disabled])'` selector
 * + shift-tab wrap), and the abort-signal wiring, alongside the
 * already-shared `computeFloatingPosition`. This single helper serves both.
 *
 * Behavior is identical to the inlined originals — every existing
 * emoji-picker AND product-picker test (dismiss / focus-trap / escape /
 * outside-click / abort) stays green.
 */

export interface FloatingDismissOptions {
  /** Called when an outside pointerdown / Escape / abort dismisses the picker. */
  onHide: () => void;
  /** Element to restore focus to on Escape (read at dismiss time, before
   *  onHide nulls the picker's internal reference). */
  getRestoreFocusEl: () => HTMLElement | null;
  /** Optional abort signal — when aborted, the picker is dismissed via onHide. */
  signal?: AbortSignal;
}

/**
 * Install outside-pointerdown dismiss + Escape/Tab focus-trap + abort
 * listener on a floating picker element anchored to `anchorEl`.
 *
 * @returns A teardown function that removes every installed listener —
 *          call it from the picker's hide/remove path.
 */
export function useFloatingDismiss(
  pickerEl: HTMLElement,
  anchorEl: HTMLElement,
  opts: FloatingDismissOptions,
): () => void {
  const { onHide, getRestoreFocusEl, signal } = opts;

  // Outside dismissal — capture phase so we intercept before the target's
  // own pointerdown handlers. Ignore presses on the anchor itself (the
  // picker's trigger button toggles independently).
  const onPointerDown = (e: MouseEvent) => {
    if (
      !pickerEl.contains(e.target as Node) &&
      e.target !== anchorEl &&
      !anchorEl.contains(e.target as Node)
    ) {
      onHide();
    }
  };
  document.addEventListener("pointerdown", onPointerDown, true);

  // Escape hides + restores focus; Tab wraps within the picker (focus trap).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Capture the restore target BEFORE onHide nulls the picker's reference
      // (hide() clears internal state synchronously).
      const restore = getRestoreFocusEl();
      onHide();
      queueMicrotask(() => restore?.focus());
    } else if (e.key === "Tab") {
      const focusable = pickerEl.querySelectorAll<HTMLElement>(
        "input, button:not([disabled])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener("keydown", onKeyDown);

  // Abort signal — dismiss the picker when the caller cancels.
  const onAbort = () => onHide();
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown);
    if (signal) signal.removeEventListener("abort", onAbort);
  };
}
