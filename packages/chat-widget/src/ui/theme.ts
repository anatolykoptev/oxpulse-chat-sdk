/**
 * @oxpulse/chat-widget — Shadow DOM CSS theme foundation (W2.2 slice 1).
 *
 * Defines CSS custom-property palette for the widget's Shadow DOM.
 * Light defaults via :host, dark via :host([data-theme='dark']),
 * auto via @media (prefers-color-scheme: dark).
 */

/** CSS for the Shadow DOM <style> block — theme variables + dark overrides. */
export const THEME_CSS = `
:host {
  /* ── Light theme defaults ── */
  --oxp-bg: #ffffff;
  --oxp-fg: #1a1a1a;
  --oxp-accent: #0088cc;
  /* F2: #767676 ≈ 4.55:1 on #fff PASS (prior #8a8a8a = 3.45:1 FAIL) */
  --oxp-muted: #767676;
  --oxp-border: #e0e0e0;
  --oxp-bubble-self-bg: #dcf8c6;
  --oxp-bubble-other-bg: #f1f0f0;
  --oxp-radius: 12px;
  --oxp-font: system-ui, -apple-system, sans-serif;
  --oxp-spacing-unit: 8px;
  /* danger token — light mode #c00 (contrast ≥4.5:1 on white bg) */
  --oxp-danger: #c00000;
  /* B2 (BLOCKER WCAG 1.4.3): --oxp-on-danger for text ON danger-colored backgrounds.
   * Light #ffffff on #c00000 = 6.48:1 PASS. Dark #ffffff on #ff6b6b = 5.05:1 PASS.
   * Do NOT reuse --oxp-on-accent (#000 on #c00000 = 3.24:1 FAIL for normal text). */
  --oxp-on-danger: #ffffff;
  /* Design M5: --oxp-success — light #16a34a ≥4.5:1 on banner bg (#fff + 15% mix).
   * 2B: tint source only — do not use as color: in light mode (2.78:1 fail on white bg). */
  --oxp-success: #16a34a;
  /* DM5: --oxp-success-text — WCAG-safe fg for success text content (not tint use).
   * Light #0f7a35: vs #ffffff ≈7:1 PASS, vs bubble-self #dcf8c6 ≈4.8:1 PASS.
   * Dark  #4ade80: 7.11:1 on #1c1c1e PASS. Prevents authors reaching for --oxp-success. */
  --oxp-success-text: #0f7a35;
  /* F1: on-accent — #000 passes 5.39:1 on #0088cc (light) and 5.82:1 on #0a84ff (dark).
   * Prior #fff failed both (3.89:1 / 3.61:1). Single value for both themes. */
  --oxp-on-accent: #000;
  /* B2: fg-secondary for secondary text. Light #5a5a5a ≥4.5:1 on all bubble bgs:
   *   vs #dcf8c6 (self-light): 4.55:1 PASS
   *   vs #f1f0f0 (other-light): 4.58:1 PASS
   * Much better than --oxp-muted (#767676) on bubble bgs which fails at small sizes. */
  --oxp-fg-secondary: #5a5a5a;
  /* DB1: --oxp-link — WCAG-passing link color distinct from --oxp-accent.
   * Light #0066a3: contrast vs #dcf8c6 (self-bubble) = 5.36:1 PASS,
   *               vs #f1f0f0 (other-bubble) = 5.14:1 PASS,
   *               vs #ffffff (bg) = 6.23:1 PASS — all ≥4.5:1. */
  --oxp-link: #0066a3;
  /* 2A: --oxp-code-bg — semantic token for code surface background.
   * Light #f5f5f5: contrast vs --oxp-fg #1a1a1a = ~18:1 PASS (background token, not fg). */
  --oxp-code-bg: #f5f5f5;
  /* B3 (BLOCKER): --oxp-code-border — guarantees code region boundary independent of bg match.
   * Light: rgba(0,0,0,0.50) blends to #808080 on white → 3.95:1 on widget-bg, ~3.87:1 on
   * bubble-other #f1f0f0 — all ≥3:1 PASS (prior 0.40 → 2.85:1 FAIL). */
  --oxp-code-border: rgba(0, 0, 0, 0.50);
  /* B1 (BLOCKER WCAG 1.4.11): --oxp-spinner-track for the inactive arc of the CSS spinner.
   * Light: rgba(0,0,0,0.55) blends to #737373 on white → 3.15:1 PASS (non-text ≥3:1).
   * Prior --oxp-border (#e0e0e0 on white) = 1.32:1 FAIL. */
  --oxp-spinner-track: rgba(0, 0, 0, 0.55);

  display: block;
  box-sizing: border-box;
  font-family: var(--oxp-font);
  background: var(--oxp-bg);
  color: var(--oxp-fg);
}

/* W7: [hidden] attribute must win over any component display style.
 * Without this, classes like .oxp-composer-reply { display: flex; } keep the
 * element visible even when hidden="" is set. */
[hidden] {
  display: none !important;
}

:host([data-theme='dark']) {
  --oxp-bg: #1c1c1e;
  --oxp-fg: #ebebf5;
  --oxp-accent: #0a84ff;
  --oxp-muted: #8e8e93;
  --oxp-border: #38383a;
  --oxp-bubble-self-bg: #1e4e31;
  --oxp-bubble-other-bg: #2c2c2e;
  /* danger token — dark mode #ff6b6b (contrast ≥4.5:1 on #1c1c1e bg) */
  --oxp-danger: #ff6b6b;
  /* B2 (BLOCKER WCAG 1.4.3): dark on-danger — #000000 on #ff6b6b = 7.57:1 PASS.
   * Note: #ff6b6b is a light-ish red; dark text provides higher contrast than white. */
  --oxp-on-danger: #000000;
  /* Design M5: --oxp-success — dark #4ade80 ≥4.5:1 on dark banner bg */
  --oxp-success: #4ade80;
  /* DM5: dark --oxp-success-text — #4ade80: 7.11:1 on #1c1c1e PASS. */
  --oxp-success-text: #4ade80;
  /* F1: on-accent #000 — 5.82:1 on #0a84ff PASS */
  --oxp-on-accent: #000;
  /* B2: dark fg-secondary — #cccccc ≥4.5:1 on dark bubble bgs:
   *   vs #1e4e31 (self-dark): 5.12:1 PASS
   *   vs #2c2c2e (other-dark): 5.48:1 PASS */
  --oxp-fg-secondary: #cccccc;
  /* DB1: dark --oxp-link — #7cc4ff: contrast vs #1e4e31 (self-dark) ≥4.5:1 PASS,
   *                          vs #2c2c2e (other-dark) ≥4.5:1 PASS — all ≥4.5:1.
   * Prior #5eb3ff on #1e4e31 = 4.28:1 FAIL (comment claimed 5.42:1 — wrong math). */
  --oxp-link: #7cc4ff;
  /* B3 (BLOCKER): dark --oxp-code-bg shifted away from --oxp-bubble-other-bg (#2c2c2e).
   * Prior value was IDENTICAL to bubble-other-bg → 1:1 zero contrast inside other-person bubble.
   * #1a1a1c: darker, visually distinct; fg #ebebf5 vs #1a1a1c ≥4.5:1 PASS. */
  --oxp-code-bg: #1a1a1c;
  /* B3 (BLOCKER): dark --oxp-code-border provides guaranteed boundary regardless of bg match.
   * rgba(255,255,255,0.40) → 3.83:1 on #1a1a1c code-bg, 3.54:1 on #2c2c2e bubble-other — all
   * ≥3:1 PASS (prior 0.30 → 2.72:1 / 2.62:1 FAIL). */
  --oxp-code-border: rgba(255, 255, 255, 0.40);
  /* B1 (BLOCKER WCAG 1.4.11): dark spinner track token.
   * rgba(255,255,255,0.50) on #1c1c1e → ~4.76:1 PASS (non-text ≥3:1 per WCAG 1.4.11).
   * Note: spec suggested 0.30 (3.50:1) but actual calculation shows 0.30 → 2.71:1 FAIL;
   * using 0.50 is empirically verified.
   * Prior --oxp-border (#38383a on #1c1c1e) = 1.45:1 FAIL. */
  --oxp-spinner-track: rgba(255, 255, 255, 0.50);
}

@media (prefers-color-scheme: dark) {
  :host([data-theme='auto']), :host(:not([data-theme])) {
    --oxp-bg: #1c1c1e;
    --oxp-fg: #ebebf5;
    --oxp-accent: #0a84ff;
    --oxp-muted: #8e8e93;
    --oxp-border: #38383a;
    --oxp-bubble-self-bg: #1e4e31;
    --oxp-bubble-other-bg: #2c2c2e;
    --oxp-danger: #ff6b6b;
    /* B2: dark on-danger matching dark theme block — #000 on #ff6b6b = 7.57:1 PASS */
    --oxp-on-danger: #000000;
    /* F1: on-accent #000 — 5.82:1 on #0a84ff PASS */
    --oxp-on-accent: #000;
    /* B2: dark fg-secondary matching dark theme block */
    --oxp-fg-secondary: #cccccc;
    /* DB1: dark link token matching dark theme block — #7cc4ff WCAG ≥4.5:1 */
    --oxp-link: #7cc4ff;
    /* Design M5: dark success matching dark theme block */
    --oxp-success: #4ade80;
    /* DM5: dark success-text matching dark theme block */
    --oxp-success-text: #4ade80;
    /* B3: dark code-bg shifted from #2c2c2e (collision with bubble-other-bg) */
    --oxp-code-bg: #1a1a1c;
    /* B3: dark code-border — rgba(255,255,255,0.40) mirrors dark theme block (prior 0.30 FAIL) */
    --oxp-code-border: rgba(255, 255, 255, 0.40);
    /* B1: dark spinner-track matching dark theme block */
    --oxp-spinner-track: rgba(255, 255, 255, 0.50);
  }
}

/* ── Message list container ── */
.oxp-message-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: calc(var(--oxp-spacing-unit) * 1.5);
  overflow-y: auto;
  height: 100%;
  box-sizing: border-box;
}

/* ── Bubble base ── */
.oxp-bubble {
  display: flex;
  flex-direction: column;
  max-width: 75%;
  padding: calc(var(--oxp-spacing-unit) * 0.75) var(--oxp-spacing-unit);
  border-radius: var(--oxp-radius);
  font-size: 0.9rem;
  line-height: 1.4;
  word-break: break-word;
  margin-bottom: calc(var(--oxp-spacing-unit) * 0.5);
}

.oxp-bubble[data-self='true'] {
  align-self: flex-end;
  background: var(--oxp-bubble-self-bg);
}

.oxp-bubble[data-self='false'] {
  align-self: flex-start;
  background: var(--oxp-bubble-other-bg);
}

/* Chained bubbles — tighter margin, no sender label gap */
.oxp-bubble[data-chained='true'] {
  margin-bottom: 1px;
}

/* T18-avatar: message row = leading avatar + bubble (avatar for OTHER writers). */
.oxp-row {
  display: flex;
  align-items: flex-start;
  gap: calc(var(--oxp-spacing-unit) * 0.5);
  max-width: 80%;
}
.oxp-row[data-self='true'] {
  align-self: flex-end;
}
.oxp-row[data-self='false'] {
  align-self: flex-start;
}
/* The row now owns left/right placement; let the bubble fill the row width. */
.oxp-row .oxp-bubble {
  max-width: 100%;
}
.oxp-bubble-avatar {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  margin-top: 2px;
  border-radius: 50%;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1;
  color: #fff;
  user-select: none;
}
.oxp-bubble-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
/* Chained rows: keep the avatar footprint but hide it so bubbles stay aligned. */
.oxp-row[data-chained='true'] .oxp-bubble-avatar {
  visibility: hidden;
}

/* Placeholder + error states using theme tokens */
.oxp-placeholder {
  font-family: var(--oxp-font);
  padding: 16px;
  color: var(--oxp-muted);
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 1C: CSS spinner via ::after — respects prefers-reduced-motion */
/* B1 (BLOCKER WCAG 1.4.11): track uses --oxp-spinner-track (≥3:1) not --oxp-border (1.32:1 FAIL). */
.oxp-placeholder::after {
  content: '';
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid var(--oxp-spinner-track);
  border-top-color: var(--oxp-accent);
  border-radius: 50%;
  animation: oxp-spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes oxp-spin {
  to { transform: rotate(360deg); }
}

/* Minor: prefers-reduced-motion — replace opacity:0.5 (renders 1.14:1 invisible) with static
 * accent-colored arc. Spinner stops but remains visible as an indicator. */
@media (prefers-reduced-motion: reduce) {
  .oxp-placeholder::after {
    animation: none;
    border-top-color: var(--oxp-accent);
    opacity: 1;
  }
}

.oxp-error {
  font-family: var(--oxp-font);
  padding: 16px;
  color: var(--oxp-danger);
  border: 1px solid var(--oxp-danger);
  border-radius: 4px;
}

/* 1D: Inline message list error state */
.oxp-message-list-error {
  font-family: var(--oxp-font);
  padding: 16px;
  color: var(--oxp-danger);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}

/* B2 (BLOCKER WCAG 1.4.3): use --oxp-on-danger (not --oxp-on-accent) for text on danger bg.
 * Light #000 on #c00000 = 3.24:1 FAIL; #ffffff on #c00000 = 6.48:1 PASS. */
.oxp-message-list-error button {
  font-family: var(--oxp-font);
  font-size: 0.85rem;
  padding: calc(var(--oxp-spacing-unit) * 0.5) var(--oxp-spacing-unit);
  background: var(--oxp-danger);
  color: var(--oxp-on-danger);
  border: none;
  border-radius: calc(var(--oxp-radius) * 0.5);
  cursor: pointer;
  min-height: 40px;
  /* DM list error minor: min-width for consistent touch target */
  min-width: 64px;
}

.oxp-message-list-error button:focus-visible {
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
}

/* P5: sender label + optional role badge (senderEl is prepended into this row). */
.oxp-bubble-sender-row {
  display: flex;
  align-items: center;
  gap: calc(var(--oxp-spacing-unit) * 0.5);
  margin-bottom: 2px;
}

.oxp-bubble-sender {
  font-size: 0.75rem;
  font-weight: 600;
  /* B5: Use fg with opacity instead of accent — contrast ≥4.5:1 on both
   * self-bubble (#dcf8c6 light / #1e4e31 dark) and other-bubble
   * (#f1f0f0 light / #2c2c2e dark) backgrounds. */
  color: var(--oxp-fg);
  opacity: 0.7;
}

.oxp-bubble[data-chained='true'] .oxp-bubble-sender-row {
  display: none;
}

/* P5: privileged-role badge (moderator/owner) next to the sender name.
 * background/color pairing mirrors .oxp-composer-send (F1: --oxp-on-accent on
 * --oxp-accent verified 5.39:1 light / 5.82:1 dark — WCAG AA for normal text). */
.oxp-role-badge {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--oxp-accent);
  color: var(--oxp-on-accent);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  user-select: none;
}

.oxp-bubble-body {
  color: var(--oxp-fg);
}

.oxp-bubble-time {
  font-size: 0.7rem;
  /* design-empirical review of starthey.com/demo 2026-07-14 (WCAG 1.4.3):
   * --oxp-muted measured 3.99:1 light / 4.27:1 dark at this size — below the
   * 4.5:1 AA floor on every message, both themes. --oxp-fg-secondary is this
   * file's own designated on-bubble text token (see :40-44 / :95-98) and
   * passes ≥4.5:1 on all four self/other × light/dark bubble backgrounds. */
  color: var(--oxp-fg-secondary);
  align-self: flex-end;
  margin-top: 2px;
}

.oxp-tombstone {
  color: var(--oxp-muted);
  font-style: italic;
}

/* U2: failed-decrypt placeholder — text color: --oxp-danger text directly on
 * --oxp-bubble-self-bg fails WCAG 1.4.3 in the dark theme (#ff6b6b on #1e4e31
 * = 3.46:1, below the 4.5:1 AA floor for italic/normal-size text — italic does
 * not qualify for the large-text exemption). --oxp-fg-secondary is the token
 * this file already designates for bubble-background text (see its own doc
 * comment: "Much better than --oxp-muted on bubble bgs which fails at small
 * sizes") and passes ≥5.9:1 on all four self/other × light/dark backgrounds.
 *
 * review-fix HIGH#2: text color alone left this visually identical in weight
 * to .oxp-tombstone (both small/italic/muted) — but an unsealError, unlike a
 * benign deletion, can mean a tampered/replayed message (SDK explicitly
 * preserves it rather than masking it — see chat-sdk client.ts). Give it a
 * danger-tinted chip background so it reads as a security-relevant state, not
 * routine housekeeping. Reuses TWO existing in-file conventions rather than
 * inventing a new one: the transparent-mix idiom from
 * .oxp-reaction-chip[data-own='true'] (color-mix(..., transparent) — correct
 * here too, since this span sits on a VARYING backdrop, self or other bubble,
 * light or dark, unlike .oxp-reconnect-banner which sits on a fixed --oxp-bg
 * and can mix against it directly); and the 12% tint ratio from
 * .oxp-reconnect-banner[data-state='auth-expired'].
 * Re-verified WCAG 1.4.3 (text-on-tint, ≥4.5:1 required) with the same
 * relative-luminance math after alpha-compositing the 12% danger tint onto
 * each bubble bg: light-self 4.81:1, light-other 4.88:1, dark-self 5.42:1,
 * dark-other 7.30:1 — all PASS. */
.oxp-unseal-error {
  display: inline-block;
  color: var(--oxp-fg-secondary);
  font-style: italic;
  background: color-mix(in srgb, var(--oxp-danger) 12%, transparent);
  border-radius: calc(var(--oxp-radius) * 0.35);
  padding: 2px calc(var(--oxp-spacing-unit) * 0.625);
}

/* ── Markdown styles ── */
/* 2A: use --oxp-code-bg (semantic token) instead of --oxp-border (structural token).
 * B3 (BLOCKER): add --oxp-code-border for guaranteed code region boundary.
 *   Dark: #1a1a1c code bg now distinct from bubble-other (#2c2c2e), but border provides extra guarantee.
 *   Light: rgba(0,0,0,0.40) border on #f5f5f5 bg — visible on all surfaces. */
.md-code { background: var(--oxp-code-bg); border: 1px solid var(--oxp-code-border); border-radius: 3px; padding: 1px 4px; font-size: 0.85em; }
.md-pre  { background: var(--oxp-code-bg); border: 1px solid var(--oxp-code-border); border-radius: 6px; padding: 8px; overflow-x: auto; }
.md-link { color: var(--oxp-accent); }
.md-spoiler { background: var(--oxp-fg); color: var(--oxp-fg); border-radius: 3px; cursor: pointer; }
.md-spoiler:hover, .md-spoiler:focus { background: transparent; }
.md-quote { border-left: 3px solid var(--oxp-accent); margin: 0; padding-left: 8px; color: var(--oxp-muted); }

/* ── Widget root + composer (slice 2) ── */
.oxp-widget-root { display: flex; flex-direction: column; width: 100%; height: 100%; overflow: hidden; }
/* The wrapper div (element.ts) sits between the root and the message list; it
 * must be the flex-growing child so the composer is pinned to the bottom. The
 * rule previously targeted only the inner list element (oxp-message-list),
 * leaving the wrapper at flex-grow:0 so it collapsed to content height and the
 * composer rode up under the last row (dead space below on a tall/mobile
 * fullscreen host). flex:1 + column on the wrapper, flex:1 on the inner list.
 * NB keep this comment backtick-free — this string is a JS template literal. */
.oxp-widget-root .oxp-message-list-wrapper { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.oxp-widget-root .oxp-message-list { flex: 1; min-height: 0; }

.oxp-composer {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--oxp-spacing-unit);
  padding: var(--oxp-spacing-unit);
  border-top: 1px solid var(--oxp-border);
  background: var(--oxp-bg);
  box-sizing: border-box;
  flex-shrink: 0;
  position: relative;
}

.oxp-composer-main {
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  gap: var(--oxp-spacing-unit);
}

.oxp-composer-input {
  flex: 1;
  min-height: 44px;
  max-height: 144px;
  padding: calc(var(--oxp-spacing-unit) * 0.75) var(--oxp-spacing-unit);
  border: 1px solid var(--oxp-border);
  border-radius: var(--oxp-radius);
  background: var(--oxp-bg);
  color: var(--oxp-fg);
  font-family: var(--oxp-font);
  font-size: 0.95rem;
  line-height: 1.4;
  resize: none;
  box-sizing: border-box;
  outline: none;
  overflow-y: auto;
}

.oxp-composer-input:focus {
  border-color: var(--oxp-accent);
}

/* B4: placeholder contrast — override default 0.54 opacity */
.oxp-composer-input::placeholder {
  color: var(--oxp-muted);
  opacity: 1;
}

.oxp-composer-send:focus-visible {
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
}

.oxp-composer-send {
  width: 44px;
  height: 44px;
  padding: 0;
  background: var(--oxp-accent);
  /* F1: use --oxp-on-accent for WCAG contrast (#000 on both: 5.39:1 light, 5.82:1 dark) */
  color: var(--oxp-on-accent);
  border: none;
  border-radius: 999px;
  font-family: var(--oxp-font);
  cursor: pointer;
  box-sizing: border-box;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  align-self: flex-end;
}

.oxp-composer-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* M9: Counter row below the input row. */
.oxp-composer-footer {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: var(--oxp-spacing-unit);
  align-self: flex-end;
  min-height: 0;
}

.oxp-composer-counter {
  font-size: 0.75rem;
  color: var(--oxp-muted);
  pointer-events: none;
}

.oxp-composer-counter[data-over-limit='true'] {
  color: var(--oxp-danger);
}

/* W7: reply preview bar above the composer input */
.oxp-composer-reply {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: space-between;
  gap: calc(var(--oxp-spacing-unit) * 0.5);
  padding: calc(var(--oxp-spacing-unit) * 0.5) var(--oxp-spacing-unit);
  border-left: 3px solid var(--oxp-accent);
  border-radius: calc(var(--oxp-radius) * 0.5);
  background: color-mix(in srgb, var(--oxp-bubble-other-bg) 60%, transparent);
  color: var(--oxp-fg);
}

.oxp-composer-reply-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.oxp-composer-reply-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--oxp-fg-secondary);
}

.oxp-composer-reply-body {
  font-size: 0.85rem;
  /* review pr-review-council 2026-07-14: --oxp-muted fails WCAG 1.4.3 here
   * (light ≈4.2:1, dark ≈2.95:1, both below the 4.5:1 floor). Sibling
   * .oxp-composer-reply-label already uses --oxp-fg-secondary. */
  color: var(--oxp-fg-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.oxp-composer-reply-cancel {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  color: var(--oxp-fg-secondary);
  padding: 2px 4px;
  border-radius: 4px;
}

.oxp-composer-reply-cancel:focus-visible {
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
}

/* M10: visually-hidden for screen-reader-only text */
.oxp-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0,0,0,0);
  white-space: nowrap;
  border: 0;
}

/* ── Reactions (W2.2 slice 3) ── */
.oxp-bubble-reactions {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: calc(var(--oxp-spacing-unit) * 0.25);
  margin-top: calc(var(--oxp-spacing-unit) * 0.25);
}

.oxp-reaction-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px calc(var(--oxp-spacing-unit) * 0.625);
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--oxp-border);
  color: var(--oxp-fg);
  font-family: var(--oxp-font);
  font-size: 0.8rem;
  cursor: pointer;
  line-height: 1.4;
  box-sizing: border-box;
}

.oxp-reaction-chip[data-own='true'] {
  background: color-mix(in srgb, var(--oxp-accent) 15%, transparent);
  border-color: var(--oxp-accent);
}

.oxp-reaction-chip:focus-visible {
  /* B4 / F2 (WCAG 2.4.11): double-ring pattern — outer outline + outer box-shadow ring.
   * Prior: outermost pixel = accent (#0a84ff) on dark self-bubble (#1e4e31) = 2.63:1 FAIL.
   * Fix: outermost box-shadow uses --oxp-fg.
   *   light: #1a1a1a on dark self-bubble #1e4e31 >> 3:1 PASS.
   *   dark:  #ebebf5 on #1e4e31 = 8.10:1 PASS. */
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px var(--oxp-fg);
}

.oxp-bubble-footer {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: calc(var(--oxp-spacing-unit) * 0.5);
  margin-top: 2px;
}

/* Heart-first reactions (spec amendment 2026-07-14): a single heart button
 * replaces the old '+😀' text trigger — outline heart by default, tap
 * instantly toggles ❤️, hold/ArrowUp opens the full ReactionQuickBar. */
.oxp-reaction-heart-btn {
  background: none;
  border: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* B2 (carried from .oxp-reaction-add-btn): --oxp-fg-secondary, not --oxp-muted.
   * Light #5a5a5a ≥4.5:1 on all bubble bgs; dark #cccccc ≥4.5:1 on dark bubble bgs. */
  color: var(--oxp-fg-secondary);
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.1s, color 0.15s;
}

.oxp-reaction-heart-btn svg {
  fill: none;
  stroke: currentColor;
}

/* Own-❤️ state: aria-pressed reflects #ownReactionFor(msgId) === HEART_EMOJI
 * (kept live by MessageList#syncHeartButton). Accent-tinted, filled heart —
 * mirrors .oxp-reaction-chip[data-own='true']'s own-highlight token choice. */
.oxp-reaction-heart-btn[aria-pressed='true'] {
  color: var(--oxp-accent);
}

.oxp-reaction-heart-btn[aria-pressed='true'] svg {
  fill: currentColor;
}

.oxp-bubble:hover .oxp-reaction-heart-btn,
.oxp-bubble:focus-within .oxp-reaction-heart-btn {
  opacity: 1;
}

.oxp-reaction-heart-btn:focus-visible {
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
  opacity: 1;
}

/* Heart-add pulse (reuse-update 2026-07-14) — ported verbatim from
 * oxpulse-chat web's Bubble.svelte '.qa-heart.on.pulse' keyframe
 * (0%/50%/100% scale(1)/scale(1.18)/scale(1), 240ms — see HEART_PULSE_MS
 * in message-list.ts, MessageList#pulseHeart). */
.oxp-reaction-heart-btn--pulse {
  animation: oxp-heart-pulse 240ms ease both;
}

@keyframes oxp-heart-pulse {
  0%   { transform: scale(1); }
  50%  { transform: scale(1.18); }
  100% { transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .oxp-reaction-heart-btn--pulse {
    animation: none;
  }
}

/* W7: reply button on each bubble */
.oxp-reply-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--oxp-fg-secondary);
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.1s;
}

.oxp-bubble:hover .oxp-reply-btn,
.oxp-bubble:focus-within .oxp-reply-btn {
  opacity: 1;
}

.oxp-reply-btn:focus-visible {
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
  opacity: 1;
}

/* W7: reply quote inside a bubble */
.oxp-bubble-reply {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 4px;
  padding-left: 8px;
  background: transparent;
  border: none;
  border-left: 3px solid var(--oxp-accent);
  text-align: left;
  cursor: pointer;
  width: 100%;
  box-sizing: border-box;
}

.oxp-bubble-reply:disabled {
  cursor: default;
}

.oxp-bubble-reply-sender {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--oxp-fg-secondary);
}

.oxp-bubble-reply-body {
  font-size: 0.8rem;
  /* review pr-review-council 2026-07-14: --oxp-muted fails WCAG 1.4.3 here
   * (light ≈4.2:1, dark ≈2.95:1, both below the 4.5:1 floor). Sibling
   * .oxp-bubble-reply-sender already uses --oxp-fg-secondary. */
  color: var(--oxp-fg-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.oxp-reaction-quick-bar {
  position: absolute;
  z-index: 10;
  background: var(--oxp-bg);
  /* B3: border retained for shape definition.
   * F1 (WCAG 1.4.11): discrete outer pixel via 0 0 0 1px box-shadow ring.
   *   outline-offset:-1px was placing the ring inward (outermost pixel = --oxp-border = 1.32:1 FAIL).
   *   box-shadow sits OUTSIDE the border-box — outermost pixel is the ring pixel.
   *   Light: rgba(0,0,0,0.50) on #fff → rgb(128,128,128) → L=0.216 → contrast vs #fff = 3.95:1 PASS.
   *   Dark:  rgba(255,255,255,0.50) on #1c1c1e → rgb(141,141,142) → L=0.266 → 4.39:1 PASS. */
  border: 1px solid var(--oxp-border);
  border-radius: var(--oxp-radius);
  padding: calc(var(--oxp-spacing-unit) * 0.5);
  display: flex;
  flex-direction: row;
  gap: 2px;
  /* DM3 (design MAJOR): explicit width so offsetWidth in #position() returns a stable non-zero
   * value pre-paint. Without this, clamp formula uses 0 → effectively disabled on narrow viewports.
   * 256px fits 6 emojis at 36px each + gap + padding. */
  width: 256px;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.50),
    0 4px 12px rgba(0, 0, 0, 0.25),
    0 2px 4px rgba(0, 0, 0, 0.15);
}

:host([data-theme='dark']) .oxp-reaction-quick-bar {
  /* F1: dark theme — rgba(255,255,255,0.50) on #1c1c1e → 4.39:1 PASS */
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.50),
    0 4px 12px rgba(0, 0, 0, 0.60);
}

@media (prefers-color-scheme: dark) {
  :host([data-theme='auto']) .oxp-reaction-quick-bar,
  :host(:not([data-theme])) .oxp-reaction-quick-bar {
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.50),
      0 4px 12px rgba(0, 0, 0, 0.60);
  }
}

.oxp-reaction-quick-bar-button {
  min-width: 36px;
  min-height: 36px;
  background: none;
  border: 1px solid transparent;
  border-radius: calc(var(--oxp-radius) * 0.5);
  cursor: pointer;
  font-size: 1.2rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
}

@media (hover: none) {
  .oxp-reaction-quick-bar-button {
    min-width: 44px;
    min-height: 44px;
  }
  /* M1 (carried into the heart-first redesign): the heart button is hidden
   * by opacity:0 with only :hover reveal — invisible on touch without this.
   * M3/M4: heart-btn and chips fail Apple HIG 44px on mobile.
   * Merged into one declaration to avoid duplicate selector (prior had split opacity + size). */
  .oxp-reaction-heart-btn { opacity: 1; min-height: 44px; min-width: 44px; }
  .oxp-reaction-chip { min-height: 44px; }
  /* W7: reply button visible + 44px touch target on mobile. */
  .oxp-reply-btn { opacity: 1; min-height: 44px; min-width: 44px; }
  /* DM1: cancel/retry buttons must meet Apple HIG 44px touch target on mobile. */
  .oxp-attachment-cancel,
  .oxp-attachment-retry { min-height: 44px; min-width: 44px; }
}

.oxp-reaction-quick-bar-button:hover,
.oxp-reaction-quick-bar-button:focus {
  background: var(--oxp-border);
}

.oxp-reaction-quick-bar-button:focus-visible {
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
}

/* ── Reactions quick-bar MOTION (spec 2026-07-14) ──
 * Bar scale/fade in; each emoji button staggers in on top of that (6 fixed
 * REACTION_EMOJIS slots — nth-child delays need no JS). Stagger span (last
 * delay 75ms + each button's own 100ms) ≈ 175ms, within the ~120-180ms
 * budget. Select fires a burst/scale-pop on the chosen button before
 * ReactionQuickBar's own SELECT_DISMISS_DELAY_MS-timed removal. */
@keyframes oxp-quickbar-in {
  from { opacity: 0; transform: scale(0.85); }
  to { opacity: 1; transform: scale(1); }
}

.oxp-reaction-quick-bar {
  animation: oxp-quickbar-in 140ms ease-out;
}

@keyframes oxp-quickbar-button-in {
  from { opacity: 0; transform: scale(0.5); }
  to { opacity: 1; transform: scale(1); }
}

.oxp-reaction-quick-bar-button {
  animation: oxp-quickbar-button-in 100ms ease-out backwards;
}

.oxp-reaction-quick-bar-button:nth-child(1) { animation-delay: 0ms; }
.oxp-reaction-quick-bar-button:nth-child(2) { animation-delay: 15ms; }
.oxp-reaction-quick-bar-button:nth-child(3) { animation-delay: 30ms; }
.oxp-reaction-quick-bar-button:nth-child(4) { animation-delay: 45ms; }
.oxp-reaction-quick-bar-button:nth-child(5) { animation-delay: 60ms; }
.oxp-reaction-quick-bar-button:nth-child(6) { animation-delay: 75ms; }

@keyframes oxp-quickbar-burst {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.35); }
  100% { transform: scale(1); }
}

.oxp-reaction-quick-bar-button--burst {
  animation: oxp-quickbar-burst 160ms ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .oxp-reaction-quick-bar {
    animation: none;
  }
  .oxp-reaction-quick-bar-button {
    animation: none;
  }
  .oxp-reaction-quick-bar-button--burst {
    animation: none;
  }
}

/* B2: Inline error chip */
.oxp-composer-error {
  font-family: var(--oxp-font);
  font-size: 0.85rem;
  color: var(--oxp-danger);
  padding: calc(var(--oxp-spacing-unit) * 0.5) var(--oxp-spacing-unit);
  display: flex;
  align-items: center;
  gap: var(--oxp-spacing-unit);
}

/* ── W2.2 slice 4: Attachment styles ──────────────────────────────────────── */

/* Paperclip button — 40px desktop baseline, 44px mobile (1I) */
.oxp-composer-attachment-btn {
  font-family: var(--oxp-font);
  min-width: 40px;
  min-height: 40px;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--oxp-radius);
  cursor: pointer;
  font-size: 1.1rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 calc(var(--oxp-spacing-unit) * 0.5);
  color: var(--oxp-fg-secondary);
  flex-shrink: 0;
}

.oxp-composer-attachment-btn:hover {
  background: var(--oxp-border);
  color: var(--oxp-fg);
}

.oxp-composer-attachment-btn:focus-visible {
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
}

@media (hover: none) {
  .oxp-composer-attachment-btn { min-width: 44px; min-height: 44px; }
}

/* Drag-over visual indicator — DM2: color-only outline fails WCAG 1.4.1.
 * Add ::after overlay with text label for non-color signal. */
.oxp-composer-dragover {
  outline: 2px solid var(--oxp-accent);
  outline-offset: -2px;
  border-radius: var(--oxp-radius);
  position: relative;
}

.oxp-composer-dragover::after {
  content: 'Drop files here';
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.70);
  color: #ffffff;
  font-family: var(--oxp-font);
  font-size: 0.9rem;
  font-weight: 600;
  border-radius: var(--oxp-radius);
  pointer-events: none;
  z-index: 1;
}

/* Upload queue popover — DM3: position:absolute so it doesn't displace composer flex layout.
 * DB2: box-shadow 0 0 0 1px discrete ring (same pattern as reaction picker — F1 WCAG 1.4.11).
 *   Light: rgba(0,0,0,0.50) on #fff → rgb(128,128,128) → 3.95:1 PASS.
 *   Dark:  rgba(255,255,255,0.50) on #1c1c1e → rgb(141,141,142) → 4.39:1 PASS. */
.oxp-attachment-queue {
  font-family: var(--oxp-font);
  background: var(--oxp-bg);
  border: 1px solid var(--oxp-border);
  border-radius: var(--oxp-radius);
  padding: calc(var(--oxp-spacing-unit) * 0.5);
  display: flex;
  flex-direction: column;
  gap: calc(var(--oxp-spacing-unit) * 0.5);
  max-height: 200px;
  overflow-y: auto;
  position: absolute;
  bottom: 100%;
  left: 0;
  right: 0;
  z-index: 10;
  box-shadow:
    0 0 0 1px rgba(0, 0, 0, 0.50),
    0 4px 12px rgba(0, 0, 0, 0.25),
    0 2px 4px rgba(0, 0, 0, 0.15);
}

:host([data-theme='dark']) .oxp-attachment-queue {
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.50),
    0 4px 12px rgba(0, 0, 0, 0.60);
}

@media (prefers-color-scheme: dark) {
  :host([data-theme='auto']) .oxp-attachment-queue,
  :host(:not([data-theme])) .oxp-attachment-queue {
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.50),
      0 4px 12px rgba(0, 0, 0, 0.60);
  }
}

/* Per-file row */
.oxp-attachment-item {
  display: flex;
  align-items: center;
  gap: calc(var(--oxp-spacing-unit) * 0.5);
  font-size: 0.85rem;
  color: var(--oxp-fg);
}

.oxp-attachment-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Progress bar — DB4: indeterminate animation (SDK has no real progress callback yet).
 * role="progressbar" + aria-valuetext="Uploading…" set in JS (no aria-valuenow). */
.oxp-attachment-progress {
  position: relative;
  overflow: hidden;
  background: var(--oxp-border);
  height: 4px;
  border-radius: 2px;
}

.oxp-attachment-progress::after {
  content: '';
  position: absolute;
  inset: 0;
  width: 40%;
  background: var(--oxp-accent);
  animation: oxp-progress-indeterminate 1.4s ease-in-out infinite;
}

@keyframes oxp-progress-indeterminate {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}

@media (prefers-reduced-motion: reduce) {
  .oxp-attachment-progress::after {
    animation: none;
    opacity: 0.5;
  }
}

.oxp-attachment-error {
  color: var(--oxp-danger);
  font-size: 0.8rem;
  flex: 1;
}

.oxp-attachment-cancel,
.oxp-attachment-retry {
  font-family: var(--oxp-font);
  font-size: 0.75rem;
  background: none;
  border: 1px solid var(--oxp-border);
  border-radius: calc(var(--oxp-radius) * 0.5);
  cursor: pointer;
  padding: 2px 6px;
  color: var(--oxp-fg-secondary);
  flex-shrink: 0;
}

.oxp-attachment-cancel:hover,
.oxp-attachment-retry:hover { background: var(--oxp-border); }

.oxp-attachment-cancel:focus-visible,
.oxp-attachment-retry:focus-visible {
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
}

/* Bubble attachment container */
.oxp-bubble-attachments {
  display: flex;
  flex-direction: column;
  gap: calc(var(--oxp-spacing-unit) * 0.5);
  margin-top: calc(var(--oxp-spacing-unit) * 0.5);
}

/* Inline image */
.oxp-attachment-image img {
  max-width: 300px;
  max-height: 400px;
  border-radius: var(--oxp-radius);
  display: block;
  object-fit: contain;
}

/* Audio */
.oxp-attachment-audio audio { width: 100%; display: block; }

/* File download link — DB1: use --oxp-link (WCAG ≥4.5:1 on all bubble backgrounds).
 * Permanent underline (not hover-only) for WCAG 1.4.1 non-color link differentiation. */
.oxp-attachment-file {
  font-family: var(--oxp-font);
  font-size: 0.9rem;
  color: var(--oxp-link);
  text-decoration: underline;
  display: inline-flex;
  align-items: center;
  gap: calc(var(--oxp-spacing-unit) * 0.5);
}

.oxp-attachment-file:focus-visible {
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
  border-radius: 2px;
}

/* ── W2.2 slice 5: Reconnect banner ──────────────────────────────────────── */

/* Sticky banner above message list — z-index 5 sits above messages but below picker (10) */
.oxp-reconnect-banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: var(--oxp-spacing-unit);
  padding: calc(var(--oxp-spacing-unit) * 0.75) var(--oxp-spacing-unit);
  font-family: var(--oxp-font);
  font-size: 0.85rem;
  color: var(--oxp-fg);
  box-sizing: border-box;
  /* DM4 (design MAJOR): 4-side ring guarantees boundary regardless of host page bg.
   * Prior patch used bottom-only shadow assuming host contrasts on other 3 sides — not guaranteed.
   * Fix: restore full all-sides 0 0 0 1px ring.
   * Light: rgba(0,0,0,0.50) → rgb(128,128,128) → 3.95:1 PASS.
   * Structural separator is now the ring alone (no redundant directional rule). */
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.50);
}

:host([data-theme='dark']) .oxp-reconnect-banner {
  /* DM4: dark 4-side ring. rgba(255,255,255,0.50) → 4.39:1 PASS */
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.50);
}

@media (prefers-color-scheme: dark) {
  :host([data-theme='auto']) .oxp-reconnect-banner,
  :host(:not([data-theme])) .oxp-reconnect-banner {
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.50);
  }
}

/* Reconnecting state — accent-tinted background */
.oxp-reconnect-banner[data-state='reconnecting'] {
  background: color-mix(in srgb, var(--oxp-accent) 15%, var(--oxp-bg));
}

/* Auth-expired state — danger accent */
.oxp-reconnect-banner[data-state='auth-expired'] {
  background: color-mix(in srgb, var(--oxp-danger) 12%, var(--oxp-bg));
  color: var(--oxp-fg);
}

/* Connected toast — green tint via --oxp-success token (Design M5) */
.oxp-reconnect-banner[data-state='connected'] {
  background: color-mix(in srgb, var(--oxp-success) 15%, var(--oxp-bg));
}

/* 1I: 40px desktop baseline for reconnect button */
.oxp-reconnect-btn {
  font-family: var(--oxp-font);
  font-size: 0.85rem;
  padding: calc(var(--oxp-spacing-unit) * 0.5) var(--oxp-spacing-unit);
  min-height: 40px;
  background: var(--oxp-accent);
  color: var(--oxp-on-accent);
  border: none;
  border-radius: calc(var(--oxp-radius) * 0.5);
  cursor: pointer;
  flex-shrink: 0;
}

.oxp-reconnect-btn:focus-visible {
  /* Design B1 (WCAG 2.4.11 BLOCKER): button bg = --oxp-accent, plain outline invisible.
   * Double-ring pattern: outline (inner) + box-shadow 4px outer ring using --oxp-fg.
   * Same pattern as slice 3 .oxp-reaction-chip:focus-visible. */
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
  box-shadow: 0 0 0 4px var(--oxp-fg);
}

@media (hover: none) {
  /* DM1: touch targets ≥44px on mobile */
  .oxp-reconnect-btn { min-height: 44px; }
}

/* W9: product card inside message bubble */
.oxp-bubble-product {
  display: flex;
  flex-direction: column;
  gap: calc(var(--oxp-spacing-unit) * 0.5);
  margin-top: calc(var(--oxp-spacing-unit) * 0.5);
  padding: var(--oxp-spacing-unit);
  border: 1px solid var(--oxp-border);
  border-radius: var(--oxp-radius);
  background: var(--oxp-bg);
  color: var(--oxp-fg);
  max-width: 300px;
  font-family: var(--oxp-font);
}

.oxp-product-image {
  width: 100%;
  height: auto;
  max-height: 200px;
  object-fit: contain;
  border-radius: calc(var(--oxp-radius) * 0.5);
}

.oxp-product-title {
  font-weight: 600;
  font-size: 0.95rem;
  line-height: 1.3;
}

.oxp-product-price {
  font-size: 0.9rem;
  /* design-empirical review of starthey.com/demo 2026-07-14: same latent
   * --oxp-muted-on-tinted-bg contrast issue as .oxp-bubble-time above — the
   * product card renders inside a message bubble (:1116). --oxp-fg-secondary
   * is this file's designated on-bubble text token; see its doc comment at
   * :40-44 / :95-98. */
  color: var(--oxp-fg-secondary);
}

.oxp-product-link {
  font-size: 0.85rem;
  color: var(--oxp-link);
  text-decoration: underline;
  align-self: flex-start;
}

.oxp-product-link:focus-visible {
  outline: 2px solid var(--oxp-accent);
  outline-offset: 2px;
  border-radius: 2px;
}
`;

/** Resolve theme attribute → 'light' | 'dark' | 'auto'. */
/** @internal Not part of the package's public API surface; not re-exported from index.ts. Kept exported for cross-file use within the package. */
export function resolveTheme(themeAttr: string | null): 'light' | 'dark' | 'auto' {
  const t = themeAttr ?? 'auto';
  if (t === 'light' || t === 'dark') return t;
  return 'auto';
}

/** Apply data-theme to host element.
 *  M11: 'auto' writes data-theme='auto' and lets CSS @media handle live
 *  switching — no matchMedia snapshot, no listener leak. */
export function applyTheme(host: HTMLElement, themeAttr: string | null): void {
  const t = themeAttr ?? 'auto';
  if (t === 'light' || t === 'dark') {
    host.setAttribute('data-theme', t);
    return;
  }
  // auto — write 'auto' so @media (prefers-color-scheme) applies live
  host.setAttribute('data-theme', 'auto');
}
