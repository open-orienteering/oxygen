import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGE_FILES,
  readManifestVersions,
  setManifestVersion,
} from "../release-version.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "../release-version.mjs");

function fixtureRepo(version) {
  const root = mkdtempSync(path.join(tmpdir(), "release-version-"));
  for (const file of PACKAGE_FILES) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    const text =
      `{\n  "name": "x",\n  "version": "${version}",\n` +
      `  "dependencies": {\n    "dep": "1.0.0",\n    "version": "9.9.9"\n  }\n}`;
    writeFileSync(path.join(root, file), file === "package.json" ? `${text}\n` : text);
  }
  return root;
}

describe("setManifestVersion", () => {
  it("changes only the top-level version line", () => {
    const before = '{\n  "name": "x",\n  "version": "0.1.0",\n  "private": true\n}';
    assert.equal(
      setManifestVersion(before, "0.7.0"),
      '{\n  "name": "x",\n  "version": "0.7.0",\n  "private": true\n}',
    );
  });

  it("rejects a version that is not X.Y.Z", () => {
    assert.throws(() => setManifestVersion('{"version":"0.1.0"}', "v0.7.0"));
    assert.throws(() => setManifestVersion('{"version":"0.1.0"}', "0.7"));
  });

  it("refuses a manifest without a version", () => {
    assert.throws(() => setManifestVersion('{"name":"x"}', "0.7.0"));
  });
});

describe("CLI", () => {
  it("sets all four manifests and keeps each file's trailing newline", () => {
    const root = fixtureRepo("0.1.0");
    const res = spawnSync(process.execPath, [CLI, "0.8.0"], {
      encoding: "utf8",
      env: { ...process.env, RELEASE_VERSION_ROOT: root },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(
      readManifestVersions(root),
      Object.fromEntries(PACKAGE_FILES.map((f) => [f, "0.8.0"])),
    );
    assert.ok(readFileSync(path.join(root, "package.json"), "utf8").endsWith("}\n"));
    assert.ok(readFileSync(path.join(root, "packages/web/package.json"), "utf8").endsWith("}"));
    assert.match(readFileSync(path.join(root, "package.json"), "utf8"), /"version": "9.9.9"/);
  });

  it("accepts a leading v and fails on garbage", () => {
    const root = fixtureRepo("0.1.0");
    const env = { ...process.env, RELEASE_VERSION_ROOT: root };
    assert.equal(spawnSync(process.execPath, [CLI, "v0.9.0"], { env }).status, 0);
    assert.equal(readManifestVersions(root)["packages/api/package.json"], "0.9.0");
    assert.equal(spawnSync(process.execPath, [CLI, "next"], { env }).status, 1);
  });
});

describe("the repository", () => {
  it("carries one version in all four manifests", () => {
    const versions = new Set(Object.values(readManifestVersions()));
    assert.equal(versions.size, 1, `versions differ: ${[...versions].join(", ")}`);
  });
});
