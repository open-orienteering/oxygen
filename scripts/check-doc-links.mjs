#!/usr/bin/env node
// Checks that documentation references resolve (docs/README.md, AGENTS.md §10):
//
// 1. Every relative Markdown link in a tracked `.md` file points at a file
//    or directory that exists (anchors are not checked).
// 2. Every repo-relative `docs/…` path mentioned in a tracked text file
//    (code comments, configs, Markdown) exists.
//
// The research record under docs/research/ is frozen and cites docs that
// were deleted with the legacy pipeline, so its `docs/…` mentions are not
// checked (its Markdown links are). Applied Prisma migrations are never
// edited (their checksum would change), so they are skipped too.
//
// Usage: node scripts/check-doc-links.mjs   (exit 1 on any broken reference)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const TEXT = /\.(md|ts|tsx|js|mjs|cjs|json|ya?ml|sh|prisma|css|html|toml|txt)$|(^|\/)(Dockerfile|\.gitattributes|\.dockerignore)$/;
const SKIP = /^(pnpm-lock\.yaml|packages\/api\/prisma\/migrations\/)/;
const FROZEN = /^docs\/research\//;

const problems = [];

function stripFences(text) {
  // Keep line numbers stable: blank out fenced code blocks.
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) =>
    block.replace(/[^\n]/g, ""),
  );
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

for (const file of files) {
  if (!TEXT.test(file) || SKIP.test(file) || !existsSync(file)) continue;
  const raw = readFileSync(file, "utf8");

  if (file.endsWith(".md")) {
    const text = stripFences(raw);
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#|\/)/.test(target)) continue;
      const path = decodeURIComponent(target.split("#")[0]);
      if (!path) continue;
      const resolved = normalize(join(dirname(file), path));
      if (!existsSync(resolved)) {
        problems.push(`${file}:${lineOf(text, m.index)}: link ${target}`);
      }
    }
  }

  if (FROZEN.test(file)) continue;
  for (const m of raw.matchAll(/(?<![\w./-])docs\/[A-Za-z0-9_./-]*/g)) {
    // Placeholders and globs (docs/bugfixes/<name>.md, docs/map-*.md) stop
    // at the `<`, `*` or `{`: not a path to check.
    const next = raw[m.index + m[0].length];
    if (next === "<" || next === "*" || next === "{") continue;
    const path = m[0].replace(/[.,/-]+$/, "");
    if (!existsSync(path)) {
      problems.push(`${file}:${lineOf(raw, m.index)}: path ${path}`);
    }
  }
}

if (problems.length) {
  console.error(`${problems.length} broken documentation reference(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("Documentation references OK.");
