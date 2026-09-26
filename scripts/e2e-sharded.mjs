#!/usr/bin/env node
/**
 * Sharded E2E runner.
 *
 * The Playwright suite is intentionally serial (one worker, shared seed
 * events, reseed() wipes) — in-place parallelism is unsafe. Instead this
 * script launches N fully isolated stacks in parallel, each with its own:
 *
 *   - Postgres database  oxygen_e2e_<i>   (on the :5433 test container)
 *   - API server         port 4100 + i
 *   - Vite dev server    port 4200 + i
 *   - Eventor API stub   port 4300 + i
 *
 * and runs a subset of the spec files in each with today's serial
 * semantics. `playwright.config.ts` reads E2E_SHARD / E2E_API_PORT /
 * E2E_WEB_PORT / E2E_EVENTOR_PORT / E2E_DB_NAME to wire everything up.
 *
 * Usage:
 *   pnpm test:e2e                    # full suite, sharded (default: min(4, cores/2))
 *   pnpm test:e2e e2e/kiosk.spec.ts  # selective run → single plain
 *                                    # playwright process, no sharding
 *   E2E_SHARDS=2 pnpm test:e2e       # fewer shards (lower peak load)
 *   pnpm test:e2e:serial             # escape hatch: plain playwright test
 *
 * Artifacts land in test-results/shard-<i> and playwright-report/shard-<i>.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * Each shard is a full stack — API, Vite, eventor stub and a Chromium —
 * so it wants about two cores to itself. Default to half the available
 * parallelism, capped at four: a 16-core dev box keeps four shards, a
 * 4 vCPU GitHub runner gets two instead of four stacks fighting for the
 * same cores (which is what turned tight `expect` budgets into failures
 * after the map specs started rendering two tile layers).
 */
const DEFAULT_SHARDS = Math.max(
  1,
  Math.min(4, Math.floor(os.availableParallelism() / 2)),
);
const SHARD_COUNT = Math.max(1, Number(process.env.E2E_SHARDS ?? DEFAULT_SHARDS));
const API_PORT_BASE = 4100;
const WEB_PORT_BASE = 4200;
const EVENTOR_PORT_BASE = 4300;

/**
 * Relative run-time weights per spec file, used to balance the shards
 * (LPT assignment). Unlisted files get DEFAULT_WEIGHT. Rough proportions
 * only — rebalance using the per-shard durations printed after each run.
 */
const WEIGHTS = {
  // Measured from a full sharded run after the 2026-09 merge pass
  // (sum of Playwright test durations; reseed/setup overhead included).
  "course-editor.spec.ts": 12, // ~104s — OCAD+map, 12 editor flows
  "registration-dialog.spec.ts": 8, // ~63s — reseed, dual pages, watchdog
  "rental-cards.spec.ts": 4, // ~28s
  "kiosk.spec.ts": 3, // ~22s after merges (still has 5s auto-reset)
  "controls.spec.ts": 3, // ~22s
  "courses.spec.ts": 3, // ~21s — OCAD/ppen imports
  "phase2.spec.ts": 3, // ~21s
  "course-maps.spec.ts": 4, // ~21s — PDF exports
  "phase3.spec.ts": 3, // ~20s
  "kiosk-readout.spec.ts": 3, // ~20s — dual contexts + 5s auto-reset
  "offline.spec.ts": 3, // ~19s — drain polling
  "draw.spec.ts": 3, // ~18s
  "wide-screen-map-pane.spec.ts": 3, // ~18s
  "editor-start-finish.spec.ts": 3, // ~18s — fresh event + map
  "mobile-layout.spec.ts": 3, // ~18s — touch + map upload
  "permissions.spec.ts": 3, // ~18s
  "webserial.spec.ts": 2, // ~16s after merges
  "control-series.spec.ts": 3, // ~15s — library + map upload
  "map-multicourse.spec.ts": 4, // OCAD replace-all + wide viewport
  "map-control-circles.spec.ts": 3,
  "kiosk-smart.spec.ts": 2, // ~14s after merges
  "printer-settings.spec.ts": 2,
  "eventor.spec.ts": 2,
  "classes.spec.ts": 2,
  "error-paths.spec.ts": 2,
  "competition.spec.ts": 2,
  "event.spec.ts": 2,
  "club-map-library.spec.ts": 2,
};
const DEFAULT_WEIGHT = 2;

const args = process.argv.slice(2);
const hasFileFilter = args.some((a) => !a.startsWith("-"));

function runPlaywright(extraArgs, env, onLine) {
  const child = spawn("pnpm", ["exec", "playwright", "test", ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: onLine ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (onLine) {
    for (const stream of [child.stdout, child.stderr]) {
      readline.createInterface({ input: stream }).on("line", onLine);
    }
  }
  return child;
}

if (hasFileFilter) {
  // Selective run: a single plain Playwright process, but on its own ports
  // (API_PORT_BASE + 0 / WEB_PORT_BASE + 0) and DB so it never collides
  // with a running `pnpm dev` stack on 3002/5173. Explicit E2E_* env vars
  // still win.
  const child = runPlaywright(args, {
    E2E_API_PORT: process.env.E2E_API_PORT ?? String(API_PORT_BASE),
    E2E_WEB_PORT: process.env.E2E_WEB_PORT ?? String(WEB_PORT_BASE),
    E2E_EVENTOR_PORT: process.env.E2E_EVENTOR_PORT ?? String(EVENTOR_PORT_BASE),
    E2E_DB_NAME: process.env.E2E_DB_NAME ?? "oxygen_e2e",
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  // Full run: partition all spec files across N shards.
  const specs = readdirSync(path.join(ROOT, "e2e"))
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();

  // LPT: heaviest files first, each into the currently lightest shard.
  const shards = Array.from({ length: SHARD_COUNT }, () => ({
    files: [],
    weight: 0,
  }));
  const byWeightDesc = [...specs].sort(
    (a, b) => (WEIGHTS[b] ?? DEFAULT_WEIGHT) - (WEIGHTS[a] ?? DEFAULT_WEIGHT),
  );
  for (const file of byWeightDesc) {
    const lightest = shards.reduce((min, s) => (s.weight < min.weight ? s : min));
    lightest.files.push(`e2e/${file}`);
    lightest.weight += WEIGHTS[file] ?? DEFAULT_WEIGHT;
  }

  console.log(
    `Running ${specs.length} spec files across ${SHARD_COUNT} shards (${os.availableParallelism()} cores available):`,
  );
  shards.forEach((s, i) => {
    console.log(
      `  shard ${i + 1} (api :${API_PORT_BASE + i + 1}, web :${WEB_PORT_BASE + i + 1}, eventor :${EVENTOR_PORT_BASE + i + 1}, db oxygen_e2e_${i + 1}, weight ${s.weight}):`,
    );
    for (const f of s.files) console.log(`    ${f}`);
  });
  console.log("");

  const children = [];
  const results = shards.map(() => ({ code: null, seconds: 0 }));
  const startedAt = Date.now();

  const killAll = () => {
    for (const c of children) {
      if (c.exitCode === null) c.kill("SIGTERM");
    }
  };
  process.on("SIGINT", () => {
    killAll();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    killAll();
    process.exit(143);
  });

  await Promise.all(
    shards.map((shard, i) => {
      const n = i + 1;
      const env = {
        E2E_SHARD: String(n),
        E2E_API_PORT: String(API_PORT_BASE + n),
        E2E_WEB_PORT: String(WEB_PORT_BASE + n),
        E2E_EVENTOR_PORT: String(EVENTOR_PORT_BASE + n),
        E2E_DB_NAME: `oxygen_e2e_${n}`,
      };
      const t0 = Date.now();
      const child = runPlaywright([...args, ...shard.files], env, (line) => {
        console.log(`[shard ${n}] ${line}`);
      });
      children.push(child);
      return new Promise((resolve) => {
        child.on("exit", (code) => {
          results[i] = { code: code ?? 1, seconds: (Date.now() - t0) / 1000 };
          resolve();
        });
      });
    }),
  );

  const totalSeconds = (Date.now() - startedAt) / 1000;
  console.log("\n── Shard summary ──────────────────────────────");
  results.forEach((r, i) => {
    const status = r.code === 0 ? "PASS" : `FAIL (exit ${r.code})`;
    console.log(
      `  shard ${i + 1}: ${status} in ${r.seconds.toFixed(0)}s — report: playwright-report/shard-${i + 1}`,
    );
  });
  console.log(`  total wall time: ${totalSeconds.toFixed(0)}s`);
  const failed = results.filter((r) => r.code !== 0).length;
  if (failed > 0) {
    console.error(`\n${failed} shard(s) failed.`);
    process.exit(1);
  }
  process.exit(0);
}
