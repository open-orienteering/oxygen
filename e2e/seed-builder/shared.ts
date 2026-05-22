/**
 * Shared helpers for the E2E seed builders.
 *
 * All builders share one PrismaClient instance per process. They write to
 * the database pointed at by DATABASE_URL (set by global-setup to the
 * dedicated `oxygen_e2e` database on :5433).
 */
import { PrismaClient, RunnerStatus as PgRunnerStatus } from "@prisma/client";

export type PgRunnerStatusLiteral = `${PgRunnerStatus}`;

export const ZERO_TIME_DS = 324000; // 09:00:00 in deciseconds
export const ZERO_TIME_SECS = ZERO_TIME_DS / 10;

/**
 * Convert an absolute decisecond value to ZeroTime-relative deciseconds,
 * preserving the legacy MeOS sentinels (0 and 1 keep their meaning).
 */
export function toRel(absDs: number): number {
  return absDs > 1 ? absDs - ZERO_TIME_DS : absDs;
}

/**
 * Convert a MeOS punch string from absolute seconds (e.g. "67-45929.0")
 * to ZeroTime-relative seconds. The format the old seed produced is the
 * same format `parsePunches` reads back (seconds + tenths), so we keep
 * that representation for Card.punchesRaw.
 */
export function toRelPunches(punchStr: string): string {
  if (!punchStr) return punchStr;
  return punchStr.replace(/(\d+)-(\d+)\.(\d)/g, (_m, type, secs, tenths) => {
    const relSecs = parseInt(secs, 10) - ZERO_TIME_SECS;
    return `${type}-${relSecs}.${tenths}`;
  });
}

/**
 * Convert a MeOS-style punch string to the JSONB array shape stored in
 * card_readouts.punches: `[{ controlCode, time, subSecond? }, ...]` where
 * `time` is absolute deciseconds since midnight.
 */
export function punchStringToJsonb(
  punchStr: string,
): Array<{ controlCode: number; time: number; subSecond?: number }> {
  if (!punchStr) return [];
  const out: Array<{ controlCode: number; time: number; subSecond?: number }> =
    [];
  for (const part of punchStr.split(";").filter(Boolean)) {
    const dash = part.indexOf("-");
    if (dash < 0) continue;
    const type = parseInt(part.substring(0, dash), 10);
    const timeStr = part.substring(dash + 1);
    const dot = timeStr.indexOf(".");
    let time: number;
    let sub: number | undefined;
    if (dot >= 0) {
      const secs = parseInt(timeStr.substring(0, dot), 10);
      const tenths = parseInt(timeStr.substring(dot + 1), 10) || 0;
      time = secs * 10 + tenths;
      if (tenths) sub = tenths;
    } else {
      time = parseInt(timeStr, 10) * 10;
    }
    if (!Number.isNaN(type) && !Number.isNaN(time)) {
      out.push({ controlCode: type, time, ...(sub !== undefined ? { subSecond: sub } : {}) });
    }
  }
  return out;
}

/** Build a Prisma client bound to the current DATABASE_URL. */
export function newPrisma(): PrismaClient {
  guardDatabaseUrl();
  return new PrismaClient();
}

/**
 * Refuse to run against the developer's working DB. The seed wipes &
 * recreates events, so a misconfigured run would clobber real work.
 *
 * Allowed: any URL whose port is NOT 5432 OR whose host is not local.
 * In practice, `e2e/global-setup.ts` always points us at
 * postgresql://oxygen:oxygen@localhost:5433/oxygen_e2e?schema=oxygen.
 */
function guardDatabaseUrl(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "[e2e-seed] DATABASE_URL not set. Refusing to run — set it explicitly to the test DB URL.",
    );
  }
  try {
    const parsed = new URL(url);
    const port = parsed.port || "5432";
    const hostIsLocal =
      parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (hostIsLocal && port === "5432") {
      throw new Error(
        `[e2e-seed] Refusing to run: DATABASE_URL points at port 5432 (developer's working DB). ` +
          `Expected the dedicated E2E DB on port 5433.`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("[e2e-seed]")) throw err;
    // URL parsing failed — fall through. If DATABASE_URL is malformed,
    // PrismaClient will fail anyway and give a clearer error.
  }
}

/**
 * MeOS RunnerStatus numeric → new PG enum literal.
 *   0  unknown
 *   1  ok
 *   2  no_timing (NotCompeting was distinct in MeOS but mapped here)
 *   3  missing_punch (MP)
 *   4  dnf
 *   5  dq
 *   6  over_max_time
 *   15 out_of_competition
 *   20 dns
 *   21 cancel  (also old "100" / "Cancel" sentinel)
 *   99 not_competing
 */
export function meosStatusToEnum(s: number): PgRunnerStatusLiteral {
  switch (s) {
    case 1:
      return "ok";
    case 2:
      return "no_timing";
    case 3:
      return "missing_punch";
    case 4:
      return "dnf";
    case 5:
      return "dq";
    case 6:
      return "over_max_time";
    case 15:
      return "out_of_competition";
    case 20:
      return "dns";
    case 21:
    case 100:
      return "cancel";
    case 50:
    case 99:
      return "not_competing";
    default:
      return "unknown";
  }
}

/**
 * Wipe any existing event with the given nameId (cascades to all children)
 * and create a fresh one with sensible defaults.
 */
export async function recreateEvent(
  prisma: PrismaClient,
  data: {
    nameId: string;
    name: string;
    date: string;
    annotation?: string;
    zeroTime?: number;
  },
): Promise<{ id: bigint }> {
  await prisma.event.deleteMany({ where: { nameId: data.nameId } });
  const row = await prisma.event.create({
    data: {
      nameId: data.nameId,
      name: data.name,
      annotation: data.annotation ?? "",
      date: new Date(data.date),
      zeroTime: data.zeroTime ?? ZERO_TIME_DS,
    },
    select: { id: true },
  });
  return { id: row.id };
}
