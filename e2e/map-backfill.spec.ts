/**
 * Map document backfill from the Maintenance tab (docs/map-storage.md
 * §6.7): a club-library row from before the document pipeline is listed
 * as pending, one click imports it into a series + version, and the card
 * reports the outcome.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Client } from "pg";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  `postgresql://oxygen:oxygen@localhost:5433/${process.env.E2E_DB_NAME ?? "oxygen_e2e"}?schema=oxygen`;
const NAME = `E2E_backfill_${Date.now()}`;

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO oxygen, public");
    return await fn(client);
  } finally {
    await client.end();
  }
}

test.describe("Map backfill", () => {
  let rowId: string;

  test.beforeAll(async () => {
    // A legacy row: bytes only — no file_hash, no series. The trailer keeps
    // its hash distinct from every other fixture upload in the suite.
    const bytes = Buffer.concat([readFileSync("e2e/test.ocd"), Buffer.from(NAME)]);
    rowId = await withDb(async (c) => {
      const r = await c.query<{ id: string }>(
        "INSERT INTO club_map_files (name, file_name, file_data, size_bytes) VALUES ($1, $2, $3, $4) RETURNING id",
        [NAME, "legacy.ocd", bytes, bytes.byteLength],
      );
      return r.rows[0].id;
    });
  });

  test.afterAll(async () => {
    await withDb(async (c) => {
      await c.query("DELETE FROM club_maps WHERE id IN (SELECT club_map_id FROM club_map_files WHERE id = $1)", [rowId]);
      await c.query("DELETE FROM club_map_files WHERE id = $1", [rowId]);
    });
  });

  test("the Maintenance tab lists the pending row and imports it on request", async ({ page }) => {
    await page.goto("/settings?tab=maintenance");
    const card = page.getByTestId("map-backfill-card");
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("map-backfill-pending")).toContainText(/club map/);
    await expect(page.getByTestId("map-backfill-pending")).not.toContainText("Every map has a document");

    await page.getByTestId("map-backfill-run").click();
    const result = page.getByTestId("map-backfill-result");
    await expect(result).toBeVisible({ timeout: 60000 });
    await expect(result).toContainText(/^Imported \d+, failed \d+ of \d+\.$/);

    // The row now has a series with one version pinned to a stored document.
    const after = await withDb((c) =>
      c.query<{ club_map_id: string | null; versions: string; file_hash: string | null }>(
        `SELECT f.club_map_id, f.file_hash,
                (SELECT count(*) FROM club_map_versions v WHERE v.club_map_id = f.club_map_id) AS versions
           FROM club_map_files f WHERE f.id = $1`,
        [rowId],
      ),
    );
    expect(after.rows[0].club_map_id).not.toBeNull();
    expect(after.rows[0].file_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(after.rows[0].versions).toBe("1");

    // Reloading shows the row is no longer pending.
    await page.reload();
    await expect(page.getByTestId("map-backfill-card")).toBeVisible({ timeout: 15000 });
    const pending = page.getByTestId("map-backfill-pending");
    await expect(pending).toBeVisible();
    const text = (await pending.textContent()) ?? "";
    const clubs = /^(\d+) club map/.exec(text);
    if (clubs) expect(Number(clubs[1])).toBe(0);
  });
});
