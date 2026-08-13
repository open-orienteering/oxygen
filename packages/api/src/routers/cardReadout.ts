/**
 * Card readout router.
 *
 * Stores raw card readouts, links them to runners, and produces a fully
 * matched result via the @oxygen/shared matcher.
 *
 * `performReadout(db, eventId, zeroTime, runnerUuid)` is the canonical
 * orchestrator — it loads runner + card + free punches + course, runs
 * `matchPunchesToCourse`, derives status via `computeStatus`, and
 * returns the legacy nested shape so the existing receipt printer and
 * web UI keep working.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { uuidv7 } from "uuidv7";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure, raceProcedure } from "../trpc.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import {
  parsePunches,
  matchPunchesToCourse,
  computeStatus,
  computeMatchScore,
  voltsFromMeos,
  RunnerStatus,
  type ParsedPunch,
  type ControlMatch,
  type CardReadPayload,
} from "@oxygen/shared";
import { toAbsolute, toRelative } from "../timeConvert.js";
import {
  runnerStatusToValue,
  valueToRunnerStatus,
} from "../statusConvert.js";
import { appendJournal } from "../journalEmit.js";
import { resolveCourseExpectedPositions } from "./course.js";
import { pushToGoogleSheet, type SheetRow } from "../sheetsBackup.js";

/** Works with both the singleton client and a `$transaction` client. */
type Db = PrismaClient | Prisma.TransactionClient;

// Re-exports kept for backwards compatibility with code that imports
// these from this file.
export {
  parsePunches,
  computeReadId,
  computeMatchScore,
  parseCourseControls,
  matchPunchesToCourse,
  computeStatus,
  PUNCH_START,
  PUNCH_FINISH,
  PUNCH_CHECK,
  type ParsedPunch,
  type ControlMatch,
} from "@oxygen/shared";

/**
 * Parse the semicolon-separated leg-length string written by the
 * OCAD / IOF importer into a flat `number[]`. Empty / trailing
 * separators are ignored; non-numeric chunks yield `0`. Returns
 * `[]` for an empty input.
 */
export function parseLegsString(s: string | null | undefined): number[] {
  if (!s) return [];
  return s
    .split(";")
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const n = parseInt(chunk, 10);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    });
}

// ─── Core matcher ──────────────────────────────────────────

export interface PerformReadoutResult {
  runner: {
    id: number; // seq
    uuid: string;
    name: string;
    cardNo: number;
    startNo: number;
    clubName: string;
    clubId: number; // eventor_club_id, 0 if none
    className: string;
    classId: number; // seq
    dbStatus: number; // numeric RunnerStatus
  };
  isRentalCard: boolean;
  cardReturned: boolean;
  course: {
    id: number; // seq
    name: string;
    length: number;
    controlCount: number;
    requiredControlCount: number;
    /**
     * Per-position leg lengths in metres, parsed from the
     * semicolon-separated `Course.legs` string the importer writes.
     * `legs[i]` is the length of the leg leading INTO position `i`
     * (so `legs[0]` is start→1st control). The last entry covers the
     * leg into the finish.
     */
    legs: number[];
  } | null;
  timing: {
    cardStartTime: number;
    assignedStartTime: number; // ZeroTime-relative, raw runner.startTime
    startTime: number; // absolute deciseconds
    finishTime: number; // absolute deciseconds
    runningTime: number;
    rawRunningTime: number;
    runningTimeAdjustment: number;
    status: number; // numeric RunnerStatus
  };
  controls: ControlMatch[];
  extraPunches: Array<{
    controlCode: number;
    time: number;
    source: "card" | "free";
    freePunchId?: string;
  }>;
  missingControls: number[];
  rawPunchCount: number;
  freePunchCount: number;
  hasCard: boolean;
  /**
   * 0..1 — how well do the card's punches match the runner's assigned
   * course? Used by the DeviceManager to decide whether to treat a
   * card-read as a real readout or as a pre-start scan with stale data.
   */
  matchScore: number;
}

/**
 * Core readout: load runner + card + free punches + course, match
 * punches, derive status. Returns the full nested shape used by both
 * the receipt printer and the web readout view.
 */
export async function performReadout(
  db: PrismaClient,
  eventId: bigint,
  zeroTime: number,
  runnerUuid: string,
): Promise<PerformReadoutResult | null> {
  const runner = await db.runner.findUnique({
    where: { id: runnerUuid },
    include: {
      class: {
        select: {
          seq: true,
          name: true,
          courseId: true,
          maxTime: true,
          noTiming: true,
        },
      },
    },
  });
  if (!runner || runner.eventId !== eventId || runner.removed) return null;

  // Card: prefer linked (runner.cardId), fall back to cardNo lookup.
  const card = runner.cardId
    ? await db.card.findUnique({ where: { id: runner.cardId } })
    : runner.cardNo != null
      ? await db.card.findFirst({
          where: { eventId, cardNo: runner.cardNo, removed: false },
          orderBy: { updatedAt: "desc" },
        })
      : null;

  // Free punches (radio + manual + online-input + backup-memory).
  const freePunches =
    runner.cardNo != null
      ? await db.punch.findMany({
          where: { eventId, cardNo: runner.cardNo, removed: false },
          orderBy: { time: "asc" },
        })
      : [];

  // Course: per-runner override > per-class course.
  const courseId = runner.courseId ?? runner.class?.courseId ?? null;
  const course = courseId
    ? await db.course.findUnique({
        where: { id: courseId },
        select: { id: true, seq: true, name: true, lengthM: true, legs: true },
      })
    : null;

  // Parse card punches (the packed MeOS string format is preserved as
  // punches_raw in the new schema).
  const cardPunches = parsePunches(card?.punchesRaw ?? "");

  // DB stores all times ZeroTime-relative; matcher works in absolute.
  for (const p of cardPunches) {
    if (p.time !== 0) p.time = toAbsolute(p.time, zeroTime);
  }
  const freeParsed: ParsedPunch[] = freePunches.map((p) => ({
    type: p.controlCode,
    time: p.time !== 0 ? toAbsolute(p.time, zeroTime) : 0,
    source: "free" as const,
    freePunchId: p.id, // UUID string in the new schema
  }));

  // Merge + sort chronologically so sequential matching works.
  const allPunches = [...cardPunches, ...freeParsed].sort(
    (a, b) => a.time - b.time,
  );

  // Expected positions: full status-aware descriptors so MeOS evaluation
  // rules (Multiple, Bad/Optional/BadNoTiming skipping, NoTiming leg
  // deduction) all apply.
  const expectedPositions = course
    ? await resolveCourseExpectedPositions(db, course.id)
    : [];

  const runnerStartTime = toAbsolute(runner.startTime, zeroTime);

  const {
    matches,
    extraPunches,
    startTime,
    cardStartTime,
    finishTime,
    missingCount,
    runningTimeAdjustment,
  } = matchPunchesToCourse(allPunches, expectedPositions, runnerStartTime);

  const rawRunningTime =
    finishTime !== 0 && startTime !== 0 ? finishTime - startTime : 0;
  const runningTime = Math.max(0, rawRunningTime - runningTimeAdjustment);

  const dbStatusNumeric = runnerStatusToValue(runner.status);
  const status = computeStatus({
    finishTime,
    startTime,
    missingCount,
    runningTime,
    classMaxTime: runner.class?.maxTime ?? 0,
    classNoTiming: runner.class?.noTiming ?? false,
    transferFlags: runner.transferFlags,
    currentStatus: dbStatusNumeric,
  });

  const missingControls = matches
    .filter((m) => m.status === "missing" && m.positionMode === "required")
    .map((m) => m.controlCode);
  const requiredCount = matches.filter((m) => m.positionMode !== "skipped").length;

  // Match score: how well the card's punches match the runner's course.
  // Args: (courseControlCount, matchedCount, totalCardPunches, foreignPunchCount)
  const matchedCount = matches.filter((m) => m.status === "ok").length;
  const foreignPunchCount = extraPunches.filter(
    (p) => p.source === "card",
  ).length;
  const matchScore = computeMatchScore(
    requiredCount,
    matchedCount,
    cardPunches.length,
    foreignPunchCount,
  );

  return {
    runner: {
      id: runner.seq,
      uuid: runner.id,
      name: runner.name,
      cardNo: runner.cardNo ?? 0,
      startNo: runner.startNo,
      clubName: runner.clubName,
      clubId: runner.eventorClubId ? Number(runner.eventorClubId) : 0,
      className: runner.class?.name ?? "",
      classId: runner.class?.seq ?? 0,
      dbStatus: dbStatusNumeric,
    },
    isRentalCard: runner.cardFeeCents !== 0,
    cardReturned: runner.cardReturned,
    course: course
      ? {
          id: course.seq,
          name: course.name,
          length: course.lengthM,
          controlCount: expectedPositions.length,
          requiredControlCount: requiredCount,
          legs: parseLegsString(course.legs),
        }
      : null,
    timing: {
      cardStartTime,
      assignedStartTime: runner.startTime,
      startTime,
      finishTime,
      runningTime,
      rawRunningTime,
      runningTimeAdjustment,
      status,
    },
    controls: matches,
    extraPunches: extraPunches.map((p) => ({
      controlCode: p.type,
      time: p.time,
      source: p.source,
      freePunchId: p.freePunchId as string | undefined,
    })),
    missingControls,
    rawPunchCount: cardPunches.length,
    freePunchCount: freeParsed.length,
    hasCard: !!card,
    matchScore,
  };
}

/** Find a runner UUID by event + card number. */
async function findRunnerUuidByCard(
  db: PrismaClient,
  eventId: bigint,
  cardNo: number,
): Promise<string | null> {
  if (cardNo <= 0) return null;
  const r = await db.runner.findFirst({
    where: { eventId, cardNo, removed: false },
    select: { id: true },
  });
  return r?.id ?? null;
}

// ─── Schemas ───────────────────────────────────────────────

const storeReadoutInput = z.object({
  cardNo: z.number().int().positive(),
  cardType: z.string().optional().default(""),
  punches: z.array(
    z.object({
      controlCode: z.number().int(),
      time: z.number().int(),
      subSecond: z.number().int().optional(),
      unit: z.number().int().optional(),
    }),
  ),
  /** Optional times read off the card itself (absolute deciseconds). */
  checkTime: z.number().int().nullable().optional(),
  startTime: z.number().int().nullable().optional(),
  finishTime: z.number().int().nullable().optional(),
  voltageMv: z.number().int().optional().default(0),
  batteryVoltage: z.number().int().optional(), // mV — alias for voltageMv
  batteryLow: z.boolean().optional(),
  punchesFresh: z.boolean().optional(),
  ownerData: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  stationId: z.string().optional(),
  /**
   * Original read time for backup-imported readouts. When omitted, the
   * cardReadout row's `read_at` defaults to NOW(). Used by
   * `pushReadoutBackup` so replayed readouts keep their original timestamp.
   */
  readAt: z.string().datetime().optional(),
});

export type StoreReadoutInput = z.infer<typeof storeReadoutInput>;

/**
 * Hash a logical card readout so duplicates can be detected without comparing
 * the full punch list byte-for-byte. The same card + same set of punches
 * (regardless of order, which station/slot they came from, or import session)
 * always produces the same hash — used as the dedup key on
 * `card_readout_backups.punches_hash`.
 */
export function computePunchesHash(
  cardNo: number,
  punches: ReadonlyArray<{ controlCode: number; time: number }>,
): string {
  const sorted = [...punches].sort(
    (a, b) => a.time - b.time || a.controlCode - b.controlCode,
  );
  const payload = `${cardNo}|${sorted.map((p) => `${p.controlCode}:${p.time}`).join(";")}`;
  return createHash("sha256").update(payload).digest("hex");
}

// ─── Helpers used by the router ────────────────────────────

/**
 * Encode a punch list back into the MeOS-style packed string stored in
 * `cards.punches_raw`. The format `code-seconds.tenths` is what
 * `parsePunches` round-trips (it multiplies the seconds component by 10
 * to recover deciseconds).
 *
 * `time` is the canonical internal unit: ZeroTime-relative deciseconds.
 */
function encodePunchesRaw(
  punches: Array<{ controlCode: number; time: number }>,
): string {
  return punches
    .map((p) => {
      if (p.time === 0) return `${p.controlCode}-0.0`;
      const secs = Math.floor(p.time / 10);
      const tenths = p.time % 10;
      return `${p.controlCode}-${secs}.${tenths}`;
    })
    .join(";");
}

/**
 * Core logic for storing a card readout. Shared between the live-readout
 * `storeReadout` mutation, the backup-replay `pushReadoutBackup`, and the
 * offline-outbox drain (`events.push` `card.read` entries), so every readout
 * goes through the same downstream pipeline (card upsert, runner link,
 * relevance score).
 *
 * Transaction-safe: accepts a `$transaction` client, so callers can commit
 * the readout and its `card.read` journal entry atomically. The Google
 * Sheets push is therefore NOT fired here — the returned `sheetRow` is
 * ready for `pushToGoogleSheet` after the caller's transaction commits (a
 * fire-and-forget fetch must never run on a transaction client).
 */
export async function storeReadoutImpl(
  db: Db,
  eventId: bigint,
  zeroTime: number,
  input: StoreReadoutInput,
) {
  const voltageMv = input.batteryVoltage ?? input.voltageMv;

  // 1. Immutable raw readout log row. `readAt` is supplied by backup
  //    imports so replayed readouts keep their original timestamp.
  const readout = await db.cardReadout.create({
    data: {
      eventId,
      cardNo: input.cardNo,
      cardType: input.cardType,
      punches: input.punches as never,
      voltageMv,
      batteryLow: input.batteryLow ?? null,
      ownerData: (input.ownerData ?? undefined) as never,
      metadata: (input.metadata ?? undefined) as never,
      stationId: input.stationId,
      ...(input.readAt ? { readAt: new Date(input.readAt) } : {}),
    },
    select: { id: true, readAt: true },
  });

  // 2. Upsert the per-event Card row. punchesRaw is stored in
  //    ZeroTime-relative deciseconds (MeOS-style `code-seconds.tenths`
  //    so parsePunches round-trips correctly).
  //
  //    Synthesize a `start (1)` / `finish (2)` / `check (3)` punch
  //    when the card supplied those header times — the course matcher
  //    keys off them to derive startTime/finishTime.
  const synthesized: Array<{ controlCode: number; time: number }> = [];
  if (input.startTime && input.startTime > 0) {
    synthesized.push({ controlCode: 1, time: input.startTime });
  }
  if (input.finishTime && input.finishTime > 0) {
    synthesized.push({ controlCode: 2, time: input.finishTime });
  }
  if (input.checkTime && input.checkTime > 0) {
    synthesized.push({ controlCode: 3, time: input.checkTime });
  }
  const allInputPunches = [...synthesized, ...input.punches];
  const relativePunches = allInputPunches.map((p) => ({
    controlCode: p.controlCode,
    time: p.time !== 0 ? toRelative(p.time, zeroTime) : 0,
  }));
  const punchesRaw = encodePunchesRaw(relativePunches);

  const existingCard = await db.card.findFirst({
    where: { eventId, cardNo: input.cardNo, removed: false },
  });
  const card = existingCard
    ? await db.card.update({
        where: { id: existingCard.id },
        data: {
          readoutId: readout.id,
          readCount: existingCard.readCount + 1,
          voltageMv,
          punchesRaw,
        },
        select: { id: true, seq: true },
      })
    : await db.card.create({
        data: {
          eventId,
          cardNo: input.cardNo,
          readoutId: readout.id,
          readCount: 1,
          voltageMv,
          punchesRaw,
        },
        select: { id: true, seq: true },
      });

  // 3. Link the card to a runner if one matches by card number.
  const runner = await db.runner.findFirst({
    where: { eventId, cardNo: input.cardNo, removed: false },
    select: { id: true, seq: true, classId: true },
  });
  if (runner) {
    await db.runner.update({
      where: { id: runner.id },
      data: { cardId: card.id },
    });
  }

  // 4. Quick relevance check: are *any* of these punch codes useful
  //    for the runner's assigned course? We resolve the runner's
  //    course controls and look for at least one overlapping code.
  //    Used by the kiosk / device-manager to skip "stale-card"
  //    pre-start punches from being applied.
  let punchesRelevant = false;
  let matchScore = 0;
  if (!runner?.classId) {
    // Unregistered card — fall back to event-level relevance: any
    // punch code matching a known control in this event counts.
    const codes = new Set(
      input.punches.map((p) => p.controlCode).filter((c) => c >= 30),
    );
    if (codes.size > 0) {
      const known = await db.control.findMany({
        where: { eventId, removed: false },
        select: { codes: true },
      });
      const knownCodes = new Set<number>();
      for (const k of known) {
        for (const c of k.codes.split(";")) {
          const n = parseInt(c, 10);
          if (Number.isFinite(n)) knownCodes.add(n);
        }
      }
      for (const c of codes) {
        if (knownCodes.has(c)) {
          punchesRelevant = true;
          break;
        }
      }
    }
  }
  if (runner?.classId) {
    const cls = await db.class.findUnique({
      where: { id: runner.classId },
      select: { courseId: true },
    });
    if (cls?.courseId) {
      const expected = await resolveCourseExpectedPositions(
        db,
        cls.courseId,
      );
      const expectedCodes = new Set<number>(
        expected.flatMap((e) => e.codes),
      );
      const requiredCount = expected.filter((e) => !e.skipMatching).length;
      let matchedCount = 0;
      let foreignCount = 0;
      for (const p of input.punches) {
        if (expectedCodes.has(p.controlCode)) matchedCount++;
        else if (p.controlCode >= 30) foreignCount++; // ignore start/finish/check
      }
      matchScore = computeMatchScore(
        requiredCount,
        matchedCount,
        input.punches.length,
        foreignCount,
      );
      punchesRelevant = matchScore >= 0.2;
    }
  }

  // 5. Build the Google Sheets row for the caller to fire AFTER its
  //    transaction commits (no-op downstream when no webhook configured).
  const fullName = runner
    ? await db.runner.findUnique({
        where: { id: runner.id },
        select: { name: true, clubName: true, class: { select: { name: true } } },
      })
    : null;
  const sheetRow: SheetRow = {
    timestamp: readout.readAt.toISOString(),
    cardNo: input.cardNo,
    cardType: input.cardType ?? "",
    runnerName: fullName?.name ?? "",
    className: fullName?.class?.name ?? "",
    clubName: fullName?.clubName ?? "",
    startNo: 0,
    checkTime: input.checkTime ?? null,
    startTime: input.startTime ?? null,
    finishTime: input.finishTime ?? null,
    punchCount: input.punches.length,
    punches: encodePunchesRaw(input.punches),
    punchesRelevant,
    batteryVoltage: voltageMv || null,
  };

  return {
    readoutId: readout.id,
    cardId: card.seq,
    readAt: readout.readAt.toISOString(),
    linkedRunnerId: runner?.seq ?? null,
    punchesRelevant,
    matchScore,
    sheetRow,
  };
}

// ─── Router ────────────────────────────────────────────────

export const cardReadoutRouter = router({
  /**
   * Store a raw card readout, upsert the per-event Card row, and
   * (if the cardNo matches a runner) write any radio-style punches the
   * card carries into the punches table.
   *
   * Returns a `punchesRelevant` flag the DeviceManager uses to decide
   * whether to call applyResult immediately or keep the entry as a
   * pre-start scan.
   */
  storeReadout: raceProcedure
    .input(storeReadoutInput)
    .mutation(async ({ ctx, input }) => {
      // Readout + its card.read journal entry commit or roll back together
      // (storeReadoutImpl is transaction-safe; the Sheets push fires after).
      const result = await ctx.db.$transaction(async (tx) => {
        const r = await storeReadoutImpl(
          tx,
          ctx.event.id,
          ctx.event.zeroTime,
          input,
        );
        await appendJournal(tx, {
          eventId: ctx.event.id,
          type: "card.read",
          stationId: input.stationId,
          payload: {
            cardNo: input.cardNo,
            punches: input.punches.map((p) => ({
              controlCode: p.controlCode,
              time: p.time,
            })),
            checkTime: input.checkTime ?? undefined,
            startTime: input.startTime ?? undefined,
            finishTime: input.finishTime ?? undefined,
            cardType: input.cardType,
            // The payload battery is in VOLTS (offline-emit contract); the
            // storeReadout input carries integer mV, so convert.
            batteryVoltage:
              voltsFromMeos(input.batteryVoltage ?? input.voltageMv) ??
              undefined,
            punchesFresh: input.punchesFresh,
            ownerData: input.ownerData as CardReadPayload["ownerData"],
            metadata: input.metadata as CardReadPayload["metadata"],
          },
        });
        return r;
      });
      pushToGoogleSheet(ctx.db, ctx.event.id, result.sheetRow);
      const { sheetRow: _sheetRow, ...response } = result;
      return response;
    }),

  /**
   * Most-recent readout for a given card number — returns the matched,
   * placed, status-derived result via the matcher. Returns the legacy
   * `{ found: false }` shape when no runner is registered for this card.
   */
  readout: eventProcedure
    .input(z.object({ cardNo: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const eventId = ctx.event.id;
      if (input.cardNo <= 0) {
        return { found: false as const, cardNo: input.cardNo };
      }
      const runnerUuid = await findRunnerUuidByCard(
        ctx.db,
        eventId,
        input.cardNo,
      );
      if (!runnerUuid) {
        return { found: false as const, cardNo: input.cardNo };
      }
      const result = await performReadout(
        ctx.db,
        eventId,
        ctx.event.zeroTime,
        runnerUuid,
      );
      if (!result) return { found: false as const, cardNo: input.cardNo };
      return { found: true as const, ...result };
    }),

  /**
   * Same as readout but keyed by runner seq. Used by the standalone
   * Card Readout page and by RunnerMapPreview.
   */
  readoutByRunner: eventProcedure
    .input(z.object({ runnerId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const runner = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, seq: input.runnerId, removed: false },
        select: { id: true },
      });
      if (!runner) return null;
      return performReadout(
        ctx.db,
        ctx.event.id,
        ctx.event.zeroTime,
        runner.id,
      );
    }),

  /**
   * Apply the matcher's computed result back to the runner row
   * (start/finish/status). Used by the readout station after a card
   * read produces a real result.
   */
  applyResult: raceProcedure
    .input(
      z.object({
        runnerId: z.number().int(),
        status: z.number().int(),
        finishTime: z.number().int(), // absolute deciseconds
        startTime: z.number().int(), // absolute deciseconds
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const runner = await ctx.db.runner.findFirst({
        where: {
          eventId: ctx.event.id,
          seq: input.runnerId,
          removed: false,
        },
        select: { id: true, status: true, transferFlags: true, cardNo: true },
      });
      if (!runner) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Runner ${input.runnerId} not found`,
        });
      }
      const zeroTime = ctx.event.zeroTime;
      // Table write + journal entry commit or roll back together.
      await ctx.db.$transaction(async (tx) => {
        await tx.runner.update({
          where: { id: runner.id },
          data: {
            status: valueToRunnerStatus(input.status),
            finishTime:
              input.finishTime > 0 ? toRelative(input.finishTime, zeroTime) : 0,
            startTime:
              input.startTime > 0 ? toRelative(input.startTime, zeroTime) : 0,
          },
        });
        await appendJournal(tx, {
          eventId: ctx.event.id,
          type: "result.applied",
          payload: {
            cardNo: runner.cardNo ?? null,
            runnerId: input.runnerId,
            status: input.status,
            finishTime: input.finishTime,
            startTime: input.startTime,
          },
        });
      });
      return { ok: true as const };
    }),

  /** History of recent card readouts for the active event. */
  recent: eventProcedure
    .input(
      z
        .object({ limit: z.number().int().min(1).max(500).default(50) })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.cardReadout.findMany({
        where: { eventId: ctx.event.id },
        orderBy: { readAt: "desc" },
        take: input?.limit ?? 50,
      });
      return rows.map((r) => ({
        id: r.id,
        cardNo: r.cardNo,
        cardType: r.cardType,
        voltageMv: r.voltageMv,
        readAt: r.readAt.toISOString(),
        stationId: r.stationId,
      }));
    }),

  /** Look up a stored readout by id (UUID). */
  getById: eventProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const r = await ctx.db.cardReadout.findUnique({
        where: { id: input.id },
      });
      if (!r || r.eventId !== ctx.event.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Readout not found",
        });
      }
      return {
        id: r.id,
        cardNo: r.cardNo,
        cardType: r.cardType,
        punches: r.punches,
        voltageMv: r.voltageMv,
        readAt: r.readAt.toISOString(),
      };
    }),

  /** All known cards for the event (one row per card_no). */
  /**
   * One row per card, joined with the runner that currently owns it.
   *
   * The CardsPage filter UI consumes a rich shape — `cardType`,
   * `batteryVoltage` (volts!), `punchCount`, `runner.{status,
   * isRentalCard, cardReturned}` — so we synthesise that here from the
   * latest readout + the runner row. Cards with no readout yet still
   * appear with `cardType: ""` and `batteryVoltage: null`.
   */
  cardList: eventProcedure.query(async ({ ctx }) => {
    const cards = await ctx.db.card.findMany({
      where: { eventId: ctx.event.id, removed: false },
      orderBy: { cardNo: "asc" },
    });
    const cardNos = cards.map((c) => c.cardNo);
    const runners = cardNos.length
      ? await ctx.db.runner.findMany({
          where: {
            eventId: ctx.event.id,
            cardNo: { in: cardNos },
            removed: false,
          },
          select: {
            seq: true,
            cardNo: true,
            name: true,
            clubName: true,
            eventorClubId: true,
            status: true,
            cardReturned: true,
            cardFeeCents: true,
            class: { select: { name: true } },
          },
        })
      : [];
    const runnerByCard = new Map(runners.map((r) => [r.cardNo, r]));

    // Latest readout per card (for cardType + battery voltage). We
    // query in one go and reduce client-side to avoid an N+1.
    const readouts = cardNos.length
      ? await ctx.db.cardReadout.findMany({
          where: { eventId: ctx.event.id, cardNo: { in: cardNos } },
          orderBy: { readAt: "desc" },
          select: {
            cardNo: true,
            cardType: true,
            voltageMv: true,
            readAt: true,
            punches: true,
          },
        })
      : [];
    const latestByCard = new Map<number, (typeof readouts)[number]>();
    for (const r of readouts) {
      if (!latestByCard.has(r.cardNo)) latestByCard.set(r.cardNo, r);
    }

    return cards.map((c) => {
      const r = runnerByCard.get(c.cardNo);
      const latest = latestByCard.get(c.cardNo) ?? null;
      const punches = latest?.punches as unknown[] | null | undefined;
      const punchCount = Array.isArray(punches) ? punches.length : 0;
      const voltageMv = latest?.voltageMv ?? c.voltageMv ?? 0;
      const batteryVoltage = voltageMv > 0 ? voltageMv / 1000 : null;
      return {
        id: c.seq,
        cardNo: c.cardNo,
        cardType: latest?.cardType ?? "",
        batteryVoltage,
        voltageMv,
        readCount: c.readCount,
        punchCount,
        hasPunches: punchCount > 0,
        modified: (latest?.readAt ?? c.updatedAt).toISOString(),
        runnerId: r?.seq ?? null,
        runnerName: r?.name ?? "",
        className: r?.class?.name ?? "",
        clubName: r?.clubName ?? "",
        runner: r
          ? {
              id: r.seq,
              name: r.name,
              clubName: r.clubName,
              clubId: r.eventorClubId ? Number(r.eventorClubId) : 0,
              className: r.class?.name ?? "",
              status: runnerStatusToValue(r.status),
              // Rental cards are flagged with a non-zero cardFee
              // (matches the legacy MeOS convention).
              isRentalCard: r.cardFeeCents > 0,
              cardReturned: r.cardReturned,
            }
          : null,
      };
    });
  }),

  /**
   * Full detail for a card — the structured shape the CardsPage drawer
   * consumes. Surfaces the parsed punches, owner data + metadata from
   * the latest readout, and the linked runner (with club + status +
   * card-return flag).
   *
   * Returns `null` when neither the card nor a readout exists for the
   * given `cardNo`, so the page can render "unknown card" gracefully.
   */
  cardDetail: eventProcedure
    .input(z.object({ cardNo: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const card = await ctx.db.card.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo, removed: false },
      });
      const runner = await ctx.db.runner.findFirst({
        where: {
          eventId: ctx.event.id,
          cardNo: input.cardNo,
          removed: false,
        },
        select: {
          seq: true,
          name: true,
          clubName: true,
          eventorClubId: true,
          status: true,
          cardFeeCents: true,
          cardReturned: true,
          class: { select: { name: true } },
        },
      });
      const latestReadout = await ctx.db.cardReadout.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo },
        orderBy: { readAt: "desc" },
      });

      if (!card && !latestReadout) return null;

      // Parsed punches from the latest readout. The readout `punches`
      // column is JSONB matching the legacy
      //   { type: number, time: number, ... } shape.
      type Punch = { type: number; time: number };
      const parsedPunches: Punch[] = Array.isArray(latestReadout?.punches)
        ? (latestReadout!.punches as unknown as Punch[])
        : [];
      const PUNCH_START = 1;
      const PUNCH_FINISH = 2;
      const PUNCH_CHECK = 3;
      const startPunch = parsedPunches.find((p) => p.type === PUNCH_START);
      const finishPunch = parsedPunches.find((p) => p.type === PUNCH_FINISH);
      const checkPunch = parsedPunches.find((p) => p.type === PUNCH_CHECK);
      const controlPunches = parsedPunches.filter(
        (p) =>
          p.type !== PUNCH_START &&
          p.type !== PUNCH_FINISH &&
          p.type !== PUNCH_CHECK,
      );

      const voltageMv = latestReadout?.voltageMv ?? card?.voltageMv ?? 0;
      const batteryVoltage = voltageMv > 0 ? voltageMv / 1000 : null;

      return {
        cardNo: input.cardNo,
        id: card?.seq ?? 0,
        cardType: latestReadout?.cardType ?? "",
        batteryVoltage,
        voltageMv,
        ownerData: latestReadout?.ownerData ?? null,
        metadata: latestReadout?.metadata ?? null,
        runner: runner
          ? {
              id: runner.seq,
              name: runner.name,
              className: runner.class?.name ?? "",
              clubName: runner.clubName,
              clubId: runner.eventorClubId ? Number(runner.eventorClubId) : 0,
              status: runnerStatusToValue(runner.status),
              isRentalCard: runner.cardFeeCents > 0,
              cardReturned: runner.cardReturned,
            }
          : null,
        checkTime: checkPunch?.time ?? null,
        startTime: startPunch?.time ?? null,
        finishTime: finishPunch?.time ?? null,
        punches: controlPunches.map((p) => ({
          controlCode: p.type,
          time: p.time,
        })),
        modified: (latestReadout?.readAt ?? card?.updatedAt ?? new Date()).toISOString(),
      };
    }),

  /** History of every readout for a card. */
  readoutHistory: eventProcedure
    .input(z.object({ cardNo: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.cardReadout.findMany({
        where: { eventId: ctx.event.id, cardNo: input.cardNo },
        orderBy: { readAt: "desc" },
        take: 100,
      });
      return rows.map((r) => ({
        id: r.id,
        cardType: r.cardType,
        voltageMv: r.voltageMv,
        readAt: r.readAt.toISOString(),
        stationId: r.stationId,
      }));
    }),

  /**
   * Link a card to a runner manually.
   *
   * Accepts either `{ cardNo }` (the new shape) or `{ cardId }` (the
   * legacy seq-based shape — the CardsPage drawer still passes this).
   * `runnerId` is the runner's seq, or `null` to unlink. The card row
   * is created if it doesn't exist yet.
   */
  linkCardToRunner: raceProcedure
    .input(
      z.object({
        cardNo: z.number().int().optional(),
        cardId: z.number().int().optional(),
        runnerId: z.number().int().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let cardNo = input.cardNo;
      if (!cardNo && input.cardId) {
        const c = await ctx.db.card.findFirst({
          where: { eventId: ctx.event.id, seq: input.cardId },
          select: { cardNo: true },
        });
        if (!c) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Card #${input.cardId} not found.`,
          });
        }
        cardNo = c.cardNo;
      }
      if (!cardNo) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Provide cardNo or cardId.",
        });
      }
      if (input.runnerId === null) {
        // Unlink: clear cardNo on any runner currently holding it.
        const affected = await ctx.db.runner.findMany({
          where: { eventId: ctx.event.id, cardNo, removed: false },
          select: { id: true, seq: true },
        });
        await ctx.db.$transaction(async (tx) => {
          await tx.runner.updateMany({
            where: { id: { in: affected.map((r) => r.id) } },
            data: { cardNo: null },
          });
          for (const r of affected) {
            await appendJournal(tx, {
              eventId: ctx.event.id,
              type: "runner.updated",
              // Resolve by the card being unlinked; 0 → NULL on replay.
              payload: { cardNo, runnerId: r.seq, fields: { cardNo: 0 } },
            });
          }
        });
        return { ok: true as const };
      }
      const runnerSeq = input.runnerId; // narrowed to number by the guard above
      const runner = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, seq: runnerSeq, removed: false },
        select: { id: true, cardNo: true },
      });
      if (!runner) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Runner not found",
        });
      }
      const card = await ctx.db.card.findFirst({
        where: { eventId: ctx.event.id, cardNo, removed: false },
        select: { id: true },
      });
      await ctx.db.$transaction(async (tx) => {
        await tx.runner.update({
          where: { id: runner.id },
          data: { cardNo, cardId: card?.id ?? null },
        });
        await appendJournal(tx, {
          eventId: ctx.event.id,
          type: "runner.updated",
          payload: {
            cardNo: runner.cardNo ?? null, // pre-link card resolves the peer row
            runnerId: runnerSeq,
            fields: { cardNo },
          },
        });
      });
      return { ok: true as const };
    }),

  /** Append a free punch to a card. */
  addPunch: raceProcedure
    .input(
      z.object({
        cardNo: z.number().int(),
        controlCode: z.number().int(),
        time: z.number().int(), // absolute deciseconds
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const zeroTime = ctx.event.zeroTime;
      const control = await ctx.db.control.findFirst({
        where: {
          eventId: ctx.event.id,
          codes: { contains: String(input.controlCode) },
          removed: false,
        },
        select: { id: true },
      });
      // Table write + journal entry commit or roll back together. The punch
      // id is minted here and travels in the payload so every node stores
      // the row under the same UUID (punch edits address it by id).
      const punchId = uuidv7();
      await ctx.db.$transaction(async (tx) => {
        await tx.punch.create({
          data: {
            id: punchId,
            eventId: ctx.event.id,
            cardNo: input.cardNo,
            controlCode: input.controlCode,
            controlId: control?.id ?? null,
            time: input.time > 0 ? toRelative(input.time, zeroTime) : 0,
            source: "manual",
            isOriginal: false,
          },
        });
        await appendJournal(tx, {
          eventId: ctx.event.id,
          type: "punch.recorded",
          payload: {
            id: punchId,
            cardNo: input.cardNo,
            controlCode: input.controlCode,
            time: input.time, // absolute deciseconds (portable)
            origin: "manual",
          },
        });
      });
      return { ok: true as const };
    }),

  /** Remove a free punch by id (UUID). */
  removePunch: raceProcedure
    .input(z.object({ punchId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const p = await ctx.db.punch.findFirst({
        where: { id: input.punchId, eventId: ctx.event.id },
      });
      if (!p) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Punch not found" });
      }
      // Table write + journal entry commit or roll back together.
      await ctx.db.$transaction(async (tx) => {
        await tx.punch.update({
          where: { id: p.id },
          data: { removed: true },
        });
        await appendJournal(tx, {
          eventId: ctx.event.id,
          type: "punch.removed",
          payload: {
            id: p.id,
            cardNo: p.cardNo,
            controlCode: p.controlCode,
            time: p.time !== 0 ? toAbsolute(p.time, ctx.event.zeroTime) : 0,
          },
        });
      });
      return { ok: true as const };
    }),

  /** Adjust the time on an existing free punch. */
  updatePunchTime: raceProcedure
    .input(z.object({ punchId: z.string().uuid(), time: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const zeroTime = ctx.event.zeroTime;
      const p = await ctx.db.punch.findFirst({
        where: { id: input.punchId, eventId: ctx.event.id },
      });
      if (!p) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Punch not found" });
      }
      // Table write + journal entry commit or roll back together.
      await ctx.db.$transaction(async (tx) => {
        await tx.punch.update({
          where: { id: p.id },
          data: {
            time: input.time > 0 ? toRelative(input.time, zeroTime) : 0,
            isOriginal: false,
          },
        });
        await appendJournal(tx, {
          eventId: ctx.event.id,
          type: "punch.updated",
          payload: {
            id: p.id,
            cardNo: p.cardNo,
            controlCode: p.controlCode,
            oldTime: p.time !== 0 ? toAbsolute(p.time, zeroTime) : 0,
            time: input.time,
          },
        });
      });
      return { ok: true as const };
    }),

  // ─── Readout-station backup memory recovery ─────────────────
  //
  // When a readout station's `M_READOUT` backup memory is dumped via
  // `webserial.readBackupMemory`, the parsed records are staged here for
  // operator review on the BackupPunchesPage's "Card readouts" tab before
  // being replayed through the normal `storeReadout` pipeline.

  /**
   * Bulk-import parsed readout-backup records. Idempotent: the
   * `(eventId, punchesHash)` unique constraint silently drops re-imports.
   */
  importReadoutBackups: raceProcedure
    .input(
      z.object({
        stationSerial: z.number().int().optional(),
        records: z.array(
          z.object({
            slotAddress: z.number().int(),
            cardNo: z.number().int().positive(),
            cardType: z.string().optional().default(""),
            punches: z.array(
              z.object({
                controlCode: z.number().int(),
                time: z.number().int(),
                subSecond: z.number().int().optional(),
              }),
            ),
            startTime: z.number().int().nullable().optional(),
            finishTime: z.number().int().nullable().optional(),
            checkTime: z.number().int().nullable().optional(),
            clearTime: z.number().int().nullable().optional(),
            ownerData: z.record(z.string(), z.unknown()).optional(),
            /** Hex-encoded raw slot bytes (optional, for forensics). */
            rawBytesHex: z.string().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const eventId = ctx.event.id;
      const data = input.records.map((r) => ({
        eventId,
        stationSerial: input.stationSerial ?? null,
        slotAddress: r.slotAddress,
        cardNo: r.cardNo,
        cardType: r.cardType ?? "",
        punches: r.punches as never,
        startTime: r.startTime ?? null,
        finishTime: r.finishTime ?? null,
        checkTime: r.checkTime ?? null,
        clearTime: r.clearTime ?? null,
        ownerData: (r.ownerData ?? undefined) as never,
        punchesHash: computePunchesHash(r.cardNo, r.punches),
        rawBytes: r.rawBytesHex
          ? Buffer.from(r.rawBytesHex, "hex")
          : null,
      }));
      const result = await ctx.db.cardReadoutBackup.createMany({
        data,
        skipDuplicates: true,
      });
      return {
        ok: true as const,
        inserted: result.count,
        duplicates: input.records.length - result.count,
      };
    }),

  /**
   * List backup readouts for the event, with the enrichment the
   * BackupPunchesPage's "Card readouts" tab needs to render match-status
   * badges: linked runner (if any), and whether the row has already been
   * pushed into card_readouts.
   */
  listReadoutBackups: eventProcedure.query(async ({ ctx }) => {
    const eventId = ctx.event.id;
    const rows = await ctx.db.cardReadoutBackup.findMany({
      where: { eventId },
      orderBy: { importedAt: "desc" },
      select: {
        id: true,
        stationSerial: true,
        slotAddress: true,
        cardNo: true,
        cardType: true,
        punches: true,
        startTime: true,
        finishTime: true,
        checkTime: true,
        clearTime: true,
        originalReadAt: true,
        ownerData: true,
        importedAt: true,
        pushedAt: true,
        pushedReadoutId: true,
      },
    });
    if (rows.length === 0) return [];

    // Look up runners by cardNo so the UI can render names + a "no runner"
    // status badge for cards that aren't registered.
    const cardNos = Array.from(new Set(rows.map((r) => r.cardNo)));
    const runners = await ctx.db.runner.findMany({
      where: { eventId, cardNo: { in: cardNos }, removed: false },
      select: {
        seq: true,
        cardNo: true,
        name: true,
        clubName: true,
        class: { select: { name: true } },
      },
    });
    const runnerByCard = new Map(runners.map((r) => [r.cardNo, r]));

    return rows.map((r) => {
      const runner = runnerByCard.get(r.cardNo) ?? null;
      let matchStatus: "pushed" | "no_runner" | "pending";
      if (r.pushedAt) matchStatus = "pushed";
      else if (!runner) matchStatus = "no_runner";
      else matchStatus = "pending";
      const punchCount = Array.isArray(r.punches) ? r.punches.length : 0;
      return {
        id: r.id,
        stationSerial: r.stationSerial,
        slotAddress: r.slotAddress,
        cardNo: r.cardNo,
        cardType: r.cardType,
        punches: r.punches,
        punchCount,
        startTime: r.startTime,
        finishTime: r.finishTime,
        checkTime: r.checkTime,
        clearTime: r.clearTime,
        originalReadAt: r.originalReadAt
          ? r.originalReadAt.toISOString()
          : null,
        ownerData: r.ownerData,
        importedAt: r.importedAt.toISOString(),
        pushedAt: r.pushedAt ? r.pushedAt.toISOString() : null,
        pushedReadoutId: r.pushedReadoutId,
        matchStatus,
        runner: runner
          ? {
              id: runner.seq,
              name: runner.name,
              clubName: runner.clubName,
              className: runner.class?.name ?? "",
            }
          : null,
      };
    });
  }),

  /**
   * Promote a staged backup readout into card_readouts. Calls the same
   * `storeReadoutImpl` core that live readouts use, so the runner gets
   * the normal cardReadout + Card upsert + runner-link side effects.
   *
   * Idempotent: re-pushing a row that was already pushed returns the
   * existing pushedReadoutId without doing the work twice.
   */
  pushReadoutBackup: raceProcedure
    .input(z.object({ backupId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const eventId = ctx.event.id;
      const zeroTime = ctx.event.zeroTime;
      const backup = await ctx.db.cardReadoutBackup.findUnique({
        where: { id: input.backupId },
      });
      if (!backup || backup.eventId !== eventId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Backup readout ${input.backupId} not found`,
        });
      }
      if (backup.pushedAt && backup.pushedReadoutId) {
        // Already pushed — return the previous result idempotently.
        return {
          ok: true as const,
          alreadyPushed: true as const,
          pushedReadoutId: backup.pushedReadoutId,
        };
      }
      const punches = (backup.punches as unknown) as Array<{
        controlCode: number;
        time: number;
        subSecond?: number;
      }>;
      const stationId = backup.stationSerial
        ? `backup-${backup.stationSerial}`
        : `backup-${input.backupId}`;
      const readAt = backup.originalReadAt ?? backup.importedAt;
      // Readout, staging-row flip and the card.read journal entry commit or
      // roll back together. The payload carries the ORIGINAL read time so
      // the applying node's dedupe window and read_at both use it.
      const result = await ctx.db.$transaction(async (tx) => {
        const r = await storeReadoutImpl(tx, eventId, zeroTime, {
          cardNo: backup.cardNo,
          cardType: backup.cardType,
          punches,
          startTime: backup.startTime,
          finishTime: backup.finishTime,
          checkTime: backup.checkTime,
          voltageMv: 0,
          ownerData:
            (backup.ownerData as Record<string, unknown> | null) ?? undefined,
          stationId,
          readAt: readAt.toISOString(),
        });
        await tx.cardReadoutBackup.update({
          where: { id: backup.id },
          data: {
            pushedAt: new Date(),
            pushedReadoutId: r.readoutId,
          },
        });
        await appendJournal(tx, {
          eventId,
          type: "card.read",
          stationId,
          payload: {
            cardNo: backup.cardNo,
            punches: punches.map((p) => ({
              controlCode: p.controlCode,
              time: p.time,
            })),
            checkTime: backup.checkTime ?? undefined,
            startTime: backup.startTime ?? undefined,
            finishTime: backup.finishTime ?? undefined,
            cardType: backup.cardType,
            readAt: readAt.getTime(),
          },
        });
        return r;
      });
      pushToGoogleSheet(ctx.db, eventId, result.sheetRow);
      return {
        ok: true as const,
        alreadyPushed: false as const,
        pushedReadoutId: result.readoutId,
        punchesRelevant: result.punchesRelevant,
        matchScore: result.matchScore,
        linkedRunnerId: result.linkedRunnerId,
      };
    }),
});

// Silence unused-import warning until other tooling consumes the constant.
void RunnerStatus;
