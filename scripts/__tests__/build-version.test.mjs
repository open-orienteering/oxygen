import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVersion, compareVersions } from "../build-version.mjs";

describe("buildVersion", () => {
  it("is the package version when it is ahead of the last tag (the release commit)", () => {
    assert.equal(
      buildVersion({ packageVersion: "0.8.0", describe: "v0.7.0-12-gabc1234" }),
      "0.8.0",
    );
  });

  it("is the tag's version on the tagged commit", () => {
    assert.equal(buildVersion({ packageVersion: "0.7.0", describe: "v0.7.0" }), "0.7.0");
  });

  it("is the describe output past the tag", () => {
    assert.equal(
      buildVersion({ packageVersion: "0.7.0", describe: "v0.7.0-3-gabc1234" }),
      "0.7.0-3-gabc1234",
    );
  });

  it("follows describe when package.json is behind the tag", () => {
    assert.equal(
      buildVersion({ packageVersion: "0.1.0", describe: "v0.7.0-3-gabc1234" }),
      "0.7.0-3-gabc1234",
    );
  });

  it("is <package version>-dev without git or without a reachable v* tag", () => {
    // A shallow checkout has no tags: claiming the bare package version
    // there would label every commit as the release.
    assert.equal(buildVersion({ packageVersion: "0.7.0", describe: "" }), "0.7.0-dev");
    assert.equal(buildVersion({ packageVersion: "0.7.0", describe: null }), "0.7.0-dev");
    assert.equal(buildVersion({ packageVersion: "0.7.0" }), "0.7.0-dev");
  });

  it("rejects a malformed package version", () => {
    assert.throws(() => buildVersion({ packageVersion: "next", describe: "v0.7.0" }));
  });
});

describe("compareVersions", () => {
  it("orders X.Y.Z numerically", () => {
    assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
    assert.ok(compareVersions("0.7.0", "0.7.1") < 0);
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
  });
});

describe("build plumbing", () => {
  const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const read = (file) => readFileSync(path.join(ROOT, file), "utf8");

  it("publish.yml fetches tags and passes BUILD_VERSION", () => {
    const publish = read(".github/workflows/publish.yml");
    assert.match(publish, /fetch-depth: 0/);
    assert.match(publish, /node scripts\/build-version\.mjs/);
    assert.match(publish, /BUILD_VERSION=\$\{\{ steps\.meta\.outputs\.version \}\}/);
  });

  it("release.yml checks the tag against package.json before promoting", () => {
    const release = read(".github/workflows/release.yml");
    const check = release.indexOf("ghcr-ref.mjs check-release-version");
    assert.ok(check > 0, "release.yml runs check-release-version");
    assert.ok(check < release.indexOf("imagetools create"), "the check runs before the retag");
  });

  it("the Dockerfile bakes OXYGEN_VERSION into the API and the web bundle", () => {
    const dockerfile = read("Dockerfile");
    assert.match(dockerfile, /OXYGEN_VERSION="\$BUILD_VERSION" npx vite build/);
    assert.match(dockerfile, /ENV OXYGEN_VERSION=\$BUILD_VERSION/);
  });

  it("deploy.sh --from-source computes the version for Cloud Build", () => {
    assert.match(read("scripts/gcp/deploy.sh"), /_BUILD_VERSION=\$\{BUILD_VERSION\}/);
    assert.match(read("scripts/gcp/cloudbuild.yaml"), /BUILD_VERSION=\$\{_BUILD_VERSION\}/);
  });

  it("the CLI prints a version", () => {
    const res = spawnSync(process.execPath, [path.join(ROOT, "scripts/build-version.mjs")], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+(-\d+-g[0-9a-f]+|-dev)?$/);
  });
});

describe("CLI against a real history", () => {
  const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../build-version.mjs");
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = (root) =>
    spawnSync(process.execPath, [CLI], {
      encoding: "utf8",
      env: { ...gitEnv, BUILD_VERSION_ROOT: root },
    });
  const git = (root, ...args) => {
    const res = spawnSync("git", args, { cwd: root, encoding: "utf8", env: gitEnv });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  const commit = (root, version) => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
    git(root, "add", "package.json");
    git(root, "commit", "-q", "--allow-empty", "-m", version);
  };

  it("is <package>-dev outside a git repository", () => {
    const root = mkdtempSync(path.join(tmpdir(), "build-version-nogit-"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.7.0" }));
    const res = run(root);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), "0.7.0-dev");
  });

  it("follows a release through its tag and past it, ignoring non-release v tags", () => {
    const root = mkdtempSync(path.join(tmpdir(), "build-version-git-"));
    git(root, "init", "-q");
    commit(root, "0.6.0");
    git(root, "tag", "v0.6.0");
    commit(root, "0.7.0"); // the release PR's merge commit, before its tag
    assert.equal(run(root).stdout.trim(), "0.7.0");
    git(root, "tag", "v0.7.0");
    assert.equal(run(root).stdout.trim(), "0.7.0");
    commit(root, "0.7.0");
    git(root, "tag", "v0.8.0-rc.1");
    git(root, "tag", "vector-spike");
    const sha = git(root, "rev-parse", "--short=7", "HEAD");
    assert.match(run(root).stdout.trim(), new RegExp(`^0\\.7\\.0-1-g${sha}`));
  });
});
