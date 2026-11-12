import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { partition, weightOf } from "../e2e-weights.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNNER = path.join(ROOT, "scripts", "e2e-sharded.mjs");
const SPECS = readdirSync(path.join(ROOT, "e2e"))
  .filter((f) => f.endsWith(".spec.ts"))
  .sort();

/** Run the sharded runner with `--plan` (prints the split, starts nothing). */
function plan(env) {
  const base = { ...process.env };
  for (const k of ["E2E_SHARDS", "E2E_SHARD_TOTAL", "E2E_SHARD_INDEX"]) delete base[k];
  return spawnSync(process.execPath, [RUNNER, "--plan"], {
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
