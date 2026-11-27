#!/usr/bin/env node
/**
 * Decides whether the image built from a commit may become `:edge`
 * (docs/releases/README.md, BLD-05/BLD-06).
 *
 * `edge` moves only to a commit that is still, as far as code goes, the tip of
 * `origin/main`: the commit is an ancestor of it (or is it), and nothing but
 * documentation (docs/ and *.md; CI runs nothing for those, so they publish no
 * image of their own) changed since. A burst of merges therefore leaves `edge`
 * on the newest commit that passed the image smoke, and re-running an old
 * publish run cannot move `edge` backwards.
 *
 * CLI: node scripts/edge-guard.mjs <sha> [ref=origin/main]
 *      exit 0 and "yes: ..." to move edge, exit 1 and "no: ..." not to.
 * The caller fetches the ref first (`git fetch origin main`).
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

export function edgeGuard({ sha, ref = "origin/main", cwd = process.cwd() }) {
  if (!sha) return { ok: false, reason: "no commit given" };
  const ancestor = git(["merge-base", "--is-ancestor", sha, ref], cwd);
  if (ancestor.status === 1) {
    return { ok: false, reason: `${sha} is not an ancestor of ${ref}` };
  }
  if (ancestor.status !== 0) {
    return { ok: false, reason: `cannot compare ${sha} with ${ref}: ${ancestor.stderr.trim()}` };
  }
  const diff = git(["diff", "--quiet", sha, ref, "--", ".", ":(exclude)docs", ":(exclude)*.md"], cwd);
  if (diff.status === 0) return { ok: true, reason: `${sha} is ${ref} as far as code goes` };
  if (diff.status === 1) {
    return { ok: false, reason: `${ref} has code changes after ${sha}; a newer image owns edge` };
  }
  return { ok: false, reason: `git diff failed: ${diff.stderr.trim()}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = edgeGuard({ sha: process.argv[2], ref: process.argv[3] });
  console.log(`${result.ok ? "yes" : "no"}: ${result.reason}`);
  process.exit(result.ok ? 0 : 1);
}
