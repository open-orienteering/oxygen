import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
