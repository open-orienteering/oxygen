/**
 * A GPS route straight in the E2E database (like `event-map-pin.ts`): no API
 * writes `routes` (Livelox sync fills it), so the Tracks page's tests insert
 * one. `reseed()` deletes the event and its routes with it.
 */
import { Client } from "pg";

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  `postgresql://oxygen:oxygen@localhost:5433/${process.env.E2E_DB_NAME ?? "oxygen_e2e"}?schema=oxygen`;

/** Inserts a route for the event `nameId` through `waypoints` (WGS 84, `t` ms from the first); returns its id. */
export async function insertGpsRoute(nameId: string, waypoints: { lat: number; lng: number }[]): Promise<number> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO oxygen, public");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO routes (event_id, source_type, color, waypoints)
       VALUES ((SELECT id FROM events WHERE name_id = $1), 'livelox', '', $2::jsonb) RETURNING id::text AS id`,
      [nameId, JSON.stringify(waypoints.map((w, i) => ({ ...w, t: i * 5000 })))],
    );
    return Number(rows[0].id);
  } finally {
    await client.end();
  }
}
