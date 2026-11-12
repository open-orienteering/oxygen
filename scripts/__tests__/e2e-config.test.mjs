import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
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

/** The projects and their file lists, as Playwright reads them. */
function loadProjects() {
  const out = execFileSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "-e",
      `import c from "./playwright.config.ts";
       console.log(JSON.stringify(c.projects.map((p) => ({ name: p.name, testMatch: p.testMatch ?? null, testIgnore: p.testIgnore ?? null }))));`,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  return JSON.parse(out.trim().split("\n").pop());
}

/** The config's globs are all `**` + `/<file>`: a file matches by its base name. */
const matches = (globs, file) => (globs ?? []).some((g) => g === `**/${file}`);
const runsIn = (project, file) =>
  (project.testMatch === null || matches(project.testMatch, file)) && !matches(project.testIgnore, file);

test("projects: chromium and mobile only; the phone specs in mobile, every other spec once in chromium (E3)", () => {
  const projects = loadProjects();
  assert.deepEqual(projects.map((p) => p.name).sort(), ["chromium", "mobile"]);
  const runners = (file) => projects.filter((p) => runsIn(p, file)).map((p) => p.name).sort();
  assert.deepEqual(runners("course-editor.spec.ts"), ["chromium"]);
  assert.deepEqual(runners("course-editor-tools.spec.ts"), ["chromium"]);
  assert.deepEqual(runners("course-editor-phone.spec.ts"), ["mobile"]);
  assert.deepEqual(runners("field-mode.spec.ts"), ["mobile"]);
  assert.deepEqual(runners("course-maps.spec.ts"), ["chromium"]);
  assert.deepEqual(runners("webserial.spec.ts"), ["chromium"]);
  assert.deepEqual(runners("kiosk.spec.ts"), ["chromium"]);
});

test("every spec file run by more than one project is weighted per project (scripts/e2e-weights.mjs)", async () => {
  const { WEIGHTS, weightOf } = await import("../e2e-weights.mjs");
  const projects = loadProjects();
  const specs = readdirSync(path.join(ROOT, "e2e")).filter((f) => f.endsWith(".spec.ts"));
  for (const file of specs) {
    const names = projects.filter((p) => runsIn(p, file)).map((p) => p.name).sort();
    assert.ok(names.length > 0, `${file} runs in no project`);
    const w = WEIGHTS[file];
    if (names.length > 1 || (w !== undefined && typeof w !== "number")) {
      assert.equal(typeof w, "object", `${file} runs in ${names.join(", ")}: weight it per project`);
      assert.deepEqual(Object.keys(w).sort(), names, `${file}: weights name exactly the projects that run it`);
    }
  }
  for (const file of Object.keys(WEIGHTS)) assert.ok(specs.includes(file), `weight for a missing spec: ${file}`);
  const phone = WEIGHTS["course-editor-phone.spec.ts"];
  assert.equal(weightOf("course-editor-phone.spec.ts"), phone.mobile);
  assert.equal(weightOf("course-editor.spec.ts"), WEIGHTS["course-editor.spec.ts"]);
  assert.equal(weightOf("no-such.spec.ts"), 10);
});
