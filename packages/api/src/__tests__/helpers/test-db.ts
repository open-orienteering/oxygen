/**
 * Test database helpers for API integration tests.
 *
 * The new Oxygen layout uses a single Postgres database with all tables
 * under the `oxygen` schema; per-event entities are scoped by `event_id`.
 * Test isolation is therefore achieved by giving each suite its own
 * `Event` row inside the dedicated test container (port 5433) and
 * cascading the cleanup via `ON DELETE CASCADE`.
 *
 * Anything globally-scoped (`settings`, `runner_directory`,
 * `club_directory`, `eventor_event_meta`) is the caller's responsibility
 * to clean up. Suites that touch those should snapshot/restore around
 * their assertions.
 */

import { randomBytes } from "crypto";
import { prisma, disconnectAll, type EventRef } from "../../db.js";
import type { PrismaClient } from "@prisma/client";

export interface TestEventContext {
  /** Resolved EventRef ready to pass to makeCaller. */
  event: EventRef;
  /** Shared Prisma singleton — use for fixture seeding. */
  db: PrismaClient;
  /** Internal numeric event id. */
  eventId: bigint;
  /** URL slug of the test event. */
  nameId: string;
  /** Drop the event row (cascades to all children) + close the client. */
  cleanup: () => Promise<void>;
}

/**
 * Create a fresh test event inside the shared test DB.
 * Call in `beforeAll`; call `ctx.cleanup()` in `afterAll`.
 *
 * @param label human-readable label for the suite — embedded in the
 *   event's `nameId` so leftover rows after a crash are easy to spot.
 */
export async function createTestEvent(
  label = "test",
): Promise<TestEventContext> {
  const suffix = randomBytes(4).toString("hex");
  const nameId = `oxygen_test_${label}_${suffix}`;
  const db = prisma();

  const row = await db.event.create({
    data: {
      nameId,
      name: `Test Event ${label} ${suffix}`,
      date: new Date("2026-01-01T00:00:00Z"),
      kind: "competition",
    },
    select: { id: true, nameId: true, zeroTime: true },
  });

  const event: EventRef = {
    id: row.id,
    nameId: row.nameId,
    zeroTime: row.zeroTime,
  };

  const cleanup = async () => {
    try {
      await db.event.delete({ where: { id: row.id } });
    } catch {
      // Already gone — fine.
    }
  };

  return { event, db, eventId: row.id, nameId: row.nameId, cleanup };
}

/**
 * Suite-level disconnect. Call from a top-level `afterAll` when no
 * further DB work will happen — releases the connection pool so Vitest
 * can exit cleanly.
 */
export async function disconnect(): Promise<void> {
  await disconnectAll();
}
