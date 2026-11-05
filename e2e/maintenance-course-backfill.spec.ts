/**
 * Course structure backfill from the Maintenance tab (docs/course-layer.md
 * §6.4): a course from before structures existed (`structure` NULL) is
 * listed as pending, one click fills it, and the card reports the outcome.
 */
import { test, expect } from "@playwright/test";
import { Client } from "pg";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  `postgresql://oxygen:oxygen@localhost:5433/${process.env.E2E_DB_NAME ?? "oxygen_e2e"}?schema=oxygen`;
const NAME = `E2E_structure_backfill_${Date.now()}`;

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

test.describe("Course structure backfill", () => {
  let courseId: string;

  test.beforeAll(async () => {
    courseId = await withDb(async (c) => {
      const ev = await c.query<{ id: string }>("SELECT id FROM events WHERE removed = false ORDER BY id LIMIT 1");
      const r = await c.query<{ id: string }>(
        "INSERT INTO courses (event_id, name, geometry_source) VALUES ($1, $2, 'editor') RETURNING id",
        [ev.rows[0].id, NAME],
      );
      return r.rows[0].id;
    });
  });

  test.afterAll(async () => {
    await withDb((c) => c.query("DELETE FROM courses WHERE id = $1", [courseId]));
  });

  test("the Maintenance tab lists the pending course and fills it on request", async ({ page }) => {
    await page.goto("/settings?tab=maintenance");
    await expect(page.getByTestId("structure-backfill-card")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("structure-backfill-pending")).toContainText(/course\(s\) still need a structure/);

    await page.getByTestId("structure-backfill-run").click();
    const result = page.getByTestId("structure-backfill-result");
    await expect(result).toBeVisible({ timeout: 60000 });
    await expect(result).toContainText(/^Filled \d+, failed 0 of \d+\.$/);

    const row = await withDb((c) => c.query<{ structure: unknown }>("SELECT structure FROM courses WHERE id = $1", [courseId]));
    expect(row.rows[0].structure).not.toBeNull();
    await expect(page.getByTestId("structure-backfill-pending")).toContainText("Every course has a structure.");
  });
});
