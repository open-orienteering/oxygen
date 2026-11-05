/**
 * The map pipeline switch in E2E (docs/map-pipeline-switch.md §5).
 *
 * The stack's default is `vector` (slice E2): the seed builders write every
 * seed event `vector` and seed `map.pipeline.default = vector` and
 * `map.editor.vector = true` (`e2e/seed-builder/shared.ts`
 * `seedMapDefaults`), so a spec that sets nothing runs on the GL viewer and
 * the new course editor. `setMapPipeline` writes `events.map_pipeline` for
 * every event in the E2E database and `map.pipeline.default` for the ones
 * created later, straight through Postgres like `reseed()`. `test` is
 * Playwright's test with a `mapPipeline` option: `playwright.config.ts`
 * runs the specs in `MAP_PIPELINE_SPECS` once per value (projects
 * `map-legacy` and `map-vector`), and the auto fixture applies the
 * project's value before every test — after the spec's `beforeAll(reseed)`,
 * so freshly seeded events get it too — and puts the stack default back
 * after it, so nothing leaks into the next spec. The E2E API runs with
 * `MAP_PIPELINE_FLAGS_TTL_MS=0`, so an event a test creates through the UI
 * takes the project's value too. A spec about `legacy` sets it itself and
 * calls `restoreMapDefaults()` when done.
 */
import { test as base } from "@playwright/test";
import { Client } from "pg";

export type MapPipeline = "legacy" | "vector";

/** The stack's default pipeline (`seedMapDefaults` in `e2e/seed-builder/shared.ts`). */
export const DEFAULT_MAP_PIPELINE: MapPipeline = "vector";

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

/** Write `map.pipeline.allowLegacy`; `null` removes it (= allowed). */
export async function setAllowLegacy(allow: boolean | null): Promise<void> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO oxygen, public");
    if (allow === null) {
      await client.query("DELETE FROM settings WHERE key = 'map.pipeline.allowLegacy'");
      return;
    }
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('map.pipeline.allowLegacy', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(allow)],
    );
  } finally {
    await client.end();
  }
}

/**
 * Write `map.editor.vector`, the new course editor's temporary gate
 * (docs/map-pipeline-switch.md §1, §3.6); `null` puts back the stack's
 * default (on, as seeded).
 */
export async function setEditorVector(on: boolean | null): Promise<void> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO oxygen, public");
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('map.editor.vector', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [String(on ?? true)],
    );
  } finally {
    await client.end();
  }
}

/** Every event, the pipeline default and the editor flag back to the stack's defaults. */
export async function restoreMapDefaults(): Promise<void> {
  await setMapPipeline(DEFAULT_MAP_PIPELINE);
  await setAllowLegacy(null);
  await setEditorVector(null);
}

export const test = base.extend<{ mapPipeline: MapPipeline; applyMapPipeline: void }>({
  mapPipeline: [DEFAULT_MAP_PIPELINE, { option: true }],
  applyMapPipeline: [
    async ({ mapPipeline }, use) => {
      await setMapPipeline(mapPipeline);
      await use();
      if (mapPipeline !== DEFAULT_MAP_PIPELINE) await setMapPipeline(DEFAULT_MAP_PIPELINE);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
