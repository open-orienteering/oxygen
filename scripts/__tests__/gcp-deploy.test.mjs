import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEPLOY = path.join(ROOT, "scripts/gcp/deploy.sh");

// A gcloud stand-in first on PATH: logs every call's argv (one line per call)
// and answers from fixture environment variables.
const STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$1 $2 $3" in
  "run services list")
    [[ ",$STUB_FAIL," == *,services-list,* ]] && { echo "ERROR: (gcloud.run.services.list) 503 unavailable" >&2; exit 1; }
    [[ "$STUB_SERVICE_EXISTS" == 1 ]] && echo oxygen
    exit 0 ;;
  "run services describe")
    [[ ",$STUB_FAIL," == *,describe,* ]] && { echo "ERROR: (gcloud.run.services.describe) timeout" >&2; exit 1; }
    cat "$STUB_DESCRIBE_JSON"
    exit 0 ;;
  "secrets list "*)
    [[ ",$STUB_FAIL," == *,secrets-list,* ]] && { echo "ERROR: (gcloud.secrets.list) 500" >&2; exit 1; }
    IFS=, read -ra have <<<"$STUB_SECRETS"
    for s in "\${have[@]}"; do
      [[ "$*" == *"/secrets/$s$"* ]] && echo "projects/1/secrets/$s"
    done
    exit 0 ;;
esac
exit 0
`;

function describeJson({ min = "0", throttle = "true", env = [] } = {}) {
  return JSON.stringify({
    spec: {
      template: {
        metadata: {
          annotations: {
            "autoscaling.knative.dev/minScale": min,
            "run.googleapis.com/cpu-throttling": throttle,
          },
        },
        spec: {
          containers: [
            {
              env: env.map((name) => ({ name, value: "x" })),
            },
          ],
        },
      },
    },
  });
}

const MANAGED_LIVE = [
  "DATABASE_URL", "NODE_OPTIONS", "DATABASE_POOL_MAX", "MAP_RENDER_CONCURRENCY", "AUTH_MODE",
  "AUTH_HEADER", "AUTH_AUTO_PROVISION", "OXYGEN_ADMIN_EMAILS", "OXYGEN_DEPLOY_REF",
];

describe("scripts/gcp/deploy.sh", () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "gcp-deploy-"));
    writeFileSync(path.join(dir, "gcloud"), STUB);
    chmodSync(path.join(dir, "gcloud"), 0o755);
    writeFileSync(
      path.join(dir, "env.sh"),
      [
        'export PROJECT_ID="proj"',
        'export REGION="europe-north1"',
        'export SERVICE="oxygen"',
        'export SQL_CONNECTION="proj:europe-north1:pg"',
        'export OXYGEN_ADMIN_EMAILS="me@example.com"',
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(dir, "describe.json"), describeJson());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(args = [], { env = {}, extraEnvFile = "", describe: json } = {}) {
    if (extraEnvFile) {
      writeFileSync(path.join(dir, "env.sh"), readFileSync(path.join(dir, "env.sh"), "utf8") + extraEnvFile + "\n");
    }
    if (json) writeFileSync(path.join(dir, "describe.json"), json);
    const log = path.join(dir, "calls.log");
    writeFileSync(log, "");
    const result = spawnSync("bash", [DEPLOY, "v1.2.3", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        OXYGEN_GCP_ENV: path.join(dir, "env.sh"),
        STUB_LOG: log,
        STUB_DESCRIBE_JSON: path.join(dir, "describe.json"),
        STUB_SERVICE_EXISTS: "0",
        STUB_SECRETS: "",
        STUB_FAIL: "",
        ...env,
      },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { ...result, calls };
  }

  const deployCall = (r) => r.calls.find((c) => c.startsWith("run deploy "));
  const migrated = (r) => r.calls.some((c) => c.startsWith("run jobs"));
  const flag = (call, name) => new RegExp(`--${name}=(\\S*)`).exec(call)?.[1];

  it("exits 1 without deploying or migrating when the service listing fails", () => {
    const r = run([], { env: { STUB_FAIL: "services-list" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gcloud run services list failed/);
    assert.match(r.stderr, /503 unavailable/);
    assert.equal(deployCall(r), undefined);
    assert.equal(migrated(r), false);
  });

  it("exits 1 without deploying when the describe of an existing service fails", () => {
    const r = run([], { env: { STUB_SERVICE_EXISTS: "1", STUB_FAIL: "describe" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /describe failed/);
    assert.equal(deployCall(r), undefined);
    assert.equal(migrated(r), false);
  });

  it("treats an absent service as a first deploy: min-instances=0, throttled", () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    const call = deployCall(r);
    assert.equal(flag(call, "min-instances"), "0");
    assert.match(call, /--cpu-throttling /);
    assert.match(r.stdout, /First deploy: idle mode/);
  });

  it("keeps a live event mode and prints it", () => {
    const r = run([], {
      env: { STUB_SERVICE_EXISTS: "1" },
      describe: describeJson({ min: "1", throttle: "false", env: MANAGED_LIVE }),
    });
    assert.equal(r.status, 0, r.stderr);
    const call = deployCall(r);
    assert.equal(flag(call, "min-instances"), "1");
    assert.match(call, /--no-cpu-throttling/);
    assert.match(r.stdout, /Mode kept from the running service: event mode \(min-instances=1, cpu-throttling=0\)/);
    assert.doesNotMatch(r.stdout, /unchanged/);
  });

  it("binds the sync secret when it exists", () => {
    const r = run([], { env: { STUB_SECRETS: "oxygen-sync-secret" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(flag(deployCall(r), "set-secrets"), /SYNC_SHARED_SECRET=oxygen-sync-secret:latest/);
  });

  it("warns, and leaves it out, when the sync secret is absent", () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(flag(deployCall(r), "set-secrets"), /SYNC_SHARED_SECRET/);
    assert.match(r.stderr, /venue-box sync is OFF/);
  });

  it("honours SYNC_SECRET from env.sh", () => {
    const r = run([], { env: { STUB_SECRETS: "club-sync" }, extraEnvFile: 'export SYNC_SECRET="club-sync"' });
    assert.match(flag(deployCall(r), "set-secrets"), /SYNC_SHARED_SECRET=club-sync:latest/);
  });

  it("passes EXTRA_ENV through with the managed variables", () => {
    const r = run([], { extraEnvFile: 'export EXTRA_ENV="PRINT_WORKERS=2;MAP_HEIGHTFIELD_MAX_CELLS=30000000"' });
    assert.equal(r.status, 0, r.stderr);
    const env = flag(deployCall(r), "set-env-vars");
    assert.match(env, /^\^;\^NODE_OPTIONS=/);
    assert.match(env, /;PRINT_WORKERS=2;MAP_HEIGHTFIELD_MAX_CELLS=30000000;OXYGEN_DEPLOY_REF=v1\.2\.3$/);
  });

  for (const [label, value, message] of [
    ["an entry without =", "PRINT_WORKERS", /not NAME=value/],
    ["a bad name", "1BAD=2", /not NAME=value/],
    ["a managed name", "AUTH_MODE=off", /may not set AUTH_MODE/],
  ]) {
    it(`rejects EXTRA_ENV with ${label}, before migrating`, () => {
      const r = run([], { extraEnvFile: `export EXTRA_ENV="${value}"` });
      assert.equal(r.status, 1);
      assert.match(r.stderr, message);
      assert.equal(migrated(r), false);
      assert.equal(deployCall(r), undefined);
    });
  }

  it("aborts before migrating when the live service has a variable it would drop", () => {
    const r = run([], {
      env: { STUB_SERVICE_EXISTS: "1" },
      describe: describeJson({ env: [...MANAGED_LIVE, "PRINT_WORKERS", "SYNC_SHARED_SECRET"] }),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /would REMOVE: PRINT_WORKERS SYNC_SHARED_SECRET/);
    assert.equal(migrated(r), false);
    assert.equal(deployCall(r), undefined);
  });

  it("does not abort when EXTRA_ENV and the sync secret cover the live variables", () => {
    const r = run([], {
      env: { STUB_SERVICE_EXISTS: "1", STUB_SECRETS: "oxygen-sync-secret" },
      extraEnvFile: 'export EXTRA_ENV="PRINT_WORKERS=2"',
      describe: describeJson({ env: [...MANAGED_LIVE, "PRINT_WORKERS", "SYNC_SHARED_SECRET"] }),
    });
    assert.equal(r.status, 0, r.stderr);
  });

  it("--drop-unlisted deploys anyway and names what is removed", () => {
    const r = run(["--drop-unlisted"], {
      env: { STUB_SERVICE_EXISTS: "1" },
      describe: describeJson({ env: [...MANAGED_LIVE, "PRINT_WORKERS"] }),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /removing live variables not set by this deploy: PRINT_WORKERS/);
    assert.ok(deployCall(r));
    assert.ok(migrated(r));
  });

  it("exits 1 when listing the DEM secret fails", () => {
    const r = run([], { env: { STUB_FAIL: "secrets-list" } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /gcloud secrets list \(oxygen-geotorget-credentials\) failed/);
    assert.equal(deployCall(r), undefined);
    assert.equal(migrated(r), false);
  });

  it("--migrate-only neither reads scaling nor deploys", () => {
    const r = run(["--migrate-only"], { env: { STUB_FAIL: "services-list" } });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(migrated(r));
    assert.equal(deployCall(r), undefined);
    assert.equal(r.calls.some((c) => c.startsWith("run services list")), false);
  });
});
