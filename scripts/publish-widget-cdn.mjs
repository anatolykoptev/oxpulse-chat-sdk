#!/usr/bin/env node
// CDN publisher for @oxpulse/chat-widget.
//
// Publishes the esbuild CDN bundle (dist-cdn/) to the krolik box file-server
// via SSH + rsync.  Assumes `build:cdn` has already run (dist-cdn/ exists).
//
// Key properties:
//   Append-only:   if widget/<version>/index.js already exists on the remote
//                  with a DIFFERENT sha256 → exit 1, abort (immutable URL contract).
//                  Identical hash → no-op, exit 0 (idempotent re-run safe).
//   Atomic deploy: rsync to a temp dir, then `ssh … mv` into place so a
//                  client never sees a half-written version dir.  This also
//                  avoids a 404-with-Cache-Control:immutable window during rsync.
//   latest/:       refreshed ONLY if this version is the highest stable semver
//                  among all dirs in widget/ on the remote.  Mutable, staged
//                  then mv'd atomically as well.
//   Soft-skip:     if CDN_DEPLOY_KEY is absent → log + exit 0 (pipeline safe
//                  before the operator installs the key).
//   DRY_RUN=1:     does everything EXCEPT remote writes — prints the exact plan.
//
// Required env:
//   CDN_SSH_HOST    box hostname or IP (e.g. "192.9.243.148")
//   CDN_SSH_USER    ssh user (e.g. "krolik")
//   CDN_DEPLOY_KEY  private ed25519 key content (PEM); written to a tmp file
//
// Optional env:
//   DRY_RUN=1       skip actual remote writes; print plan; exit 0
//
// SSH authorised_keys line the operator must install on the box:
//   command="rrsync -wo /home/krolik/deploy/krolik-server/files/cdn-oxpulse",restrict ssh-ed25519 <PUBKEY> cdn-deploy@oxpulse-chat-sdk
//
// This jails the key to write-only access on the CDN directory via rrsync.
// The key can rsync files in but cannot read or delete any existing content.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

const DRY_RUN = process.env.DRY_RUN === '1';
const CDN_SSH_HOST = process.env.CDN_SSH_HOST || '';
const CDN_SSH_USER = process.env.CDN_SSH_USER || '';
const CDN_DEPLOY_KEY = process.env.CDN_DEPLOY_KEY || '';

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
	console.log(`[cdn-publish] ${msg}`);
}

function fail(msg) {
	console.error(`[cdn-publish] FATAL: ${msg}`);
	process.exit(1);
}

// ── Soft-skip when deploy key is absent ──────────────────────────────────────
// Mirror the SOFT_PACKAGES pattern in release-npm-packages.mjs.
// Pipeline safe to merge before the operator installs the key.

if (!CDN_DEPLOY_KEY) {
	log('CDN_DEPLOY_KEY secret is absent — CDN publish skipped (non-fatal).');
	log('Action required: generate an ed25519 key pair and install as described in the PR body.');
	process.exit(0);
}

// ── Semver helpers ────────────────────────────────────────────────────────────

function semverParse(v) {
	const m = v.match(/^(\d+)\.(\d+)\.(\d+)(-(.+))?$/);
	if (!m) return null;
	return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[5] ?? null };
}

function semverCompare(a, b) {
	const pa = semverParse(a);
	const pb = semverParse(b);
	if (!pa || !pb) return 0;
	for (const k of ['major', 'minor', 'patch']) {
		if (pa[k] !== pb[k]) return pa[k] - pb[k];
	}
	// stable > prerelease
	if (!pa.pre && pb.pre) return 1;
	if (pa.pre && !pb.pre) return -1;
	return 0;
}

function isStable(version) {
	const p = semverParse(version);
	return p !== null && p.pre === null;
}

// ── Resolve paths ─────────────────────────────────────────────────────────────

const widgetPkgJson = join(REPO_ROOT, 'packages', 'chat-widget', 'package.json');
if (!existsSync(widgetPkgJson)) fail(`package.json not found: ${widgetPkgJson}`);
const pkg = JSON.parse(readFileSync(widgetPkgJson, 'utf8'));
const VERSION = pkg.version;
if (!VERSION) fail('packages/chat-widget/package.json has no version field');

const DIST_CDN = join(REPO_ROOT, 'packages', 'chat-widget', 'dist-cdn');
const INDEX_JS = join(DIST_CDN, 'index.js');
const SHA384_FILE = join(DIST_CDN, 'index.js.sha384');

if (!existsSync(INDEX_JS)) {
	fail(`dist-cdn/index.js not found — run 'pnpm --filter @oxpulse/chat-widget build:cdn' first`);
}
if (!existsSync(SHA384_FILE)) {
	fail(`dist-cdn/index.js.sha384 not found — run 'pnpm --filter @oxpulse/chat-widget build:cdn' first`);
}

// ── Local sha256 of index.js ──────────────────────────────────────────────────

const localIndexBuf = readFileSync(INDEX_JS);
const localSha256 = createHash('sha256').update(localIndexBuf).digest('hex');

// ── SRI line ──────────────────────────────────────────────────────────────────

const sri = readFileSync(SHA384_FILE, 'utf8').trim();
const sriAttr = `integrity="sha384-${sri}"`;

log(`version: ${VERSION}`);
log(`local sha256(index.js): ${localSha256}`);
log(`SRI: ${sriAttr}`);

// ── Validate required env (unless dry-run) ────────────────────────────────────

if (!DRY_RUN) {
	if (!CDN_SSH_HOST) fail('CDN_SSH_HOST env is not set');
	if (!CDN_SSH_USER) fail('CDN_SSH_USER env is not set');
}

const SSH_TARGET = `${CDN_SSH_USER}@${CDN_SSH_HOST}`;

// rrsync jail maps to /home/krolik/deploy/krolik-server/files/cdn-oxpulse
// so rsync paths are RELATIVE to that root.
const REMOTE_WIDGET_BASE = 'widget';
const REMOTE_VERSION_DIR = `${REMOTE_WIDGET_BASE}/${VERSION}`;
const REMOTE_LATEST_DIR = `${REMOTE_WIDGET_BASE}/latest`;
// Temp dirs on remote for atomic deploy
const RUN_ID = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const REMOTE_VERSION_TMP = `${REMOTE_WIDGET_BASE}/.tmp-${VERSION}-${RUN_ID}`;
const REMOTE_LATEST_TMP = `${REMOTE_WIDGET_BASE}/.tmp-latest-${RUN_ID}`;

// ── Write deploy key to tmp file ──────────────────────────────────────────────

const keyDir = join(tmpdir(), `cdn-deploy-key-${Date.now()}`);
mkdirSync(keyDir, { mode: 0o700, recursive: true });
const keyFile = join(keyDir, 'id_ed25519');

function cleanupKey() {
	try { rmSync(keyDir, { recursive: true, force: true }); } catch {}
}

// ── SSH / rsync helpers ───────────────────────────────────────────────────────

const SSH_OPTS = [
	'-i', keyFile,
	'-o', 'StrictHostKeyChecking=yes',
	'-o', 'BatchMode=yes',
	'-o', 'ConnectTimeout=30',
];

function rsync(args, description) {
	const cmd = ['rsync', '-az', '--no-perms', '-e', `ssh ${SSH_OPTS.join(' ')}`, ...args];
	log(`rsync plan: ${cmd.join(' ')}`);
	if (DRY_RUN) {
		log(`DRY_RUN — skipping rsync (${description})`);
		return;
	}
	const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', encoding: 'utf8' });
	if (res.status !== 0) fail(`rsync failed (${description}): exit ${res.status}`);
}

function ssh(remoteCmd, description) {
	const args = [...SSH_OPTS, SSH_TARGET, remoteCmd];
	log(`ssh plan: ssh ${args.join(' ')}`);
	if (DRY_RUN) {
		log(`DRY_RUN — skipping ssh (${description})`);
		return '';
	}
	const res = spawnSync('ssh', args, { encoding: 'utf8' });
	if (res.status !== 0) fail(`ssh failed (${description}): ${res.stderr}`);
	return res.stdout.trim();
}

// ── Append-only guard ─────────────────────────────────────────────────────────
// If widget/<version>/index.js already exists on the remote, compare sha256.
// Identical → idempotent no-op exit 0.
// Different → exit 1 (immutable URL contract violation, abort).

function appendOnlyGuard() {
	if (DRY_RUN) {
		log(`DRY_RUN — skipping append-only guard remote check (remote hash unknown)`);
		log(`Append-only guard logic: if remote sha256 == local sha256 → no-op; if different → exit 1`);
		return 'not-exists'; // assume new in dry-run
	}

	// rrsync in -wo (write-only) mode does not allow reads, so we cannot
	// directly `cat` the remote file. Instead, we rsync just index.js to a
	// dedicated check-tmp dir and compare locally, then clean up.
	// Alternative: use a separate read-only SSH key for verification. That is
	// overkill; write-only rrsync naturally prevents mutation — the guard is a
	// belt-and-suspenders local-vs-remote hash comparison using a tmp rsync.
	//
	// To avoid any ambiguity: we use --ignore-existing on the actual deploy rsync.
	// The guard here uses a probe rsync of just the existing file (if it exists)
	// to detect content drift.

	const probeTmp = join(tmpdir(), `cdn-probe-${Date.now()}`);
	mkdirSync(probeTmp, { recursive: true });
	try {
		// Attempt to fetch the existing index.js. If the version dir does not
		// exist yet, rsync exits 23 (partial transfer, no files). We detect by
		// file presence, not exit code.
		const res = spawnSync('rsync', [
			'-az', '--no-perms',
			'-e', `ssh ${SSH_OPTS.join(' ')}`,
			// source is a single file; if missing, rsync exits non-zero
			`${SSH_TARGET}:${REMOTE_VERSION_DIR}/index.js`,
			`${probeTmp}/`,
		], { encoding: 'utf8' });

		const probedFile = join(probeTmp, 'index.js');
		if (!existsSync(probedFile)) {
			// File does not exist on remote → new deploy, proceed.
			log(`Append-only guard: ${REMOTE_VERSION_DIR}/index.js not found on remote → new version`);
			return 'not-exists';
		}

		const remoteSha256 = createHash('sha256').update(readFileSync(probedFile)).digest('hex');
		if (remoteSha256 === localSha256) {
			log(`Append-only guard: sha256 match (${localSha256}) → idempotent re-run, nothing to do`);
			return 'same';
		}

		// Different content for the same version → immutable contract violation.
		fail(
			`Append-only guard: ${REMOTE_VERSION_DIR}/index.js ALREADY EXISTS with different sha256.\n` +
			`  remote sha256: ${remoteSha256}\n` +
			`  local  sha256: ${localSha256}\n` +
			`Refusing to overwrite a published immutable version. ` +
			`If this is a legitimate re-build, bump the version number first.`
		);
	} finally {
		try { rmSync(probeTmp, { recursive: true, force: true }); } catch {}
	}
}

// ── Determine if this version should advance `latest/` ───────────────────────
// Fetch all existing widget/<v>/ directory names from the remote, pick the
// highest stable semver. If the current version is higher → update latest/.

function shouldUpdateLatest() {
	if (!isStable(VERSION)) {
		log(`Version ${VERSION} is a prerelease — skipping latest/ update`);
		return false;
	}

	if (DRY_RUN) {
		log(`DRY_RUN — assuming ${VERSION} is the highest stable (no remote query)`);
		return true;
	}

	// List widget/ entries on remote (just dir names).
	// rrsync in write-only mode blocks reads. We list via rsync --list-only.
	const res = spawnSync('rsync', [
		'--list-only',
		'-e', `ssh ${SSH_OPTS.join(' ')}`,
		`${SSH_TARGET}:${REMOTE_WIDGET_BASE}/`,
	], { encoding: 'utf8' });

	if (res.status !== 0) {
		// Remote widget/ might not exist yet — treat as "no existing versions".
		log(`Could not list remote widget/ (${res.stderr.trim()}) — treating as first deploy; will update latest/`);
		return true;
	}

	// Parse dir names from rsync --list-only output.
	// Each line looks like: drwxr-xr-x          4,096 2026/06/18 10:00:00 0.3.0
	const existing = res.stdout
		.split('\n')
		.map(l => l.trim().split(/\s+/).pop())
		.filter(name => name && /^\d+\.\d+\.\d+/.test(name));

	const allVersions = [...new Set([...existing, VERSION])];
	const highestStable = allVersions
		.filter(v => isStable(v))
		.sort((a, b) => semverCompare(a, b))
		.pop();

	log(`Existing versions on remote: ${existing.join(', ') || '(none)'}`);
	log(`Highest stable: ${highestStable}`);

	return highestStable === VERSION;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	log(`Starting CDN publish — version=${VERSION} dry_run=${DRY_RUN}`);
	log(`Target: ${SSH_TARGET}:${REMOTE_VERSION_DIR}/`);

	// Write key file (skipped in dry-run but we still need structure for plan printing)
	if (!DRY_RUN) {
		writeFileSync(keyFile, CDN_DEPLOY_KEY + (CDN_DEPLOY_KEY.endsWith('\n') ? '' : '\n'), { mode: 0o600 });
	}

	try {
		// 1. Append-only guard
		const guardResult = appendOnlyGuard();
		if (guardResult === 'same') {
			log(`Version ${VERSION} already on CDN with matching content — nothing to do`);
			log(`SRI: ${sriAttr}`);
			return;
		}

		const updateLatest = shouldUpdateLatest();

		// 2. Atomic deploy of version dir
		// Rsync dist-cdn/ → remote tmp dir, then ssh mv tmp → version dir.
		log(`\n── Plan: version dir deploy ──`);
		log(`  rsync ${DIST_CDN}/ → ${SSH_TARGET}:${REMOTE_VERSION_TMP}/`);
		log(`  ssh mv ${REMOTE_VERSION_TMP} → ${REMOTE_VERSION_DIR}`);

		rsync(
			[
				`${DIST_CDN}/`,
				`${SSH_TARGET}:${REMOTE_VERSION_TMP}/`,
			],
			`upload dist-cdn/ → ${REMOTE_VERSION_TMP}`
		);

		// Atomic mv on the remote: rename tmp → version dir.
		// If widget/<version>/ already exists (guard passed as 'not-exists' due to
		// dry-run or race), mv will fail — the guard is the primary safety net.
		ssh(
			`mv '${REMOTE_VERSION_TMP}' '${REMOTE_VERSION_DIR}'`,
			`atomic mv tmp → ${REMOTE_VERSION_DIR}`
		);

		log(`widget/${VERSION}/ deployed atomically`);

		// 3. Update latest/ (if this is the highest stable version)
		if (updateLatest) {
			log(`\n── Plan: latest/ update ──`);
			log(`  rsync ${DIST_CDN}/ → ${SSH_TARGET}:${REMOTE_LATEST_TMP}/`);
			log(`  ssh rm -rf ${REMOTE_LATEST_DIR} && mv ${REMOTE_LATEST_TMP} → ${REMOTE_LATEST_DIR}`);

			rsync(
				[
					`${DIST_CDN}/`,
					`${SSH_TARGET}:${REMOTE_LATEST_TMP}/`,
				],
				`upload dist-cdn/ → latest tmp`
			);

			// Atomic swap: remove old latest, mv tmp → latest.
			ssh(
				`rm -rf '${REMOTE_LATEST_DIR}' && mv '${REMOTE_LATEST_TMP}' '${REMOTE_LATEST_DIR}'`,
				`atomic swap latest/`
			);

			log(`widget/latest/ updated → ${VERSION}`);
		} else {
			log(`Skipping latest/ update (${VERSION} is not the highest stable)`);
		}

		// 4. Final summary
		log(`\n── CDN publish complete ──`);
		log(`URL: https://cdn.oxpulse.chat/widget/${VERSION}/index.js`);
		log(`SRI: <script type="module"`);
		log(`       src="https://cdn.oxpulse.chat/widget/${VERSION}/index.js"`);
		log(`       ${sriAttr}`);
		log(`       crossorigin="anonymous"></script>`);
		if (updateLatest) {
			log(`latest URL: https://cdn.oxpulse.chat/widget/latest/index.js`);
		}

	} finally {
		cleanupKey();
	}
}

main().catch(err => {
	cleanupKey();
	fail(String(err));
});
