#!/usr/bin/env node
// CDN publisher for @oxpulse/chat-widget.
//
// Publishes the esbuild CDN bundle (dist-cdn/) to the krolik box file-server
// via rsync.  Assumes `build:cdn` has already run (dist-cdn/ exists).
//
// Key properties:
//   Immutability:  widget/<version>/ is ALWAYS deployed with rsync
//                  --ignore-existing, unconditionally — a re-run of the same
//                  version is a no-op (rrsync permits rsync writes, and
//                  --ignore-existing refuses to touch any file already present
//                  on the remote), and a PARTIAL prior deploy self-heals
//                  (missing files get uploaded, present ones untouched). No SSH
//                  read is needed for this — rrsync -wo blocks reads entirely,
//                  and --ignore-existing doesn't need one.
//   latest/:       refreshed ONLY when a separate public HTTPS HEAD probe (see
//                  probeDeployedState) confirms this version was ABSENT from
//                  the CDN before this run — i.e. this run is a confirmed new
//                  release, not a re-run or a network hiccup. Deployed with a
//                  plain rsync overwrite (intentionally mutable pointer — no
//                  --ignore-existing), which is exactly why it's gated on a
//                  confirmed-absent probe rather than running unconditionally.
//   Soft-skip:     if CDN_DEPLOY_KEY is absent → log + exit 0 (pipeline safe
//                  before the operator installs the key).
//   DRY_RUN=1:     skips remote WRITES and prints the exact plan, but still
//                  performs the live HTTPS HEAD probe (read-only, can't mutate
//                  anything) — DRY_RUN reports what would REALLY happen,
//                  including whether latest/ would actually advance.
//
// Deploy is rsync-ONLY (no ssh mv, no ssh rm-rf, no read probes).  The
// authorized_keys jail is command="rrsync -wo …",restrict — rrsync refuses
// any SSH_ORIGINAL_COMMAND whose first token is not "rsync" (rrsync:159-160),
// so shell commands (mv, rm, cat) are unconditionally rejected.  rsync writes
// are the only operations the jail allows.
//
// 404-cache window note: a versioned path is not embedded in any client page
// until the release is announced (the URL is new, so no warmed CDN/browser
// cache exists for it before the rsync completes).  In practice, mid-rsync
// requests to a new versioned path do not occur.  If true server-side atomicity
// is later required, an alternative is a custom server-side forced-command script
// that takes <version> as argv and does the mv server-side — this would not
// weaken the jail (the forced command is still fixed), but adds server-side
// complexity.  Not implemented; documented here for future reference.
//
// Required env:
//   CDN_SSH_HOST     box hostname or IP (e.g. "192.9.243.148")
//   CDN_SSH_USER     ssh user (e.g. "krolik")
//   CDN_DEPLOY_KEY   private ed25519 key content (PEM); written to a tmp file
//   CDN_SSH_HOST_KEY box's SSH host public key line, WITHOUT the hostname
//                    prefix (just "ssh-ed25519 AAAA...") — pinned into a
//                    throwaway known_hosts so StrictHostKeyChecking=yes
//                    succeeds on a fresh CI runner with no prior known_hosts.
//                    Get it via: cat /etc/ssh/ssh_host_ed25519_key.pub (on
//                    the box) or `ssh-keyscan -p <port> <host>` (strip the
//                    leading "host:port " token from keyscan's output).
//                    TOFU (bare ssh-keyscan with no pinning) is deliberately
//                    NOT used here — an unpinned first connection from an
//                    ephemeral CI runner is a MITM window on the deploy key's
//                    target.
//
// Optional env:
//   CDN_SSH_PORT    ssh port (default "22"; this box uses a non-default port
//                   — see the box's sshd_config, not hardcoded here since a
//                   future CDN host may differ)
//   DRY_RUN=1       skip actual remote writes; print plan; exit 0
//
// SSH authorised_keys line the operator must install on the box:
//   command="rrsync -wo /home/krolik/deploy/krolik-server/files/cdn-oxpulse",restrict ssh-ed25519 <PUBKEY> cdn-deploy@oxpulse-chat-sdk
//
// This jails the key to write-only rsync access on the CDN directory via rrsync.
// The key can rsync files in but cannot read or delete any existing content.
// rsync --ignore-existing is the immutability enforcer for versioned dirs.

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
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
const CDN_SSH_PORT = process.env.CDN_SSH_PORT || '22';
const CDN_SSH_HOST_KEY = process.env.CDN_SSH_HOST_KEY || '';
const CDN_DEPLOY_KEY = process.env.CDN_DEPLOY_KEY || '';

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
	console.log(`[cdn-publish] ${msg}`);
}

function fail(msg) {
	console.error(`[cdn-publish] FATAL: ${msg}`);
	process.exit(1);
}

// GitHub Actions workflow-command annotation: shows up in the run's Job
// Summary / Checks UI, unlike a plain stdout line which is invisible on a
// green job unless someone opens the raw log. Message must have %/\r/\n
// percent-encoded per GHA's workflow-command escaping rules.
function ghaWarning(title, message) {
	const escaped = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
	console.log(`::warning title=${title}::${escaped}`);
}

// GitHub Actions step-summary: appends a line to the $GITHUB_STEP_SUMMARY file
// (a path GHA injects as an env var) so the note shows up in the run's Summary
// UI, not just the raw log. No-op outside GHA (env var absent).
function ghaStepSummary(line) {
	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (!summaryPath) return;
	try {
		const prefix = existsSync(summaryPath) ? '\n' : '';
		appendFileSync(summaryPath, `${prefix}${line}\n`);
	} catch {
		// Best-effort visibility — never let a summary-write failure mask the
		// actual soft-skip signal (ghaWarning already emitted above).
	}
}

// ── Soft-skip when deploy key is absent ──────────────────────────────────────
// Mirror the SOFT_PACKAGES pattern in release-npm-packages.mjs.
// Pipeline safe to merge before the operator installs the key.
// LOUD: a stuck/misconfigured CDN deploy is indistinguishable from success on
// a green GHA job that only logs to stdout — emit a ::warning:: annotation
// (visible in the Checks UI without opening the raw log) AND a step-summary
// line so the skip is surfaced in the run's Summary tab. exit(0) is
// intentional (soft-skip is non-fatal) — the noise is the fix.

if (!CDN_DEPLOY_KEY) {
	const skipMsg = 'CDN_DEPLOY_KEY secret is absent — CDN publish skipped (non-fatal). Action required: generate an ed25519 key pair and install it on the CDN box as described in the publish-widget-cdn.mjs header / PR body.';
	ghaWarning('CDN publish skipped — CDN_DEPLOY_KEY absent', skipMsg);
	ghaStepSummary('⚠️ **CDN publish skipped** — `CDN_DEPLOY_KEY` secret is absent. The widget CDN bundle was NOT published this run. See the script header in `scripts/publish-widget-cdn.mjs` for key setup instructions.');
	log(skipMsg);
	process.exit(0);
}

// ── Semver helpers ────────────────────────────────────────────────────────────

function semverParse(v) {
	const m = v.match(/^(\d+)\.(\d+)\.(\d+)(-(.+))?$/);
	if (!m) return null;
	return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[5] ?? null };
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

// ── Probe live CDN state (drives the latest/ decision, NOT a skip-everything gate) ──
// The CI workflow runs this script on every push, not just "a release actually
// happened" (see release.yml's Phase-3 comment — a proxy signal like another
// package's npm-publish status can't represent chat-widget's own state). A live
// HTTPS HEAD against the CDN is a fact about deployed state, not a proxy.
//
// This is deliberately tri-state, not a boolean short-circuit. An earlier
// version of this script exit(0)'d on a 200 before ever reaching the versioned
// rsync — which defeated --ignore-existing's own self-heal property: rsync
// transfers index.js/index.js.map/zstd.wasm/index.js.sha384 as a set, roughly
// alphabetically, so a mid-transfer failure can leave index.js present (HEAD
// 200) while zstd.wasm is still missing. Skipping the rsync entirely on 200
// would leave that partial deploy broken forever. So the versioned-dir rsync
// below now ALWAYS runs unconditionally — --ignore-existing already makes it a
// no-op when everything is present and a self-heal when only some files are —
// and this probe result is used ONLY to decide whether to advance the mutable
// `latest/` pointer, never to skip the versioned dir.
//
// Assumption this relies on: the CDN origin hard-404s a missing path (no SPA/
// catch-all fallback that would 200 everything). True for the current static
// file-server config; if that ever changes, this probe would wrongly read
// every version as "live" and latest/ would stop advancing — silently.
async function probeDeployedState(version) {
	const url = `https://cdn.oxpulse.chat/widget/${version}/index.js`;
	try {
		const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
		if (res.status === 200) return 'live';
		if (res.status === 404) return 'absent';
		log(`unexpected HEAD status ${res.status} for ${url} — indeterminate (treated conservatively: versioned dir still deploys, latest/ does not advance)`);
		return 'indeterminate';
	} catch (err) {
		log(`HEAD check failed for ${url} (${err.message ?? err}) — indeterminate (treated conservatively: versioned dir still deploys, latest/ does not advance)`);
		return 'indeterminate';
	}
}

// Read even in DRY_RUN — it's a read-only network call, and DRY_RUN should
// report what would REALLY happen (including whether latest/ would advance).
const deployState = await probeDeployedState(VERSION);
log(`CDN probe: widget/${VERSION}/ is ${deployState}`);

// ── Validate required env (unless dry-run) ────────────────────────────────────

const SSH_KEY_TYPE_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-\S+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-\S+)\s/;

if (!DRY_RUN) {
	if (!CDN_SSH_HOST) fail('CDN_SSH_HOST env is not set');
	if (!CDN_SSH_USER) fail('CDN_SSH_USER env is not set');
	if (!CDN_SSH_HOST_KEY) fail('CDN_SSH_HOST_KEY env is not set (see script header for how to obtain it)');
	if (CDN_SSH_HOST_KEY.includes('\n')) fail('CDN_SSH_HOST_KEY must be a single line (no embedded newline)');
	if (!SSH_KEY_TYPE_RE.test(CDN_SSH_HOST_KEY)) {
		fail(`CDN_SSH_HOST_KEY must start with a key type (ssh-ed25519, ssh-rsa, ...) — got: "${CDN_SSH_HOST_KEY.slice(0, 30)}...". Did you leave the hostname prefix in? Strip the leading "host:port " token.`);
	}
	if (!/^\d+$/.test(CDN_SSH_PORT)) fail(`CDN_SSH_PORT must be numeric — got: "${CDN_SSH_PORT}"`);
}

const SSH_TARGET = `${CDN_SSH_USER}@${CDN_SSH_HOST}`;

// rrsync jail maps to /home/krolik/deploy/krolik-server/files/cdn-oxpulse
// so rsync paths are RELATIVE to that root.
const REMOTE_WIDGET_BASE = 'widget';
const REMOTE_VERSION_DIR = `${REMOTE_WIDGET_BASE}/${VERSION}`;
const REMOTE_LATEST_DIR = `${REMOTE_WIDGET_BASE}/latest`;

// ── Write deploy key to tmp file ──────────────────────────────────────────────

const keyDir = join(tmpdir(), `cdn-deploy-key-${Date.now()}`);
mkdirSync(keyDir, { mode: 0o700, recursive: true });
const keyFile = join(keyDir, 'id_ed25519');
const knownHostsFile = join(keyDir, 'known_hosts');

function cleanupKey() {
	try { rmSync(keyDir, { recursive: true, force: true }); } catch {}
}

// ── SSH / rsync helpers ───────────────────────────────────────────────────────
// known_hosts is pinned (not TOFU) from CDN_SSH_HOST_KEY — see header comment.

const SSH_OPTS = [
	'-i', keyFile,
	'-p', CDN_SSH_PORT,
	'-o', 'StrictHostKeyChecking=yes',
	'-o', `UserKnownHostsFile=${knownHostsFile}`,
	'-o', 'BatchMode=yes',
	'-o', 'ConnectTimeout=30',
];

// rsync helper. extraArgs are inserted after the base flags.
// The rrsync jail (command="rrsync -wo …",restrict) only allows rsync — no ssh mv/rm.
function rsync(extraArgs, src, dest, description) {
	const cmd = ['rsync', '-az', '--no-perms', '-e', `ssh ${SSH_OPTS.join(' ')}`, ...extraArgs, src, dest];
	log(`rsync plan: ${cmd.join(' ')}`);
	if (DRY_RUN) {
		log(`DRY_RUN — skipping rsync (${description})`);
		return;
	}
	const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', encoding: 'utf8' });
	if (res.status !== 0) fail(`rsync failed (${description}): exit ${res.status}`);
}

// ── Immutability note ─────────────────────────────────────────────────────────
// widget/<version>/ is deployed with rsync --ignore-existing (see main()).
// rrsync -wo allows rsync writes but refuses any read (pull/list) from the
// sender (rrsync:170-171: "reading from write-only server is not allowed").
// Therefore we cannot probe the remote for an existing file to compare hashes.
// --ignore-existing is the enforcer: rsync skips every file that already
// exists on the remote regardless of content, making a re-publish of the same
// version a no-op at the byte level. A re-publish with DIFFERENT bytes (same
// version, changed content) will also be a no-op — the immutable URL contract
// is preserved. Bump the version to publish changed bytes.

// ── Determine if this version should advance `latest/` ───────────────────────
// The rrsync -wo jail blocks reads (rsync --list-only is refused: it acts as
// a sender, which -wo forbids), so this can't query the remote for "what's the
// current latest/". Instead it relies on the deployState probe above: advance
// latest/ ONLY when the probe CONFIRMED this version is absent (deployState ===
// 'absent') — i.e. this run is genuinely the one releasing it. On 'live' (this
// version was already released, latest/ was already advanced correctly back
// then) or 'indeterminate' (network blip / CDN hiccup — NOT proof this is a
// real new release) latest/ is deliberately left untouched: the versioned-dir
// rsync always runs regardless (self-heals via --ignore-existing either way),
// but the mutable latest/ pointer only ever moves on a confirmed new release.
// Prerelease versions never advance latest/, confirmed or not.

function shouldUpdateLatest() {
	if (!isStable(VERSION)) {
		log(`Version ${VERSION} is a prerelease — skipping latest/ update`);
		return false;
	}
	if (deployState !== 'absent') {
		log(`Version ${VERSION} is stable but CDN probe=${deployState} (not a confirmed new release) — skipping latest/ update`);
		return false;
	}
	log(`Version ${VERSION} is stable and confirmed absent from the CDN — will update latest/`);
	return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
	log(`Starting CDN publish — version=${VERSION} dry_run=${DRY_RUN}`);
	log(`Target: ${SSH_TARGET}:${REMOTE_VERSION_DIR}/`);

	// Write key file + pinned known_hosts (skipped in dry-run)
	if (!DRY_RUN) {
		writeFileSync(keyFile, CDN_DEPLOY_KEY + (CDN_DEPLOY_KEY.endsWith('\n') ? '' : '\n'), { mode: 0o600 });
		const hostPort = CDN_SSH_PORT === '22' ? CDN_SSH_HOST : `[${CDN_SSH_HOST}]:${CDN_SSH_PORT}`;
		writeFileSync(knownHostsFile, `${hostPort} ${CDN_SSH_HOST_KEY}\n`, { mode: 0o600 });
	}

	try {
		const updateLatest = shouldUpdateLatest();

		// 1. Deploy versioned dir with --ignore-existing (immutability enforcer).
		//    rrsync -wo allows rsync writes; --ignore-existing refuses to touch any
		//    file already present on the remote — a re-publish of the same version
		//    is a byte-level no-op.  No read probe needed (reads are blocked by -wo).
		log(`\n── Plan: version dir deploy ──`);
		log(`  rsync --ignore-existing ${DIST_CDN}/ → ${SSH_TARGET}:${REMOTE_VERSION_DIR}/`);

		rsync(
			['--ignore-existing'],
			`${DIST_CDN}/`,
			`${SSH_TARGET}:${REMOTE_VERSION_DIR}/`,
			`upload dist-cdn/ → widget/${VERSION}/ (immutable, --ignore-existing)`
		);

		log(`widget/${VERSION}/ deployed`);

		// 2. Update latest/ (stable versions only; mutable pointer — no --ignore-existing).
		if (updateLatest) {
			log(`\n── Plan: latest/ update ──`);
			log(`  rsync ${DIST_CDN}/ → ${SSH_TARGET}:${REMOTE_LATEST_DIR}/`);

			rsync(
				[],
				`${DIST_CDN}/`,
				`${SSH_TARGET}:${REMOTE_LATEST_DIR}/`,
				`upload dist-cdn/ → widget/latest/ (mutable pointer)`
			);

			log(`widget/latest/ updated → ${VERSION}`);
		} else if (isStable(VERSION) && deployState === 'indeterminate') {
			// This is the genuine strand-risk case, not the benign steady state:
			// deployState === 'live' (handled below) is the NORMAL outcome on every
			// ordinary push during the Version-PR window (this version was already
			// released last time, so of course it's live) — warning on that would
			// cry wolf on every routine merge and drown out the rare real signal.
			// 'indeterminate' means the probe itself couldn't tell (network blip,
			// unexpected status) on what may be the ONE run that would have caught
			// this version genuinely absent. If so, latest/ misses its only chance
			// to advance here, and every SUBSEQUENT run sees the version as 'live'
			// (the versioned dir deployed regardless) — permanently stranding
			// latest/ on the OLD version with no automatic recovery. Surfaced as a
			// real GHA annotation (not just a log line) so it's visible without
			// opening the raw log on an otherwise-green run.
			ghaWarning(
				'latest/ not advanced — CDN probe was indeterminate',
				`widget/${VERSION}/ is stable but the live-CDN probe returned 'indeterminate' (not a confirmed absent), so latest/ was NOT advanced this run. If this was meant to be the release of ${VERSION}, latest/ may now be stranded on an older version — investigate (curl -I https://cdn.oxpulse.chat/widget/latest/index.js) or re-run workflow_dispatch.`
			);
		} else if (isStable(VERSION)) {
			// deployState === 'live': the normal, expected case for most pushes —
			// this version was already released and latest/ was already correctly
			// advanced back then. Nothing wrong; no need to shout.
			log(`widget/${VERSION}/ already live — latest/ presumed current, not touched`);
		} else {
			log(`Skipping latest/ update (${VERSION} is a prerelease)`);
		}

		// 3. Final summary
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
