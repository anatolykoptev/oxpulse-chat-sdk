#!/usr/bin/env node
// Release watcher for oxpulse-chat-sdk npm packages.
//
// Reads versions from packages/* in this repo (no git clone/sync needed —
// this script runs inside the repo itself). Publishes to npm when local
// version > registry version.
//
// Behaviour:
//   For each package in PACKAGES:
//     1. Read local version from packages/<dir>/package.json
//     2. Query npm registry for latest version
//     3. local > registry  → npm publish + git tag + push tag
//     4. equal or local <  → skip
//
// Idempotent: safe to run on a cron / systemd timer or CI.
// Triggers a publish when operator bumps `version` in a package.json and
// pushes to main. No conventional-commit parsing — operator-controlled semver.
//
// Required env:
//   NPM_TOKEN          npm automation token, bypass_2fa=true, write access
//                      to @oxpulse/* packages.
//
// Optional env:
//   DRY_RUN=1          Run `npm publish --dry-run` instead of real publish.
//                      Skips tagging/pushing.
//
// Exit codes:
//   0  ok (no-op or successful publish)
//   1  publish failure in at least one package
//   2  config error (missing token)

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

function npmViewVersion(pkgName) {
	const res = spawnSync('npm', ['view', pkgName, 'version'], {
		encoding: 'utf8',
	});
	if (res.status === 0) return res.stdout.trim();
	// E404 = never published; treat as "0.0.0" so any local version wins.
	if (res.stderr.includes('E404')) return '0.0.0';
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

async function publishPackage(pkg, localVersion) {
	const pkgDir = join(REPO_ROOT, pkg.dir);
	log(`publishing ${pkg.name}@${localVersion}…`);

	const args = ['publish'];
	if (DRY_RUN) args.push('--dry-run');

	// Write a scoped .npmrc so the token is used without touching the global
	// npmrc. Scrubbed in finally.
	const npmrcPath = join(pkgDir, '.npmrc');
	let wroteNpmrc = false;
	if (NPM_TOKEN) {
		writeFileSync(
			npmrcPath,
			`//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nregistry=https://registry.npmjs.org/\n`,
			{ mode: 0o600 },
		);
		wroteNpmrc = true;
	}

	let res;
	try {
		res = spawnSync('npm', args, { cwd: pkgDir, stdio: 'inherit' });
	} finally {
		if (wroteNpmrc) {
			try { unlinkSync(npmrcPath); } catch {}
		}
	}
	if (res.status !== 0) {
		throw new Error(`npm publish failed for ${pkg.name} (exit=${res.status})`);
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

// ─── Main ───────────────────────────────────────────────────────────────────

if (!NPM_TOKEN && !DRY_RUN) {
	fail(2, 'NPM_TOKEN env not set (set DRY_RUN=1 to skip auth check)');
}

log(`repo_root=${REPO_ROOT} dry_run=${DRY_RUN}`);

let published = 0;
let skipped = 0;
let failed = 0;

for (const pkg of PACKAGES) {
	try {
		const local = readLocalVersion(pkg.dir);
		const remote = npmViewVersion(pkg.name);
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
	} catch (err) {
		console.error(`[release-npm] ${pkg.name} ERROR: ${err.message ?? err}`);
		failed++;
	}
}

log(`done — published=${published} skipped=${skipped} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
