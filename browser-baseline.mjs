/**
 * The oldest browser engine this repo's shipped JavaScript must run on.
 *
 * ONE declaration, consumed by two places that must never disagree:
 *   - packages/chat-widget/esbuild.cdn.mjs — the CDN bundle's esbuild `target`
 *   - packages/chat-widget/src/__tests__/browser-regex-compat.test.ts — the gate
 *
 * Why a shared module and not two matching literals: the failure mode this whole
 * gate exists to prevent is a bundle that a real phone cannot PARSE. If the build
 * target and the assertion are typed out separately, someone raises the target,
 * the gate keeps asserting the old number, and the artifact silently outruns the
 * engines we claim to support. That is the same shape as the outage itself.
 *
 * The one knob is OLDEST_SUPPORTED_ENGINE. Everything else is derived from it or
 * checked against it — including ES_CEILING, which is asserted to be an edition
 * the baseline engine fully implements. Raising ES_CEILING past what the baseline
 * supports fails the gate rather than shipping.
 */

/**
 * Safari / iOS WebKit, as [major, minor].
 *
 * Every browser on iOS is WebKit regardless of its name, so this number is the
 * real floor for the entire iOS install base, not just for Safari users.
 *
 * 15.0 matches the sibling repo's measured baseline. It is also honest about what
 * we already ship: the CDN bundle currently requires ~ES2020 syntax, i.e. roughly
 * Safari 14.1 — the previous comment in the gate claimed Safari 11.1, which was
 * never true of the artifact.
 *
 * Lowering this is a real product decision, not a formality: it tightens
 * ALLOWED_FLAGS and the banned-pattern set automatically, and it may force
 * ES_CEILING down, which changes the emitted bundle.
 */
export const OLDEST_SUPPORTED_ENGINE = { name: 'Safari / iOS WebKit', version: [15, 0] };

/**
 * The highest ECMAScript edition the emitted artifacts may use.
 *
 * This is the esbuild `target` AND the acorn `ecmaVersion` the gate parses with.
 * Deliberately kept one edition below what the baseline strictly allows: the
 * artifact needs ES2020 today, so there is no reason to buy syntax headroom we
 * are not using. Raising it is allowed — the gate checks it against the baseline
 * (see ES_EDITION_MIN_ENGINE) — but it must be a decision, not a drift.
 *
 * NOTE this is a CEILING on the ES *edition*, which is a blunter instrument than
 * per-feature engine support. It cannot express "ES2018 lookbehind is fine as a
 * language feature but WebKit only shipped it in 16.4". That gap is exactly what
 * the regex tables below are for — the parser handles the syntax axis, the tables
 * handle the sub-edition WebKit gaps a parser cannot know about.
 */
export const ES_CEILING = 2020;

/**
 * First Safari/WebKit version that fully implements each ECMAScript edition's
 * SYNTAX (not its library methods — a missing method is a runtime error in one
 * call site; missing syntax aborts the whole module, which is the class we gate).
 *
 * Anchors, for whoever has to re-derive this:
 *   2018 — async iteration, object rest/spread          → 11.1
 *   2019 — optional catch binding                       → 12.1
 *   2020 — optional chaining, nullish, `export * as ns` → 14.1
 *   2021 — logical assignment operators                 → 14.1
 *   2022 — class static initialisation blocks           → 16.4
 *   2024 — regex `v` flag                               → 17.0
 * An edition missing from this table is a hard error, not a default — a future
 * edition must be measured before it can be declared.
 */
export const ES_EDITION_MIN_ENGINE = {
  2017: [10, 3],
  2018: [11, 1],
  2019: [12, 1],
  2020: [14, 1],
  2021: [14, 1],
  2022: [16, 4],
  2023: [16, 4],
  2024: [17, 0],
};

/**
 * First Safari/WebKit version supporting each regex FLAG.
 *
 * An unsupported flag on a regex LITERAL is a SyntaxError at module-parse time —
 * identical blast radius to the lookbehind that caused the 0.21.2 outage.
 *
 * The gate turns this into an allowlist by comparing against the baseline, so it
 * is self-updating in both directions: a flag stays banned until the declared
 * baseline actually supports it, and a future flag absent from this table is
 * rejected outright (fail closed — a flag nobody has heard of yet cannot ship).
 */
export const REGEX_FLAG_MIN_ENGINE = {
  // hasIndices. Legal at this baseline, but reachable through the CONSTRUCTOR
  // forms only: `d` is an ES2022 flag, so a `/x/d` LITERAL exceeds ES_CEILING
  // (2020) and acorn rejects it before the flag check ever runs — it surfaces
  // as a ceiling failure, not as a flag verdict. Not a hole: both outcomes are
  // safe here, and esbuild lowers such a literal to `new RegExp("x","d")`,
  // which this row then correctly accepts. Written down because a row that
  // says "allowed" while the literal form cannot reach it is exactly the kind
  // of thing that sends the next reader hunting the wrong knob.
  d: [15, 0],
  g: [1, 0],
  i: [1, 0],
  m: [1, 0],
  s: [11, 1], // dotAll
  u: [10, 0], // unicode
  v: [17, 0], // unicodeSets
  y: [10, 0], // sticky
};

/**
 * Regex PATTERN features whose WebKit support lags their ECMAScript edition.
 *
 * This is the list a parser cannot derive: lookbehind is ES2018, but WebKit only
 * shipped it in 16.4 — six years and one outage apart.
 */
export const REGEX_PATTERN_FEATURES = [
  { id: 'lookbehind', test: /\(\?<[=!]/, minEngine: [16, 4] },
  { id: 'named-capture-group', test: /\(\?<[A-Za-z_$]/, minEngine: [11, 1] },
  { id: 'unicode-property-escape', test: /\\[pP]\{/, minEngine: [11, 1] },
];

/** True when engine version `have` is at least `want`. Both [major, minor]. */
export function engineAtLeast(have, want) {
  return have[0] !== want[0] ? have[0] > want[0] : have[1] >= want[1];
}

/** The esbuild `target` string derived from ES_CEILING. */
export function esbuildTarget() {
  return `es${ES_CEILING}`;
}

/** "Safari / iOS WebKit 15.0" — for assertion messages. */
export function describeEngine(version = OLDEST_SUPPORTED_ENGINE.version) {
  return `${OLDEST_SUPPORTED_ENGINE.name} ${version[0]}.${version[1]}`;
}
