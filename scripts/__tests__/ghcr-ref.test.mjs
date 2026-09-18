import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_GHCR_IMAGE,
  parseReleaseGitTag,
  resolveImageRef,
  shaTag,
} from "../ghcr-ref.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../ghcr-ref.mjs");

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("resolveImageRef", () => {
  it("defaults empty input to :stable", () => {
    assert.equal(resolveImageRef(""), `${DEFAULT_GHCR_IMAGE}:stable`);
    assert.equal(resolveImageRef("  "), `${DEFAULT_GHCR_IMAGE}:stable`);
    assert.equal(resolveImageRef(undefined), `${DEFAULT_GHCR_IMAGE}:stable`);
  });

  it("prefixes GHCR for bare tags", () => {
    assert.equal(resolveImageRef("edge"), `${DEFAULT_GHCR_IMAGE}:edge`);
    assert.equal(resolveImageRef("v1.2.3"), `${DEFAULT_GHCR_IMAGE}:v1.2.3`);
    assert.equal(
      resolveImageRef("sha-0123456789abcdef0123456789abcdef01234567"),
      `${DEFAULT_GHCR_IMAGE}:sha-0123456789abcdef0123456789abcdef01234567`,
    );
  });

  it("passes through a full image reference", () => {
    assert.equal(
      resolveImageRef("ghcr.io/example/oxygen:edge"),
      "ghcr.io/example/oxygen:edge",
    );
  });

  it("turns a digest into an @ digest pull spec", () => {
    const digest = `sha256:${"ab".repeat(32)}`;
    assert.equal(resolveImageRef(digest), `${DEFAULT_GHCR_IMAGE}@${digest}`);
  });

  it("honours an explicit image name", () => {
    assert.equal(resolveImageRef("edge", "ghcr.io/acme/app"), "ghcr.io/acme/app:edge");
  });
});

describe("shaTag", () => {
  it("lowercases a full commit SHA", () => {
    const sha = "ABCDEF0123456789abcdef0123456789abcdef01";
    assert.equal(shaTag(sha), `sha-${sha.toLowerCase()}`);
  });

  it("rejects short or empty SHAs", () => {
    assert.throws(() => shaTag("abc1234"), /40-character/);
    assert.throws(() => shaTag(""), /40-character/);
  });
});

describe("parseReleaseGitTag", () => {
  it("expands vX.Y.Z into version and moving tags", () => {
    assert.deepEqual(parseReleaseGitTag("v1.2.3"), {
      gitTag: "v1.2.3",
      version: "1.2.3",
      imageTags: ["v1.2.3", "1.2.3", "stable", "latest"],
    });
  });

  it("rejects non-semver tags", () => {
    assert.throws(() => parseReleaseGitTag("1.2.3"), /vX.Y.Z/);
    assert.throws(() => parseReleaseGitTag("v1.2.3-rc.1"), /vX.Y.Z/);
    assert.throws(() => parseReleaseGitTag("nightly"), /vX.Y.Z/);
  });
});

describe("CLI", () => {
  it("resolves tags and honours GHCR_IMAGE", () => {
    const def = runCli(["resolve", "edge"]);
    assert.equal(def.status, 0);
    assert.equal(def.stdout.trim(), `${DEFAULT_GHCR_IMAGE}:edge`);

    const custom = runCli(["resolve", "stable"], { GHCR_IMAGE: "ghcr.io/acme/app" });
    assert.equal(custom.status, 0);
    assert.equal(custom.stdout.trim(), "ghcr.io/acme/app:stable");
  });

  it("prints sha tags and release metadata", () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const shaOut = runCli(["sha-tag", sha]);
    assert.equal(shaOut.status, 0);
    assert.equal(shaOut.stdout.trim(), `sha-${sha}`);

    const rel = runCli(["parse-release-tag", "v2.0.0"]);
    assert.equal(rel.status, 0);
    assert.deepEqual(JSON.parse(rel.stdout), {
      gitTag: "v2.0.0",
      version: "2.0.0",
      imageTags: ["v2.0.0", "2.0.0", "stable", "latest"],
    });
  });

  it("fails closed on a bad release tag", () => {
    const bad = runCli(["parse-release-tag", "nope"]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /vX.Y.Z/);
  });
});
