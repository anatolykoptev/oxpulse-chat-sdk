/**
 * Browser regex-compatibility gate for EVERYTHING WE SHIP.
 *
 * Why this exists
 * ---------------
 * A regex literal is parsed with the MODULE, before any of its code runs. A
 * regex feature the engine does not know is therefore not a broken renderer —
 * it is a SyntaxError that aborts the whole bundle, the custom element never
 * registers, and every consumer embed silently renders nothing. Shipped exactly
 * that way once (lookbehind in chat-widget's markdown.ts, fixed in 0.21.2).
 *
 * Two axes make the class wider than that one incident:
 *   1. PACKAGE. chat-widget depends on @oxpulse/chat-sdk and @oxpulse/voice-core
 *      (and wire-codec transitively); all of them compile INTO the CDN bundle
 *      and into every consumer bundle. A lookbehind added to chat-sdk/src
 *      reproduces the outage byte for byte.
 *   2. FEATURE. Lookbehind is not the only parse-fatal construct. Unsupported
 *      regex FLAGS are the same class: `v` is a SyntaxError before Safari 17,
 *      `d` before Safari 15. So flags are checked against an ALLOWLIST — a flag
 *      nobody has heard of yet fails closed.
 *
 * Why the built artifacts and not the sources
 * -------------------------------------------
 * This replaces the source-text grep that shipped with the 0.21.2 fix
 * (src/__tests__/browser-syntax.test.ts, deleted in the same commit). That check
 * scanned only chat-widget/src and matched raw TEXT, so it was blind to sibling
 * workspace packages, to flags, and to regexes inside comments (false positives).
 *
 * Scanning the EMITTED JavaScript with a real parser is strictly wider and
 * strictly more precise:
 *   - every workspace package's dist/ is covered, not just chat-widget;
 *   - the CDN bundle is covered, so anything esbuild pulls in is covered;
 *   - only actual RegExpLiteral nodes are inspected, so comments and strings
 *     cannot produce a false positive, and flags are readable structurally.
 * Every package's tsconfig excludes __tests__ from its outDir, so test-only
 * regexes (e.g. the Node-only lookbehind in theme.test.ts) are out of scope by
 * construction — no allowlisting needed.
 *
 * Falsification: adding `(?<=x)y` to ANY packages/<pkg>/src file, or any regex
 * literal with a `d`/`v` flag, makes this file RED after a build. Verified by
 * mutation, not by assumption.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.resolve(__dirname, '../..');
const packagesRoot = path.resolve(widgetRoot, '..');
const cdnBundle = path.resolve(widgetRoot, 'dist-cdn/index.js');

/**
 * Regex flags whose SUPPORT predates the oldest engine we support.
 *
 * ES2018 and earlier: g i m s u y — all available in WebKit since Safari 11.1.
 * Deliberately NOT here:
 *   d (hasIndices) — SyntaxError before Safari 15
 *   v (unicodeSets) — SyntaxError before Safari 17
 * An allowlist, not a denylist: a flag added to some future edition fails this
 * gate on arrival instead of shipping and taking iOS down.
 */
const ALLOWED_FLAGS = new Set(['g', 'i', 'm', 's', 'u', 'y']);

/** (?<= and (?<! — landed in WebKit only in Safari 16.4. */
const LOOKBEHIND = /\(\?<[=!]/;

interface Finding {
  file: string;
  line: number;
  detail: string;
}

interface Scan {
  files: number;
  literals: number;
  lookbehind: Finding[];
  badFlags: Finding[];
  dynamic: Finding[];
}

function jsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      out.push(...jsFilesUnder(full));
      continue;
    }
    if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

function scan(files: string[]): Scan {
  const result: Scan = { files: files.length, literals: 0, lookbehind: [], badFlags: [], dynamic: [] };

  for (const file of files) {
    const rel = path.relative(packagesRoot, file);
    const ast = parse(fs.readFileSync(file, 'utf8'), {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    });

    walk.simple(ast, {
      Literal(node: any) {
        if (!node.regex) return;
        result.literals++;
        const { pattern, flags } = node.regex as { pattern: string; flags: string };
        const line = node.loc.start.line as number;
        if (LOOKBEHIND.test(pattern)) {
          result.lookbehind.push({ file: rel, line, detail: `/${pattern}/${flags}` });
        }
        const rejected = [...flags].filter((f) => !ALLOWED_FLAGS.has(f));
        if (rejected.length > 0) {
          result.badFlags.push({ file: rel, line, detail: `/${pattern}/${flags} → ${rejected.join('')}` });
        }
      },
      // `new RegExp("(?<=a)b")` is not parse-fatal, but it throws at
      // construction on the same engines — usually at module top level, with the
      // same "widget renders nothing" outcome. Only string-literal arguments are
      // inspected; a runtime-built pattern is out of reach of any static check.
      NewExpression(node: any) {
        if (node.callee?.name !== 'RegExp') return;
        const arg = node.arguments?.[0];
        if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return;
        if (!LOOKBEHIND.test(arg.value)) return;
        result.dynamic.push({ file: rel, line: node.loc.start.line, detail: arg.value });
      },
    });
  }

  return result;
}

function show(findings: Finding[]): string[] {
  return findings.map((f) => `${f.file}:${f.line} ${f.detail}`);
}

describe('shipped JavaScript stays parseable on the oldest supported engine', () => {
  let bundle: Scan;
  let dists: Scan;
  let scannedPackages: string[];

  beforeAll(() => {
    if (!fs.existsSync(cdnBundle)) {
      throw new Error(
        'dist-cdn/index.js not found — run `pnpm --filter @oxpulse/chat-widget build:cdn` first.'
      );
    }
    bundle = scan([cdnBundle]);

    const distFiles: string[] = [];
    scannedPackages = [];
    for (const pkg of fs.readdirSync(packagesRoot).sort()) {
      const pkgJson = path.join(packagesRoot, pkg, 'package.json');
      if (!fs.existsSync(pkgJson)) continue;
      const dist = path.join(packagesRoot, pkg, 'dist');
      if (!fs.existsSync(dist)) {
        throw new Error(
          `packages/${pkg}/dist not found — run \`pnpm build\` first. This gate covers EVERY ` +
            `workspace package because they all compile into consumer bundles; skipping one ` +
            `would recreate the blind spot this file exists to close.`
        );
      }
      scannedPackages.push(pkg);
      distFiles.push(...jsFilesUnder(dist));
    }
    dists = scan(distFiles);
  });

  it('scans a non-empty population (guards against a vacuously green run)', () => {
    // Every assertion below is an ABSENCE claim, which passes trivially if the
    // scan found nothing. Pin the population instead.
    expect(scannedPackages.length).toBeGreaterThanOrEqual(7);
    expect(dists.files).toBeGreaterThan(20);
    expect(bundle.literals + dists.literals).toBeGreaterThan(50);
  });

  it('CDN bundle contains no regex lookbehind', () => {
    expect(show(bundle.lookbehind)).toEqual([]);
  });

  it('CDN bundle uses only allowlisted regex flags', () => {
    expect(show(bundle.badFlags)).toEqual([]);
  });

  it('every workspace package dist contains no regex lookbehind', () => {
    expect(show(dists.lookbehind)).toEqual([]);
  });

  it('every workspace package dist uses only allowlisted regex flags', () => {
    expect(show(dists.badFlags)).toEqual([]);
  });

  it('no statically-visible `new RegExp("…lookbehind…")` construction', () => {
    expect(show([...bundle.dynamic, ...dists.dynamic])).toEqual([]);
  });
});
