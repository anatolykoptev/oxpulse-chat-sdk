/**
 * Parseability gate for EVERYTHING WE SHIP.
 *
 * Why this exists
 * ---------------
 * A regex literal is parsed with the MODULE, before any of its code runs. So a
 * regex feature the engine does not know is not a broken renderer — it is a
 * SyntaxError that aborts the whole bundle, the custom element never registers,
 * and every consumer embed silently renders nothing. Shipped exactly that way
 * once (lookbehind in chat-widget's markdown.ts, fixed in 0.21.2). Nothing about
 * that blast radius is specific to regexes: ANY syntax above the engine's level
 * does the same thing.
 *
 * Three axes, in increasing order of coverage:
 *
 *   1. PACKAGE. chat-widget depends on @oxpulse/chat-sdk and @oxpulse/voice-core
 *      (wire-codec transitively); all of them compile INTO the CDN bundle and
 *      into every consumer bundle. A lookbehind added to chat-sdk/src reproduces
 *      the outage byte for byte.
 *
 *   2. LANGUAGE LEVEL. The whole artifact is parsed at the declared ES ceiling.
 *      This subsumes every hand-maintained denylist on the syntax axis — `??=`,
 *      class fields, `static {}` and everything not yet invented — and, unlike a
 *      denylist, it cannot fall out of date. It is also the only check that
 *      notices when the esbuild target is raised: without it, flipping
 *      esbuild.cdn.mjs to `es2022` leaves this suite green while iOS takes the
 *      identical bundle-aborting SyntaxError this file exists to prevent.
 *
 *   3. SUB-EDITION ENGINE GAPS. A parser cannot know that lookbehind is ES2018
 *      but WebKit only shipped it in 16.4, or that the `v` flag is a SyntaxError
 *      before Safari 17. Those come from the tables in browser-baseline.mjs,
 *      compared against the declared engine — so both the flag allowlist and the
 *      banned-pattern set are DERIVED, not hand-picked, and move automatically
 *      when the baseline moves.
 *
 * Where the numbers live
 * ----------------------
 * ../../../../browser-baseline.mjs — the single declaration of the oldest engine
 * we support, also consumed by esbuild.cdn.mjs to set the build target. The two
 * cannot drift apart because there is only one of them.
 *
 * Why the built artifacts and not the sources
 * -------------------------------------------
 * This replaces the source-text grep that shipped with the 0.21.2 fix
 * (src/__tests__/browser-syntax.test.ts, deleted with it). That check scanned
 * only chat-widget/src and matched raw TEXT, so it was blind to sibling
 * packages, to flags, and to regexes inside comments (false positives).
 *
 * Scanning EMITTED JavaScript with a real parser is strictly wider and strictly
 * more precise: every package's dist/ is covered, the CDN bundle covers whatever
 * esbuild pulls in (including third-party dependencies, which never pass through
 * tsc and are therefore invisible to any source-level check), and only real
 * RegExpLiteral nodes are inspected. Every package's tsconfig excludes __tests__
 * from its outDir, so test-only regexes (e.g. the Node-only lookbehind in
 * theme.test.ts) are out of scope by construction — no allowlisting needed.
 *
 * The `RegExp(…)` branch is not decoration
 * ----------------------------------------
 * esbuild DOWNLEVELS an unsupported-flag literal into a constructor call, with
 * no warning: at this repo's exact production settings, `/q/d` is emitted as
 * `new RegExp("q","d")`. So on the bundle axis — the only axis that sees
 * third-party dependencies, which is the reason that axis exists — an
 * unsupported flag NEVER appears as a literal, and a check that reads only
 * literals can never fire on it. Both the pattern AND the flags argument are
 * therefore checked, for `new RegExp(…)` and for a bare `RegExp(…)` call, which
 * esbuild preserves verbatim.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { parse } from 'acorn';
import * as walk from 'acorn-walk';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain-ESM shared config with no type declarations. It is
// intentionally not a TS module: esbuild.cdn.mjs consumes the same file at build
// time and must not depend on a build step to read the baseline.
import * as baseline from '../../../../browser-baseline.mjs';

const {
  OLDEST_SUPPORTED_ENGINE,
  ES_CEILING,
  ES_EDITION_MIN_ENGINE,
  REGEX_FLAG_MIN_ENGINE,
  REGEX_PATTERN_FEATURES,
  engineAtLeast,
  describeEngine,
} = baseline as {
  OLDEST_SUPPORTED_ENGINE: { name: string; version: [number, number] };
  ES_CEILING: number;
  ES_EDITION_MIN_ENGINE: Record<number, [number, number] | undefined>;
  REGEX_FLAG_MIN_ENGINE: Record<string, [number, number] | undefined>;
  REGEX_PATTERN_FEATURES: { id: string; test: RegExp; minEngine: [number, number] }[];
  engineAtLeast: (have: [number, number], want: [number, number]) => boolean;
  describeEngine: (version?: [number, number]) => string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.resolve(__dirname, '../..');
const packagesRoot = path.resolve(widgetRoot, '..');
const cdnBundle = path.resolve(widgetRoot, 'dist-cdn/index.js');

const BASELINE = OLDEST_SUPPORTED_ENGINE.version;

/** Flags the DECLARED baseline engine actually supports. Derived, never edited. */
const ALLOWED_FLAGS = new Set(
  Object.entries(REGEX_FLAG_MIN_ENGINE)
    .filter(([, min]) => min !== undefined && engineAtLeast(BASELINE, min))
    .map(([flag]) => flag)
);

/** Pattern features the baseline engine does NOT support. Derived, never edited. */
const BANNED_PATTERN_FEATURES = REGEX_PATTERN_FEATURES.filter(
  (f) => !engineAtLeast(BASELINE, f.minEngine)
);

interface Finding {
  file: string;
  line: number;
  detail: string;
}

interface Scan {
  files: number;
  literals: number;
  constructors: number;
  patternFeature: Finding[];
  badFlags: Finding[];
}

function emptyScan(): Scan {
  return { files: 0, literals: 0, constructors: 0, patternFeature: [], badFlags: [] };
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

function checkPattern(pattern: string, file: string, line: number, into: Finding[]): void {
  for (const feature of BANNED_PATTERN_FEATURES) {
    if (!feature.test.test(pattern)) continue;
    into.push({
      file,
      line,
      detail: `${feature.id} in /${pattern}/ — needs ${describeEngine(feature.minEngine)}, baseline is ${describeEngine()}`,
    });
  }
}

function checkFlags(flags: string, file: string, line: number, into: Finding[]): void {
  const rejected = [...flags].filter((f) => !ALLOWED_FLAGS.has(f));
  if (rejected.length === 0) return;
  const why = rejected
    .map((f) => {
      const min = REGEX_FLAG_MIN_ENGINE[f];
      // A flag missing from the table is rejected outright — fail closed, so a
      // flag nobody has heard of yet cannot ship by being unrecognised.
      return min ? `"${f}" needs ${describeEngine(min)}` : `"${f}" is unknown to browser-baseline.mjs`;
    })
    .join(', ');
  into.push({ file, line, detail: `flags "${flags}" — ${why}; baseline is ${describeEngine()}` });
}

function scan(files: string[]): Scan {
  const result = emptyScan();
  result.files = files.length;

  for (const file of files) {
    const rel = path.relative(packagesRoot, file);
    const source = fs.readFileSync(file, 'utf8');

    // Axis 2: the parse itself is an assertion. acorn rejects any syntax above
    // ecmaVersion, so a successful parse proves the artifact's language level is
    // within ES_CEILING. A failure surfaces in the "parses at the declared ES
    // ceiling" test, carrying acorn's own message and position.
    const ast = parse(source, {
      ecmaVersion: ES_CEILING as 2020,
      sourceType: 'module',
      locations: true,
    });

    const inspectConstructor = (node: any) => {
      if (node.callee?.type !== 'Identifier' || node.callee.name !== 'RegExp') return;
      result.constructors++;
      const line = node.loc.start.line as number;
      const [patternArg, flagsArg] = node.arguments ?? [];
      // Only statically-known arguments can be checked. A runtime-built pattern
      // is out of reach of ANY static analysis; it is counted, not asserted on.
      if (patternArg?.type === 'Literal' && typeof patternArg.value === 'string') {
        checkPattern(patternArg.value, rel, line, result.patternFeature);
      }
      if (flagsArg?.type === 'Literal' && typeof flagsArg.value === 'string') {
        checkFlags(flagsArg.value, rel, line, result.badFlags);
      }
    };

    walk.simple(ast, {
      Literal(node: any) {
        if (!node.regex) return;
        result.literals++;
        const { pattern, flags } = node.regex as { pattern: string; flags: string };
        const line = node.loc.start.line as number;
        checkPattern(pattern, rel, line, result.patternFeature);
        checkFlags(flags, rel, line, result.badFlags);
      },
      NewExpression: inspectConstructor,
      CallExpression: inspectConstructor,
    });
  }

  return result;
}

function show(findings: Finding[]): string[] {
  return findings.map((f) => `${f.file}:${f.line} ${f.detail}`);
}

describe(`shipped JavaScript stays parseable on ${describeEngine()}`, () => {
  let bundle: Scan;
  let dists: Scan;
  let scannedPackages: string[];
  let parseError: string | null;

  beforeAll(() => {
    if (!fs.existsSync(cdnBundle)) {
      throw new Error(
        'dist-cdn/index.js not found — run `pnpm --filter @oxpulse/chat-widget build:cdn` first.'
      );
    }

    const distFiles: string[] = [];
    scannedPackages = [];
    for (const pkg of fs.readdirSync(packagesRoot).sort()) {
      if (!fs.existsSync(path.join(packagesRoot, pkg, 'package.json'))) continue;
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

    // A parse failure IS the finding for axis 2, so it must not blow up every
    // other assertion — capture it and let its own test report it.
    parseError = null;
    bundle = emptyScan();
    dists = emptyScan();
    try {
      bundle = scan([cdnBundle]);
      dists = scan(distFiles);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  });

  it('declares an ES ceiling the baseline engine actually supports', () => {
    const min = ES_EDITION_MIN_ENGINE[ES_CEILING];
    // A ceiling absent from the table is a hard failure: a new edition must be
    // measured against real engines before it can be declared.
    expect(
      min,
      `ES${ES_CEILING} is not in ES_EDITION_MIN_ENGINE — measure it before declaring it`
    ).toBeDefined();
    expect(
      engineAtLeast(BASELINE, min!),
      `ES_CEILING is ES${ES_CEILING}, which needs ${describeEngine(min!)}, but the declared ` +
        `baseline is ${describeEngine()}. Raising the ceiling past the baseline ships syntax ` +
        `the oldest supported engine cannot parse.`
    ).toBe(true);
  });

  it(`parses at the declared ES ceiling (ES${ES_CEILING})`, () => {
    expect(parseError).toBeNull();
  });

  it('scans a non-empty population (guards against a vacuously green run)', () => {
    // Every assertion below is an ABSENCE claim, which passes trivially if the
    // scan found nothing. Pin the population instead — and pin the BUNDLE
    // separately, because a truncated or stale dist-cdn/index.js would otherwise
    // hide behind the seven dists' literal count.
    expect(scannedPackages.length).toBeGreaterThanOrEqual(7);
    expect(dists.files).toBeGreaterThan(20);
    expect(dists.literals).toBeGreaterThan(20);
    expect(bundle.literals).toBeGreaterThan(20);
  });

  it('CDN bundle uses no regex pattern feature above the baseline', () => {
    expect(show(bundle.patternFeature)).toEqual([]);
  });

  it('CDN bundle uses only regex flags the baseline supports', () => {
    expect(show(bundle.badFlags)).toEqual([]);
  });

  it('every workspace package dist uses no regex pattern feature above the baseline', () => {
    expect(show(dists.patternFeature)).toEqual([]);
  });

  it('every workspace package dist uses only regex flags the baseline supports', () => {
    expect(show(dists.badFlags)).toEqual([]);
  });
});
