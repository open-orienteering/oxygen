import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Dev servers (3002/5173) and the Docker stack (3001/8080): ports a test
// run must never use or attach to. docs/bugfix-e2e-reuses-dev-server.md.
const FORBIDDEN = [3001, 3002, 5173, 8080];

/** Load playwright.config.ts under a given env and report what it would do. */
function loadConfig(env) {
  const base = { ...process.env };
  for (const k of ["E2E_API_PORT", "E2E_WEB_PORT", "E2E_EVENTOR_PORT", "E2E_SHARD"]) delete base[k];
  const out = execFileSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "-e",
      `import c from "./playwright.config.ts";
       console.log(JSON.stringify({
         baseURL: c.use.baseURL,
         servers: c.webServer.map((w) => ({ port: w.port, reuse: w.reuseExistingServer, env: w.env })),
       }));`,
    ],
    { cwd: ROOT, env: { ...base, ...env }, encoding: "utf8" },
  );
  return JSON.parse(out.trim().split("\n").pop());
}

test("default stack uses the 4100/4200/4300 triple, not the dev or Docker ports", () => {
  const cfg = loadConfig({});
  assert.deepEqual(
    cfg.servers.map((s) => s.port),
    [4100, 4300, 4200],
  );
  assert.equal(cfg.baseURL, "http://127.0.0.1:4200");
  for (const s of cfg.servers) assert.ok(!FORBIDDEN.includes(s.port), `port ${s.port}`);
});

test("no web server reuses an existing server, on any port", () => {
  for (const env of [{}, { E2E_API_PORT: "4101", E2E_WEB_PORT: "4201", E2E_EVENTOR_PORT: "4301" }]) {
    for (const s of loadConfig(env).servers) {
      assert.equal(s.reuse, false, `port ${s.port} must not reuse an existing server`);
    }
  }
});

test("E2E_*_PORT overrides still reach the servers and baseURL (sharded runner)", () => {
  const cfg = loadConfig({ E2E_API_PORT: "4102", E2E_WEB_PORT: "4202", E2E_EVENTOR_PORT: "4302" });
  assert.deepEqual(
    cfg.servers.map((s) => s.port),
    [4102, 4302, 4202],
  );
  assert.equal(cfg.baseURL, "http://127.0.0.1:4202");
  assert.equal(cfg.servers[2].env.API_PROXY_PORT, "4102");
});
