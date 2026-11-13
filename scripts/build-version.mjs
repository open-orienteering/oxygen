#!/usr/bin/env node
/**
 * The version an image build reports (`BUILD_VERSION` → `OXYGEN_VERSION`).
 *
 *   node scripts/build-version.mjs        # prints e.g. 0.7.0 or 0.7.0-3-gabc1234
 *
 * The git tag is the version of record (docs/releases-and-images.md, "Tags").
 * The release commit is built before its tag exists, so its `package.json`
 * — bumped by the release PR — is ahead of the last tag and is the version.
 * Every other commit reports `git describe --tags --match 'v*'`: the tag on
 * the tagged commit, `0.7.0-3-gabc1234` past it. Without git, or without a
 * reachable `v*` tag (a shallow checkout), the build is an unversioned one:
 * `<package version>-dev`, the same string a local web build bakes.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const DESCRIBE = /^v(\d+\.\d+\.\d+)(-\d+-g[0-9a-f]+)?$/;

function parse(version) {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`Expected a version X.Y.Z, got ${JSON.stringify(version)}`);
  return match.slice(1, 4).map(Number);
}

/** Numeric X.Y.Z order: negative, zero or positive like a sort comparator. */
export function compareVersions(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * @param {{ packageVersion: string, describe?: string | null }} input
 *   `describe` is the output of `git describe --tags --match 'v*'`; `null`,
 *   absent or `""` when there is no git or no reachable `v*` tag.
 */
export function buildVersion({ packageVersion, describe = null }) {
  parse(packageVersion);
  const match = DESCRIBE.exec((describe ?? "").trim());
  if (!match) return `${packageVersion}-dev`;
  const tagVersion = match[1];
  if (compareVersions(packageVersion, tagVersion) > 0) return packageVersion;
  return describe.trim().slice(1);
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const describe = git(["describe", "--tags", "--match", "v*"], root);
  process.stdout.write(`${buildVersion({ packageVersion: version, describe })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
