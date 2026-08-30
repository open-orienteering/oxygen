import type { AuthUser } from "./auth.js";
import type { Capability } from "@oxygen/shared";
import {
  ALL_CAPABILITIES,
  SYSTEM_GROUP_IDS,
  isCapability,
} from "@oxygen/shared";
import type { PrismaClient, Prisma } from "./generated/prisma/client.js";

export { ALL_CAPABILITIES, SYSTEM_GROUP_IDS };

export type { Capability };

export function parseCapabilities(json: unknown): Capability[] {
  if (!Array.isArray(json)) return [];
  return json.filter(isCapability);
}

/**
 * `event.date` is a calendar date; compare as YYYY-MM-DD in local time.
 * Past dates are completed. Race day (today) is not, unless results exist.
 */
export function isEventCompleted(
  eventDate: string,
  finishedCount: number,
): boolean {
  const today = localDateString(new Date());
  const day = eventDate.slice(0, 10);
  return day < today || finishedCount > 0;
}

export function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function eventDateString(d: Date): string {
  return localDateString(d);
}

export function effectiveCapabilities(args: {
  user: AuthUser | null;
  grants: Capability[][];
  eventCompleted: boolean;
  authEnabled: boolean;
}): Set<Capability> {
  if (!args.authEnabled) return new Set(ALL_CAPABILITIES);
  if (!args.user) return new Set();
  if (args.user.isAdmin) return new Set(ALL_CAPABILITIES);

  const caps = new Set<Capability>();
  for (const group of args.grants) {
    for (const c of group) caps.add(c);
  }
  if (args.eventCompleted) {
    caps.add("event.view");
    caps.add("results.view");
    caps.add("courses.view");
  }
  return caps;
}

const FINISHED_STATUSES = [
  "ok",
  "missing_punch",
  "dnf",
  "dq",
  "over_max_time",
] as const;

export async function countFinishedRunners(
  db: PrismaClient | Prisma.TransactionClient,
  eventId: bigint,
): Promise<number> {
  return db.runner.count({
    where: {
      eventId,
      removed: false,
      OR: [
        { finishTime: { not: 0 } },
        { status: { in: [...FINISHED_STATUSES] } },
      ],
    },
  });
}

export async function loadGrantCapabilities(
  db: PrismaClient | Prisma.TransactionClient,
  eventId: bigint,
  userId: string,
): Promise<Capability[][]> {
  const rows = await db.eventPermission.findMany({
    where: {
      eventId,
      OR: [
        { userId },
        // Club-group grants apply to the group's current members —
        // resolved live, so membership edits take effect immediately.
        { clubGroup: { members: { some: { userId } } } },
      ],
    },
    include: { group: { select: { capabilities: true } } },
  });
  return rows.map((row) => parseCapabilities(row.group.capabilities));
}

export async function resolveEventCapabilities(args: {
  db: PrismaClient | Prisma.TransactionClient;
  eventId: bigint;
  eventDate: Date;
  user: AuthUser | null;
  authEnabled: boolean;
}): Promise<Set<Capability>> {
  if (!args.authEnabled) return new Set(ALL_CAPABILITIES);
  if (!args.user) return new Set();
  if (args.user.isAdmin) return new Set(ALL_CAPABILITIES);

  const [grants, finishedCount] = await Promise.all([
    loadGrantCapabilities(args.db, args.eventId, args.user.id),
    countFinishedRunners(args.db, args.eventId),
  ]);
  return effectiveCapabilities({
    user: args.user,
    grants,
    eventCompleted: isEventCompleted(eventDateString(args.eventDate), finishedCount),
    authEnabled: true,
  });
}

export async function grantSystemGroup(
  db: PrismaClient | Prisma.TransactionClient,
  args: {
    eventId: bigint;
    userId: string;
    groupId: string;
    grantedBy?: string | null;
  },
): Promise<void> {
  await db.eventPermission.upsert({
    where: {
      eventId_userId_groupId: {
        eventId: args.eventId,
        userId: args.userId,
        groupId: args.groupId,
      },
    },
    create: {
      eventId: args.eventId,
      userId: args.userId,
      groupId: args.groupId,
      grantedBy: args.grantedBy ?? null,
    },
    update: {},
  });
}
