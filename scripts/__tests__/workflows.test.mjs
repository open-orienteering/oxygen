import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.github/workflows");
const load = (name) => parse(readFileSync(path.join(DIR, name), "utf8"));
const steps = (wf, job) => wf.jobs[job].steps;
const stepNamed = (wf, job, re) => {
  const s = steps(wf, job).find((x) => re.test(x.name ?? ""));
  assert.ok(s, `step ${re} in ${job}`);
  return s;
};
const index = (wf, job, re) => steps(wf, job).findIndex((x) => re.test(x.name ?? ""));

describe("ci.yml", () => {
  const ci = load("ci.yml");

  it("gives each push its own concurrency group and cancels only superseded PR runs (BLD-06)", () => {
    assert.equal(
      ci.concurrency.group,
      "ci-${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
    );
    assert.equal(ci.concurrency["cancel-in-progress"], true);
  });

  it("boots the loaded image through demo.sh on its own project and port, then cleans up (BLD-05)", () => {
    const build = steps(ci, "image").find((s) => s.uses?.startsWith("docker/build-push-action"));
    assert.equal(build.with.load, true);
    assert.equal(build.with.push, false);
    const smoke = stepNamed(ci, "image", /boots against Postgres/);
    assert.equal(smoke.run.trim(), "bash scripts/demo.sh");
    assert.equal(smoke.env.OXYGEN_IMAGE, build.with.tags);
    assert.equal(smoke.env.OXYGEN_PULL_POLICY, "never");
    assert.equal(smoke.env.OXYGEN_PORT, "18080");
    assert.equal(smoke.env.COMPOSE_PROJECT_NAME, "oxygen-pr-smoke");
    const cleanup = stepNamed(ci, "image", /Clean up smoke/);
    assert.equal(cleanup.if, "always()");
    assert.match(cleanup.run, /docker compose -f docker-compose\.release\.yml down -v/);
    assert.equal(cleanup.env.COMPOSE_PROJECT_NAME, "oxygen-pr-smoke");
    assert.ok(index(ci, "image", /boots against/) < index(ci, "image", /Clean up smoke/));
  });

  it("asserts the image does not run as root (BLD-09)", () => {
    const step = stepNamed(ci, "image", /unprivileged/);
    assert.match(step.run, /--entrypoint id oxygen-smoke:ci -u\)" != 0/);
  });

  it("publishes only after the image job", () => {
    assert.ok(ci.jobs.publish.needs.includes("image"));
  });
});

describe("publish.yml", () => {
  const publish = load("publish.yml");
  const text = readFileSync(path.join(DIR, "publish.yml"), "utf8");

  it("the build pushes only the sha tag, never edge (BLD-05)", () => {
    const meta = stepNamed(publish, "ghcr", /Resolve tags/);
    assert.doesNotMatch(meta.run, /:edge/);
    const build = steps(publish, "ghcr").find((s) => s.uses?.startsWith("docker/build-push-action"));
    assert.doesNotMatch(build.with.tags, /edge/);
  });

  it("tags verified-sha after the smoke, then edge only behind the guard, in that order", () => {
    const smoke = index(publish, "ghcr", /Smoke-test/);
    const verified = index(publish, "ghcr", /verified/);
    const edge = index(publish, "ghcr", /Move edge/);
    assert.ok(smoke >= 0 && smoke < verified && verified < edge);
    const v = stepNamed(publish, "ghcr", /verified/).run;
    assert.match(v, /imagetools create/);
    assert.match(v, /:verified-\$\{\{ steps\.meta\.outputs\.sha_tag \}\}/);
    const e = stepNamed(publish, "ghcr", /Move edge/).run;
    assert.match(e, /git fetch --no-tags origin main/);
    assert.match(e, /if verdict="\$\(node scripts\/edge-guard\.mjs "\$\{GITHUB_SHA\}" origin\/main\)"/);
    assert.match(e, /--tag "\$\{IMAGE\}:edge"/);
    // Nothing before the guard step mentions edge as a tag to push.
    assert.equal(text.split("Move edge")[0].includes(":edge\""), false);
  });

  it("checks out enough history for the guard", () => {
    const checkout = steps(publish, "ghcr").find((s) => s.uses?.startsWith("actions/checkout"));
    assert.equal(checkout.with["fetch-depth"], 0);
  });
});

describe("release.yml", () => {
  const release = load("release.yml");
  it("promotes only a verified-sha image and says the smoke has not passed (BLD-05)", () => {
    const promote = stepNamed(release, "release", /Promote/);
    assert.match(promote.run, /SOURCE="\$\{IMAGE\}:verified-\$\{SHA_TAG\}"/);
    assert.match(promote.run, /the image smoke has not passed for commit/);
  });
});
