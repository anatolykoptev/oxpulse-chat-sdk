#!/usr/bin/env node
// Release watcher for oxpulse-chat-sdk npm packages.
//
// Reads versions from packages/* in this repo (no git clone/sync needed —
// this script runs inside the repo itself). Publishes to npm when local
// version > registry version.
//
// Behaviour:
//   For each package in PACKAGES (in dep order — deps before dependents):
//     1. Read local version from packages/<dir>/package.json
//     2. Reject prerelease versions (versions containing "-") with a hard error
//     3. Query npm registry for latest version
//     4. local > registry  → pnpm publish (rewrites workspace:^ to real ranges)
//                           + git tag + push tag
//     5. equal or local <  → skip
//
// Fail-fast: any publish failure exits immediately (exit 1). Dependents are
// not published on top of a failed dependency. Re-run is safe — the
// version-compare gate skips already-published packages.
//
// Required env:
//   NPM_TOKEN          npm automation token, bypass_2fa=true, write access
//                      to @oxpulse/* packages.
//
// Optional env:
//   DRY_RUN=1          Run `pnpm publish --dry-run` instead of real publish.
//                      Skips tagging/pushing. Still runs the no-workspace-string
//                      assertion on the packed tarball.
//
// Exit codes:
//   0  ok (no-op or successful publish)
//   1  publish failure or workspace-string assertion failed
//   2  config error (missing token / wrong remote)

import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Repo root is one level up from scripts/
const REPO_ROOT = join(__dirname, '..');

const DRY_RUN = process.env.DRY_RUN === '1';
const NPM_TOKEN = process.env.NPM_TOKEN;

// Packages in this repo, in dependency order (deps before dependents so a
// same-run wire-codec bump is visible to chat-sdk if both bump together).
const PACKAGES = [
	{ name: '@oxpulse/wire-codec', dir: 'packages/wire-codec' },
	{ name: '@oxpulse/chat-sdk',   dir: 'packages/chat-sdk'   },
	{ name: '@oxpulse/chat-widget', dir: 'packages/chat-widget' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
	console.log(`[release-npm] ${msg}`);
}

function fail(code, msg) {
	console.error(`[release-npm] FATAL: ${msg}`);
	process.exit(code);
}

function semverCompare(a, b) {
	const pa = a.split('.').map((n) => parseInt(n, 10));
	const pb = b.split('.').map((n) => parseInt(n, 10));
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

function npmViewVersion(pkgName) {
	const res = spawnSync('npm', ['view', pkgName, 'version'], {
		encoding: 'utf8',
	});
	if (res.status === 0) return res.stdout.trim();
	// E404 or non-zero with E404 in stderr = never published; treat as "0.0.0"
	if (res.status !== 0 && /E?404/.test(res.stderr)) return '0.0.0';
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

// Assert the packed tarball for a package contains no workspace: strings in
// package.json — pnpm must have rewritten them. Throws on failure.
function assertNoWorkspaceStrings(pkgName, pkgDir) {
	const scratch = join(tmpdir(), `oxpulse-pack-${Date.now()}`);
	mkdirSync(scratch, { recursive: true });
	try {
		// pnpm pack outputs the tarball filename to stdout
		const packRes = spawnSync(
			'pnpm',
			['pack', '--pack-destination', scratch],
			{ cwd: pkgDir, encoding: 'utf8' },
		);
		if (packRes.status !== 0) {
			throw new Error(`pnpm pack failed for ${pkgName}: ${packRes.stderr}`);
		}
		// pnpm pack outputs the full tarball path as the last line of stdout
		const tarballPath = packRes.stdout.trim().split('\n').filter(Boolean).pop().trim();

		// Extract package/package.json from the tarball and check for workspace:
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
				JSON.stringify(JSON.parse(packedPkgJson).dependencies ?? {}, null, 2)
			);
		}
		log(`workspace-string assertion passed for ${pkgName}`);
		return packedPkgJson;
	} finally {
		try { rmSync(scratch, { recursive: true, force: true }); } catch {}
	}
}

async function publishPackage(pkg, localVersion) {
	const pkgDir = join(REPO_ROOT, pkg.dir);
	log(`publishing ${pkg.name}@${localVersion}…`);

	// Assert no workspace: strings in the packed tarball BEFORE publish.
	// Runs in both dry-run and real mode.
	assertNoWorkspaceStrings(pkg.name, pkgDir);

	// Use pnpm publish — it rewrites workspace:^ to real ranges at pack time.
	// Auth via env var: pnpm respects npm_config_* env vars for registry auth.
	const args = ['publish', '--no-git-checks', '--access', 'public'];
	if (DRY_RUN) args.push('--dry-run');

	const childEnv = Object.assign({}, process.env);
	// pnpm respects npm_config_* env vars for registry auth.
	// The key contains slashes so must be set via Object.assign / bracket notation.
	if (NPM_TOKEN) {
		childEnv['npm_config_//registry.npmjs.org/:_authToken'] = NPM_TOKEN;
	}

	const res = spawnSync('pnpm', args, {
		cwd: pkgDir,
		stdio: 'inherit',
		env: childEnv,
	});

	if (res.status !== 0) {
		// Fail fast — exit immediately, do not continue to dependents.
		fail(1, `pnpm publish failed for ${pkg.name} (exit=${res.status}) — aborting release`);
	}

	if (DRY_RUN) {
		log(`DRY_RUN — would have tagged ${pkg.name}@${localVersion}`);
		return;
	}

	const tag = `${pkg.name}@${localVersion}`;
	try {
		execSync(`git tag -a "${tag}" -m "release ${tag}"`, {
			cwd: REPO_ROOT,
			stdio: 'inherit',
		});
		execSync(`git push origin "${tag}"`, { cwd: REPO_ROOT, stdio: 'inherit' });
		log(`tagged + pushed ${tag}`);
	} catch (err) {
		// Tag already exists if script ran twice for the same version before
		// npm view caught up. Publish succeeded — that's the load-bearing op.
		log(`tag/push warning (non-fatal): ${err.message ?? err}`);
	}
}

// ─── Pre-flight ─────────────────────────────────────────────────────────────

if (!NPM_TOKEN && !DRY_RUN) {
	fail(2, 'NPM_TOKEN env not set (set DRY_RUN=1 to skip auth check)');
}

// Assert the git remote matches the expected repo to avoid accidental tag
// pushes from a fork or mis-cloned checkout.
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

log(`repo_root=${REPO_ROOT} dry_run=${DRY_RUN}`);

// ─── Main ───────────────────────────────────────────────────────────────────

let published = 0;
let skipped = 0;

for (const pkg of PACKAGES) {
	const local = readLocalVersion(pkg.dir);

	// Hard-reject prerelease versions — we don't support them and semverCompare
	// would silently mis-handle them (strips the prerelease suffix via parseInt).
	assertNoPrerelease(local, `${pkg.name} local package.json`);

	const remote = npmViewVersion(pkg.name);
	assertNoPrerelease(remote, `${pkg.name} npm registry`);

	const cmp = semverCompare(local, remote);
	if (cmp > 0) {
		log(`${pkg.name}: local=${local} > registry=${remote} — publishing`);
		await publishPackage(pkg, local);
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
