/**
 * F12 (docs/course-layer.md §3.6): a sheet's legacy map-anchored layout
 * objects, written straight into the E2E database (the API refuses them
 * since F12), then moved by the F12 migration file run as Prisma runs it —
 * one transaction. The migration is idempotent, so running it again on the
 * migrated E2E database moves exactly what was just seeded.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  `postgresql://oxygen:oxygen@localhost:5433/${process.env.E2E_DB_NAME ?? "oxygen_e2e"}?schema=oxygen`;

const F12 = resolve("packages/api/prisma/migrations/20261109120000_map_anchored_objects_to_course_objects/migration.sql");

/**
 * Write `objects` (pre-F12 shape, `anchor: "map"`) onto the event's sheet `sheetSeq`, run the F12 migration, and
 * return what the sheet keeps afterwards.
 */
export async function migrateLegacySheetObjects(nameId: string, sheetSeq: number, objects: unknown[]): Promise<unknown[]> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    const sheet = `SELECT m.id FROM oxygen.course_maps m JOIN oxygen.events e ON e.id = m.event_id WHERE e.name_id = $1 AND m.seq = $2`;
    const { rowCount } = await client.query(`UPDATE oxygen.course_maps SET objects = $3::jsonb WHERE id = (${sheet})`, [nameId, sheetSeq, JSON.stringify(objects)]);
    if (rowCount !== 1) throw new Error(`no sheet ${sheetSeq} in ${nameId}`);
    await client.query("BEGIN");
    try {
      await client.query(readFileSync(F12, "utf8"));
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    const { rows } = await client.query<{ objects: unknown[] }>(`SELECT objects FROM oxygen.course_maps WHERE id = (${sheet})`, [nameId, sheetSeq]);
    return rows[0].objects;
  } finally {
    await client.end();
  }
}
