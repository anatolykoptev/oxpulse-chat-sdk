/**
 * role-badge.ts — roster privileged-role badge rendering (P5).
 *
 * Produces a small inline badge ("mod" / "owner" by default) shown next to a
 * message sender's name when the roster reports them as `moderator` or
 * `owner`. Structural mirror of the widget's `RosterEntry.role` field
 * (message-list.ts), which itself structurally mirrors chat-sdk's
 * `RosterEntry.role` — the widget stays SDK-import-free (see message-list.ts
 * doc comment).
 *
 * UX-only: this badge is a presentation hint sourced from the same roster map
 * used for names/avatars. It MUST NOT be treated as client-side authorization
 * for any privileged operation — the server is the sole source of truth.
 */

import { t, type Locale } from '../utils/i18n.js';

/** Privileged roster roles. A plain `member` is represented by `undefined`, never a string. */
export type PrivilegedRole = 'moderator' | 'owner';

export interface RoleBadgeOptions {
  role: PrivilegedRole;
  lang: Locale;
  /**
   * Partner-supplied label overrides (widget config `roleLabels`), e.g.
   * `{ moderator: "Seller" }`. Presentation only — an empty/non-string
   * override for a role falls back to the built-in i18n label.
   */
  roleLabels?: Record<string, string>;
}

/** Resolve the label text for a privileged role: config override → i18n default. */
export function roleBadgeLabel(opts: RoleBadgeOptions): string {
  const override = opts.roleLabels?.[opts.role];
  if (typeof override === 'string' && override.length > 0) return override;
  return opts.role === 'owner' ? t('roleBadgeOwner', opts.lang) : t('roleBadgeModerator', opts.lang);
}

/**
 * Build the role badge element.
 *
 * XSS-safe: label assigned via textContent (never innerHTML), whether it
 * comes from the i18n table or a partner-supplied `roleLabels` override.
 */
export function createRoleBadgeElement(opts: RoleBadgeOptions): HTMLElement {
  const el = document.createElement('span');
  el.className = 'oxp-role-badge';
  el.setAttribute('data-role', opts.role);
  el.textContent = roleBadgeLabel(opts); // XSS-safe: textContent, not innerHTML
  return el;
}
