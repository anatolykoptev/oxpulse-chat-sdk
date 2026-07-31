#!/usr/bin/env node
// Release script for oxpulse-chat-sdk npm packages.
//
// Two publish modes:
//
// ── TOKEN MODE (default for local dev) ───────────────────────────────────────
//   Active when: NPM_TOKEN env is set and TRUSTED_PUBLISH is unset.
//   Auth: pnpm publish with npm_config_//registry.npmjs.org/:_authToken.
//   Does NOT emit provenance.
//
// ── OIDC / TRUSTED PUBLISHING MODE ───────────────────────────────────────────
//   Active when: TRUSTED_PUBLISH=1 (EXPLICIT opt-in only).
//   Auth: none — npm exchanges the GitHub Actions OIDC token automatically.
//   How it works:
//     1. `pnpm pack --pack-destination <tmp>` — pnpm rewrites workspace:^
//        references to real semver ranges in the tarball's package.json.
//     2. Assert the packed package.json has NO "workspace:" strings.
//     3. `npm publish <tarball> --access public` — npm CLI fetches
//        the OIDC token from the GitHub Actions environment and exchanges it
//        with the npm trusted-publishing endpoint. No token env var needed.
//   Provenance: opt-in via NPM_PROVENANCE=1. Requires the source repo to be
//   PUBLIC — npm refuses provenance from private repos. Do NOT set
//   NPM_PROVENANCE=1 in the workflow while the repo is private.
//   Requirement: npm >= 11.5.1, Node >= 22.14 (enforced in release.yml).
//
// ── SOFT-SKIP FOR UN-BOOTSTRAPPED PACKAGES ───────────────────────────────────
//   npm Trusted Publishing cannot be configured for a package until it exists
//   on the registry (npm requires the trusted-publisher UI to be reached from
//   the package's own settings page) — so a brand-new package needs one manual
//   bootstrap publish (token mode) before OIDC works for it.
//   - In OIDC mode: if `npm view` returns E404 for a package in SOFT_PACKAGES_OIDC,
//     we LOG a clear skip message and CONTINUE rather than fail the whole run.
//   - In token mode: behaviour is unchanged (publish if local > registry).
//   All three current packages (wire-codec, chat-sdk, chat-widget) are
//   bootstrapped and have trusted publishers configured — SOFT_PACKAGES_OIDC is
//   empty. Add a package name here if a future 4th package needs the same
//   bootstrap grace period; remove it once that package's trusted publisher is
//   configured on npm.
//
// ── ORDERING INVARIANT ────────────────────────────────────────────────────────
//   PACKAGES is in dep order (wire-codec → chat-sdk → chat-widget). A same-run
//   bump of wire-codec is visible to chat-sdk because we publish wire-codec first
//   and npm view will return the new version by the time chat-sdk publishes.
//
// Optional env:
//   DRY_RUN=1          Skip actual publish + tag/push. Pack + assert still run.
//   NPM_PROVENANCE=1   Add --provenance to npm publish (OIDC mode only).
//                      Requires the source repo to be PUBLIC — npm refuses
//                      provenance generation from private repos. Set this in
//                      release.yml only after the repo goes public.
//
// Exit codes:
//   0  ok (no-op or successful publish)
//   1  publish failure or workspace-string assertion failed
//   2  config error (missing token in token mode / wrong remote)

import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync, execSync, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Repo root is one level up from scripts/
const REPO_ROOT = join(__dirname, '..');

const DRY_RUN = process.env.DRY_RUN === '1';
const NPM_TOKEN = process.env.NPM_TOKEN;

// OIDC mode: EXPLICIT opt-in only via TRUSTED_PUBLISH=1.
// The implicit "CI=true && !NPM_TOKEN" arm was removed — publishing should
// never be a side-effect of "running in CI without a token configured".
const OIDC_MODE = process.env.TRUSTED_PUBLISH === '1';

// Provenance attestation opt-in.
// Requires a PUBLIC source repo — npm refuses --provenance from private repos.
// Set NPM_PROVENANCE=1 in release.yml when the repo goes public.
const PROVENANCE = process.env.NPM_PROVENANCE === '1';

// Packages in this repo, in dependency order.
const PACKAGES = [
	// Dep order: a same-run bump of an earlier package is visible to later
	// packages via `npm view` by the time they publish.
	{ name: '@oxpulse/wire-codec',      dir: 'packages/wire-codec'      },
	{ name: '@oxpulse/url-contract',     dir: 'packages/url-contract'     },
	{ name: '@oxpulse/crypto-primitives', dir: 'packages/crypto-primitives' },
	{ name: '@oxpulse/intro-protocol',   dir: 'packages/intro-protocol'   }, // depends on crypto-primitives
	{ name: '@oxpulse/chat-sdk',         dir: 'packages/chat-sdk'         },
	{ name: '@oxpulse/voice-core',       dir: 'packages/voice-core'       },
	{ name: '@oxpulse/chat-widget',      dir: 'packages/chat-widget'      },
];

// In OIDC mode, packages in this set are treated as "soft" — if npm view
// returns E404 (never published / no trusted publisher yet), we log + skip
// instead of failing the run. Once a package is bootstrapped on npm and its
// trusted publisher is configured, remove it from this set.
//
// Bootstrapped packages must NOT be in this set — their publish failures are fatal.
//
// As of 2026-07-21 ALL 7 packages (wire-codec, chat-sdk, chat-widget, voice-core,
// crypto-primitives, url-contract, intro-protocol) are published on npm with
// trusted publishers configured, so this set is EMPTY — every OIDC publish
// failure is now fatal. Add a name here ONLY as a temporary bootstrap grace
// period for a brand-new package, and remove it once its trusted publisher is
// configured. See ADR-013 + release.yml header comment.
const SOFT_PACKAGES_OIDC = new Set([]);

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
	console.log(`[release-npm] ${msg}`);
}

function fail(code, msg) {
	console.error(`[release-npm] FATAL: ${msg}`);
	process.exit(code);
}

function normalizeVersionInput(v) {
	if (v == null) return '0.0.0';
	if (Array.isArray(v)) return String(v[0] ?? '0.0.0').trim();
	return String(v).trim();
}

function semverCompare(a, b) {
	const sa = normalizeVersionInput(a);
	const sb = normalizeVersionInput(b);
	const pa = sa.split('.').map((n) => parseInt(n, 10));
	const pb = sb.split('.').map((n) => parseInt(n, 10));
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	}
	return 0;
}

function assertNoPrerelease(version, context) {
	if (version.includes('-')) {
		fail(1, `prerelease version detected in ${context}: "${version}" — prerelease versions are not supported; remove the "-..." suffix`);
	}
}

// Returns the latest registry version, or '0.0.0' if the package does not
// exist (E404). Throws on other failures.
// Also returns a boolean `notFound` to let callers distinguish "never published"
// from a real version (used for soft-skip logic).
function npmViewVersion(pkgName) {
	const res = spawnSync('npm', ['view', pkgName, 'version', '--json'], {
		encoding: 'utf8',
	});
	if (res.status === 0) {
		// --json wraps the version string in quotes; parse it.
		const parsed = JSON.parse(res.stdout.trim());
		return { version: parsed, notFound: false };
	}
	// Parse the structured JSON error to detect E404 precisely.
	// Avoids false positives from substrings like "E40456" or proxy 404 pages.
	try {
		const errJson = JSON.parse(res.stdout.trim() || res.stderr.trim());
		if (errJson?.error?.code === 'E404') {
			return { version: '0.0.0', notFound: true };
		}
	} catch {
		// stdout/stderr not JSON — fall through to anchored regex fallback.
	}
	// Anchored fallback: match the word-boundary form \bE404\b to avoid
	// substring false-positives (e.g. E40456, or a proxy page mentioning "404").
	if (/\bE404\b/.test(res.stderr)) {
		return { version: '0.0.0', notFound: true };
	}
	throw new Error(`npm view ${pkgName} failed: ${res.stderr}`);
}

function readLocalVersion(pkgDir) {
	const path = join(REPO_ROOT, pkgDir, 'package.json');
	if (!existsSync(path)) throw new Error(`package.json not found: ${path}`);
	const pkg = JSON.parse(readFileSync(path, 'utf8'));
	if (typeof pkg.version !== 'string') {
		throw new Error(`package.json at ${path} has no version field`);
	}
	return pkg.version;
}

// Pack the package via pnpm (which rewrites workspace:^ to real ranges),
// assert the packed package.json has no "workspace:" strings, then return
// the tarball path and the raw packed package.json content.
//
// scratch dir is created by the caller and must be cleaned up by the caller.
function packAndAssert(pkgName, pkgDir, scratch) {
	const packRes = spawnSync(
		'pnpm',
		['pack', '--pack-destination', scratch],
		{ cwd: pkgDir, encoding: 'utf8' },
	);
	if (packRes.status !== 0) {
		throw new Error(`pnpm pack failed for ${pkgName}: ${packRes.stderr}`);
	}
	// pnpm outputs the full tarball path as the last non-empty line of stdout.
	const tarballPath = packRes.stdout.trim().split('\n').filter(Boolean).pop().trim();

	// Extract package/package.json from the tarball.
	const extractRes = spawnSync(
		'tar',
		['-xzOf', tarballPath, 'package/package.json'],
		{ encoding: 'utf8' },
	);
	if (extractRes.status !== 0) {
		throw new Error(`tar extract failed for ${pkgName}: ${extractRes.stderr}`);
	}
	const packedPkgJson = extractRes.stdout;

	if (packedPkgJson.includes('workspace:')) {
		throw new Error(
			`BLOCKER: packed ${pkgName}/package.json still contains "workspace:" strings — ` +
			`pnpm workspace-protocol rewrite failed. Packed deps:\n` +
			JSON.stringify(JSON.parse(packedPkgJson).dependencies ?? {}, null, 2),
		);
	}
	log(`workspace-string assertion passed for ${pkgName}`);
	return { tarballPath, packedPkgJson };
}

async function publishPackageOidc(pkg, localVersion) {
	const pkgDir = join(REPO_ROOT, pkg.dir);
	log(`[OIDC] publishing ${pkg.name}@${localVersion}…`);

	const scratch = join(tmpdir(), `oxpulse-pack-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	try {
		const { tarballPath } = packAndAssert(pkg.name, pkgDir, scratch);

		const publishArgs = ['publish', tarballPath, '--access', 'public'];
		if (PROVENANCE) publishArgs.push('--provenance');

		if (DRY_RUN) {
			log(`DRY_RUN — would publish via OIDC: npm ${publishArgs.join(' ')}`);
			return;
		}

		// npm publish <tarball> [--provenance] --access public:
		//   - npm CLI auto-fetches the OIDC token from ACTIONS_ID_TOKEN_REQUEST_URL
		//     (set by GitHub Actions when permissions.id-token=write).
		//   - No NODE_AUTH_TOKEN or NPM_TOKEN needed.
		//   - --provenance: emits a signed attestation — only works with a PUBLIC repo.
		const res = spawnSync('npm', publishArgs, { stdio: 'inherit', encoding: 'utf8' });
		if (res.status !== 0) {
			fail(1, `npm publish (OIDC) failed for ${pkg.name} (exit=${res.status}) — aborting release`);
		}

	} finally {
		try { rmSync(scratch, { recursive: true, force: true }); } catch {}
	}

	// Tag FIRST, then announce it. changesets/action's runPublish() parses
	// "New tag: <pkg>@<ver>" out of this stdout (regex:
	// /New tag:\s+(@[^/]+\/[^@]+|[^/]+)@([^\s]+)/, run.ts:101) to set
	// outputs.published — which the CDN steps gate on — and to create a GitHub
	// Release, pushing each parsed tag on the way.
	//
	// So the line is a claim the action acts on, and it must not be made before
	// it is true. Printing it first is exactly how this pipeline ended up
	// announcing tags it never created: the action then pushed refs that did not
	// exist and failed AFTER npm publish had succeeded.
	//
	// If tagging fails we skip the line. That costs the CDN steps for this run —
	// they are gated on published — but it keeps the run green and leaves a
	// recoverable state, rather than failing the job on a ref we know is absent.
	// The WARNING logged by tagAndPush names the version and the manual repair.
	const tagged = tagAndPush(pkg.name, localVersion);
	if (tagged) console.log(`New tag: ${pkg.name}@${localVersion}`);
}

async function publishPackageToken(pkg, localVersion) {
	const pkgDir = join(REPO_ROOT, pkg.dir);
	log(`[token] publishing ${pkg.name}@${localVersion}…`);

	// Assert no workspace: strings (run pack-and-assert for the check, discard tarball).
	const scratch = join(tmpdir(), `oxpulse-pack-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	try {
		packAndAssert(pkg.name, pkgDir, scratch);
	} finally {
		try { rmSync(scratch, { recursive: true, force: true }); } catch {}
	}

	// Use pnpm publish — it rewrites workspace:^ to real ranges at pack time.
	const args = ['publish', '--no-git-checks', '--access', 'public'];
	if (DRY_RUN) args.push('--dry-run');

	const childEnv = Object.assign({}, process.env);
	childEnv['npm_config_//registry.npmjs.org/:_authToken'] = NPM_TOKEN;

	const res = spawnSync('pnpm', args, {
		cwd: pkgDir,
		stdio: 'inherit',
		env: childEnv,
	});

	if (res.status !== 0) {
		fail(1, `pnpm publish failed for ${pkg.name} (exit=${res.status}) — aborting release`);
	}

	if (DRY_RUN) {
		log(`DRY_RUN — would have tagged ${pkg.name}@${localVersion}`);
		return;
	}

	tagAndPush(pkg.name, localVersion);
}

// Give a CI checkout a git identity so `git tag -a` works. Only sets what is
// missing, so a local release keeps the operator's own identity.
function ensureGitIdentity() {
	const defaults = [
		['user.name', 'krolik-release-bot'],
		['user.email', 'krolik-release-bot@users.noreply.github.com'],
	];
	for (const [key, value] of defaults) {
		const probe = spawnSync('git', ['config', '--get', key], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
		});
		if (probe.status !== 0 || !String(probe.stdout || '').trim()) {
			execFileSync('git', ['config', key, value], { cwd: REPO_ROOT, stdio: 'inherit' });
		}
	}
}

function tagAndPush(pkgName, localVersion) {
	const tag = `${pkgName}@${localVersion}`;
	// Tag in BOTH modes.
	//
	// A published version that no tag points at is unreachable: `git log
	// <old>..<new>` cannot run, no GitHub Release exists, and there is no way
	// back from a registry version to a commit. Skipping this in CI is how 65 of
	// this repo's 66 published versions ended up untraceable — every automated
	// release published correctly and recorded nothing, and the one tag that did
	// exist was left by the last manual release.
	//
	// The previous justification was that "CI runners have no git identity".
	// That is two `git config` lines (ensureGitIdentity above); the job already
	// holds contents: write.
	//
	// Loop-safety: pushing a tag cannot re-trigger the release workflow, which is
	// filtered on `branches: [main]` — a branch filter never matches a tag ref.
	// changesets/action also pushes each tag it parses out of the "New tag:"
	// lines; pushing an identical existing tag is a no-op, so both paths are safe
	// together and neither depends on the other having run.
	if (OIDC_MODE) ensureGitIdentity();
	try {
		execFileSync('git', ['tag', '-a', tag, '-m', `release ${tag}`], {
			cwd: REPO_ROOT,
			stdio: 'inherit',
		});
		execFileSync('git', ['push', 'origin', tag], {
			cwd: REPO_ROOT,
			stdio: 'inherit',
		});
		log(`tagged + pushed ${tag}`);
		return true;
	} catch (err) {
		// Deliberately non-fatal: npm publish has already succeeded by this point,
		// and failing here would abort the job and skip the CDN steps that are
		// gated on it — trading a missing tag for a missing bundle.
		//
		// But say plainly what was lost, because the quiet version of this message
		// is what let the gap grow to 65 versions. A re-run is not enough: the
		// version is already on the registry, so the tag must be placed by hand at
		// the release commit — `git tag -a <tag> <sha> -m "release <tag>" && git
		// push origin <tag>`.
		log(`WARNING: ${tag} PUBLISHED BUT NOT TAGGED — this version is now untraceable until tagged by hand: ${err.message ?? err}`);
		return false;
	}
}

// ─── Pre-flight ─────────────────────────────────────────────────────────────

log(`mode=${OIDC_MODE ? 'OIDC/trusted-publish' : 'token'} dry_run=${DRY_RUN} provenance=${PROVENANCE}`);

if (!OIDC_MODE && !NPM_TOKEN && !DRY_RUN) {
	fail(2, 'NPM_TOKEN env not set (set TRUSTED_PUBLISH=1 for OIDC mode, or DRY_RUN=1 to skip auth check)');
}

// Assert git remote matches expected repo to avoid accidental tag pushes from
// a fork or mis-cloned checkout.
try {
	const remoteUrl = execSync('git remote get-url origin', {
		cwd: REPO_ROOT,
		encoding: 'utf8',
	}).trim();
	if (!remoteUrl.includes('oxpulse-chat-sdk')) {
		fail(2, `git remote origin "${remoteUrl}" does not match expected repo "oxpulse-chat-sdk" — refusing to push tags`);
	}
} catch (err) {
	fail(2, `could not read git remote: ${err.message ?? err}`);
}

log(`repo_root=${REPO_ROOT}`);

// ─── Main ───────────────────────────────────────────────────────────────────

let published = 0;
let skipped = 0;

for (const pkg of PACKAGES) {
	const local = readLocalVersion(pkg.dir);

	// Hard-reject prerelease versions.
	assertNoPrerelease(local, `${pkg.name} local package.json`);

	const { version: remote, notFound } = npmViewVersion(pkg.name);

	// ── Soft-skip for packages not yet bootstrapped on npm (OIDC mode only) ──
	// In OIDC mode, if a package has never been published (notFound=true) AND it
	// is in SOFT_PACKAGES_OIDC, we skip gracefully — the trusted publisher
	// cannot be configured for a non-existent package. The operator must do a
	// first manual publish (`pnpm publish --access public`) from a local machine
	// with an npm token, then configure the trusted publisher on npmjs.com.
	if (OIDC_MODE && notFound && SOFT_PACKAGES_OIDC.has(pkg.name)) {
		log(`${pkg.name}: no trusted publisher yet (package not on npm) — bootstrap manually first, then add to trusted publishers. SKIPPING (non-fatal).`);
		skipped++;
		continue;
	}

	assertNoPrerelease(remote, `${pkg.name} npm registry`);

	const cmp = semverCompare(local, remote);
	if (cmp > 0) {
		log(`${pkg.name}: local=${local} > registry=${remote} — publishing`);
		if (OIDC_MODE) {
			await publishPackageOidc(pkg, local);
		} else {
			await publishPackageToken(pkg, local);
		}
		published++;
	} else if (cmp === 0) {
		log(`${pkg.name}: local=${local} == registry=${remote} — skip`);
		skipped++;
	} else {
		log(`${pkg.name}: local=${local} < registry=${remote} — skip (no downgrade)`);
		skipped++;
	}
}

log(`done — published=${published} skipped=${skipped}`);
