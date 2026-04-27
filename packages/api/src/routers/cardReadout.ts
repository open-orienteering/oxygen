import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, competitionProcedure } from "../trpc.js";
import { ensureReadoutTable, incrementCounter, getZeroTime } from "../db.js";
import { toRelative, toAbsolute } from "../timeConvert.js";
import {
  RunnerStatus, TransferFlags, hasTransferFlag,
  // Re-exported from @oxygen/shared — shared between server and client
  parsePunches, computeReadId, computeMatchScore, parseCourseControls,
  matchPunchesToCourse, computeStatus,
  PUNCH_START, PUNCH_FINISH, PUNCH_CHECK,
  meosFromVolts, voltsFromMeos,
  type ParsedPunch, type ControlMatch,
} from "@oxygen/shared";
import type { PrismaClient } from "@prisma/client";
import { pushToGoogleSheet } from "../sheetsBackup.js";
import { resolveCourseExpectedPositions } from "./course.js";

// Re-export shared functions so existing imports from this file continue to work
export {
  parsePunches, computeReadId, computeMatchScore, parseCourseControls,
  matchPunchesToCourse, computeStatus,
  PUNCH_START, PUNCH_FINISH, PUNCH_CHECK,
  type ParsedPunch, type ControlMatch,
} from "@oxygen/shared";

/**
 * Core readout logic - shared between readout-by-card and readout-by-runner endpoints.
 * Exported so race.ts can reuse it for the finish receipt endpoint.
 */
export async function performReadout(client: PrismaClient, runnerId: number) {
  const runner = await client.oRunner.findFirst({
    where: { Id: runnerId, Removed: false },
  });
  if (!runner) return null;

  const club = runner.Club
    ? await client.oClub.findUnique({ where: { Id: runner.Club }, select: { Name: true } })
    : null;
  const cls = runner.Class
    ? await client.oClass.findUnique({
      where: { Id: runner.Class },
      select: { Name: true, Course: true, MaxTime: true, NoTiming: true },
    })
    : null;

  const courseId = runner.Course || cls?.Course || 0;
  const course = courseId
    ? await client.oCourse.findUnique({ where: { Id: courseId } })
    : null;

  // Get card data (original SI card readout)
  // Prefer linked card (runner.Card FK), fall back to CardNo lookup
  // (card may exist from a prior read before the runner was registered)
  const card = runner.Card
    ? await client.oCard.findUnique({ where: { Id: runner.Card } })
    : await client.oCard.findFirst({
        where: { CardNo: runner.CardNo, Removed: false },
      });

  // Get free punches (radio punches + manual corrections)
  const freePunches = await client.oPunch.findMany({
    where: { CardNo: runner.CardNo, Removed: false },
    orderBy: { Time: "asc" },
  });

  // Parse card punches
  const cardPunches = parsePunches(card?.Punches ?? "");

  // Convert ZeroTime-relative DB times to absolute (MeOS stores all times relative to ZeroTime)
  const zeroTime = await getZeroTime(client);
  for (const p of cardPunches) {
    if (p.time !== 0) p.time = toAbsolute(p.time, zeroTime);
  }

  // Convert free punches to our format (oPunch.Time is also ZeroTime-relative)
  const freeParsed: ParsedPunch[] = freePunches.map((p) => ({
    type: p.Type,
    time: p.Time !== 0 ? toAbsolute(p.Time, zeroTime) : 0,
    source: "free" as const,
    freePunchId: p.Id,
  }));

  // Merge card + free punches, sorted chronologically so sequential matching works
  const allPunches = [...cardPunches, ...freeParsed].sort((a, b) => a.time - b.time);

  // Resolve the course's stored Id list into status-aware per-position
  // descriptors. The matcher then applies MeOS's full evaluation rules:
  // - Multiple expansion (any-order code pool)
  // - Bad / Optional / BadNoTiming positions skipped from missing-punch
  //   accounting (but consumed if punched, mirroring oRunner.cpp:1424-1438)
  // - NoTiming / propagated-from-BadNoTiming legs deducted from runningTime
  //   (mirroring oRunner.cpp:1772-1786).
  const expectedPositions = course
    ? await resolveCourseExpectedPositions(client, course.Controls)
    : [];

  // Convert runner's assigned start time from ZeroTime-relative to absolute
  const runnerStartTime = toAbsolute(runner.StartTime, zeroTime);

  // Match punches to course (pass runner's assigned start time as fallback)
  const {
    matches,
    extraPunches,
    startTime,
    cardStartTime,
    finishTime,
    missingCount,
    runningTimeAdjustment,
  } = matchPunchesToCourse(allPunches, expectedPositions, runnerStartTime);

  const effectiveStartTime = startTime;
  // Raw time across the card (finish - start). The adjusted running time
  // subtracts NoTiming / BadNoTiming legs so that downstream consumers
  // (kiosk, results, leaderboards, Eventor) all see the canonical value.
  const rawRunningTime =
    finishTime !== 0 && effectiveStartTime !== 0
      ? finishTime - effectiveStartTime
      : 0;
  const runningTime = Math.max(0, rawRunningTime - runningTimeAdjustment);

  const status = computeStatus({
    finishTime,
    startTime: effectiveStartTime,
    missingCount,
    runningTime,
    classMaxTime: cls?.MaxTime ?? 0,
    classNoTiming: cls?.NoTiming === 1,
    transferFlags: runner.TransferFlags,
    currentStatus: runner.Status,
  });

  // Only required positions that the runner failed to punch count as
  // "missing" for status banners — skipped positions never bubble up.
  const missingControls = matches
    .filter((m) => m.status === "missing" && m.positionMode === "required")
    .map((m) => m.controlCode);

  // Required positions only (skipped positions don't count toward the
  // X/Y stat the kiosk shows; they were never expected to be punched).
  const requiredCount = matches.filter((m) => m.positionMode !== "skipped").length;

  return {
    runner: {
      id: runner.Id,
      name: runner.Name,
      cardNo: runner.CardNo,
      startNo: runner.StartNo,
      clubName: club?.Name ?? "",
      clubId: runner.Club,
      className: cls?.Name ?? "",
      classId: runner.Class,
      dbStatus: runner.Status,
    },
    isRentalCard: runner.CardFee !== 0,
    cardReturned: runner.oos_card_returned === 1,
    course: course
      ? {
        id: course.Id,
        name: course.Name,
        length: course.Length,
        controlCount: expectedPositions.length,
        requiredControlCount: requiredCount,
      }
      : null,
    timing: {
      cardStartTime,
      assignedStartTime: runner.StartTime,
      startTime: effectiveStartTime,
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
      freePunchId: p.freePunchId,
    })),
    missingControls,
    rawPunchCount: cardPunches.length,
    freePunchCount: freeParsed.length,
    hasCard: !!card,
  };
}

export const cardReadoutRouter = router({
  /** Full card readout by SI card number */
  readout: competitionProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const client = ctx.db;
      const runner = await client.oRunner.findFirst({
        where: { CardNo: input.cardNo, Removed: false },
      });
      if (!runner) {
        return { found: false as const, cardNo: input.cardNo };
      }
      const result = await performReadout(client, runner.Id);
      if (!result) {
        return { found: false as const, cardNo: input.cardNo };
      }
      // Compute match score: how well do the card's punches match the course?
      const matchedCount = result.controls.filter(
        (c) => c.status === "ok",
      ).length;

      // Load competition controls to identify foreign punches
      const allControls = await client.oControl.findMany({
        where: { Removed: false },
        select: { Numbers: true },
      });
      const competitionCodes = new Set<number>();
      for (const c of allControls) {
        const code = parseInt(c.Numbers.split(";")[0], 10);
        if (!isNaN(code) && code > 0) competitionCodes.add(code);
      }
      const foreignPunchCount = competitionCodes.size > 0
        ? result.extraPunches.filter(
            (p) => !competitionCodes.has(p.controlCode),
          ).length
        : 0;

      const matchScore = computeMatchScore(
        result.controls.length,
        matchedCount,
        result.rawPunchCount,
        foreignPunchCount,
      );

      return {
        found: true as const,
        cardNo: input.cardNo,
        matchScore,
        punchesMatchCourse: matchScore >= 0.2,
        ...result,
      };
    }),

  /** Card readout by runner ID (for inline detail) */
  readoutByRunner: competitionProcedure
    .input(z.object({ runnerId: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const client = ctx.db;
      const result = await performReadout(client, input.runnerId);
      return result;
    }),

  /** Add a manual punch correction (stored in oPunch table) */
  addPunch: competitionProcedure
    .input(
      z.object({
        cardNo: z.number().int(),
        controlCode: z.number().int(),
        time: z.number().int(), // deciseconds
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      const zeroTime = await getZeroTime(client);
      const punch = await client.oPunch.create({
        data: {
          CardNo: input.cardNo,
          Type: input.controlCode,
          Time: toRelative(input.time, zeroTime),
          Origin: 0, // manual entry
        },
      });
      return { id: punch.Id };
    }),

  /** Remove a manual punch correction (soft delete in oPunch table) */
  removePunch: competitionProcedure
    .input(z.object({ punchId: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      await client.oPunch.update({
        where: { Id: input.punchId },
        data: { Removed: true },
      });
      return { success: true };
    }),

  /** Update the time of a free punch */
  updatePunchTime: competitionProcedure
    .input(
      z.object({
        punchId: z.number().int(),
        time: z.number().int(), // deciseconds
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      const zeroTime = await getZeroTime(client);
      await client.oPunch.update({
        where: { Id: input.punchId },
        data: { Time: toRelative(input.time, zeroTime) },
      });
      return { success: true };
    }),

  /**
   * Store a full SI card readout from the WebSerial reader.
   * Converts SI punch data (seconds since midnight) into MeOS format
   * (deciseconds) and upserts into the oCard table.
   *
   * MeOS punch format: "{controlCode}-{seconds}.{tenths}[@unit][#origin];"
   * Special types: 1=CHECK, 2=FINISH, 3=START  (note: MeOS uses different numbering than SI)
   *
   * SI times are in seconds since midnight, MeOS times are in deciseconds.
   */
  storeReadout: competitionProcedure
    .input(
      z.object({
        cardNo: z.number().int().positive(),
        punches: z.array(
          z.object({
            controlCode: z.number().int(),
            time: z.number().int(), // seconds since midnight
          }),
        ),
        checkTime: z.number().int().optional(),
        startTime: z.number().int().optional(),
        finishTime: z.number().int().optional(),
        cardType: z.string().optional(),
        batteryVoltage: z.number().optional(),
        punchesFresh: z.boolean().optional(), // client-side DOW freshness check result
        ownerData: z
          .object({
            firstName: z.string().optional(),
            lastName: z.string().optional(),
            sex: z.string().optional(),
            dateOfBirth: z.string().optional(),
            club: z.string().optional(),
            phone: z.string().optional(),
            email: z.string().optional(),
            country: z.string().optional(),
          })
          .optional(),
        metadata: z
          .object({
            batteryDate: z.string().optional(),
            productionDate: z.string().optional(),
            hardwareVersion: z.string().optional(),
            softwareVersion: z.string().optional(),
            clearCount: z.number().optional(),
          })
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      const zeroTime = await getZeroTime(client);

      // Helper: convert absolute seconds → ZeroTime-relative deciseconds punch token
      const fmtPunch = (type: number, absSecs: number, unit?: number) => {
        const relDs = toRelative(absSecs * 10, zeroTime);
        const base = `${type}-${Math.floor(relDs / 10)}.${relDs % 10}`;
        return unit && unit > 0 ? `${base}@${unit}` : base;
      };

      // Build the MeOS punch string (ZeroTime-relative, matching MeOS convention)
      const parts: string[] = [];

      // Check time → special type 3 (PUNCH_CHECK)
      if (input.checkTime != null && input.checkTime > 0) {
        parts.push(fmtPunch(PUNCH_CHECK, input.checkTime));
      }

      // Start time → special type 1 (PUNCH_START)
      if (input.startTime != null && input.startTime > 0) {
        parts.push(fmtPunch(PUNCH_START, input.startTime));
      }

      // Control punches
      for (const p of input.punches) {
        parts.push(fmtPunch(p.controlCode, p.time));
      }

      // Finish time → special type 2 (PUNCH_FINISH)
      if (input.finishTime != null && input.finishTime > 0) {
        parts.push(fmtPunch(PUNCH_FINISH, input.finishTime));
      }

      const punchString = parts.length > 0 ? parts.join(";") + ";" : "";

      // ── Check for foreign controls (stale punch detection) ──
      let punchesRelevant = true;
      if (input.punches.length > 0) {
        const controls = await client.oControl.findMany({
          where: { Removed: false },
          select: { Numbers: true },
        });
        const competitionCodes = new Set<number>();
        for (const c of controls) {
          // oControl.Numbers is semicolon-separated; first value is the code
          const code = parseInt(c.Numbers.split(";")[0], 10);
          if (!isNaN(code) && code > 0) competitionCodes.add(code);
        }

        if (competitionCodes.size > 0) {
          const foreignCount = input.punches.filter(
            (p) => !competitionCodes.has(p.controlCode),
          ).length;
          // Majority of punches must be for this competition's controls
          if (foreignCount > input.punches.length * 0.5) {
            punchesRelevant = false;
          }
        }
      }

      // ── Save readout history (deduplicate by punch content) ─────────
      // Only INSERT if punches differ from the most recent readout for this card.
      // If punches are identical, UPDATE metadata (battery, owner data, timestamp).
      // Voltage is stored as integer millivolts (matches MeOS oCard.Voltage).
      const voltageStored = meosFromVolts(input.batteryVoltage) ?? 0;
      const ownerDataJson = input.ownerData ? JSON.stringify(input.ownerData) : null;
      const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

      try {
        await ensureReadoutTable(client, ctx.dbName);
        const latest = await client.$queryRawUnsafe<Array<{ Id: bigint; Punches: string }>>(
          `SELECT Id, Punches FROM oxygen_card_readouts
           WHERE CardNo = ? ORDER BY ReadAt DESC LIMIT 1`,
          input.cardNo,
        );
        if (latest.length > 0 && latest[0].Punches === punchString) {
          // Same punches — update metadata and timestamp on existing row
          await client.$executeRawUnsafe(
            `UPDATE oxygen_card_readouts
             SET ReadAt = NOW(), CardType = ?, Voltage = ?, OwnerData = ?, Metadata = ?
             WHERE Id = ?`,
            input.cardType ?? "",
            voltageStored,
            ownerDataJson,
            metadataJson,
            latest[0].Id,
          );
        } else {
          // New or different punches — insert new history row
          await client.$executeRawUnsafe(
            `INSERT INTO oxygen_card_readouts (CardNo, CardType, Punches, Voltage, OwnerData, Metadata)
             VALUES (?, ?, ?, ?, ?, ?)`,
            input.cardNo,
            input.cardType ?? "",
            punchString,
            voltageStored,
            ownerDataJson,
            metadataJson,
          );
        }
      } catch {
        // Non-critical — readout history is supplementary
        console.warn("[cardReadout] Failed to save readout history");
      }

      // ── Fire-and-forget Google Sheets backup ────────────────
      {
        const runner = await client.oRunner.findFirst({
          where: { CardNo: input.cardNo, Removed: false },
          select: { Name: true, Class: true, Club: true, StartNo: true },
        });
        const cls = runner?.Class
          ? await client.oClass.findUnique({ where: { Id: runner.Class }, select: { Name: true } })
          : null;
        const club = runner?.Club
          ? await client.oClub.findUnique({ where: { Id: runner.Club }, select: { Name: true } })
          : null;

        const fmtTime = (secs: number) => {
          const h = Math.floor(secs / 3600);
          const m = Math.floor((secs % 3600) / 60);
          const s = secs % 60;
          return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        };

        pushToGoogleSheet(client, ctx.dbName, {
          timestamp: new Date().toISOString(),
          cardNo: input.cardNo,
          cardType: input.cardType ?? "",
          runnerName: runner?.Name ?? "",
          className: cls?.Name ?? "",
          clubName: club?.Name ?? "",
          startNo: runner?.StartNo ?? 0,
          checkTime: input.checkTime ?? null,
          startTime: input.startTime ?? null,
          finishTime: input.finishTime ?? null,
          punchCount: input.punches.length,
          punches: input.punches.map((p) => `${p.controlCode}:${fmtTime(p.time)}`).join(","),
          punchesRelevant,
          batteryVoltage: input.batteryVoltage ?? null,
        });
      }

      // ── Upsert into oCard (only for real readouts, not registration scans) ──
      // oCard should only contain real race data (matches MeOS behavior).
      // Three conditions must ALL be true:
      //   1. punchesRelevant — no foreign controls detected
      //   2. hasControlPunches — not just check/start/finish
      //   3. punchesFresh !== false — client DOW check didn't flag as stale
      const hasControlPunches = input.punches.length > 0;
      const shouldWriteOCard =
        punchesRelevant && hasControlPunches && input.punchesFresh !== false;

      if (!shouldWriteOCard) {
        return { cardId: null as number | null, created: false, punchesRelevant };
      }

      // Find the runner to prefer their linked oCard
      const runner = await client.oRunner.findFirst({
        where: { CardNo: input.cardNo, Removed: false },
        select: { Id: true, Card: true },
      });

      // Prefer runner-linked card, then non-removed by CardNo, then any by CardNo
      const linkedCard =
        runner?.Card
          ? await client.oCard.findUnique({ where: { Id: runner.Card } })
          : null;
      const existing =
        linkedCard ??
        (await client.oCard.findFirst({
          where: { CardNo: input.cardNo, Removed: false },
        })) ??
        (await client.oCard.findFirst({
          where: { CardNo: input.cardNo },
        }));

      // MeOS stores oCard.Voltage as integer millivolts (e.g. 2980 = 2.98 V).
      const voltageMv = meosFromVolts(input.batteryVoltage) ?? undefined;

      // Compute ReadId hash for deduplication (matches MeOS's calculateHash)
      const readId = computeReadId(input.punches, input.finishTime, input.startTime);

      if (existing) {
        // Skip update if identical data (ReadId deduplication)
        if (existing.ReadId === readId) {
          // Still link runner if not yet linked
          if (runner && !runner.Card) {
            await client.oRunner.update({
              where: { Id: runner.Id },
              data: { Card: existing.Id },
            });
          }
          return { cardId: existing.Id as number | null, created: false, punchesRelevant };
        }

        await client.oCard.update({
          where: { Id: existing.Id },
          data: {
            Punches: punchString,
            ReadId: readId,
            Removed: false, // ensure card is visible after re-read
            ...(voltageMv != null && voltageMv > 0
              ? { Voltage: voltageMv }
              : {}),
          },
        });

        // Link runner on update path too (not just create)
        if (runner && !runner.Card) {
          await client.oRunner.update({
            where: { Id: runner.Id },
            data: { Card: existing.Id },
          });
        }

        return { cardId: existing.Id as number | null, created: false, punchesRelevant };
      }

      const card = await client.oCard.create({
        data: {
          CardNo: input.cardNo,
          Punches: punchString,
          ReadId: readId,
          ...(voltageMv != null && voltageMv > 0
            ? { Voltage: voltageMv }
            : {}),
        },
      });

      // Link the card to the runner if one exists with this card number
      if (runner && !runner.Card) {
        await client.oRunner.update({
          where: { Id: runner.Id },
          data: { Card: card.Id },
        });
      }

      return { cardId: card.Id as number | null, created: true, punchesRelevant };
    }),

  /** List readout history for a card number */
  readoutHistory: competitionProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const client = ctx.db;
      try {
        await ensureReadoutTable(client, ctx.dbName);
        const rows = await client.$queryRawUnsafe<
          Array<{
            Id: bigint | number;
            CardNo: bigint | number;
            CardType: string;
            Punches: string;
            Voltage: bigint | number;
            OwnerData: string | null;
            Metadata: string | null;
            ReadAt: Date;
          }>
        >(
          `SELECT Id, CardNo, CardType, Punches, Voltage, OwnerData, Metadata, ReadAt
           FROM oxygen_card_readouts
           WHERE CardNo = ?
           ORDER BY ReadAt DESC
           LIMIT 50`,
          input.cardNo,
        );
        // Prisma raw SQL returns MySQL INT columns as BigInt — convert to Number
        return rows.map((r) => ({
          id: Number(r.Id),
          cardNo: Number(r.CardNo),
          cardType: r.CardType,
          punches: r.Punches,
          batteryVoltage: voltsFromMeos(r.Voltage),
          ownerData: r.OwnerData ? (JSON.parse(r.OwnerData) as unknown) : null,
          metadata: r.Metadata ? (JSON.parse(r.Metadata) as unknown) : null,
          readAt: r.ReadAt.toISOString(),
        }));
      } catch {
        return [];
      }
    }),

  // ─── Card list / detail endpoints ───────────────────────

  /** List all cards with linked runner info */
  cardList: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;

    // Ensure the voltage-encoding migration has run before we read oCard.Voltage.
    await ensureReadoutTable(client, ctx.dbName);

    const allCards = await client.oCard.findMany({
      where: { Removed: false },
      orderBy: { CardNo: "asc" },
    });

    // Deduplicate by CardNo — keep the record with the highest Id (newest)
    const dedupMap = new Map<number, (typeof allCards)[number]>();
    for (const card of allCards) {
      const existing = dedupMap.get(card.CardNo);
      if (!existing || card.Id > existing.Id) {
        dedupMap.set(card.CardNo, card);
      }
    }
    const cards = [...dedupMap.values()];

    const runners = await client.oRunner.findMany({
      where: { Removed: false },
      select: {
        Id: true,
        Name: true,
        CardNo: true,
        Card: true,
        Club: true,
        Class: true,
        Status: true,
        CardFee: true,
        oos_card_returned: true,
      },
    });

    // Build a map: cardNo → runner
    const runnerByCardNo = new Map<number, (typeof runners)[number]>();
    const runnerByCardId = new Map<number, (typeof runners)[number]>();
    for (const r of runners) {
      if (r.CardNo > 0) runnerByCardNo.set(r.CardNo, r);
      if (r.Card > 0) runnerByCardId.set(r.Card, r);
    }

    // Load clubs and classes for display
    const clubs = await client.oClub.findMany({
      where: { Removed: false },
      select: { Id: true, Name: true },
    });
    const clubMap = new Map(clubs.map((c) => [c.Id, c.Name]));

    const classes = await client.oClass.findMany({
      where: { Removed: false },
      select: { Id: true, Name: true },
    });
    const classMap = new Map(classes.map((c) => [c.Id, c.Name]));

    // Try to get latest readout info (card type, voltage, metadata) from history
    let cardInfoMap = new Map<
      number,
      { cardType: string; voltage: number; metadata: unknown }
    >();
    try {
      await ensureReadoutTable(client, ctx.dbName);
      const infoRows = await client.$queryRawUnsafe<
        Array<{
          CardNo: bigint | number;
          CardType: string;
          Voltage: bigint | number;
          Metadata: string | null;
        }>
      >(
        `SELECT r.CardNo, r.CardType, r.Voltage, r.Metadata FROM oxygen_card_readouts r
         INNER JOIN (
           SELECT CardNo, MAX(ReadAt) as MaxReadAt
           FROM oxygen_card_readouts
           GROUP BY CardNo
         ) latest ON r.CardNo = latest.CardNo AND r.ReadAt = latest.MaxReadAt`,
      );
      cardInfoMap = new Map(
        infoRows.map((r) => [
          Number(r.CardNo),
          {
            cardType: r.CardType,
            voltage: Number(r.Voltage),
            metadata: r.Metadata ? (JSON.parse(r.Metadata) as unknown) : null,
          },
        ]),
      );
    } catch {
      // ok
    }

    return cards.map((card) => {
      const runner =
        runnerByCardId.get(card.Id) ?? runnerByCardNo.get(card.CardNo);
      const punchCount = card.Punches
        ? card.Punches.split(";").filter(Boolean).length
        : 0;
      const historyInfo = cardInfoMap.get(card.CardNo);

      // Battery voltage is stored as integer millivolts (MeOS-compatible).
      // Prefer the readout-history reading if present (it's what we just
      // observed at the readout station), otherwise fall back to oCard.Voltage.
      const batteryVoltage =
        voltsFromMeos(historyInfo?.voltage) ?? voltsFromMeos(card.Voltage);

      return {
        id: card.Id,
        cardNo: card.CardNo,
        cardType: historyInfo?.cardType || "",
        batteryVoltage, // volts, or null when not measured
        punchCount,
        hasPunches: punchCount > 0,
        modified: card.Modified?.toISOString() ?? null,
        runner: runner
          ? {
            id: runner.Id,
            name: runner.Name,
            clubName: clubMap.get(runner.Club) ?? "",
            clubId: runner.Club,
            className: classMap.get(runner.Class) ?? "",
            status: runner.Status,
            isRentalCard: runner.CardFee !== 0,
            cardReturned: runner.oos_card_returned === 1,
          }
          : null,
      };
    });
  }),

  /** Get detail for a single card (parsed punches + owner data from latest readout) */
  cardDetail: competitionProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const client = ctx.db;

      // Ensure the voltage-encoding migration has run before we read oCard.Voltage.
      await ensureReadoutTable(client, ctx.dbName);

      const card = await client.oCard.findFirst({
        where: { CardNo: input.cardNo, Removed: false },
      });

      if (!card) return null;

      // Parse the MeOS punch string into structured data
      const rawPunches = parsePunches(card.Punches ?? "");
      const startPunch = rawPunches.find((p) => p.type === PUNCH_START);
      const finishPunch = rawPunches.find((p) => p.type === PUNCH_FINISH);
      const checkPunch = rawPunches.find((p) => p.type === PUNCH_CHECK);
      const controlPunches = rawPunches.filter(
        (p) =>
          p.type !== PUNCH_START &&
          p.type !== PUNCH_FINISH &&
          p.type !== PUNCH_CHECK,
      );

      // Get linked runner — use select to avoid BigInt fields (ExtId, ExtId2)
      const runner = await client.oRunner.findFirst({
        where: {
          OR: [
            { Card: card.Id, Removed: false },
            { CardNo: input.cardNo, Removed: false },
          ],
        },
        select: {
          Id: true,
          Name: true,
          Club: true,
          Class: true,
          Status: true,
          CardFee: true,
          oos_card_returned: true,
        },
      });

      let runnerInfo = null;
      if (runner) {
        const club = runner.Club
          ? await client.oClub.findUnique({
            where: { Id: runner.Club },
            select: { Name: true },
          })
          : null;
        const cls = runner.Class
          ? await client.oClass.findUnique({
            where: { Id: runner.Class },
            select: { Name: true },
          })
          : null;
        runnerInfo = {
          id: runner.Id,
          name: runner.Name,
          clubName: club?.Name ?? "",
          clubId: runner.Club,
          className: cls?.Name ?? "",
          status: runner.Status,
          isRentalCard: runner.CardFee !== 0,
          cardReturned: runner.oos_card_returned === 1,
        };
      }

      // Get latest readout for card type / owner data / metadata
      let cardType = "";
      let ownerData: unknown = null;
      let metadata: unknown = null;
      try {
        await ensureReadoutTable(client, ctx.dbName);
        const latest = await client.$queryRawUnsafe<
          Array<{
            CardType: string;
            OwnerData: string | null;
            Metadata: string | null;
            Voltage: bigint | number;
          }>
        >(
          `SELECT CardType, OwnerData, Metadata, Voltage FROM oxygen_card_readouts
           WHERE CardNo = ? ORDER BY ReadAt DESC LIMIT 1`,
          input.cardNo,
        );
        if (latest.length > 0) {
          cardType = latest[0].CardType;
          ownerData = latest[0].OwnerData
            ? (JSON.parse(latest[0].OwnerData) as unknown)
            : null;
          metadata = latest[0].Metadata
            ? (JSON.parse(latest[0].Metadata) as unknown)
            : null;
        }
      } catch {
        // ok
      }

      return {
        id: Number(card.Id),
        cardNo: Number(card.CardNo),
        cardType,
        batteryVoltage: voltsFromMeos(card.Voltage),
        ownerData,
        metadata,
        runner: runnerInfo,
        checkTime: checkPunch?.time ?? null,
        startTime: startPunch?.time ?? null,
        finishTime: finishPunch?.time ?? null,
        punches: controlPunches.map((p) => ({
          controlCode: p.type,
          time: p.time,
        })),
        rawPunchString: card.Punches,
        modified: card.Modified?.toISOString() ?? null,
      };
    }),

  /**
   * Apply the computed result from a card readout to the runner record.
   * This is the "readout station" step: after punches are evaluated,
   * persist the status (OK/MP/DNF) and finish time back to oRunner.
   */
  applyResult: competitionProcedure
    .input(
      z.object({
        runnerId: z.number().int(),
        status: z.number().int(),
        finishTime: z.number().int(),
        startTime: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      const zeroTime = await getZeroTime(client);
      await client.oRunner.update({
        where: { Id: input.runnerId },
        data: {
          Status: input.status,
          FinishTime: toRelative(input.finishTime, zeroTime),
          StartTime: toRelative(input.startTime, zeroTime),
        },
      });
      await incrementCounter("oRunner", input.runnerId, ctx.dbName);
      return { applied: true, runnerId: input.runnerId, status: input.status, finishTime: input.finishTime, startTime: input.startTime };
    }),

  /** Manually link or unlink a card to/from a runner */
  linkCardToRunner: competitionProcedure
    .input(
      z.object({
        cardId: z.number().int().positive(),
        runnerId: z.number().int().nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;

      const card = await client.oCard.findUnique({ where: { Id: input.cardId } });
      if (!card) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Card not found" });
      }

      // Clear any runner currently linked to this card (by Card FK or CardNo)
      const oldRunners = await client.oRunner.findMany({
        where: {
          OR: [{ Card: card.Id }, { CardNo: card.CardNo }],
          Removed: false,
        },
        select: { Id: true },
      });
      for (const r of oldRunners) {
        await client.oRunner.update({
          where: { Id: r.Id },
          data: { Card: 0, CardNo: 0 },
        });
      }

      // Link new runner if provided
      if (input.runnerId) {
        const runner = await client.oRunner.findUnique({
          where: { Id: input.runnerId },
          select: { Id: true, Removed: true },
        });
        if (!runner || runner.Removed) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Runner not found" });
        }
        await client.oRunner.update({
          where: { Id: input.runnerId },
          data: { CardNo: card.CardNo, Card: card.Id },
        });
      }

      return { success: true };
    }),
});
