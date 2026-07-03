/**
 * markdown.test.ts — XSS test suite (B2, W2.2 fix-loop).
 *
 * Ported from web/src/lib/chat/domain/markdown.test.ts.
 * Adjusted import path to the widget package's renderer.
 */

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../utils/markdown.js';

describe('renderMarkdown', () => {
  it('escapes raw HTML so peers cannot inject tags', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes attribute-breakers', () => {
    const out = renderMarkdown('"><img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('"&gt;');
  });

  it('renders **bold** as <strong>', () => {
    expect(renderMarkdown('**hi**')).toContain('<strong>hi</strong>');
  });

  it('renders __underline__ as <u>', () => {
    expect(renderMarkdown('__hi__')).toContain('<u>hi</u>');
  });

  it('renders _italic_ as <em>', () => {
    expect(renderMarkdown('an _italic_ word')).toContain('<em>italic</em>');
  });

  it('does NOT italicize underscores inside snake_case identifiers', () => {
    // ITALIC_RE's word-boundary lookaround must reject an underscore flanked
    // by word chars — a doubled-backslash char class ([\\w]) instead of the
    // \w escape disables this and mis-italicizes snake_case text.
    expect(renderMarkdown('snake_case_var')).not.toContain('<em>');
    expect(renderMarkdown('a_hi_b')).not.toContain('<em>');
  });

  it('renders ~~strike~~ as <del>', () => {
    expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>');
  });

  it('renders ||spoiler|| as md-spoiler span', () => {
    const out = renderMarkdown('||secret||');
    expect(out).toContain('class="md-spoiler"');
    expect(out).toContain('tabindex="0"');
    expect(out).toContain('>secret<');
  });

  it('renders inline `code` as md-code', () => {
    const out = renderMarkdown('`foo`');
    expect(out).toContain('class="md-code"');
    expect(out).toContain('>foo<');
  });

  it('renders ```block code``` as md-pre', () => {
    const out = renderMarkdown('```\nfoo\n```');
    expect(out).toContain('class="md-pre"');
    expect(out).toContain('<code>foo</code>');
  });

  it('does NOT format inside inline code', () => {
    const out = renderMarkdown('`**not bold**`');
    expect(out).not.toContain('<strong>');
    expect(out).toContain('>**not bold**<');
  });

  it('renders [text](https://example.com) as md-link', () => {
    const out = renderMarkdown('[click](https://example.com)');
    expect(out).toContain('class="md-link"');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('>click</a>');
    expect(out).toContain('rel="noopener"');
  });

  it('strips javascript: links', () => {
    const out = renderMarkdown('[xss](javascript:alert(1))');
    expect(out).not.toContain('href="javascript:');
    expect(out).not.toContain('<a ');
  });

  it('strips data: links', () => {
    const out = renderMarkdown('[xss](data:text/html,<script>)');
    expect(out).not.toContain('<a ');
  });

  it('autolinks bare https://', () => {
    const out = renderMarkdown('see https://example.com');
    expect(out).toContain('href="https://example.com"');
  });

  it('renders > line as blockquote', () => {
    const out = renderMarkdown('> quoted');
    expect(out).toContain('<blockquote class="md-quote">');
  });

  it('preserves newlines as <br>', () => {
    const out = renderMarkdown('a\nb');
    expect(out).toContain('<br>');
  });

  it('leaves plain text untouched (escape-only)', () => {
    expect(renderMarkdown('just text')).toBe('just text');
  });
});
