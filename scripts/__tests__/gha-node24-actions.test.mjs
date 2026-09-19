import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.github/workflows",
);

/**
 * Action major pins that still declare `runs.using: node20`. GitHub hosted
 * runners now force those onto Node 24 and warn on every job.
 */
const NODE20_ACTION_PINS = [
  "pnpm/action-setup@v4",
  "actions/github-script@v7",
  "actions/upload-artifact@v4",
  "actions/upload-artifact@v5",
  "docker/setup-qemu-action@v3",
  "docker/setup-buildx-action@v3",
  "docker/login-action@v3",
  "docker/build-push-action@v6",
];

function workflowUses(contents) {
  return [...contents.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1]);
}

describe("GitHub Actions Node 24 runtimes", () => {
  it("does not pin JavaScript actions that still target Node 20", () => {
    const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml"));
    assert.ok(files.length > 0, "expected workflow files");

    const hits = [];
    for (const file of files) {
      const uses = workflowUses(
        readFileSync(path.join(WORKFLOWS_DIR, file), "utf8"),
      );
      for (const pin of uses) {
        if (NODE20_ACTION_PINS.includes(pin)) {
          hits.push(`${file}: ${pin}`);
        }
      }
    }

    assert.deepEqual(hits, []);
  });
});
