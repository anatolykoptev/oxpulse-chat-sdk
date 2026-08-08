import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { OBSERVED_ATTRIBUTES } from '../types.js';

/**
 * `docs/embedding.md` hand-listed the widget's attributes and fell five behind
 * the code: `base-url`, `allow-anon-read`, `reactions-enabled`,
 * `pinned-messages-enabled` and `seller-catalog` were all live and undocumented.
 *
 * `base-url` is why this test exists rather than a doc fix alone. It defaults to
 * production, so an integrator who never learns the attribute exists points an
 * embed at production while believing it is on staging — and nothing errors,
 * warns, or looks wrong. A hand-maintained list cannot detect what is missing
 * from it, so the list is checked against the registration site instead.
 *
 * This is the same class as #265 (the documented `WidgetErrorCode` list missing
 * three codes that fire in production).
 */
const DOC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../docs/embedding.md',
);

describe('docs/embedding.md attribute coverage', () => {
  it('documents every attribute the element observes', () => {
    const doc = readFileSync(DOC, 'utf8');

    // Match the doc's own table cells (`| \`attr\` |`) rather than a bare
    // substring: `mode` and `theme` appear in prose throughout the file, so a
    // substring search would pass on a table that never mentions them.
    const documented = new Set(
      [...doc.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1]),
    );

    const missing = OBSERVED_ATTRIBUTES.filter((a) => !documented.has(a));

    expect(missing, `undocumented attributes in ${path.basename(DOC)}`).toEqual([]);
  });

  it('does not document an attribute the element ignores', () => {
    // The inverse direction, and not symmetric decoration: a documented
    // attribute that is NOT observed reads as a supported knob and silently
    // does nothing. Scoped to the kebab-case names in the observed-attributes
    // table specifically, because other tables in this file legitimately list
    // CSS custom properties and event fields.
    const doc = readFileSync(DOC, 'utf8');
    const section = doc.slice(
      doc.indexOf('### Observed attributes'),
      doc.indexOf('### Events'),
    );
    expect(section.length, 'observed-attributes section not found').toBeGreaterThan(0);

    const listed = [...section.matchAll(/^\|\s*`([a-z-]+)`\s*\|/gm)].map((m) => m[1]);
    const observed = new Set<string>(OBSERVED_ATTRIBUTES);
    const phantom = listed.filter((a) => !observed.has(a));

    expect(phantom, 'documented but not observed').toEqual([]);
  });
});
