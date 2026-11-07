import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("published-image demo", () => {
  it("uses one selected GHCR image for migrations and the app", () => {
    const image =
      "ghcr.io/open-orienteering/oxygen:sha-0123456789abcdef0123456789abcdef01234567";
    const result = spawnSync(
      "docker",
      ["compose", "-f", "docker-compose.release.yml", "config", "--format", "json"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, OXYGEN_IMAGE: image, OXYGEN_PORT: "18080" },
      },
    );
    assert.equal(result.status, 0, result.stderr);

    const config = JSON.parse(result.stdout);
    assert.equal(config.services.migrate.image, image);
    assert.equal(config.services.oxygen.image, image);
    assert.equal(config.services.oxygen.ports[0].published, "18080");
  });

  it("requires neither pnpm nor a source image build", () => {
    const script = readFileSync(path.join(ROOT, "scripts/demo.sh"), "utf8");
    const commands = script
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    assert.match(script, /docker-compose\.release\.yml/);
    assert.match(script, /ghcr\.io\/open-orienteering\/oxygen:edge/);
    assert.doesNotMatch(commands, /\bpnpm\b/);
    assert.doesNotMatch(commands, /docker compose .*--build/);
  });

  it("loads the showcase with the image's own re-match CLI, no host Node (docs/demo.md)", () => {
    const loader = readFileSync(path.join(ROOT, "scripts/load-showcase.sh"), "utf8");
    const dockerBranch = loader.slice(loader.indexOf("# ─── 4. Import and pin the map"), loader.indexOf("# ─── 5. Smoke check"));
    const [whenDocker] = dockerBranch.split("\nelse\n");
    assert.match(whenDocker, /docker compose exec -T "\$API_SERVICE" node packages\/api\/dist\/cli\/map-rematch\.js --event demo_competition/);
    assert.doesNotMatch(whenDocker, /\bpnpm\b|\bnode scripts\//);
    assert.match(loader, /docker-compose\.release\.yml"\* ]]; then\n  API_SERVICE="\$\{API_SERVICE:-oxygen\}"/);
    // The CLI the image runs is built from packages/api/src (docs/map-storage.md §6.9).
    assert.ok(existsSync(path.join(ROOT, "packages/api/src/cli/map-rematch.ts")));
    // The source row travels on psql's stdin; the map file is the committed one.
    assert.match(loader, /decode\('[^\n]*\n\s*base64 < "\$MAP_FILE"/);
    assert.match(loader, /puit-de-laven-demo\.omap/);
  });

  it("installs OpenSSL before Prisma dependencies", () => {
    const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
    const depsStage = dockerfile.slice(
      dockerfile.indexOf("FROM node:20-slim AS base"),
      dockerfile.indexOf("FROM deps AS build"),
    );
    assert.match(depsStage, /apt-get install[^]*\bopenssl\b/);
    assert.ok(
      depsStage.indexOf("apt-get install") < depsStage.indexOf("pnpm install"),
      "OpenSSL must exist when Prisma chooses its schema-engine target",
    );
  });
});
