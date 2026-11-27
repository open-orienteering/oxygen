import { Client } from "pg";
import { E2E_DATABASE_URL } from "./reseed";

/**
 * Change the card number of the runner holding `from` in event `nameId`,
 * straight in Postgres like `reseed()`.
 *
 * The seed runners hold SI5/SI6 numbers (e.g. 501438). The app reads those
 * cards as detection only: no punches, no finish. Such a read of a runner with
 * a stored result is held by the readout guard ("no-finish", a "Replace
 * result?" banner instead of the card notification), and without a result it
 * resolves to "pre-start". A spec that needs the full readout path (punches,
 * finish, "View Readout") re-numbers the runner to an SI8-range card the mock
 * reader reads in full, and puts the number back afterwards.
 */
export async function setRunnerCardNo(nameId: string, from: number, to: number): Promise<void> {
  const client = new Client({ connectionString: E2E_DATABASE_URL });
  await client.connect();
  try {
    await client.query("SET search_path TO oxygen, public");
    const res = await client.query(
      `UPDATE runners SET card_no = $3
         WHERE card_no = $2 AND removed = false
           AND event_id = (SELECT id FROM events WHERE name_id = $1)`,
      [nameId, from, to],
    );
    // Idempotent: a second call (or a retried test) finds the number already set.
    if (res.rowCount === 0) {
      const done = await client.query(
        `SELECT 1 FROM runners
           WHERE card_no = $2 AND removed = false
             AND event_id = (SELECT id FROM events WHERE name_id = $1)`,
        [nameId, to],
      );
      if (done.rowCount === 1) return;
    }
    if (res.rowCount !== 1) throw new Error(`setRunnerCardNo: ${res.rowCount} runners for card ${from}`);
  } finally {
    await client.end();
  }
}
