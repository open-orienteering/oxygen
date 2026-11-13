import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
