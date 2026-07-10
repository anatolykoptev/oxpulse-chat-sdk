/**
 * avatar.ts — roster avatar rendering (T18-avatar).
 *
 * Produces the leading avatar element for a message row: an <img> when the
 * sender has an avatar URL, or a deterministic initials-circle fallback.
 * Falls back to initials on image load error (onerror).
 *
 * Security: the avatar URL is caller-supplied roster data. It is assigned via
 * `img.src` (the property), NEVER via innerHTML, and only when it is an http(s)
 * URL — a defensive second gate on top of the server-side scheme validation.
 */

/** Deterministic initials from a display name (1-2 uppercase letters). */
export function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  // Spread to code points so multi-byte names (Cyrillic, emoji) are safe.
  const firstWord = parts[0] ?? '';
  const lastWord = parts[parts.length - 1] ?? '';
  const firstChar = [...firstWord][0] ?? '?';
  if (parts.length === 1) return firstChar.toUpperCase();
  const lastChar = [...lastWord][0] ?? '';
  return (firstChar + lastChar).toUpperCase();
}

/** Deterministic background color (HSL string) seeded by a stable id (epid). */
export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0; // 32-bit rolling hash
  }
  const hue = Math.abs(hash) % 360;
  // Fixed saturation/lightness keeps white initials text readable on every hue.
  return `hsl(${hue}, 55%, 42%)`;
}

/** Only http(s) URLs are safe to use as an <img src>. */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export interface AvatarOptions {
  /** Display name — used for alt text and the initials fallback. */
  name: string;
  /** Avatar URL, or null for the initials fallback. */
  avatarUrl: string | null;
  /** Stable id (epid) seeding the fallback color. */
  seed: string;
}

/**
 * Build the leading avatar element for a message row.
 *
 * - avatarUrl present + http(s): an <img> (src set via property, never
 *   innerHTML); on load error it swaps to the initials fallback.
 * - avatarUrl null/invalid: a deterministic initials circle.
 *
 * Accessible: the <img> carries alt = display name; the initials circle is
 * decorative (aria-hidden) since the sender name is already in the bubble.
 */
export function createAvatarElement(opts: AvatarOptions): HTMLElement {
  const el = document.createElement('div');
  el.className = 'oxp-bubble-avatar';
  el.style.backgroundColor = avatarColor(opts.seed);

  const initials = avatarInitials(opts.name);

  const renderInitials = (): void => {
    el.textContent = initials; // XSS-safe: textContent, not innerHTML
    el.setAttribute('aria-hidden', 'true');
  };

  if (opts.avatarUrl && isHttpUrl(opts.avatarUrl)) {
    const img = document.createElement('img');
    img.alt = opts.name; // property assignment — safe
    img.decoding = 'async';
    img.loading = 'lazy';
    // Privacy: without this, loading a third-party avatar leaks the embedding
    // page URL (Referer) + visitor IP to the avatar host — sharper for a
    // privacy-adjacent product.
    img.referrerPolicy = 'no-referrer';
    img.addEventListener(
      'error',
      () => {
        // Broken/blocked image → deterministic initials fallback.
        el.replaceChildren();
        el.style.backgroundColor = avatarColor(opts.seed);
        renderInitials();
      },
      { once: true },
    );
    img.src = opts.avatarUrl; // property, not innerHTML — safe
    el.appendChild(img);
  } else {
    renderInitials();
  }

  return el;
}
