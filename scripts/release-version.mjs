#!/usr/bin/env node
/**
 * Set the release version in the four `package.json` files.
 *
 *   pnpm release:version 0.8.0
 *
 * The release PR runs this; `release.yml` then refuses a `vX.Y.Z` tag whose
 * commit carries another version (`ghcr-ref.mjs check-release-version`).
 * Only the top-level `"version"` line changes; the rest of each file keeps
 * its formatting.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Every workspace manifest that carries the release version. */
export const PACKAGE_FILES = [
  "package.json",
  "packages/shared/package.json",
  "packages/api/package.json",
  "packages/web/package.json",
];

const SEMVER = /^\d+\.\d+\.\d+$/;
const VERSION_LINE = /^(\s*"version"\s*:\s*")[^"]*(")/m;

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Return `text` with its top-level `"version"` set to `version`. */
export function setManifestVersion(text, version) {
  if (!SEMVER.test(version)) {
    throw new Error(`Expected a version X.Y.Z, got ${JSON.stringify(version)}`);
  }
  if (!VERSION_LINE.test(text)) throw new Error('No "version" field');
  const next = text.replace(VERSION_LINE, `$1${version}$2`);
  if (JSON.parse(next).version !== version) {
    throw new Error('The first "version" line is not the top-level field');
  }
  return next;
}

/** Read the version of each manifest, keyed by its repo-relative path. */
export function readManifestVersions(root = REPO_ROOT) {
  return Object.fromEntries(
    PACKAGE_FILES.map((file) => [
      file,
      JSON.parse(readFileSync(path.join(root, file), "utf8")).version,
    ]),
  );
}

export function writeManifestVersions(version, root = REPO_ROOT) {
  for (const file of PACKAGE_FILES) {
    const full = path.join(root, file);
    writeFileSync(full, setManifestVersion(readFileSync(full, "utf8"), version));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const version = (process.argv[2] ?? "").replace(/^v/, "");
    writeManifestVersions(version, process.env.RELEASE_VERSION_ROOT || REPO_ROOT);
    process.stdout.write(`Set version ${version} in ${PACKAGE_FILES.join(", ")}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write("Usage: pnpm release:version X.Y.Z\n");
    process.exit(1);
  }
}
