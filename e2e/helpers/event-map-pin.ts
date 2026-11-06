/**
 * Take an event's map off its pinned document straight in the E2E database
 * (like `reseed()`), for the "map without a pinned document" state
 * (docs/map-rendering.md §5.4): an import still running, failed, or a map
 * from before the backfill. Returns a function that puts the pins back.
 */
import { Client } from "pg";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  `postgresql://oxygen:oxygen@localhost:5433/${process.env.E2E_DB_NAME ?? "oxygen_e2e"}?schema=oxygen`;

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO oxygen, public");
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function unpinEventMap(nameId: string): Promise<() => Promise<void>> {
  const pins = await withClient(async (client) => {
    const { rows } = await client.query<{ id: string; document_hash: string | null }>(
      `SELECT m.id::text AS id, m.document_hash FROM map_files m JOIN events e ON e.id = m.event_id WHERE e.name_id = $1`,
      [nameId],
    );
    await client.query(
      `UPDATE map_files SET document_hash = NULL WHERE event_id = (SELECT id FROM events WHERE name_id = $1)`,
      [nameId],
    );
    return rows;
  });
  return () =>
    withClient(async (client) => {
      for (const pin of pins) {
        await client.query("UPDATE map_files SET document_hash = $1 WHERE id = $2::bigint", [pin.document_hash, pin.id]);
      }
    });
}
