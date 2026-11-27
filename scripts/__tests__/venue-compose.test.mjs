import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

function composeConfig(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.VENUE_SA_KEY;
  delete env.SYNC_GOOGLE_AUDIENCE;
  Object.assign(env, extraEnv);
  const result = spawnSync(
    "docker",
    ["compose", "-f", "docker-compose.venue.yml", "config", "--format", "json"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...env,
        VENUE_NODE_ID: "venue-test-1",
        SYNC_PEER_URL: "https://cloud.example.com",
        SYNC_SHARED_SECRET: "s3cret",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

describe("docker-compose.venue.yml", () => {
  it("passes no IAP settings and mounts /dev/null without VENUE_SA_KEY", () => {
    const api = composeConfig().services.api;
    assert.equal(api.environment.SYNC_GOOGLE_AUDIENCE, "");
    assert.ok(!api.environment.GOOGLE_APPLICATION_CREDENTIALS);
    const mount = api.volumes.find((v) => v.target === "/run/secrets/venue-sa.json");
    assert.equal(mount.source, "/dev/null");
    assert.equal(mount.read_only, true);
  });

  it("wires the audience and the key file when VENUE_SA_KEY is set (BLD-03)", () => {
    const api = composeConfig({
      VENUE_SA_KEY: "/srv/oxygen/venue-sa.json",
      SYNC_GOOGLE_AUDIENCE: "123-abc.apps.googleusercontent.com",
    }).services.api;
    assert.equal(api.environment.SYNC_GOOGLE_AUDIENCE, "123-abc.apps.googleusercontent.com");
    assert.equal(api.environment.GOOGLE_APPLICATION_CREDENTIALS, "/run/secrets/venue-sa.json");
    const mount = api.volumes.find((v) => v.target === "/run/secrets/venue-sa.json");
    assert.equal(mount.source, "/srv/oxygen/venue-sa.json");
    assert.equal(mount.read_only, true);
  });

  it("has a migrate service built like the api that runs prisma migrate deploy once (DB-32)", () => {
    const { migrate, api } = composeConfig().services;
    assert.equal(migrate.restart, "no");
    assert.deepEqual(migrate.build, api.build);
    assert.equal(migrate.build.target, "api");
    assert.equal(migrate.depends_on.postgres.condition, "service_healthy");
    assert.match(migrate.command.join(" "), /cd packages\/api && node_modules\/\.bin\/prisma migrate deploy/);
    assert.equal(migrate.environment.DATABASE_URL, api.environment.DATABASE_URL);
    assert.equal(api.depends_on.migrate.condition, "service_completed_successfully");
    assert.equal(api.depends_on.postgres.condition, "service_healthy");
  });

  it("health-checks the api on /ready and makes web wait for it (BLD-09)", () => {
    const { api, web } = composeConfig().services;
    assert.match(api.healthcheck.test.join(" "), /127\.0\.0\.1:3001\/ready/);
    assert.doesNotMatch(api.healthcheck.test.join(" "), /\/health\b/);
    assert.equal(web.depends_on.api.condition, "service_healthy");
  });

  it("keeps the backup service and the process time zone (packages 14 and 8)", () => {
    const { backup, api } = composeConfig().services;
    assert.ok(backup, "backup service");
    assert.match(backup.entrypoint.join(" "), /pg-backup\.sh/);
    assert.equal(api.environment.TZ, "Europe/Stockholm");
  });

  it("no longer tells the operator to exec pnpm in the api container (DB-32)", () => {
    const text = readFileSync(path.join(ROOT, "docker-compose.venue.yml"), "utf8");
    assert.doesNotMatch(text, /exec api\s*\\?\s*pnpm|exec\s+api\s+pnpm/);
    const runbook = readFileSync(path.join(ROOT, "docs/ops/venue-runbook.md"), "utf8");
    assert.doesNotMatch(runbook, /exec api\s*\\?\s*\n?\s*pnpm|exec api pnpm/);
  });
});

describe("Dockerfile", () => {
  it("runs the api stage (and so cloud) as the node user, with no HEALTHCHECK (BLD-09)", () => {
    const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    const start = dockerfile.indexOf("FROM base AS api");
    const end = dockerfile.indexOf("FROM nginx:alpine AS web");
    const stage = dockerfile.slice(start, end);
    assert.match(stage, /^USER node$/m);
    assert.ok(stage.indexOf("USER node") < stage.indexOf('CMD ["node"'), "USER before CMD");
    assert.match(stage, /^ENV TZ=Europe\/Stockholm$/m);
    assert.doesNotMatch(dockerfile, /^HEALTHCHECK/m);
    const cloud = dockerfile.slice(dockerfile.indexOf("FROM api AS cloud"));
    assert.doesNotMatch(cloud, /^USER root/m);
  });
});
