#!/usr/bin/env node
/**
 * Production-tree vulnerability audit against npm's bulk advisory endpoint.
 *
 * `pnpm audit` (≤10.x) talks to the legacy `/-/npm/v1/security/audits`
 * endpoint, which the registry retired in 2026 (HTTP 410). pnpm 11 fixed it
 * but requires Node 22+, so this script does what pnpm 11 does with no new
 * toolchain: walk the production tree in `pnpm-lock.yaml`, POST name→versions
 * to `/-/npm/v1/security/advisories/bulk`, and match the returned vulnerable
 * ranges against the resolved versions.
 *
 * The tree is read from the lockfile rather than from an installed
 * `node_modules`: `pnpm licenses list` needs store index files, which a
 * CI-restored store does not always have (ERR_PNPM_MISSING_PACKAGE_INDEX_FILE),
 * and `pnpm list` prints deduplicated nodes without their children, so it
 * silently drops transitive packages.
 *
 * Usage:
 *   node scripts/audit-prod.mjs [--audit-level=high|critical|moderate|low]
 *
 * Exit code 1 when any advisory at or above the level matches, 0 otherwise.
 * Network/registry failures exit 2 (distinguishable from "vulnerable").
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import semver from "semver";
import YAML from "yaml";

const LEVELS = ["low", "moderate", "high", "critical"];
const levelArg = process.argv
  .find((a) => a.startsWith("--audit-level="))
  ?.split("=")[1];
const auditLevel = LEVELS.includes(levelArg ?? "") ? levelArg : "high";
const minRank = LEVELS.indexOf(auditLevel);

// ── 1. Production packages, walked out of the lockfile ────────
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const lockPath = path.join(repoRoot, "pnpm-lock.yaml");
let lock;
try {
  lock = YAML.parse(readFileSync(lockPath, "utf8"));
} catch (err) {
  console.error(`[audit-prod] Cannot read ${lockPath}:`, err.message);
  process.exit(2);
}

/**
 * Lockfile refs look like `name@version`, optionally followed by a
 * parenthesised peer/patch suffix: `@prisma/client@7.9.1(prisma@7.9.1(…))`.
 * Everything from the first `(` is suffix, so the version is what follows the
 * last `@` of the remainder.
 */
function splitRef(ref) {
  const paren = ref.indexOf("(");
  const base = paren === -1 ? ref : ref.slice(0, paren);
  const at = base.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: base.slice(0, at), version: base.slice(at + 1) };
}

const snapshots = lock.snapshots ?? {};
/** name → Set of resolved versions. */
const installed = new Map();
const visited = new Set();
const queue = [];

const enqueue = (name, versionSpec) => {
  // Workspace packages are covered by their own `importers` entry.
  if (typeof versionSpec !== "string" || versionSpec.startsWith("link:")) return;
  queue.push(`${name}@${versionSpec}`);
};

for (const importer of Object.values(lock.importers ?? {})) {
  // devDependencies are deliberately skipped: this audit gates the shipped tree.
  for (const group of [importer.dependencies, importer.optionalDependencies]) {
    for (const [name, entry] of Object.entries(group ?? {})) {
      enqueue(name, entry?.version);
    }
  }
}

const unresolved = new Set();
while (queue.length > 0) {
  const ref = queue.pop();
  if (visited.has(ref)) continue;
  visited.add(ref);

  const parsed = splitRef(ref);
  if (parsed && semver.valid(parsed.version)) {
    const set = installed.get(parsed.name) ?? new Set();
    set.add(parsed.version);
    installed.set(parsed.name, set);
  }

  const snapshot = snapshots[ref];
  if (!snapshot) {
    // Tarball/git refs resolve under a URL key; anything else means the
    // lockfile and this walker disagree, which is worth knowing about.
    if (parsed && semver.valid(parsed.version)) unresolved.add(ref);
    continue;
  }
  for (const group of [snapshot.dependencies, snapshot.optionalDependencies]) {
    for (const [name, versionSpec] of Object.entries(group ?? {})) {
      enqueue(name, versionSpec);
    }
  }
}

if (installed.size === 0) {
  console.error("[audit-prod] Walked the lockfile and found no production packages");
  process.exit(2);
}
console.log(`[audit-prod] ${installed.size} production packages in the tree`);
if (unresolved.size > 0) {
  console.log(
    `[audit-prod] ${unresolved.size} refs had no snapshot entry (checked anyway): ` +
      [...unresolved].slice(0, 5).join(", "),
  );
}

// ── 2. Bulk advisory lookup ───────────────────────────────────
const body = Object.fromEntries(
  [...installed.entries()].map(([name, versions]) => [name, [...versions]]),
);
let advisories;
try {
  const res = await fetch(
    "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    console.error(`[audit-prod] Bulk advisory endpoint responded ${res.status}`);
    process.exit(2);
  }
  advisories = await res.json();
} catch (err) {
  console.error("[audit-prod] Bulk advisory request failed:", err.message);
  process.exit(2);
}

// ── 3. Match vulnerable ranges against installed versions ─────
const findings = [];
for (const [name, pkgAdvisories] of Object.entries(advisories)) {
  const versions = installed.get(name);
  if (!versions) continue;
  for (const adv of pkgAdvisories) {
    const range = adv.vulnerable_versions ?? "*";
    const hit = [...versions].filter((v) => {
      try {
        return semver.satisfies(v, range, { includePrerelease: true });
      } catch {
        return true; // Unparseable range — treat as matching, stay loud.
      }
    });
    if (hit.length > 0) {
      findings.push({
        name,
        versions: hit,
        severity: adv.severity ?? "unknown",
        title: adv.title ?? "",
        range,
        url: adv.url ?? `https://github.com/advisories/${adv.id ?? ""}`,
      });
    }
  }
}

const rank = (s) => LEVELS.indexOf(s);
const gating = findings.filter((f) => rank(f.severity) >= minRank);
const info = findings.filter((f) => rank(f.severity) < minRank);

if (info.length > 0) {
  console.log(`[audit-prod] ${info.length} advisories below ${auditLevel} (non-gating)`);
}
if (gating.length === 0) {
  console.log(`[audit-prod] OK — no ${auditLevel}+ advisories in the production tree`);
  process.exit(0);
}

console.error(`\n[audit-prod] ${gating.length} ${auditLevel}+ advisories:\n`);
for (const f of gating.sort((a, b) => rank(b.severity) - rank(a.severity))) {
  console.error(
    `  ${f.severity.toUpperCase().padEnd(8)} ${f.name}@${f.versions.join(",")}` +
      `\n           ${f.title}\n           vulnerable: ${f.range}\n           ${f.url}\n`,
  );
}
process.exit(1);
