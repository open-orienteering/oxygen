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
 * E2E_DB_PREFIX (default `oxygen_e2e`) renames the databases — a branch
 * whose migration drops columns runs on its own copies instead of the
 * databases every other worktree migrates and reuses.
 *
 * One shard of many (CI): E2E_SHARD_TOTAL=N E2E_SHARD_INDEX=i (1-based)
 * computes the same LPT split into N shards and runs only shard i, on
 * stack i (ports 4100/4200/4300 + i, db <prefix>_i). CI's E2E job is a
 * matrix of N such jobs, one runner each (.github/workflows/ci.yml,
 * docs/dev/e2e-sharding.md "CI"); any one of them replays locally with the
 * same two variables.
 *
 * Usage:
 *   pnpm test:e2e                    # full suite, sharded (default: min(4, cores/2))
 *   pnpm test:e2e e2e/kiosk.spec.ts  # selective run → single plain
 *                                    # playwright process, no sharding
 *   E2E_SHARDS=2 pnpm test:e2e       # fewer shards (lower peak load)
 *   E2E_SHARD_TOTAL=6 E2E_SHARD_INDEX=3 pnpm test:e2e  # shard 3 of 6 only
 *   pnpm test:e2e --plan             # print the split and exit, no stack
 *                                    # (honours E2E_SHARDS / E2E_SHARD_TOTAL)
 *   E2E_DB_PREFIX=oxygen_e5 pnpm test:e2e  # databases oxygen_e5_<i>
 *   pnpm test:e2e:serial             # escape hatch: plain playwright test
 *                                    # (same 4100/4200/4300 default stack as a
 *                                    # selective run, never the dev servers)
 *
 * The preview stack (G29, docs/dev/e2e-sharding.md "The preview stack"): the
 * production bundle under `vite preview` on :4400, with its service worker,
 * beside the default stack's API :4100, Eventor stub :4300 and db <prefix>.
 * Its specs (`*.preview.spec.ts`) are in no shard; Playwright runs them as
 * project `preview` with E2E_PREVIEW=1.
 *
 *   pnpm test:e2e --preview          # the preview stack only (CI's e2e-preview job)
 *   pnpm test:e2e e2e/offline-print.preview.spec.ts  # the same, one file
 *   pnpm test:e2e                    # a full local run: the shards, then
 *                                    # the preview stack (a matrix job,
 *                                    # E2E_SHARD_INDEX, runs its shard only)
 *
 * Artifacts land in test-results/shard-<i> and playwright-report/shard-<i>
 * (the preview stack's in test-results/preview, playwright-report/preview).
 */
import { spawn } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { isPreviewSpec, partition } from "./e2e-weights.mjs";

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
/**
 * E2E_SHARD_TOTAL + E2E_SHARD_INDEX select one shard of a split (the CI
 * matrix); both or neither. Otherwise all E2E_SHARDS (or the default)
 * shards run here, side by side.
 */
function intEnv(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${name} must be a positive integer, got "${raw}"`);
    process.exit(2);
  }
  return n;
}
const SHARD_TOTAL = intEnv("E2E_SHARD_TOTAL");
const SHARD_INDEX = intEnv("E2E_SHARD_INDEX");
if ((SHARD_TOTAL === undefined) !== (SHARD_INDEX === undefined) || SHARD_INDEX > SHARD_TOTAL) {
  console.error("E2E_SHARD_TOTAL and E2E_SHARD_INDEX go together, with 1 <= index <= total");
  process.exit(2);
}
const SHARD_COUNT =
  SHARD_TOTAL ?? Math.max(1, Number(process.env.E2E_SHARDS ?? DEFAULT_SHARDS));
const API_PORT_BASE = 4100;
const WEB_PORT_BASE = 4200;
const EVENTOR_PORT_BASE = 4300;
/** The preview stack's web port (e2e/helpers/ports.ts E2E_DEFAULT_PREVIEW_PORT). */
const PREVIEW_PORT = 4400;
const DB_PREFIX = process.env.E2E_DB_PREFIX ?? "oxygen_e2e";

/**
 * Relative run-time weights per spec file (LPT assignment) live in
 * `scripts/e2e-weights.mjs`: a file run by several Playwright projects
 * counts once per project. Rebalance there using the per-shard durations
 * printed after each run.
 */

const PLAN_ONLY = process.argv.includes("--plan");
const PREVIEW_ONLY = process.argv.includes("--preview");
const args = process.argv.slice(2).filter((a) => a !== "--plan" && a !== "--preview");
// Any argument not starting with `-` makes a run selective (unsharded) —
// so `-g "name"` runs unsharded too (docs/dev/e2e-sharding.md "Commands").
const hasFileFilter = args.some((a) => !a.startsWith("-"));

/** Playwright flags whose value is the next argument: that value is not a file. */
const VALUE_FLAGS = new Set(["-g", "--grep", "--grep-invert", "--project", "-j", "--workers", "--retries", "--repeat-each", "--reporter", "--timeout", "--max-failures"]);
/** The spec files named on the command line (flag values skipped). */
const fileArgs = args.filter((a, i) => !a.startsWith("-") && !VALUE_FLAGS.has(args[i - 1]));

// One Playwright process runs one stack: the dev server's specs or the
// preview build's, never both.
const previewFiles = fileArgs.filter(isPreviewSpec);
if (previewFiles.length > 0 && previewFiles.length < fileArgs.length) {
  console.error("A selective run takes preview specs (*.preview.spec.ts) or dev-server specs, not both: they run on different stacks.");
  process.exit(2);
}
if (PREVIEW_ONLY && previewFiles.length < fileArgs.length) {
  console.error("--preview runs the preview stack: its file arguments must be preview specs (*.preview.spec.ts).");
  process.exit(2);
}
const runPreview = PREVIEW_ONLY || (fileArgs.length > 0 && previewFiles.length === fileArgs.length);

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

/** The preview stack's env: the default stack's API, stub and db, `vite preview` on PREVIEW_PORT. */
function previewEnv() {
  return {
    E2E_PREVIEW: "1",
    E2E_API_PORT: process.env.E2E_API_PORT ?? String(API_PORT_BASE),
    E2E_EVENTOR_PORT: process.env.E2E_EVENTOR_PORT ?? String(EVENTOR_PORT_BASE),
    E2E_PREVIEW_PORT: process.env.E2E_PREVIEW_PORT ?? String(PREVIEW_PORT),
    E2E_DB_NAME: process.env.E2E_DB_NAME ?? DB_PREFIX,
  };
}
const PREVIEW_LABEL = (({ E2E_API_PORT, E2E_PREVIEW_PORT, E2E_EVENTOR_PORT, E2E_DB_NAME }) =>
  `preview (api :${E2E_API_PORT}, web :${E2E_PREVIEW_PORT} vite preview, eventor :${E2E_EVENTOR_PORT}, db ${E2E_DB_NAME})`)(previewEnv());

if (runPreview) {
  // The preview stack only (`--preview`, or preview specs named): one
  // Playwright process, project `preview`; with no file named it runs
  // every preview spec (the project's testMatch).
  console.log(`Running the preview stack: ${PREVIEW_LABEL}`);
  if (PLAN_ONLY) process.exit(0);
  const child = runPlaywright(args, previewEnv());
  child.on("exit", (code) => process.exit(code ?? 1));
} else if (hasFileFilter) {
  // Selective run: a single plain Playwright process, on the unsuffixed
  // bases (API_PORT_BASE + 0 / WEB_PORT_BASE + 0, the same values as the
  // defaults in e2e/helpers/ports.ts) and DB, so it never touches a running
  // `pnpm dev` stack on 3002/5173. The config never reuses an existing
  // server, so the run always tests the checkout it is started from; a
  // busy port is an error. Explicit E2E_* env vars still win.
  const child = runPlaywright(args, {
    E2E_API_PORT: process.env.E2E_API_PORT ?? String(API_PORT_BASE),
    E2E_WEB_PORT: process.env.E2E_WEB_PORT ?? String(WEB_PORT_BASE),
    E2E_EVENTOR_PORT: process.env.E2E_EVENTOR_PORT ?? String(EVENTOR_PORT_BASE),
    E2E_DB_NAME: process.env.E2E_DB_NAME ?? DB_PREFIX,
  });
  child.on("exit", (code) => process.exit(code ?? 1));
} else {
  // Full run: partition all spec files across N shards.
  const all = readdirSync(path.join(ROOT, "e2e"))
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();
  // The preview stack's specs are in no shard (G29): they need the build.
  const specs = all.filter((f) => !isPreviewSpec(f));
  const previewSpecs = all.filter(isPreviewSpec).map((f) => `e2e/${f}`);
  // A matrix job runs its shard only; CI's e2e-preview job runs the preview stack.
  const withPreview = !SHARD_INDEX && previewSpecs.length > 0;

  // LPT (`partition` in scripts/e2e-weights.mjs): heaviest files first,
  // each into the currently lightest shard.
  const shards = partition(specs, SHARD_COUNT).map((s) => ({
    ...s,
    files: s.files.map((f) => `e2e/${f}`),
  }));
  // The shards this process runs: all of them, or the one a CI job owns.
  const mine = SHARD_INDEX ? [SHARD_INDEX - 1] : shards.map((_, i) => i);

  console.log(
    SHARD_INDEX
      ? `Running shard ${SHARD_INDEX} of ${SHARD_COUNT} (${specs.length} spec files in the split, ${os.availableParallelism()} cores available):`
      : `Running ${specs.length} spec files across ${SHARD_COUNT} shards (${os.availableParallelism()} cores available):`,
  );
  shards.forEach((s, i) => {
    const runs = mine.includes(i);
    console.log(
      `  shard ${i + 1} (api :${API_PORT_BASE + i + 1}, web :${WEB_PORT_BASE + i + 1}, eventor :${EVENTOR_PORT_BASE + i + 1}, db ${DB_PREFIX}_${i + 1}, weight ${s.weight})${runs || PLAN_ONLY ? ":" : " — another job"}`,
    );
    if (runs || PLAN_ONLY) for (const f of s.files) console.log(`    ${f}`);
  });
  if (withPreview) {
    console.log(`  ${PREVIEW_LABEL}, after the shards:`);
    for (const f of previewSpecs) console.log(`    ${f}`);
  }
  console.log("");
  if (PLAN_ONLY) process.exit(0);

  const children = [];
  const results = new Map();
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
    mine.map((i) => {
      const shard = shards[i];
      const n = i + 1;
      // More shards than files: an empty shard passes. (Playwright given
      // no file arguments would run the whole suite instead.)
      if (shard.files.length === 0) {
        results.set(n, { code: 0, seconds: 0 });
        return Promise.resolve();
      }
      const env = {
        E2E_SHARD: String(n),
        E2E_API_PORT: String(API_PORT_BASE + n),
        E2E_WEB_PORT: String(WEB_PORT_BASE + n),
        E2E_EVENTOR_PORT: String(EVENTOR_PORT_BASE + n),
        E2E_DB_NAME: `${DB_PREFIX}_${n}`,
      };
      const t0 = Date.now();
      const child = runPlaywright([...args, ...shard.files], env, (line) => {
        console.log(`[shard ${n}] ${line}`);
      });
      children.push(child);
      return new Promise((resolve) => {
        child.on("exit", (code) => {
          results.set(n, { code: code ?? 1, seconds: (Date.now() - t0) / 1000 });
          resolve();
        });
      });
    }),
  );

  // The preview stack after the shards, not beside them: the shard count
  // is sized to the cores, and one more stack would crowd every timing.
  let preview = null;
  if (withPreview) {
    const t0 = Date.now();
    const child = runPlaywright([...args, ...previewSpecs], previewEnv(), (line) => {
      console.log(`[preview] ${line}`);
    });
    children.push(child);
    preview = await new Promise((resolve) => {
      child.on("exit", (code) => resolve({ code: code ?? 1, seconds: (Date.now() - t0) / 1000 }));
    });
  }

  const totalSeconds = (Date.now() - startedAt) / 1000;
  console.log("\n── Shard summary ──────────────────────────────");
  const lines = [];
  for (const [n, r] of [...results].sort((a, b) => a[0] - b[0])) {
    const status = r.code === 0 ? "PASS" : `FAIL (exit ${r.code})`;
    lines.push(`shard ${n}/${SHARD_COUNT}: ${status} in ${r.seconds.toFixed(0)}s (weight ${shards[n - 1].weight})`);
    console.log(`  ${lines.at(-1)} — report: playwright-report/shard-${n}`);
  }
  if (preview) {
    const status = preview.code === 0 ? "PASS" : `FAIL (exit ${preview.code})`;
    lines.push(`preview: ${status} in ${preview.seconds.toFixed(0)}s`);
    console.log(`  ${lines.at(-1)} — report: playwright-report/preview`);
  }
  console.log(`  total wall time: ${totalSeconds.toFixed(0)}s`);
  // On GitHub Actions the shard's time also goes on the job's summary
  // page: the numbers scripts/e2e-weights.mjs is rebalanced from.
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.map((l) => `- ${l}\n`).join(""));
  }
  const failed = [...results.values()].filter((r) => r.code !== 0).length;
  const previewFailed = preview !== null && preview.code !== 0;
  if (failed > 0 || previewFailed) {
    console.error(`\n${failed} shard(s) failed${previewFailed ? "; the preview stack failed" : ""}.`);
    process.exit(1);
  }
  process.exit(0);
}
