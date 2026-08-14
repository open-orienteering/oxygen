#!/usr/bin/env node
/**
 * Production-tree vulnerability audit against npm's bulk advisory endpoint.
 *
 * `pnpm audit` (≤10.x) talks to the legacy `/-/npm/v1/security/audits`
 * endpoint, which the registry retired in 2026 (HTTP 410). pnpm 11 fixed it
 * but requires Node 22+, so this script does what pnpm 11 does with no new
 * toolchain: enumerate the installed production tree (via
 * `pnpm licenses list -P --json`, which reads the lockfile-resolved
 * packages), POST name→versions to `/-/npm/v1/security/advisories/bulk`,
 * and match the returned vulnerable ranges against the installed versions.
 *
 * Usage:
 *   node scripts/audit-prod.mjs [--audit-level=high|critical|moderate|low]
 *
 * Exit code 1 when any advisory at or above the level matches, 0 otherwise.
 * Network/registry failures exit 2 (distinguishable from "vulnerable").
 */

import { execFileSync } from "node:child_process";
import semver from "semver";

const LEVELS = ["low", "moderate", "high", "critical"];
const levelArg = process.argv
  .find((a) => a.startsWith("--audit-level="))
  ?.split("=")[1];
const auditLevel = LEVELS.includes(levelArg ?? "") ? levelArg : "high";
const minRank = LEVELS.indexOf(auditLevel);

// ── 1. Installed production packages (lockfile-resolved) ──────
let licensesJson;
try {
  licensesJson = execFileSync(
    "pnpm",
    ["licenses", "list", "-P", "--json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
} catch (err) {
  console.error("[audit-prod] Failed to enumerate packages via pnpm licenses:", err.message);
  if (err.stdout) console.error("[audit-prod] stdout:", String(err.stdout).slice(0, 4000));
  if (err.stderr) console.error("[audit-prod] stderr:", String(err.stderr).slice(0, 4000));
  process.exit(2);
}

/** name → Set of installed versions. */
const installed = new Map();
for (const group of Object.values(JSON.parse(licensesJson))) {
  for (const pkg of group) {
    const set = installed.get(pkg.name) ?? new Set();
    for (const v of pkg.versions) set.add(v);
    installed.set(pkg.name, set);
  }
}
console.log(`[audit-prod] ${installed.size} production packages in the tree`);

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
