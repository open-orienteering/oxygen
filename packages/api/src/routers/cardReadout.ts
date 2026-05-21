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

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import type { PrismaClient } from "@prisma/client";
import {
  parsePunches,
  matchPunchesToCourse,
  computeStatus,
  computeMatchScore,
  RunnerStatus,
  type ParsedPunch,
  type ControlMatch,
} from "@oxygen/shared";
import { toAbsolute, toRelative } from "../timeConvert.js";
import {
  runnerStatusToValue,
  valueToRunnerStatus,
} from "../statusConvert.js";
import { resolveCourseExpectedPositions } from "./course.js";
import { pushToGoogleSheet } from "../sheetsBackup.js";

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
    : runner.cardNo > 0
      ? await db.card.findFirst({
          where: { eventId, cardNo: runner.cardNo, removed: false },
          orderBy: { updatedAt: "desc" },
        })
      : null;

  // Free punches (radio + manual + online-input + backup-memory).
  const freePunches =
    runner.cardNo > 0
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
        select: { id: true, seq: true, name: true, lengthM: true },
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
      cardNo: runner.cardNo,
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
});

// ─── Helpers used by the router ────────────────────────────

/**
 * Encode `ParsedPunch[]` back into the MeOS-style packed string used by
 * cards.punches_raw. Format: "code-time;code-time;..." where time is
 * absolute deciseconds since midnight.
 */
function encodePunchesRaw(
  punches: Array<{ controlCode: number; time: number }>,
): string {
  return punches.map((p) => `${p.controlCode}-${p.time}`).join(";");
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
  storeReadout: eventProcedure
    .input(storeReadoutInput)
    .mutation(async ({ ctx, input }) => {
      const eventId = ctx.event.id;
      const zeroTime = ctx.event.zeroTime;
      const voltageMv = input.batteryVoltage ?? input.voltageMv;

      // 1. Immutable raw readout log row.
      const readout = await ctx.db.cardReadout.create({
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
        },
        select: { id: true, readAt: true },
      });

      // 2. Upsert the per-event Card row. Times in punchesRaw are absolute
      //    (the matcher expects absolute deciseconds; performReadout's
      //    later `toAbsolute` call is a no-op for these because they're
      //    already absolute — see the cardPunches handling above. To
      //    keep that branch happy, we store ZeroTime-relative here.)
      const relativePunches = input.punches.map((p) => ({
        controlCode: p.controlCode,
        time: p.time !== 0 ? toRelative(p.time, zeroTime) : 0,
      }));
      const punchesRaw = encodePunchesRaw(relativePunches);

      const existingCard = await ctx.db.card.findFirst({
        where: { eventId, cardNo: input.cardNo, removed: false },
      });
      const card = existingCard
        ? await ctx.db.card.update({
            where: { id: existingCard.id },
            data: {
              readoutId: readout.id,
              readCount: existingCard.readCount + 1,
              voltageMv,
              punchesRaw,
            },
            select: { id: true, seq: true },
          })
        : await ctx.db.card.create({
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
      const runner = await ctx.db.runner.findFirst({
        where: { eventId, cardNo: input.cardNo, removed: false },
        select: { id: true, seq: true, classId: true },
      });
      if (runner) {
        await ctx.db.runner.update({
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
      if (runner?.classId) {
        const cls = await ctx.db.class.findUnique({
          where: { id: runner.classId },
          select: { courseId: true },
        });
        if (cls?.courseId) {
          const expected = await resolveCourseExpectedPositions(
            ctx.db,
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

      // 5. Best-effort Google Sheets push (fire-and-forget; no-op when
      //    no webhook is configured).
      try {
        const fullName = runner
          ? (
              await ctx.db.runner.findUnique({
                where: { id: runner.id },
                select: { name: true, clubName: true, class: { select: { name: true } } },
              })
            )
          : null;
        pushToGoogleSheet(ctx.db, eventId, {
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
        });
      } catch {
        // Don't let webhook errors interfere with the readout flow.
      }

      return {
        readoutId: readout.id,
        cardId: card.seq,
        readAt: readout.readAt.toISOString(),
        linkedRunnerId: runner?.seq ?? null,
        punchesRelevant,
        matchScore,
      };
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
  applyResult: eventProcedure
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
        select: { id: true, status: true, transferFlags: true },
      });
      if (!runner) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Runner ${input.runnerId} not found`,
        });
      }
      const zeroTime = ctx.event.zeroTime;
      await ctx.db.runner.update({
        where: { id: runner.id },
        data: {
          status: valueToRunnerStatus(input.status),
          finishTime:
            input.finishTime > 0 ? toRelative(input.finishTime, zeroTime) : 0,
          startTime:
            input.startTime > 0 ? toRelative(input.startTime, zeroTime) : 0,
        },
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
            class: { select: { name: true } },
          },
        })
      : [];
    const runnerByCard = new Map(runners.map((r) => [r.cardNo, r]));
    return cards.map((c) => {
      const r = runnerByCard.get(c.cardNo);
      return {
        id: c.seq,
        cardNo: c.cardNo,
        voltageMv: c.voltageMv,
        readCount: c.readCount,
        runnerId: r?.seq ?? null,
        runnerName: r?.name ?? "",
        className: r?.class?.name ?? "",
        clubName: r?.clubName ?? "",
      };
    });
  }),

  /** Full detail for a card. */
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
          class: { select: { name: true } },
        },
      });
      const latestReadout = await ctx.db.cardReadout.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo },
        orderBy: { readAt: "desc" },
      });
      return {
        cardNo: input.cardNo,
        card: card
          ? {
              id: card.seq,
              voltageMv: card.voltageMv,
              readCount: card.readCount,
            }
          : null,
        runner: runner
          ? {
              id: runner.seq,
              name: runner.name,
              className: runner.class?.name ?? "",
              clubName: runner.clubName,
            }
          : null,
        latestReadout: latestReadout
          ? {
              id: latestReadout.id,
              cardType: latestReadout.cardType,
              punches: latestReadout.punches,
              voltageMv: latestReadout.voltageMv,
              readAt: latestReadout.readAt.toISOString(),
            }
          : null,
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

  /** Link a card to a runner manually. */
  linkCardToRunner: eventProcedure
    .input(z.object({ cardNo: z.number().int(), runnerId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const runner = await ctx.db.runner.findFirst({
        where: { eventId: ctx.event.id, seq: input.runnerId, removed: false },
        select: { id: true },
      });
      if (!runner) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Runner not found",
        });
      }
      const card = await ctx.db.card.findFirst({
        where: { eventId: ctx.event.id, cardNo: input.cardNo, removed: false },
        select: { id: true },
      });
      await ctx.db.runner.update({
        where: { id: runner.id },
        data: { cardNo: input.cardNo, cardId: card?.id ?? null },
      });
      return { ok: true as const };
    }),

  /** Append a free punch to a card. */
  addPunch: eventProcedure
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
      await ctx.db.punch.create({
        data: {
          eventId: ctx.event.id,
          cardNo: input.cardNo,
          controlCode: input.controlCode,
          controlId: control?.id ?? null,
          time: input.time > 0 ? toRelative(input.time, zeroTime) : 0,
          source: "manual",
          isOriginal: false,
        },
      });
      return { ok: true as const };
    }),

  /** Remove a free punch by id (UUID). */
  removePunch: eventProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.punch.update({
        where: { id: input.id },
        data: { removed: true },
      });
      return { ok: true as const };
    }),

  /** Adjust the time on an existing free punch. */
  updatePunchTime: eventProcedure
    .input(z.object({ id: z.string().uuid(), time: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const zeroTime = ctx.event.zeroTime;
      await ctx.db.punch.update({
        where: { id: input.id },
        data: {
          time: input.time > 0 ? toRelative(input.time, zeroTime) : 0,
          isOriginal: false,
        },
      });
      return { ok: true as const };
    }),
});

// Silence unused-import warning until other tooling consumes the constant.
void RunnerStatus;
