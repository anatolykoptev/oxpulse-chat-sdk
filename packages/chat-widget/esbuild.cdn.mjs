/**
 * esbuild CDN bundle — single-file ESM for <script type="module"> embedding.
 *
 * Usage: node esbuild.cdn.mjs
 *
 * Produces dist-cdn/index.js + index.js.map + zstd.wasm (sibling) + index.js.sha384
 *
 * Design:
 * - @bokuweb/zstd-wasm uses `new URL(\`./zstd.wasm\`, import.meta.url)` (template literal).
 *   esbuild's file loader only pattern-matches static string literals, so it leaves
 *   the URL as-is in the bundle (becoming `"./zstd.wasm"` after minification — correct).
 *   We locate and copy zstd.wasm from the pnpm virtual store into dist-cdn/ explicitly,
 *   making it a true sibling of index.js. At runtime, import.meta.url resolves to the
 *   CDN script URL, so the browser fetches `<version>/zstd.wasm` from the same directory.
 * - FF-1 size gate: gzip(index.js) must not exceed 250 KB — exits non-zero on breach.
 * - SRI: writes index.js.sha384 (raw base64 sha384 digest) for the README snippet.
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esbuildTarget, describeEngine } from '../../browser-baseline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const gzipAsync = promisify(gzip);

// ── Locate zstd.wasm ─────────────────────────────────────────────────────────
//
// @bokuweb/zstd-wasm is a transitive dep (chat-widget → chat-sdk → wire-codec → zstd-wasm).
// In pnpm's strict hoisting model it is NOT accessible from chat-widget's node_modules
// directly, but lives in the workspace root's virtual store.
// We walk up from __dirname to find the workspace root's node_modules and resolve from there.

function findZstdWasm(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    // pnpm virtual store: node_modules/.pnpm/@bokuweb+zstd-wasm@*/node_modules/@bokuweb/zstd-wasm
    const pnpmStore = path.join(dir, 'node_modules', '.pnpm');
    if (fs.existsSync(pnpmStore)) {
      const entries = fs.readdirSync(pnpmStore)
        .filter(e => e.startsWith('@bokuweb+zstd-wasm@'))
        .sort(); // deterministic: lexicographic order (semver-safe for same-major)

      // Guard: two distinct versions in the store would pick an arbitrary one and
      // could mismatch the version esbuild bundled → fail loudly instead.
      const versions = new Set(entries.map(e => e.replace(/^@bokuweb\+zstd-wasm@/, '')));
      if (versions.size > 1) {
        console.error(
          `[build:cdn] FAIL: multiple @bokuweb/zstd-wasm versions in pnpm store: ${[...versions].join(', ')}. ` +
          'Deduplicate before building to ensure the copied wasm matches the bundled JS.'
        );
        process.exit(1);
      }

      for (const entry of entries) {
        const candidate = path.join(pnpmStore, entry, 'node_modules', '@bokuweb', 'zstd-wasm', 'dist', 'web', 'zstd.wasm');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const zstdWasmSrc = findZstdWasm(__dirname);
if (!zstdWasmSrc) {
  console.error('[build:cdn] FAIL: cannot locate @bokuweb/zstd-wasm dist/web/zstd.wasm in pnpm store');
  process.exit(1);
}

// ── Banner ────────────────────────────────────────────────────────────────────

const banner = [
  '/*!',
  ` * @oxpulse/chat-widget v${pkg.version}`,
  ` * License: AGPL-3.0-or-later (https://www.gnu.org/licenses/agpl-3.0.html)`,
  ` * Copyright (c) OxPulse contributors`,
  ' */',
].join('\n');

const outdir = path.join(__dirname, 'dist-cdn');

// ── esbuild ───────────────────────────────────────────────────────────────────

await build({
  entryPoints: [path.join(__dirname, 'src/index.ts')],
  bundle: true,
  format: 'esm',
  minify: true,
  sourcemap: true,
  // Derived from browser-baseline.mjs — the ONE declaration of the oldest engine
  // we support. Do NOT replace this with a literal: the gate in
  // src/__tests__/browser-regex-compat.test.ts parses this bundle at the same
  // ceiling, and two separately-typed numbers are how the artifact silently
  // outruns the engines we claim to support.
  target: [esbuildTarget()],
  platform: 'browser',
  outdir,
  loader: { '.wasm': 'file' },
  assetNames: '[name]',
  define: {
    __WIDGET_VERSION__: JSON.stringify(pkg.version),
  },
  banner: { js: banner },
  treeShaking: true,
});

// ── Copy zstd.wasm as a sibling ───────────────────────────────────────────────
//
// @bokuweb/zstd-wasm uses a template literal `new URL(\`./zstd.wasm\`, import.meta.url)`
// which esbuild does not pattern-match for asset emission. The bundle already contains
// the correct relative reference "./zstd.wasm" after minification, so placing the file
// next to index.js is sufficient for the browser to fetch it at runtime.

const wasmDest = path.join(outdir, 'zstd.wasm');
fs.copyFileSync(zstdWasmSrc, wasmDest);
console.log(`[build:cdn] Copied zstd.wasm (${(fs.statSync(wasmDest).size / 1024).toFixed(1)} KB) → dist-cdn/zstd.wasm`);

// ── FF-1: size gate ───────────────────────────────────────────────────────────

const MAX_GZIP_BYTES = 250 * 1024; // 250 KB hard budget

const indexJsPath = path.join(outdir, 'index.js');
const indexJsBuf = fs.readFileSync(indexJsPath);
const compressed = await gzipAsync(indexJsBuf, { level: 9 });
const gzKb = (compressed.length / 1024).toFixed(1);

console.log(
  `[build:cdn] index.js: ${(indexJsBuf.length / 1024).toFixed(1)} KB raw, ${gzKb} KB gzip (budget: ${MAX_GZIP_BYTES / 1024} KB), target ${esbuildTarget()} (baseline ${describeEngine()})`
);

if (compressed.length > MAX_GZIP_BYTES) {
  console.error(
    `[build:cdn] FAIL: gzip size ${gzKb} KB exceeds 250 KB budget. ` +
      'Trim dependencies or enable more aggressive tree-shaking.'
  );
  process.exit(1);
}

// ── SRI: sha384 ──────────────────────────────────────────────────────────────

const sha384 = createHash('sha384').update(indexJsBuf).digest('base64');
const sriPath = path.join(outdir, 'index.js.sha384');
fs.writeFileSync(sriPath, sha384);

console.log(`[build:cdn] SRI: sha384-${sha384}`);
console.log(`[build:cdn] Done — dist-cdn/{index.js, index.js.map, zstd.wasm, index.js.sha384}`);
