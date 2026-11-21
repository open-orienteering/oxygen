import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isPreviewSpec, partition, weightOf } from "../e2e-weights.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = path.join(ROOT, "scripts", "e2e-sharded.mjs");
const ALL_SPECS = readdirSync(path.join(ROOT, "e2e"))
  .filter((f) => f.endsWith(".spec.ts"))
  .sort();
/** The specs the shards split: every spec but the preview stack's (G29). */
const SPECS = ALL_SPECS.filter((f) => !isPreviewSpec(f));

/** Run the sharded runner with `--plan` (prints the split, starts nothing). */
function plan(env, extra = []) {
  const base = { ...process.env };
  for (const k of ["E2E_SHARDS", "E2E_SHARD_TOTAL", "E2E_SHARD_INDEX", "E2E_API_PORT", "E2E_EVENTOR_PORT", "E2E_PREVIEW_PORT", "E2E_DB_NAME", "E2E_DB_PREFIX"]) delete base[k];
  return spawnSync(process.execPath, [RUNNER, "--plan", ...extra], {
    cwd: ROOT,
    env: { ...base, ...env },
    encoding: "utf8",
  });
}

/** The files a `--plan` output lists under each shard header. */
function parsePlan(stdout) {
  const shards = new Map();
  let current = null;
  for (const line of stdout.split("\n")) {
    const header = line.match(/^ {2}shard (\d+) /);
    if (header) {
      current = Number(header[1]);
      shards.set(current, []);
    } else if (/^ {2}\S/.test(line)) {
      current = null; // another header (the preview stack's): its files are no shard's
    } else if (current !== null && /^ {4}e2e\//.test(line)) {
      shards.get(current).push(line.trim());
    }
  }
  return shards;
}

test("partition: every spec file in exactly one shard, for any shard count", () => {
  for (const count of [1, 2, 3, 6, 8, SPECS.length + 3]) {
    const shards = partition(SPECS, count);
    assert.equal(shards.length, count);
    const all = shards.flatMap((s) => s.files).sort();
    assert.deepEqual(all, SPECS, `${count} shards`);
    for (const s of shards) {
      assert.equal(s.weight, s.files.reduce((sum, f) => sum + weightOf(f), 0));
    }
  }
});

test("partition: LPT — heaviest first, each into the lightest shard, ties to the lower shard", () => {
  const w = { "a.spec.ts": 5, "b.spec.ts": 4, "c.spec.ts": 3, "d.spec.ts": 3, "e.spec.ts": 1 };
  const shards = partition(Object.keys(w).reverse(), 2, (f) => w[f]);
  assert.deepEqual(
    shards.map((s) => s.files),
    [
      ["a.spec.ts", "d.spec.ts"],
      ["b.spec.ts", "c.spec.ts", "e.spec.ts"],
    ],
  );
  assert.deepEqual(
    shards.map((s) => s.weight),
    [8, 8],
  );
});

test("partition: the split does not depend on the order files are listed in", () => {
  const a = partition(SPECS, 6);
  const b = partition([...SPECS].reverse(), 6);
  assert.deepEqual(a, b);
});

test("--plan with E2E_SHARD_TOTAL/INDEX: each matrix job runs the shard the full split gives it", () => {
  const total = 6;
  const expected = partition(SPECS, total).map((s) => s.files.map((f) => `e2e/${f}`));
  const full = plan({ E2E_SHARDS: String(total) });
  assert.equal(full.status, 0, full.stderr);
  assert.deepEqual([...parsePlan(full.stdout).values()], expected);
  for (let i = 1; i <= total; i++) {
    const one = plan({ E2E_SHARD_TOTAL: String(total), E2E_SHARD_INDEX: String(i) });
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, new RegExp(`^Running shard ${i} of ${total} `, "m"));
    assert.deepEqual(parsePlan(one.stdout).get(i), expected[i - 1], `shard ${i}`);
  }
});

test("E2E_SHARD_TOTAL and E2E_SHARD_INDEX: both or neither, index within total", () => {
  for (const env of [
    { E2E_SHARD_TOTAL: "6" },
    { E2E_SHARD_INDEX: "1" },
    { E2E_SHARD_TOTAL: "3", E2E_SHARD_INDEX: "4" },
    { E2E_SHARD_TOTAL: "3", E2E_SHARD_INDEX: "0" },
    { E2E_SHARD_TOTAL: "two", E2E_SHARD_INDEX: "1" },
  ]) {
    const r = plan(env);
    assert.equal(r.status, 2, JSON.stringify(env));
    assert.equal(r.stdout, "", JSON.stringify(env));
  }
});

test("ci.yml: the E2E matrix lists shards 1..N and passes the job total and its shard to the runner", () => {
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const job = ci.slice(ci.indexOf("\n  e2e-shard:\n"), ci.indexOf("\n  e2e:\n"));
  assert.ok(job.length > 0, "e2e-shard job");
  const list = job.match(/^ {8}shard: \[([\d, ]+)\]$/m);
  assert.ok(list, "matrix shard list");
  const shards = list[1].split(",").map((n) => Number(n.trim()));
  assert.deepEqual(
    shards,
    shards.map((_, i) => i + 1),
  );
  assert.match(job, /^ {6}E2E_SHARD_TOTAL: \$\{\{ strategy\.job-total \}\}$/m);
  assert.match(job, /^ {6}E2E_SHARD_INDEX: \$\{\{ matrix\.shard \}\}$/m);
  // The gate keeps the check name the merge flow reads.
  assert.match(ci, /\n {2}e2e:\n {4}name: E2E tests\n/);
});

// G29: the preview stack (docs/dev/e2e-sharding.md "The preview stack").
test("isPreviewSpec: the .preview.spec.ts suffix, and there is at least one", () => {
  assert.equal(isPreviewSpec("offline-print.preview.spec.ts"), true);
  assert.equal(isPreviewSpec("e2e/offline-print.preview.spec.ts"), true);
  assert.equal(isPreviewSpec("offline.spec.ts"), false);
  assert.equal(isPreviewSpec("preview.ts"), false);
  assert.ok(ALL_SPECS.some(isPreviewSpec), "a preview spec in e2e/");
});

test("--plan: no preview spec in any shard; a full local run lists the preview stack after the shards", () => {
  const full = plan({ E2E_SHARDS: "3" });
  assert.equal(full.status, 0, full.stderr);
  const listed = [...parsePlan(full.stdout).values()].flat();
  assert.deepEqual(listed.sort(), SPECS.map((f) => `e2e/${f}`).sort());
  assert.match(full.stdout, /^ {2}preview \(api :4100, web :4400 vite preview, eventor :4300, db oxygen_e2e\), after the shards:$/m);
  for (const f of ALL_SPECS.filter(isPreviewSpec)) assert.ok(full.stdout.includes(`\n    e2e/${f}\n`), f);
});

test("--plan with E2E_SHARD_INDEX: one matrix job never runs the preview stack (CI's e2e-preview job does)", () => {
  const one = plan({ E2E_SHARD_TOTAL: "6", E2E_SHARD_INDEX: "1" });
  assert.equal(one.status, 0, one.stderr);
  assert.doesNotMatch(one.stdout, /preview/);
});

test("--plan --preview: the preview stack only", () => {
  const r = plan({}, ["--preview"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Running the preview stack/m);
  assert.equal(parsePlan(r.stdout).size, 0);
});

test("a selective run may not mix preview and dev-server specs; --preview with a dev-server spec is refused", () => {
  const mixed = plan({}, ["e2e/offline-print.preview.spec.ts", "e2e/offline.spec.ts"]);
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /preview/);
  const wrong = plan({}, ["--preview", "e2e/offline.spec.ts"]);
  assert.equal(wrong.status, 2);
});

test("--preview with a grep: the flag's value is not a file", () => {
  for (const extra of [["--preview", "-g", "store, reload"], ["--preview", "--grep", "offline"], ["e2e/offline-print.preview.spec.ts", "-g", "offline"]]) {
    const r = plan({}, extra);
    assert.equal(r.status, 0, `${extra.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, /^Running the preview stack/m);
  }
});

test("the preview stack's line names the ports and database it is given", () => {
  const r = plan({ E2E_API_PORT: "4105", E2E_PREVIEW_PORT: "4410", E2E_DB_NAME: "oxygen_e2e_x" }, ["--preview"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /api :4105, web :4410 vite preview, eventor :4300, db oxygen_e2e_x/);
});

test("ci.yml: the e2e-preview job runs the preview stack and the E2E gate needs it", () => {
  const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const job = ci.slice(ci.indexOf("\n  e2e-preview:\n"), ci.indexOf("\n  e2e:\n"));
  assert.ok(ci.includes("\n  e2e-preview:\n") && job.length > 0, "e2e-preview job before the gate");
  assert.match(job, /^ {8}run: pnpm test:e2e --preview$/m);
  assert.doesNotMatch(job, /E2E_SHARD_(TOTAL|INDEX)/);
  const gate = ci.slice(ci.indexOf("\n  e2e:\n"), ci.indexOf("\n  publish:\n"));
  assert.match(gate, /^ {4}needs: \[e2e-shard, e2e-preview\]$/m);
  assert.match(gate, /needs\.e2e-shard\.result/);
  assert.match(gate, /needs\.e2e-preview\.result/);
});
