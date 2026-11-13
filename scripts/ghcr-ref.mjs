#!/usr/bin/env node
/**
 * Resolve GHCR image references for deploy scripts and release workflows.
 *
 *   node scripts/ghcr-ref.mjs resolve [tag]
 *   node scripts/ghcr-ref.mjs sha-tag <40-char-commit>
 *   node scripts/ghcr-ref.mjs parse-release-tag vX.Y.Z
 *   node scripts/ghcr-ref.mjs check-release-version vX.Y.Z
 */

import { readManifestVersions } from "./release-version.mjs";

export const DEFAULT_GHCR_IMAGE = "ghcr.io/open-orienteering/oxygen";

const RELEASE_GIT_TAG = /^v(\d+\.\d+\.\d+)$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;

export function defaultImage() {
  const fromEnv = process.env.GHCR_IMAGE?.trim();
  return fromEnv || DEFAULT_GHCR_IMAGE;
}

/**
 * Map an operator-supplied tag / digest / full ref to a pullable image.
 * Empty input → `:stable`.
 */
export function resolveImageRef(input, image = defaultImage()) {
  const raw = (input ?? "").trim();
  if (!raw) return `${image}:stable`;
  if (raw.startsWith("sha256:")) return `${image}@${raw}`;
  if (raw.includes("/")) return raw;
  return `${image}:${raw}`;
}

export function shaTag(commitSha) {
  const sha = (commitSha ?? "").trim();
  if (!FULL_SHA.test(sha)) {
    throw new Error(`Expected a 40-character commit SHA, got ${JSON.stringify(commitSha)}`);
  }
  return `sha-${sha.toLowerCase()}`;
}

export function parseReleaseGitTag(gitTag) {
  const tag = (gitTag ?? "").trim();
  const match = tag.match(RELEASE_GIT_TAG);
  if (!match) {
    throw new Error(`Expected git tag vX.Y.Z, got ${JSON.stringify(gitTag)}`);
  }
  const version = match[1];
  return {
    gitTag: tag,
    version,
    imageTags: [tag, version, "stable", "latest"],
  };
}

/**
 * The git tag is the version of record: a release tag must name the version
 * its commit's `package.json` files carry (set by `pnpm release:version`).
 * `versions` maps each manifest path to its `version`.
 */
export function assertReleaseMatchesPackage(gitTag, versions) {
  const { version } = parseReleaseGitTag(gitTag);
  const differing = Object.entries(versions).filter(([, v]) => v !== version);
  if (differing.length > 0) {
    const list = differing.map(([file, v]) => `${file} is ${v}`).join(", ");
    throw new Error(
      `Tag ${gitTag} does not match the tagged commit: ${list}. ` +
        `The release PR must run \`pnpm release:version ${version}\` before the tag.`,
    );
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "resolve":
      process.stdout.write(`${resolveImageRef(rest[0] ?? "")}\n`);
      return;
    case "sha-tag":
      process.stdout.write(`${shaTag(rest[0] ?? "")}\n`);
      return;
    case "parse-release-tag":
      printJson(parseReleaseGitTag(rest[0] ?? ""));
      return;
    case "check-release-version":
      assertReleaseMatchesPackage(
        rest[0] ?? "",
        readManifestVersions(process.env.RELEASE_VERSION_ROOT || undefined),
      );
      process.stdout.write(`${rest[0]} matches package.json\n`);
      return;
    default:
      process.stderr.write(
        "Usage: ghcr-ref.mjs resolve [tag] | sha-tag <sha> | parse-release-tag vX.Y.Z" +
          " | check-release-version vX.Y.Z\n",
      );
      process.exit(1);
  }
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("ghcr-ref.mjs");

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
