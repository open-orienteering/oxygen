#!/usr/bin/env node
// Fails when git holds a map source (OCAD, OpenOrienteering Mapper) that is
// not on the public list in scripts/lib/map-files.mjs, or a listed one whose
// content changed. Club maps lent for screenshots stay on the machine they
// live on (docs/screenshots/README.md, "Private maps"); only their PNGs may
// be committed.
//
// Usage: node scripts/check-map-files.mjs [--staged]   (exit 1 on a finding)
//   default    the files in HEAD's tree plus anything staged (CI)
//   --staged   only the content staged for commit, read from the index (the pre-commit hook)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HEAD_BYTES, isMapSource, isPublicMap } from "./lib/map-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const staged = process.argv.includes("--staged");
const git = (args, opts = {}) => execFileSync("git", args, { maxBuffer: 1 << 30, ...opts });
const list = (args) => git(args, { encoding: "utf8" }).split("\0").filter(Boolean);

// Always read blobs from the index (`:path`), never the working tree: what is
// checked is what gets committed, even if the file on disk changed since.
const files = staged ? list(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]) : list(["ls-files", "--cached", "-z"]);

const found = [];
for (const f of files) {
  let bytes;
  try {
    bytes = git(["cat-file", "blob", `:${f}`]);
  } catch {
    continue; // a submodule or a path removed from the index
  }
  if (!isMapSource(f, bytes.subarray(0, HEAD_BYTES))) continue;
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (!isPublicMap(f, sha)) found.push(`${f}  (sha256 ${sha.slice(0, 12)}…)`);
}

if (found.length) {
  console.error("Map sources that are not on the public list (scripts/lib/map-files.mjs), or whose content changed:");
  for (const f of found) console.error(`  ${f}`);
  console.error("A club's map stays out of git: keep it in .local/ and commit only screenshots of it.");
  console.error("A deliberate change to a listed test or demo map updates its hash in scripts/lib/map-files.mjs.");
  process.exit(1);
}
console.log(`No private map sources among ${files.length} ${staged ? "staged" : "tracked"} files.`);
