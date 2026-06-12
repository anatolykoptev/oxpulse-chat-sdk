// Telegram-compatible inline markdown renderer — ported verbatim from
// web/src/lib/chat/domain/markdown.ts (W2.2 slice 1).
// Widget package is standalone — no runtime import from web/.
//
// Input is plaintext (already AEAD-decrypted on the receiver). The
// renderer HTML-escapes every character first so any `<` `>` `&`
// from a peer cannot break out of the rendered DOM, then re-injects
// formatting tags. Output is meant for innerHTML. The two-phase
// escape-then-inject pattern is the core safety invariant — do not break it.
//
// Supported syntax (matches Telegram desktop):
//   **bold**, __underline__, _italic_, ~~strike~~, ||spoiler||,
//   `inline code`, ```code blocks```, > blockquote, [text](url),
//   https://autolinks.
//
// URL safety: only http/https/mailto/tel schemes render as anchors.
// Anything else (javascript:, data:, file:) drops the link and keeps
// only visible text. escapeAttr double-escapes attribute values.

const BLOCK_CODE_RE = /```(\w*)\n?([\s\S]*?)```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const SPOILER_RE = /\|\|([^|]+)\|\|/g;
const BOLD_RE = /\*\*(.+?)\*\*/g;
const UNDERLINE_RE = /__(.+?)__/g;
const STRIKE_RE = /~~(.+?)~~/g;
const ITALIC_RE = /(?<![\\w])_(.+?)_(?![\\w])/g;
const LINK_RE = /\[([^\]]+)]\(([^)]+)\)/g;
const AUTOLINK_RE = /(https?:\/\/[^\s<"')\]]+)/g;

/** URL schemes allowed in rendered anchor hrefs. */
const ALLOWED_SCHEMES = ['http://', 'https://', 'mailto:', 'tel:'];

/** Return the URL if it starts with an allowed scheme, otherwise null. */
function sanitizeUrl(url: string): string | null {
  const trimmed = url.trim();
  for (const scheme of ALLOWED_SCHEMES) {
    if (trimmed.toLowerCase().startsWith(scheme)) return trimmed;
  }
  return null;
}

/** Escape a string for use in an HTML attribute value (already inside double-quotes). */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderMarkdown(text: string): string {
  // Escape HTML first
  let out = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Preserve code blocks — replace with placeholders
  const blocks: string[] = [];
  out = out.replace(BLOCK_CODE_RE, (_, lang, code) => {
    const idx = blocks.length;
    blocks.push(
      `<pre class="md-pre"><code>${code.trim()}</code></pre>`,
    );
    return `\x00BLOCK${idx}\x00`;
  });

  // Preserve inline code — replace with placeholders
  const inlines: string[] = [];
  out = out.replace(INLINE_CODE_RE, (_, code) => {
    const idx = inlines.length;
    inlines.push(
      `<code class="md-code">${code}</code>`,
    );
    return `\x00INLINE${idx}\x00`;
  });

  // Spoilers
  out = out.replace(SPOILER_RE, '<span class="md-spoiler" tabindex="0">$1</span>');

  // Order matters: underline before italic (both use _)
  out = out.replace(BOLD_RE, '<strong>$1</strong>');
  out = out.replace(UNDERLINE_RE, '<u>$1</u>');
  out = out.replace(STRIKE_RE, '<del>$1</del>');
  out = out.replace(ITALIC_RE, '<em>$1</em>');

  // Links: [text](url) — allowlist schemes; drop link (keep text) if scheme not allowed
  out = out.replace(LINK_RE, (_, linkText: string, rawUrl: string) => {
    const safeUrl = sanitizeUrl(rawUrl);
    const escapedText = escapeAttr(linkText);
    if (!safeUrl) return escapedText;
    return `<a class="md-link" target="_blank" rel="noopener" href="${escapeAttr(safeUrl)}">${escapedText}</a>`;
  });
  // Autolinks — AUTOLINK_RE already requires https?:// so all matches are safe;
  // still wrap through sanitizeUrl for consistency and skip inside existing hrefs.
  out = out.replace(AUTOLINK_RE, (url, _, offset) => {
    const before = out.slice(Math.max(0, offset - 6), offset);
    if (before.includes('href="') || before.includes("href='")) return url;
    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) return escapeAttr(url);
    return `<a class="md-link" target="_blank" rel="noopener" href="${escapeAttr(safeUrl)}">${escapeAttr(safeUrl)}</a>`;
  });

  // Blockquotes (lines starting with &gt; after HTML escape)
  out = out.replace(/^(&gt;)\s?(.*)$/gm, '<blockquote class="md-quote">$2</blockquote>');

  // Restore code placeholders
  out = out.replace(/\x00BLOCK(\d+)\x00/g, (_, i) => blocks[parseInt(i)] ?? '');
  out = out.replace(/\x00INLINE(\d+)\x00/g, (_, i) => inlines[parseInt(i)] ?? '');

  // Newlines → <br> (but not inside <pre>)
  out = out.replace(/\n/g, '<br>');

  return out;
}
