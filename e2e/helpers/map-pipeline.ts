/**
 * The map pipeline switch in E2E (docs/map-pipeline-switch.md §5).
 *
 * `setMapPipeline` writes `events.map_pipeline` for every event in the
 * E2E database and `map.pipeline.default` for the ones created later,
 * straight through Postgres like `reseed()`. `test` is Playwright's test
 * with a `mapPipeline` option: `playwright.config.ts` runs the specs in
 * `MAP_PIPELINE_SPECS` once per value (projects `map-legacy` and
 * `map-vector`), and the auto fixture applies the project's value before
 * every test — after the spec's `beforeAll(reseed)`, so freshly seeded
 * events get it too — and puts everything back to `legacy` after it, so
 * nothing leaks into the next spec. The E2E API runs with
 * `MAP_PIPELINE_FLAGS_TTL_MS=0`, so an event a test creates through the UI
 * takes the project's value too.
 */
import { test as base } from "@playwright/test";
import { Client } from "pg";

export type MapPipeline = "legacy" | "vector";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  `postgresql://oxygen:oxygen@localhost:5433/${process.env.E2E_DB_NAME ?? "oxygen_e2e"}?schema=oxygen`;

export async function setMapPipeline(pipeline: MapPipeline, nameId?: string): Promise<void> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO oxygen, public");
    if (nameId) {
      await client.query("UPDATE events SET map_pipeline = $1 WHERE name_id = $2", [pipeline, nameId]);
      return;
    }
    await client.query("UPDATE events SET map_pipeline = $1", [pipeline]);
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('map.pipeline.default', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [pipeline],
    );
  } finally {
    await client.end();
  }
}

export const test = base.extend<{ mapPipeline: MapPipeline; applyMapPipeline: void }>({
  mapPipeline: ["legacy", { option: true }],
  applyMapPipeline: [
    async ({ mapPipeline }, use) => {
      await setMapPipeline(mapPipeline);
      await use();
      if (mapPipeline !== "legacy") await setMapPipeline("legacy");
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
