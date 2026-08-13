#!/usr/bin/env node
// Guard: fail if any workspace package declares `publishConfig.directory`.
//
// `publishConfig.directory: "dist"` makes `pnpm pack` fail with
// ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND, which breaks the release script — it
// packs before it publishes. The field is redundant: `files` already includes
// `dist/`, so `publishConfig` only ever needs `access: public`.
//
// The package list is derived from `pnpm-workspace.yaml`, NOT from a hand-
// written array — so a package nobody registered anywhere is still checked.
// This is the exact scenario the guard exists for: somebody adds a package.
//
// Runs in the preflight gate (`.github/workflows/preflight.yml`) and in the
// release script's pre-flight section (`scripts/release-npm-packages.mjs`),
// next to the existing `workspace:`-string assertion — the sibling path
// sharing this invariant.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

// Parse `pnpm-workspace.yaml` and return the glob patterns under `packages:`.
// The file format is:
//   packages:
//     - "packages/*"
//     - "examples/*"
// We only need the list items under `packages:` — no full YAML parser needed.
function getWorkspacePatterns() {
	const yamlPath = join(REPO_ROOT, 'pnpm-workspace.yaml');
	if (!existsSync(yamlPath)) {
		throw new Error(`pnpm-workspace.yaml not found at ${yamlPath}`);
	}
	const content = readFileSync(yamlPath, 'utf8');
	const patterns = [];
	let inPackages = false;
	for (const line of content.split('\n')) {
		if (/^packages:\s*$/.test(line)) {
			inPackages = true;
			continue;
		}
		if (inPackages) {
			const match = line.match(/^\s+-\s+["']?([^"'\s]+)["']?\s*$/);
			if (match) {
				patterns.push(match[1].trim());
			} else if (/^\S/.test(line)) {
				// A non-indented, non-list line ends the packages block.
				break;
			}
		}
	}
	if (patterns.length === 0) {
		throw new Error('no workspace patterns found in pnpm-workspace.yaml');
	}
	return patterns;
}

// Expand a simple glob like "packages/*" to a list of package.json paths.
// Supports `dir/*` and `dir/**` (recursive) — the forms pnpm-workspace.yaml
// uses. Does NOT support brace expansion or nested wildcards; the workspace
// file is controlled and simple.
function expandGlobToPackageJsons(pattern) {
	const results = [];

	// Recursive glob: "dir/**"
	if (pattern.endsWith('/**')) {
		const baseDir = pattern.slice(0, -3);
		const basePath = join(REPO_ROOT, baseDir);
		if (!existsSync(basePath)) return results;
		walkDir(basePath, results);
		return results;
	}

	// Single-level glob: "dir/*"
	const starIdx = pattern.indexOf('*');
	if (starIdx === -1) {
		// No glob — it's a direct package path.
		const pkgPath = join(REPO_ROOT, pattern, 'package.json');
		if (existsSync(pkgPath)) results.push(pkgPath);
		return results;
	}

	const parentDir = pattern.slice(0, starIdx).replace(/\/$/, '');
	const parentPath = join(REPO_ROOT, parentDir);
	if (!existsSync(parentPath)) return results;

	const entries = readdirSync(parentPath, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const pkgPath = join(parentPath, entry.name, 'package.json');
			if (existsSync(pkgPath)) results.push(pkgPath);
		}
	}
	return results;
}

function walkDir(dirPath, results) {
	const entries = readdirSync(dirPath, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const childPath = join(dirPath, entry.name);
			const pkgPath = join(childPath, 'package.json');
			if (existsSync(pkgPath)) {
				results.push(pkgPath);
			}
			// Recurse into subdirectories (node_modules excluded).
			if (entry.name !== 'node_modules') {
				walkDir(childPath, results);
			}
		}
	}
}

// Find all workspace package.json files by expanding the workspace patterns.
function findWorkspacePackageJsons() {
	const patterns = getWorkspacePatterns();
	const seen = new Set();
	const all = [];
	for (const pattern of patterns) {
		for (const pkgPath of expandGlobToPackageJsons(pattern)) {
			if (!seen.has(pkgPath)) {
				seen.add(pkgPath);
				all.push(pkgPath);
			}
		}
	}
	return all;
}

// Check every workspace package.json for `publishConfig.directory`.
// Returns an array of offenders: { name, path }.
// Exits 1 with a message naming each offender if any are found.
// Exits 0 with a summary if all clean.
export function assertNoPublishConfigDirectory() {
	const packageJsons = findWorkspacePackageJsons();
	const offenders = [];
	for (const pkgPath of packageJsons) {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
		if (pkg.publishConfig && typeof pkg.publishConfig === 'object' && 'directory' in pkg.publishConfig) {
			offenders.push({
				name: pkg.name ?? '<unnamed>',
				path: relative(REPO_ROOT, pkgPath),
			});
		}
	}
	if (offenders.length > 0) {
		console.error('BLOCKER: publishConfig.directory found in workspace package(s):');
		for (const { name, path } of offenders) {
			console.error(`  - ${name} (${path})`);
		}
		console.error('');
		console.error('publishConfig.directory causes pnpm pack to fail with ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND.');
		console.error('The "files" field already includes dist/ — publishConfig only needs "access".');
		console.error('See issue #321 and commit 46b16fd for prior occurrences.');
		process.exit(1);
	}
	console.log(`assert-no-publishconfig-directory: OK (${packageJsons.length} packages checked)`);
}

// Run when executed directly, not when imported.
if (process.argv[1] === __filename) {
	assertNoPublishConfigDirectory();
}
