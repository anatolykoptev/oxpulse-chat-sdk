import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// A regex literal is parsed when the MODULE is parsed, before any of its code
// runs. So a regex feature the engine does not know is not a broken renderer —
// it is a SyntaxError that aborts the entire bundle, and every consumer embed
// silently renders nothing.
//
// Lookbehind ((?<= and (?<!) landed in WebKit only in Safari 16.4, and every
// browser on iOS is WebKit regardless of its name. A single lookbehind in this
// package therefore takes the whole widget off every older iPhone at once.
// Shipped exactly that way once already; this test is the gate that was missing.
//
// Named capture groups ((?<name>) are ES2018 and supported far earlier, so the
// patterns below deliberately match only the two lookbehind forms.
const LOOKBEHIND = /\(\?<[=!]/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('shipped source stays parseable on the oldest supported engine', () => {
  it('contains no regex lookbehind anywhere under src/', () => {
    const offenders = sourceFiles(join(__dirname, '..'))
      .filter((f) => LOOKBEHIND.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(f.indexOf('/src/') + 1));

    expect(offenders).toEqual([]);
  });
});
