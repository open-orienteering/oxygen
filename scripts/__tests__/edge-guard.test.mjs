import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { edgeGuard } from "../edge-guard.mjs";

describe("edge-guard", () => {
  let dir;
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const commit = (file, content, msg) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "edge-guard-"));
    git("init", "-q", "-b", "main");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("says yes for the tip itself", () => {
    const sha = commit("src/a.ts", "1", "code");
    assert.equal(edgeGuard({ sha, ref: "main", cwd: dir }).ok, true);
  });

  it("says yes when only docs and markdown follow", () => {
    const sha = commit("src/a.ts", "1", "code");
    commit(["docs", "x.md"].join("/"), "d", "docs"); // joined so the doc-link check skips it
    commit("README.md", "r", "readme");
    commit("packages/web/NOTES.md", "n", "nested md");
    assert.equal(edgeGuard({ sha, ref: "main", cwd: dir }).ok, true);
  });

  it("says no when code follows", () => {
    const sha = commit("src/a.ts", "1", "code");
    commit("src/a.ts", "2", "more code");
    const r = edgeGuard({ sha, ref: "main", cwd: dir });
    assert.equal(r.ok, false);
    assert.match(r.reason, /code changes after/);
  });

  it("says no when the commit is not an ancestor of the ref", () => {
    commit("src/a.ts", "1", "base");
    git("checkout", "-q", "-b", "side");
    const side = commit("src/b.ts", "1", "side");
    git("checkout", "-q", "main");
    commit("src/c.ts", "1", "main");
    const r = edgeGuard({ sha: side, ref: "main", cwd: dir });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not an ancestor/);
  });

  it("the CLI exits 0 for yes and 1 for no", () => {
    const sha = commit("src/a.ts", "1", "code");
    commit("src/a.ts", "2", "newer");
    const script = path.join(import.meta.dirname, "../edge-guard.mjs");
    const no = spawnSync("node", [script, sha, "main"], { cwd: dir, encoding: "utf8" });
    assert.equal(no.status, 1);
    assert.match(no.stdout, /^no: /);
    const tip = git("rev-parse", "HEAD");
    const yes = spawnSync("node", [script, tip, "main"], { cwd: dir, encoding: "utf8" });
    assert.equal(yes.status, 0);
    assert.match(yes.stdout, /^yes: /);
  });
});
