/**
 * Who has a course open (docs/course-layer.md §7 "Presence and live
 * refresh"; D11). A heartbeat upserts one row per open editor; a row older
 * than the TTL is neither shown nor kept. A table, not process memory: up to
 * two Cloud Run instances serve one event.
 */

import { decodeHlc } from "@oxygen/shared";
import type { PrismaClient } from "./generated/prisma/client.js";

export const PRESENCE_TTL_MS = 30_000;

export type PresenceMode = "course" | "layout" | "field";

export interface PresenceRow {
  courseId: number;
  courseName: string;
  name: string;
  mode: PresenceMode;
}

export async function touchPresence(
  db: PrismaClient,
  args: { eventId: bigint; courseUuid: string; clientId: string; mode: PresenceMode; userId: string | null; name: string },
): Promise<void> {
  const now = new Date();
  // A client has one course open at a time: its older rows go with the switch.
  await db.coursePresence.deleteMany({
    where: {
      eventId: args.eventId,
      OR: [{ clientId: args.clientId, courseId: { not: args.courseUuid } }, { seenAt: { lt: new Date(now.getTime() - PRESENCE_TTL_MS) } }],
    },
  });
  const data = { eventId: args.eventId, userId: args.userId, name: args.name, mode: args.mode, seenAt: now };
  await db.coursePresence.upsert({
    where: { courseId_clientId: { courseId: args.courseUuid, clientId: args.clientId } },
    create: { courseId: args.courseUuid, clientId: args.clientId, ...data },
    update: data,
  });
}

/** Everyone but `clientId` with a live row in the event, oldest course first. */
export async function othersPresent(db: PrismaClient, eventId: bigint, clientId: string): Promise<PresenceRow[]> {
  const rows = await db.coursePresence.findMany({
    where: { eventId, clientId: { not: clientId }, seenAt: { gte: new Date(Date.now() - PRESENCE_TTL_MS) }, course: { removed: false } },
    include: { course: { select: { seq: true, name: true } } },
    orderBy: [{ seenAt: "asc" }],
  });
  return rows.map((r) => ({ courseId: r.course.seq, courseName: r.course.name, name: r.name, mode: r.mode as PresenceMode }));
}

/**
 * Who last wrote a course or control and when ("moved by X at T"): the actor
 * and clock of the row's newest `*.upserted` journal entry. `name` is empty
 * when the write had no signed-in user. Null when the journal has none.
 */
export async function lastWriter(
  db: PrismaClient,
  eventId: bigint,
  type: "course.upserted" | "control.upserted",
  rowUuid: string,
): Promise<{ name: string; at: string } | null> {
  const entry = await db.journalEntry.findFirst({
    where: { eventId, type, payload: { path: ["id"], equals: rowUuid } },
    orderBy: { hlc: "desc" },
    select: { actorId: true, hlc: true, clientTimestamp: true },
  });
  if (!entry) return null;
  const actor = entry.actorId ? await db.user.findUnique({ where: { id: entry.actorId }, select: { displayName: true, email: true } }) : null;
  return {
    name: actor ? actor.displayName || actor.email : "",
    at: new Date(decodeHlc(entry.hlc).physical || entry.clientTimestamp.getTime()).toISOString(),
  };
}
