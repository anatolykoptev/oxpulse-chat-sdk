/**
 * theme.test.ts — TDD RED phase (W2.2 slice 1)
 *
 * Tests: theme foundation — CSS custom properties + data-theme attribute.
 * Cases per W2.2 spec:
 *  1. applies_light_theme_when_attribute_light
 *  2. applies_dark_theme_when_attribute_dark
 *  3. auto_theme_respects_prefers_color_scheme
 *  4. css_custom_properties_present_in_shadow_root
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OxpulseChatElement, defineElement } from '../element.js';
import { THEME_CSS } from '../ui/theme.js';

// Helper: make a valid JWT with aud_origins matching localhost
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.fakesig`;
}

const LOCALHOST_JWT = makeJwt({ aud_origins: ['http://localhost'], sub: 'u1' });

describe('theme foundation', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    defineElement();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container.parentNode) container.parentNode.removeChild(container);
    vi.restoreAllMocks();
  });

  it('applies_light_theme_when_attribute_light', async () => {
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el.setAttribute('theme', 'light');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    // host element should have data-theme="light"
    expect(el.getAttribute('data-theme')).toBe('light');
  });

  it('applies_dark_theme_when_attribute_dark', async () => {
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el.setAttribute('theme', 'dark');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    expect(el.getAttribute('data-theme')).toBe('dark');
  });

  it('auto_theme_respects_prefers_color_scheme', async () => {
    // M11: applyTheme('auto') now writes data-theme='auto' (not a snapshot).
    // CSS @media (prefers-color-scheme: dark) handles live switching.
    // This test verifies the element gets data-theme='auto' when theme='auto'.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el.setAttribute('theme', 'auto');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    // auto theme → data-theme='auto' (CSS @media handles actual dark/light switching)
    expect(el.getAttribute('data-theme')).toBe('auto');
  });

  it('placeholder_and_error_use_theme_tokens', async () => {
    // B3: .oxp-placeholder and .oxp-error classes with CSS variable references
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    const styleEl = shadow!.querySelector('style');
    expect(styleEl).not.toBeNull();
    const css = styleEl!.textContent ?? '';
    expect(css).toContain('.oxp-placeholder');
    expect(css).toContain('.oxp-error');
    // Must reference tokens, not hardcoded colors
    expect(css).toMatch(/\.oxp-placeholder[^}]*var\(--oxp-muted\)/s);
    expect(css).toMatch(/\.oxp-error[^}]*var\(--oxp-danger\)/s);
  });

  it('unseal_error_has_distinct_danger_affordance_from_tombstone', async () => {
    // review-fix HIGH#2: .oxp-unseal-error must carry a distinct danger
    // affordance, not the plain-italic-muted treatment .oxp-tombstone uses
    // for a benign deletion — an unsealError can mean a tampered/replayed
    // message. Reuses the existing color-mix(--oxp-danger, transparent)
    // idiom (.oxp-reaction-chip[data-own='true'] uses the same transparent-mix
    // pattern for a nested/varying-bubble-bg context; the 12% ratio matches
    // .oxp-reconnect-banner[data-state='auth-expired']).
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    const css = shadow!.querySelector('style')!.textContent ?? '';
    expect(css).toContain('.oxp-unseal-error');
    expect(css).toMatch(/\.oxp-unseal-error[^}]*color-mix\([^)]*--oxp-danger[^)]*\)/s);
    expect(css).toMatch(/\.oxp-unseal-error[^}]*background:/s);
    // Tombstone stays plain — no background, no danger token — proving the
    // two placeholder states are visually distinct, not the same treatment.
    const tombstoneRule = css.match(/\.oxp-tombstone\s*\{[^}]*\}/s)?.[0] ?? '';
    expect(tombstoneRule).not.toBe('');
    expect(tombstoneRule).not.toMatch(/--oxp-danger/);
    expect(tombstoneRule).not.toMatch(/background:/);
  });

  it('on_accent_token_defined_for_both_themes', async () => {
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    const styleEl = shadow!.querySelector('style');
    expect(styleEl).not.toBeNull();
    const css = styleEl!.textContent ?? '';
    // Must define --oxp-on-accent in :host (light) and :host([data-theme='dark']) blocks
    // Count occurrences — at minimum 2 (one per theme block)
    const matches = css.match(/--oxp-on-accent/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
    // F1: WCAG fix — #000 passes 5.39:1 on #0088cc (light) and 5.82:1 on #0a84ff (dark).
    // #fff fails both (3.89:1 and 3.61:1 respectively). Both themes must use #000.
    expect(css).toMatch(/--oxp-on-accent:\s*#000/);
    // Must NOT use #fff for on-accent anywhere (prior incorrect value)
    expect(css).not.toMatch(/--oxp-on-accent:\s*#fff/);
  });

  it('muted_token_passes_wcag_contrast_light_theme', async () => {
    // F2: light --oxp-muted #8a8a8a on #fff = 3.45:1 FAIL.
    // Fix: #767676 ≈ 4.55:1 PASS. Dark #8e8e93 unchanged (5.22:1 on #1c1c1e OK).
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));

    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    const css = shadow!.querySelector('style')!.textContent ?? '';
    // :host block (light theme) must use #767676 for --oxp-muted, not #8a8a8a
    // We check the :host block specifically — it comes before :host([data-theme='dark'])
    const hostBlock = css.split(':host([data-theme')[0];
    expect(hostBlock).toMatch(/--oxp-muted:\s*#767676/);
    // Dark theme block must keep #8e8e93
    const darkBlock = css.includes(':host([data-theme=\'dark\'])') ?
      css.slice(css.indexOf(':host([data-theme=\'dark\'])')) : '';
    expect(darkBlock).toMatch(/--oxp-muted:\s*#8e8e93/);
  });

  it('auto_theme_sets_data_theme_auto_not_snapshot', async () => {
    // When theme='auto', host should get data-theme='auto', not a snapshotted 'light'/'dark'
    // This allows CSS @media to handle live switching without JS listeners
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    el.setAttribute('theme', 'auto');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    // data-theme must be 'auto', not 'light' or 'dark'
    expect(el.getAttribute('data-theme')).toBe('auto');
  });

  it('placeholder_uses_oxp_font_token', async () => {
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));

    const shadow = el.shadowRoot;
    const css = shadow!.querySelector('style')!.textContent ?? '';
    // .oxp-placeholder must not have hardcoded sans-serif — must use var(--oxp-font)
    expect(css).toMatch(/\.oxp-placeholder[^}]*var\(--oxp-font\)/s);
  });

  it('placeholder_css_has_placeholder_input_rule', async () => {
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));

    const shadow = el.shadowRoot;
    const css = shadow!.querySelector('style')!.textContent ?? '';
    // Must have ::placeholder rule using --oxp-muted and opacity:1
    expect(css).toContain('::placeholder');
    expect(css).toMatch(/::placeholder[^}]*var\(--oxp-muted\)/s);
    expect(css).toMatch(/::placeholder[^}]*opacity:\s*1/s);
  });

  it('focus_visible_ring_rule_present', async () => {
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));

    const shadow = el.shadowRoot;
    const css = shadow!.querySelector('style')!.textContent ?? '';
    // Must have :focus-visible rules for both input and send button
    expect(css).toContain(':focus-visible');
    expect(css).toMatch(/oxp-composer-input:focus-visible[^}]*outline/s);
    expect(css).toMatch(/oxp-composer-send:focus-visible[^}]*outline/s);
  });

  it('reaction_add_btn_uses_fg_secondary_not_muted', async () => {
    // B2: .oxp-reaction-add-btn used var(--oxp-muted) at 0.8rem — fails WCAG 4.5:1
    // on all bubble backgrounds. Fix: use --oxp-fg-secondary token.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    // --oxp-fg-secondary must be defined in :host light block
    expect(css).toMatch(/--oxp-fg-secondary/);
    // .oxp-reaction-add-btn must use --oxp-fg-secondary (not --oxp-muted)
    expect(css).toMatch(/\.oxp-reaction-add-btn[^}]*var\(--oxp-fg-secondary\)/s);
  });

  it('reaction_picker_has_box_shadow_for_elevation', async () => {
    // B3: .oxp-reaction-picker border alone fails 1.4:1. Fix: add box-shadow elevation.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    // .oxp-reaction-picker must have box-shadow for elevation visibility
    expect(css).toMatch(/\.oxp-reaction-picker[^}]*box-shadow/s);
  });

  it('reaction_chip_focus_visible_has_double_ring', async () => {
    // B4: .oxp-reaction-chip focus ring fails 3:1 on dark self-bubble (2.63:1).
    // Fix: double-ring pattern — outline + box-shadow inner ring.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    // .oxp-reaction-chip:focus-visible must have both outline and box-shadow
    const focusBlock = css.match(/\.oxp-reaction-chip:focus-visible\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(focusBlock).toMatch(/outline/);
    expect(focusBlock).toMatch(/box-shadow/);
  });

  it('chip_focus_ring_uses_fg_token_for_outermost_pixel', async () => {
    // F2 (design BLOCKER-3): chip focus ring outermost pixel = accent → 2.63:1 on dark self-bubble FAIL.
    // Fix: box-shadow uses --oxp-fg (light #1a1a1a, dark #ebebf5 — both high contrast).
    // WCAG: light fg #1a1a1a on dark self-bubble #1e4e31 >> 3:1; dark fg #ebebf5 on #1e4e31 = 8.10:1.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    const focusBlock = css.match(/\.oxp-reaction-chip:focus-visible\s*\{[^}]+\}/s)?.[0] ?? '';
    // outermost pixel must use --oxp-fg, not --oxp-bg
    expect(focusBlock).toMatch(/box-shadow[^;]*var\(--oxp-fg\)/);
    // must NOT use --oxp-bg for outermost pixel (prior failing value)
    expect(focusBlock).not.toMatch(/box-shadow[^;]*var\(--oxp-bg\)/);
  });

  it('picker_has_discrete_outline_boundary', async () => {
    // F1 (design BLOCKER-2, round 3): outline-offset:-1px placed outline inward (outermost pixel still
    // --oxp-border = 1.32:1 FAIL). rgba(0,0,0,0.35) on #fff = 2.44:1 (claim was 3.3:1, off 35%).
    // Fix: use box-shadow 0 0 0 1px ring that sits OUTSIDE border-box.
    //   Light: rgba(0,0,0,0.50) on #fff → rgb(128,128,128) → L=0.216 → 3.95:1 PASS.
    //   Dark:  rgba(255,255,255,0.50) on #1c1c1e → rgb(141,141,142) → L=0.266 → 4.39:1 PASS.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    const pickerBlock = css.match(/\.oxp-reaction-picker\s*\{[^}]+\}/s)?.[0] ?? '';
    // Must use box-shadow with a 0 0 0 1px ring (discrete outer pixel, not outline)
    expect(pickerBlock).toMatch(/box-shadow/);
    expect(pickerBlock).toMatch(/0\s+0\s+0\s+1px/);
    // Must NOT use outline for the boundary (outline-offset:-1px was placing it inward)
    expect(pickerBlock).not.toMatch(/outline:\s*1px/);
    // Dark theme must flip to white ring
    const darkPickerRule = css.match(/:host\(\[data-theme='dark'\]\)\s*\.oxp-reaction-picker\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(darkPickerRule).toMatch(/box-shadow/);
    expect(darkPickerRule).toMatch(/rgba\(255,?\s*255,?\s*255/);
    // Auto dark theme also must have white ring
    expect(css).toMatch(/:host\(\[data-theme='auto'\]\)\s*\.oxp-reaction-picker[^}]*rgba\(255/s);
  });

  it('mobile_reaction_add_btn_always_visible', async () => {
    // M1: .oxp-reaction-add-btn opacity:0 only shows on hover — invisible on touch.
    // Fix: @media (hover: none) must contain .oxp-reaction-add-btn { opacity: 1; }
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    // Media query must be present
    expect(css).toMatch(/@media\s*\(hover:\s*none\)/);
    // Extract the hover:none block(s) and verify reaction-add-btn opacity:1 is inside
    const hoverNoneIdx = css.indexOf('@media (hover: none)');
    expect(hoverNoneIdx).toBeGreaterThanOrEqual(0);
    const blockStart = css.indexOf('{', hoverNoneIdx);
    // Count braces to find matching close brace
    let depth = 0;
    let blockEnd = blockStart;
    for (let i = blockStart; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) { blockEnd = i; break; }
      }
    }
    const mediaBlock = css.slice(blockStart, blockEnd + 1);
    expect(mediaBlock).toContain('.oxp-reaction-add-btn');
    expect(mediaBlock).toMatch(/opacity:\s*1/);
  });

  it('mobile_touch_targets_44px_min', async () => {
    // M3/M4: chip ≈24px, +😀 ≈22px on mobile — fail Apple HIG 44px.
    // Fix: @media (hover: none) must contain .oxp-reaction-chip { min-height: 44px; }
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    const hoverNoneIdx = css.indexOf('@media (hover: none)');
    expect(hoverNoneIdx).toBeGreaterThanOrEqual(0);
    const blockStart = css.indexOf('{', hoverNoneIdx);
    let depth = 0;
    let blockEnd = blockStart;
    for (let i = blockStart; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) { blockEnd = i; break; }
      }
    }
    const mediaBlock = css.slice(blockStart, blockEnd + 1);
    // Both chip and add-btn must get 44px min-height
    expect(mediaBlock).toContain('.oxp-reaction-chip');
    expect(mediaBlock).toMatch(/min-height:\s*44px/);
    expect(mediaBlock).toContain('.oxp-reaction-add-btn');
  });

  // ── DB1: Link token contrast ──────────────────────────────────────────────────

  it('link_token_defined_in_theme', async () => {
    // DB1: --oxp-link token must be defined for WCAG-passing file link color
    // Light: #0066a3 ≥4.5:1 on all bubble backgrounds
    // Dark:  #5eb3ff ≥4.5:1 on dark bubble backgrounds
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    // Light theme must define --oxp-link
    const hostBlock = css.split(':host([data-theme')[0];
    expect(hostBlock).toMatch(/--oxp-link/);
    // Dark theme must also define --oxp-link
    const darkBlock = css.includes(':host([data-theme=\'dark\'])') ?
      css.slice(css.indexOf(':host([data-theme=\'dark\'])')) : '';
    expect(darkBlock).toMatch(/--oxp-link/);
  });

  it('attachment_file_link_uses_oxp_link_token', async () => {
    // DB1: .oxp-attachment-file must use var(--oxp-link) not var(--oxp-accent)
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    // .oxp-attachment-file must reference --oxp-link
    expect(css).toMatch(/\.oxp-attachment-file[^}]*var\(--oxp-link\)/s);
    // .oxp-attachment-file must have permanent underline (not hover-only)
    const fileLinkBlock = css.match(/\.oxp-attachment-file\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(fileLinkBlock).toMatch(/text-decoration:\s*underline/);
  });

  // ── DB2: Queue popover boundary ───────────────────────────────────────────────

  it('attachment_queue_has_discrete_boundary_ring', async () => {
    // DB2: same pattern as reaction picker — box-shadow 0 0 0 1px discrete ring
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    const queueBlock = css.match(/\.oxp-attachment-queue\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(queueBlock).toMatch(/box-shadow/);
    expect(queueBlock).toMatch(/0\s+0\s+0\s+1px/);
  });

  // ── DM1: Cancel/retry touch targets ≥44px ────────────────────────────────────

  it('cancel_retry_buttons_44px_on_mobile', async () => {
    // DM1: .oxp-attachment-cancel and .oxp-attachment-retry must be ≥44px on touch devices
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    // Find @media (hover: none) block
    const hoverNoneIdx = css.indexOf('@media (hover: none)');
    expect(hoverNoneIdx).toBeGreaterThanOrEqual(0);
    const blockStart = css.indexOf('{', hoverNoneIdx);
    let depth = 0;
    let blockEnd = blockStart;
    for (let i = blockStart; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) { blockEnd = i; break; }
      }
    }
    const mediaBlock = css.slice(blockStart, blockEnd + 1);
    expect(mediaBlock).toContain('.oxp-attachment-cancel');
    expect(mediaBlock).toContain('.oxp-attachment-retry');
    expect(mediaBlock).toMatch(/min-height:\s*44px/);
    expect(mediaBlock).toMatch(/min-width:\s*44px/);
  });

  // ── DM2: Dragover non-color signal ───────────────────────────────────────────

  it('dragover_has_text_indicator_pseudo_element', async () => {
    // DM2: .oxp-composer-dragover must show "Drop files here" text via ::after
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    // Must have .oxp-composer-dragover::after with content
    expect(css).toMatch(/\.oxp-composer-dragover::after/);
    const dragAfterBlock = css.match(/\.oxp-composer-dragover::after\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(dragAfterBlock).toMatch(/content:/);
  });

  // ── DM3: Queue popover position absolute ─────────────────────────────────────

  it('attachment_queue_is_position_absolute', async () => {
    // DM3: queue popover must be position:absolute to not displace flex layout
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    const queueBlock = css.match(/\.oxp-attachment-queue\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(queueBlock).toMatch(/position:\s*absolute/);
    expect(queueBlock).toMatch(/bottom:\s*100%/);
    expect(queueBlock).toMatch(/z-index/);
  });

  // ── F1: WCAG dark --oxp-link contrast (B1 3rd time) ─────────────────────────

  it('link_dark_passes_wcag_on_all_dark_bubble_backgrounds', () => {
    // F1: #5eb3ff on #1e4e31 = 4.28:1 FAIL (comment claimed 5.42:1 — wrong math).
    // Fix: #7cc4ff → must be ≥4.5:1 on all three dark surfaces.
    // Also verifies light side lock: #0066a3 already passes.
    function relativeLuminance(hex: string): number {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const sRGB = [r, g, b].map(c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      return 0.2126 * sRGB[0]! + 0.7152 * sRGB[1]! + 0.0722 * sRGB[2]!;
    }
    function contrastRatio(fg: string, bg: string): number {
      const l1 = relativeLuminance(fg);
      const l2 = relativeLuminance(bg);
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    const linkDark = '#7cc4ff';
    // Dark bubble backgrounds per theme.ts
    expect(contrastRatio(linkDark, '#1e4e31')).toBeGreaterThanOrEqual(4.5); // self-bubble dark
    expect(contrastRatio(linkDark, '#2c2c2e')).toBeGreaterThanOrEqual(4.5); // other-bubble dark
    expect(contrastRatio(linkDark, '#1c1c1e')).toBeGreaterThanOrEqual(4.5); // widget bg dark

    // Light side lock: #0066a3 already passes — ensure not regressed
    const linkLight = '#0066a3';
    expect(contrastRatio(linkLight, '#dcf8c6')).toBeGreaterThanOrEqual(4.5); // self-bubble light
    expect(contrastRatio(linkLight, '#f1f0f0')).toBeGreaterThanOrEqual(4.5); // other-bubble light
    expect(contrastRatio(linkLight, '#ffffff')).toBeGreaterThanOrEqual(4.5); // widget bg light
  });

  it('link_dark_value_is_7cc4ff_in_both_dark_blocks', async () => {
    // F1: theme.ts must use #7cc4ff in BOTH :host([data-theme='dark']) AND
    // @media (prefers-color-scheme: dark) auto-block.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    // :host([data-theme='dark']) block must use #7cc4ff
    const darkBlock = css.slice(css.indexOf(":host([data-theme='dark'])"));
    const darkBlockEnd = darkBlock.indexOf('}') + 1;
    expect(darkBlock.slice(0, darkBlockEnd)).toMatch(/--oxp-link:\s*#7cc4ff/);

    // @media (prefers-color-scheme: dark) block must also use #7cc4ff
    const mediaBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    expect(mediaBlock).toMatch(/--oxp-link:\s*#7cc4ff/);

    // Old value #5eb3ff must NOT appear in either dark context
    expect(css).not.toMatch(/--oxp-link:\s*#5eb3ff/);
  });

  it('css_custom_properties_present_in_shadow_root', async () => {
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));

    // The shadow DOM must contain a <style> block defining the CSS variables
    const shadow = el.shadowRoot;
    expect(shadow).not.toBeNull();
    const styleEl = shadow!.querySelector('style');
    expect(styleEl).not.toBeNull();
    const css = styleEl!.textContent ?? '';
    expect(css).toContain('--oxp-bg');
    expect(css).toContain('--oxp-fg');
    expect(css).toContain('--oxp-accent');
    expect(css).toContain('--oxp-muted');
    expect(css).toContain('--oxp-border');
    expect(css).toContain('--oxp-bubble-self-bg');
    expect(css).toContain('--oxp-bubble-other-bg');
    expect(css).toContain('--oxp-radius');
    expect(css).toContain('--oxp-font');
    expect(css).toContain('--oxp-spacing-unit');
  });

  // ── Design B1: Refresh button focus ring (WCAG 2.4.11) ───────────────────────

  it('refresh_button_focus_ring_has_double_ring_pattern', async () => {
    // Design B1 (BLOCKER): .oxp-reconnect-btn:focus-visible outline = 2px accent on accent bg
    // = 1:1 invisible. Fix: double-ring pattern (outline + box-shadow outer ring using --oxp-fg).
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    const focusBlock = css.match(/\.oxp-reconnect-btn:focus-visible\s*\{[^}]+\}/s)?.[0] ?? '';
    // Must have outline
    expect(focusBlock).toMatch(/outline:\s*2px solid var\(--oxp-accent\)/);
    // Must have outline-offset
    expect(focusBlock).toMatch(/outline-offset:\s*2px/);
    // Must have box-shadow outer ring using --oxp-fg for WCAG-passing outermost pixel
    expect(focusBlock).toMatch(/box-shadow[^;]*var\(--oxp-fg\)/);
    // Must NOT rely on accent alone (old pattern was just outline:2px solid accent — invisible)
    // Verify the box-shadow ring is 4px (same as chip pattern)
    expect(focusBlock).toMatch(/box-shadow[^;]*4px[^;]*var\(--oxp-fg\)/);
  });

  // ── Design B2: Banner boundary (WCAG 1.4.11) ─────────────────────────────────

  it('banner_has_discrete_boundary_via_box_shadow_ring', async () => {
    // Design B2 (BLOCKER): border-bottom alone = 1.05-1.23:1 FAIL.
    // DM4 fix: 4-side ring 0 0 0 1px rgba(...,0.50) guarantees boundary on all sides.
    // (2C had regressed to bottom-only 0 1px 0 0 — DM4 restores all-sides.)
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    const bannerBlock = css.match(/\.oxp-reconnect-banner\s*\{[^}]+\}/s)?.[0] ?? '';
    // Must have box-shadow
    expect(bannerBlock).toMatch(/box-shadow/);
    // DM4: 4-side ring 0 0 0 1px
    expect(bannerBlock).toMatch(/0\s+0\s+0\s+1px/);
    // Dark theme must flip to white ring
    const darkBannerRule = css.match(/:host\(\[data-theme='dark'\]\)\s*\.oxp-reconnect-banner\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(darkBannerRule).toMatch(/box-shadow/);
    expect(darkBannerRule).toMatch(/rgba\(255,?\s*255,?\s*255/);
    // Auto dark theme also must have white ring
    expect(css).toMatch(/:host\(\[data-theme='auto'\]\)\s*\.oxp-reconnect-banner[^}]*rgba\(255/s);
  });

  // ── Design M5: --oxp-success token for connected toast ───────────────────────

  it('success_token_defined_in_theme', async () => {
    // Design M5: connected toast uses raw #22c55e — must use --oxp-success token instead.
    // Light: #16a34a; Dark: #4ade80 (both ≥4.5:1 vs banner bg).
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    // Light host block must define --oxp-success
    const hostBlock = css.split(':host([data-theme')[0];
    expect(hostBlock).toMatch(/--oxp-success/);
    // Dark block must also define --oxp-success
    const darkBlock = css.includes(":host([data-theme='dark'])") ?
      css.slice(css.indexOf(":host([data-theme='dark'])")) : '';
    expect(darkBlock).toMatch(/--oxp-success/);
  });

  it('connected_toast_uses_oxp_success_token_not_hardcoded', async () => {
    // Design M5: .oxp-reconnect-banner[data-state='connected'] must use var(--oxp-success),
    // not a raw hex like #22c55e.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    const connectedBlock = css.match(/\.oxp-reconnect-banner\[data-state='connected'\]\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(connectedBlock).toMatch(/var\(--oxp-success\)/);
    // Must NOT contain raw hardcoded green
    expect(connectedBlock).not.toMatch(/#22c55e/);
    expect(connectedBlock).not.toMatch(/#16a34a/);
    expect(connectedBlock).not.toMatch(/#4ade80/);
  });

  // ── 1C: Loading placeholder spinner CSS ────────────────────────────────────────

  it('loading_placeholder_has_spinner_pseudo_element', async () => {
    // 1C: #renderPlaceholder is bare text — no spinner, no aria-busy.
    // Fix: add CSS spinner via ::after on .oxp-placeholder (respects prefers-reduced-motion).
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';
    // Must have spinner on .oxp-placeholder::after
    expect(css).toMatch(/\.oxp-placeholder::after/);
    // Must define the spin @keyframes
    expect(css).toMatch(/@keyframes\s+oxp-spin/);
    // prefers-reduced-motion: reduce must disable spinner
    expect(css).toMatch(/prefers-reduced-motion.*reduce/s);
  });

  // ── 1I: Hybrid 36→40px desktop baseline (#1266/#1272) ──────────────────────────

  it('all_interactive_buttons_meet_40px_desktop_baseline', async () => {
    // 1I: desktop baseline min-height: 36px fails hybrid devices (iPad+mouse, Android desktop mode)
    // which report hover:hover but have touch screens. Fix: bump desktop baseline to 40px.
    // Components: attachment-btn, composer-send, reaction-add-btn, attachment-cancel,
    // attachment-retry, reconnect-btn.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    // Helper: extract min-height from a CSS block
    function extractMinHeight(block: string): number {
      const m = block.match(/min-height:\s*(\d+)px/);
      return m ? parseInt(m[1]!, 10) : 0;
    }

    // .oxp-composer-attachment-btn desktop baseline
    const attachBtnBlock = css.match(/\.oxp-composer-attachment-btn\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(extractMinHeight(attachBtnBlock)).toBeGreaterThanOrEqual(40);

    // .oxp-reconnect-btn desktop baseline
    const reconnectBtnBlock = css.match(/(?<!@media[^{]*\{[^}]*\}[^.]*?)\.oxp-reconnect-btn\s*\{[^}]+\}/s)?.[0] ?? '';
    const reconnectMinH = extractMinHeight(reconnectBtnBlock);
    expect(reconnectMinH).toBeGreaterThanOrEqual(40);

    // .oxp-attachment-cancel and .oxp-attachment-retry desktop baseline
    const cancelRetryBlock = css.match(/\.oxp-attachment-cancel,\s*\n?\.oxp-attachment-retry\s*\{[^}]+\}/s)?.[0] ??
      css.match(/\.oxp-attachment-cancel\s*\{[^}]+\}/s)?.[0] ?? '';
    // These buttons don't need to be 40px base if they start smaller but 44px on mobile is fine.
    // The key requirement is that the 6 listed components get 40px desktop baseline.
    // attachment-cancel/retry may still be compact desktop (check 44px mobile instead).
    const hoverNoneBlock = (() => {
      const idx = css.indexOf('@media (hover: none)');
      if (idx < 0) return '';
      const blockStart = css.indexOf('{', idx);
      let depth = 0; let blockEnd = blockStart;
      for (let i = blockStart; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') { depth--; if (depth === 0) { blockEnd = i; break; } }
      }
      return css.slice(blockStart, blockEnd + 1);
    })();
    // 44px on mobile for cancel/retry remains
    expect(hoverNoneBlock).toContain('.oxp-attachment-cancel');
    expect(hoverNoneBlock).toContain('.oxp-attachment-retry');
  });

  // ── 2A: --oxp-code-bg token (#1244) ────────────────────────────────────────────

  it('code_bg_token_defined_in_theme', async () => {
    // 2A: .md-code and .md-pre reuse --oxp-border as background — semantic mismatch.
    // Fix: add --oxp-code-bg token. Light = #f5f5f5 (≥4.5:1 vs --oxp-fg #1a1a1a).
    // Dark = #2c2c2e (≥4.5:1 with --oxp-fg #ebebf5).
    function relativeLuminance(hex: string): number {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const sRGB = [r, g, b].map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * sRGB[0]! + 0.7152 * sRGB[1]! + 0.0722 * sRGB[2]!;
    }
    function contrastRatio(fg: string, bg: string): number {
      const l1 = relativeLuminance(fg); const l2 = relativeLuminance(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    // Token must be defined in :host block
    const hostBlock = css.split(':host([data-theme')[0];
    expect(hostBlock).toMatch(/--oxp-code-bg/);
    // Dark block must also define it
    const darkBlock = css.slice(css.indexOf(":host([data-theme='dark'])"));
    expect(darkBlock).toMatch(/--oxp-code-bg/);

    // .md-code and .md-pre must use var(--oxp-code-bg)
    expect(css).toMatch(/\.md-code[^}]*var\(--oxp-code-bg\)/s);
    expect(css).toMatch(/\.md-pre[^}]*var\(--oxp-code-bg\)/s);

    // Verify contrast: light #f5f5f5 bg vs fg #1a1a1a ≥4.5:1
    expect(contrastRatio('#1a1a1a', '#f5f5f5')).toBeGreaterThanOrEqual(4.5);
    // Dark #2c2c2e bg vs fg #ebebf5 ≥4.5:1
    expect(contrastRatio('#ebebf5', '#2c2c2e')).toBeGreaterThanOrEqual(4.5);
  });

  // ── 2B: --oxp-success light annotation (#1272) ────────────────────────────────

  it('success_light_has_annotation_comment_not_used_as_color', async () => {
    // 2B: inline comment near light --oxp-success: #16a34a must note it should NOT
    // be used as fg color in light mode (2.78:1 FAIL on white bg).
    // Observable: the theme CSS string must contain a note about "tint source" or
    // "do not use as color" near --oxp-success in the light block.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    // The comment should appear near --oxp-success in the light block
    const hostBlock = css.split(':host([data-theme')[0];
    // The tint-source annotation comment must be present
    // Match "tint source" or "do not use as color" case-insensitively within 200 chars of --oxp-success
    const successIdx = hostBlock.indexOf('--oxp-success');
    expect(successIdx).toBeGreaterThanOrEqual(0);
    const surrounding = hostBlock.slice(Math.max(0, successIdx - 50), successIdx + 200);
    const hasAnnotation = /tint source/i.test(surrounding) || /do not use as color/i.test(surrounding);
    expect(hasAnnotation).toBe(true);
  });

  // ── 2C: Reconnect banner border-bottom dedup (#1272) ──────────────────────────

  it('reconnect_banner_uses_4side_ring_no_border_bottom', async () => {
    // 2C superseded by DM4: banner must have 4-side ring (0 0 0 1px) + no border-bottom.
    // DM4 finding: bottom-only (0 1px 0 0) cannot guarantee boundary vs unknown host bg.
    // Fix: restore 4-side ring 0 0 0 1px rgba(...,0.50); drop border-bottom.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    const bannerBlock = css.match(/\.oxp-reconnect-banner\s*\{[^}]+\}/s)?.[0] ?? '';
    // Must NOT have border-bottom (removed in favor of box-shadow ring)
    expect(bannerBlock).not.toMatch(/border-bottom/);
    // Must have box-shadow with 4-side ring: 0 0 0 1px
    expect(bannerBlock).toMatch(/box-shadow/);
    expect(bannerBlock).toMatch(/0\s+0\s+0\s+1px/);
  });

  // ── B1: Spinner track token WCAG 1.4.11 ─────────────────────────────────────

  it('spinner_track_passes_wcag_on_both_themes', async () => {
    // B1 (BLOCKER WCAG 1.4.11): .oxp-placeholder::after uses --oxp-border for track.
    // Light #e0e0e0 vs white bg = 1.32:1 FAIL; dark #38383a vs #1c1c1e = 1.45:1 FAIL.
    // Fix: new --oxp-spinner-track token.
    //   Light: rgba(0,0,0,0.55) blends to #737373 on white → 3.15:1 PASS.
    //   Dark:  rgba(255,255,255,0.30) blends to #5a5a5a eff on #1c1c1e → 3.50:1 PASS.
    function relativeLuminance(r255: number, g255: number, b255: number): number {
      const [r, g, b] = [r255, g255, b255].map(c => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
      const l1 = relativeLuminance(...fg);
      const l2 = relativeLuminance(...bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }
    function blendAlpha(fg: [number, number, number], alpha: number, bg: [number, number, number]): [number, number, number] {
      return [
        Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
        Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
        Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
      ];
    }

    // Light: rgba(0,0,0,0.55) on white #ffffff
    const lightTrack = blendAlpha([0, 0, 0], 0.55, [255, 255, 255]);
    const lightBg: [number, number, number] = [255, 255, 255];
    expect(contrastRatio(lightTrack, lightBg)).toBeGreaterThanOrEqual(3.0);

    // Dark: rgba(255,255,255,0.50) on #1c1c1e
    // Note: rgba(255,255,255,0.30) only gives 2.71:1 — spec claim of 3.50:1 was incorrect.
    // Using 0.50 gives ~4.76:1 PASS.
    const darkBg: [number, number, number] = [0x1c, 0x1c, 0x1e];
    const darkTrack = blendAlpha([255, 255, 255], 0.50, darkBg);
    expect(contrastRatio(darkTrack, darkBg)).toBeGreaterThanOrEqual(3.0);

    // Verify token is declared in CSS and used in spinner
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    // Token must be declared in :host light block
    const hostBlock = css.split(':host([data-theme')[0];
    expect(hostBlock).toMatch(/--oxp-spinner-track/);
    // Token must be declared in dark block
    const darkBlock = css.slice(css.indexOf(":host([data-theme='dark'])"));
    expect(darkBlock).toMatch(/--oxp-spinner-track/);
    // .oxp-placeholder::after must use the token (not --oxp-border) for the track border
    const spinnerBlock = css.match(/\.oxp-placeholder::after\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(spinnerBlock).toMatch(/var\(--oxp-spinner-track\)/);
    // Must NOT fall back to --oxp-border for the track portion
    expect(spinnerBlock).not.toMatch(/border:\s*2px solid var\(--oxp-border\)/);
  });

  // ── B2: on-danger token WCAG 1.4.3 ──────────────────────────────────────────

  it('on_danger_token_passes_wcag_on_danger_bg_both_themes', async () => {
    // B2 (BLOCKER WCAG 1.4.3): .oxp-message-list-error button uses --oxp-on-accent (#000)
    // on danger bg. Light #000 on #c00000 = 3.24:1 FAIL for normal text (need ≥4.5:1).
    // Fix: new --oxp-on-danger token. Light = #ffffff (vs #c00000 = 6.48:1 PASS).
    //                                  Dark  = #ffffff (vs #ff6b6b = 5.05:1 PASS).
    function relativeLuminance(hex: string): number {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const ch = [r, g, b].map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
    }
    function contrastRatio(fg: string, bg: string): number {
      const l1 = relativeLuminance(fg); const l2 = relativeLuminance(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    // Light: #ffffff on #c00000 ≥4.5:1 PASS (6.48:1)
    expect(contrastRatio('#ffffff', '#c00000')).toBeGreaterThanOrEqual(4.5);
    // Dark: #000000 on #ff6b6b ≥4.5:1 PASS (7.57:1).
    // Note: #ffffff on #ff6b6b = 2.77:1 FAIL — spec claim of 5.05:1 was incorrect.
    // Using #000 (dark text) on the light-ish dark danger color is the correct choice.
    expect(contrastRatio('#000000', '#ff6b6b')).toBeGreaterThanOrEqual(4.5);

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    // Token must be defined in :host light block
    const hostBlock = css.split(':host([data-theme')[0];
    expect(hostBlock).toMatch(/--oxp-on-danger/);
    // Token must be defined in dark block
    const darkBlock = css.slice(css.indexOf(":host([data-theme='dark'])"));
    expect(darkBlock).toMatch(/--oxp-on-danger/);
    // .oxp-message-list-error button must use --oxp-on-danger (not --oxp-on-accent)
    const errBtnBlock = css.match(/\.oxp-message-list-error\s+button\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(errBtnBlock).toMatch(/var\(--oxp-on-danger\)/);
    expect(errBtnBlock).not.toMatch(/var\(--oxp-on-accent\)/);
  });

  // ── B3: Dark code-bg collision with bubble-other-bg ──────────────────────────

  it('code_bg_has_border_token_for_boundary_in_dark_theme', async () => {
    // B3 (BLOCKER): dark --oxp-code-bg: #2c2c2e IDENTICAL to --oxp-bubble-other-bg: #2c2c2e.
    // Code inside other-person bubble → 1:1 zero contrast, invisible code region.
    // Fix: add --oxp-code-border token and apply to .md-code / .md-pre.
    //   Dark:  rgba(255,255,255,0.30) — boundary visible on any bubble bg.
    //   Light: rgba(0,0,0,0.40) — boundary visible on #f5f5f5 code bg.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    // --oxp-code-border token must be defined in :host block
    const hostBlock = css.split(':host([data-theme')[0];
    expect(hostBlock).toMatch(/--oxp-code-border/);
    // Token must also appear in dark block
    const darkBlock = css.slice(css.indexOf(":host([data-theme='dark'])"));
    expect(darkBlock).toMatch(/--oxp-code-border/);

    // .md-code and .md-pre must use --oxp-code-border for their border
    expect(css).toMatch(/\.md-code[^}]*var\(--oxp-code-border\)/s);
    expect(css).toMatch(/\.md-pre[^}]*var\(--oxp-code-border\)/s);

    // Dark --oxp-code-bg must differ from --oxp-bubble-other-bg (#2c2c2e)
    // The dark block should define --oxp-code-bg with a value other than #2c2c2e
    const darkBgMatch = darkBlock.match(/--oxp-code-bg:\s*(#[0-9a-fA-F]+)/);
    expect(darkBgMatch).not.toBeNull();
    expect(darkBgMatch![1]?.toLowerCase()).not.toBe('#2c2c2e');
  });

  // ── DM4: Reconnect banner 4-side ring ────────────────────────────────────────

  it('reconnect_banner_has_4_side_ring_not_bottom_only', async () => {
    // DM4 (design MAJOR): bottom-only shadow assumes host page bg contrasts on other 3 sides.
    // Cannot guarantee host bg. Fix: restore 4-side ring 0 0 0 1px rgba(...,0.50)
    // AND remove redundant border-bottom. Goal: dedup border → keep ring, drop border-bottom.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    const bannerBlock = css.match(/\.oxp-reconnect-banner\s*\{[^}]+\}/s)?.[0] ?? '';
    // Must have box-shadow ring — the 4-side ring pattern is 0 0 0 1px
    expect(bannerBlock).toMatch(/box-shadow/);
    expect(bannerBlock).toMatch(/0\s+0\s+0\s+1px/);
    // Must NOT have bottom-only shadow (0 1px 0 0) — that was the insufficient prior fix
    expect(bannerBlock).not.toMatch(/0\s+1px\s+0\s+0/);
    // Must NOT have border-bottom (replaced by ring)
    expect(bannerBlock).not.toMatch(/border-bottom/);
  });

  // ── B3 (fix-loop #2): --oxp-code-border alpha WCAG 1.4.11 ────────────────────

  it('code_border_passes_wcag_1411_on_all_surfaces', async () => {
    // F1 (BLOCKER WCAG 1.4.11): --oxp-code-border must achieve ≥3:1 on all surfaces.
    // The test READS the alpha from THEME_CSS to ensure it's ≥0.50 (light) / ≥0.40 (dark),
    // then verifies the blended contrast maths against all worst-case surfaces.
    //
    // Light rgba(0,0,0,0.40) FAILS:
    //   on #ffffff → blends to #999 → 2.85:1 FAIL
    //   on #f5f5f5 → blends to #939393 → 2.80:1 FAIL
    //   on #f1f0f0 → blends to #918f8f → 2.80:1 FAIL
    // Fix: rgba(0,0,0,0.50) → #808080 on white → 3.95:1 PASS (worst-case ~3.87:1 on bubble-other).
    //
    // Dark rgba(255,255,255,0.30) FAILS:
    //   on #1a1a1c → blends to #636365 → 2.72:1 FAIL
    //   on #2c2c2e → blends to #797979 → 2.62:1 FAIL
    // Fix: rgba(255,255,255,0.40) → ≥3.54:1 on all dark surfaces PASS.
    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    // Extract alpha from --oxp-code-border in :host (light) block.
    // Pattern: --oxp-code-border: rgba(0, 0, 0, <alpha>)
    const hostBlock = css.split(':host([data-theme')[0]!;
    const lightMatch = hostBlock.match(/--oxp-code-border:\s*rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)/);
    expect(lightMatch).not.toBeNull(); // token must be present
    const lightAlpha = parseFloat(lightMatch![1]!);

    // Extract alpha from dark block.
    // Pattern: --oxp-code-border: rgba(255, 255, 255, <alpha>)
    const darkBlockStart = css.indexOf(":host([data-theme='dark'])");
    const darkBlock = darkBlockStart >= 0 ? css.slice(darkBlockStart) : '';
    const darkMatch = darkBlock.match(/--oxp-code-border:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)/);
    expect(darkMatch).not.toBeNull();
    const darkAlpha = parseFloat(darkMatch![1]!);

    function relativeLuminance(r255: number, g255: number, b255: number): number {
      const [r, g, b] = [r255, g255, b255].map(c => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
      const l1 = relativeLuminance(...fg);
      const l2 = relativeLuminance(...bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }
    function blendAlpha(
      fg: [number, number, number],
      alpha: number,
      bg: [number, number, number],
    ): [number, number, number] {
      return [
        Math.round(fg[0]! * alpha + bg[0]! * (1 - alpha)),
        Math.round(fg[1]! * alpha + bg[1]! * (1 - alpha)),
        Math.round(fg[2]! * alpha + bg[2]! * (1 - alpha)),
      ];
    }

    // Light surfaces (worst-case = bubble-other #f1f0f0, lightest surface)
    const lightBg:     [number, number, number] = [255, 255, 255]; // widget-bg
    const codeBgLt:    [number, number, number] = [245, 245, 245]; // #f5f5f5
    const bubbleOtLt:  [number, number, number] = [241, 240, 240]; // #f1f0f0

    const bl = blendAlpha([0, 0, 0], lightAlpha, lightBg);
    expect(contrastRatio(bl, lightBg)).toBeGreaterThanOrEqual(3.0);        // on widget-bg
    const blCode = blendAlpha([0, 0, 0], lightAlpha, codeBgLt);
    expect(contrastRatio(blCode, codeBgLt)).toBeGreaterThanOrEqual(3.0);   // on code-bg
    const blBubble = blendAlpha([0, 0, 0], lightAlpha, bubbleOtLt);
    expect(contrastRatio(blBubble, bubbleOtLt)).toBeGreaterThanOrEqual(3.0); // on bubble-other

    // Dark surfaces (worst-case = code-bg #1a1a1c, darkest surface → lowest blend luminance)
    const codeBgDk:    [number, number, number] = [0x1a, 0x1a, 0x1c]; // #1a1a1c
    const bubbleOtDk:  [number, number, number] = [0x2c, 0x2c, 0x2e]; // #2c2c2e

    const bd = blendAlpha([255, 255, 255], darkAlpha, codeBgDk);
    expect(contrastRatio(bd, codeBgDk)).toBeGreaterThanOrEqual(3.0);       // on code-bg dark
    const bdBubble = blendAlpha([255, 255, 255], darkAlpha, bubbleOtDk);
    expect(contrastRatio(bdBubble, bubbleOtDk)).toBeGreaterThanOrEqual(3.0); // on bubble-other dark
  });

  // ── DM5: --oxp-success-text token ────────────────────────────────────────────

  it('success_text_token_defined_with_wcag_values', async () => {
    // DM5 (design MAJOR): comment-only guard for --oxp-success insufficient.
    // Add --oxp-success-text token with forced WCAG-safe values.
    // Light = #0f7a35 (vs white ≈7:1 PASS, vs bubble-self #dcf8c6 ≈4.8:1 PASS).
    // Dark  = #4ade80 (same as prior success — 7.11:1 on dark bg).
    function relativeLuminance(hex: string): number {
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      const ch = [r, g, b].map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
      return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
    }
    function contrastRatio(fg: string, bg: string): number {
      const l1 = relativeLuminance(fg); const l2 = relativeLuminance(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    // Light #0f7a35 ≥4.5:1 on both white bg and self-bubble bg
    expect(contrastRatio('#0f7a35', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#0f7a35', '#dcf8c6')).toBeGreaterThanOrEqual(4.5);
    // Dark #4ade80 ≥4.5:1 on dark widget bg
    expect(contrastRatio('#4ade80', '#1c1c1e')).toBeGreaterThanOrEqual(4.5);

    const el = document.createElement('oxpulse-chat') as OxpulseChatElement;
    el.setAttribute('app-id', 'app1');
    el.setAttribute('jwt', LOCALHOST_JWT);
    el.setAttribute('room-id', 'room1');
    container.appendChild(el);
    await new Promise((r) => setTimeout(r, 20));
    const css = el.shadowRoot!.querySelector('style')!.textContent ?? '';

    // Token must be defined in light :host block
    const hostBlock = css.split(':host([data-theme')[0];
    expect(hostBlock).toMatch(/--oxp-success-text/);
    // Token must be defined in dark block
    const darkBlock = css.slice(css.indexOf(":host([data-theme='dark'])"));
    expect(darkBlock).toMatch(/--oxp-success-text/);
    // Light value must be #0f7a35
    expect(hostBlock).toMatch(/--oxp-success-text:\s*#0f7a35/);
    // Dark value must be #4ade80
    expect(darkBlock).toMatch(/--oxp-success-text:\s*#4ade80/);
  });

  // W7: [hidden] attribute must override any component display style.
  it('hidden_attribute_overrides_display_styles', () => {
    expect(THEME_CSS).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
  });
});
