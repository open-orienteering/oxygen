import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getCompetitionClient, ensureReadoutTable, incrementCounter } from "../db.js";
import { RunnerStatus } from "@oxygen/shared";
import type { PrismaClient } from "@prisma/client";
import { pushToGoogleSheet } from "../sheetsBackup.js";

/** Special punch type codes in MeOS */
export const PUNCH_START = 1;
export const PUNCH_FINISH = 2;
export const PUNCH_CHECK = 3;

export interface ParsedPunch {
  type: number;
  time: number; // deciseconds since midnight
  source: "card" | "free";
  freePunchId?: number; // oPunch.Id for free punches (enables removal)
}

export interface ControlMatch {
  controlIndex: number;
  controlCode: number;
  punchTime: number;
  splitTime: number;
  cumTime: number;
  status: "ok" | "missing" | "extra";
  source: "card" | "free" | "";
  freePunchId?: number;
}

/**
 * Parse MeOS card punch string: "{type}-{seconds}.{tenths}[@unit][#origin];"
 */
export function parsePunches(punchString: string): ParsedPunch[] {
  if (!punchString) return [];
  const punches: ParsedPunch[] = [];
  const parts = punchString.split(";").filter(Boolean);

  for (const part of parts) {
    const dashIdx = part.indexOf("-");
    if (dashIdx === -1) continue;

    const type = parseInt(part.substring(0, dashIdx), 10);
    let timeStr = part.substring(dashIdx + 1);

    const atIdx = timeStr.indexOf("@");
    if (atIdx !== -1) timeStr = timeStr.substring(0, atIdx);
    const hashIdx = timeStr.indexOf("#");
    if (hashIdx !== -1) timeStr = timeStr.substring(0, hashIdx);

    const dotIdx = timeStr.indexOf(".");
    let time: number;
    if (dotIdx !== -1) {
      const seconds = parseInt(timeStr.substring(0, dotIdx), 10);
      const tenths = parseInt(timeStr.substring(dotIdx + 1), 10) || 0;
      time = seconds * 10 + tenths;
    } else {
      time = parseInt(timeStr, 10) * 10;
    }

    if (!isNaN(type) && !isNaN(time)) {
      punches.push({ type, time, source: "card" });
    }
  }

  return punches;
}

/**
 * Compute a ReadId hash from punch data, matching MeOS's SICard::calculateHash()
 * (SportIdent.cpp:2530-2538). Used for deduplication — identical card reads
 * produce the same hash so we can skip redundant oCard writes.
 */
export function computeReadId(
  punches: { controlCode: number; time: number }[],
  finishTime?: number | null,
  startTime?: number | null,
): number {
  let h = (punches.length * 100000 + (finishTime ?? 0)) >>> 0;
  for (const p of punches) {
    h = (((h * 31 + p.controlCode) >>> 0) * 31 + p.time) >>> 0;
  }
  h = (h + (startTime ?? 0)) >>> 0;
  return h;
}

/**
 * Compute a 0.0–1.0 score for how well the card punches match a course.
 *
 * Base: proportion of course controls matched (0.0–1.0).
 * Penalty: each punch for a control NOT in the competition subtracts 0.10.
 * Controls in the competition but not in this course are "extra" (no penalty).
 */
export function computeMatchScore(
  courseControlCount: number,
  matchedCount: number,
  totalCardPunches: number,
  foreignPunchCount: number,
): number {
  if (courseControlCount === 0 || totalCardPunches === 0) return 0;
  const courseRate = matchedCount / courseControlCount;
  const penalty = foreignPunchCount * 0.10;
  return Math.max(0, Math.min(1, courseRate - penalty));
}

export function parseCourseControls(controls: string): number[] {
  return controls
    .split(";")
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));
}

export function matchPunchesToCourse(
  punches: ParsedPunch[],
  courseControls: number[],
  fallbackStartTime = 0,
) {
  const startPunch = punches.find((p) => p.type === PUNCH_START);
  const finishPunch = punches.find((p) => p.type === PUNCH_FINISH);
  const controlPunches = punches.filter(
    (p) => p.type !== PUNCH_START && p.type !== PUNCH_FINISH && p.type !== PUNCH_CHECK,
  );

  const cardStartTime = startPunch?.time ?? 0;
  const startTime = fallbackStartTime > 0 ? fallbackStartTime : cardStartTime;
  const finishTime = finishPunch?.time ?? 0;

  const matches: ControlMatch[] = [];
  const usedPunchIndices = new Set<number>();
  let punchSearchStart = 0;
  let prevTime = startTime;
  let missingCount = 0;

  for (let ci = 0; ci < courseControls.length; ci++) {
    const expectedCode = courseControls[ci];
    let found = false;

    for (let pi = punchSearchStart; pi < controlPunches.length; pi++) {
      if (controlPunches[pi].type === expectedCode && !usedPunchIndices.has(pi)) {
        const p = controlPunches[pi];
        const splitTime = p.time - prevTime;
        const cumTime = p.time - startTime;

        matches.push({
          controlIndex: ci,
          controlCode: expectedCode,
          punchTime: p.time,
          splitTime,
          cumTime,
          status: "ok",
          source: p.source,
          freePunchId: p.freePunchId,
        });

        usedPunchIndices.add(pi);
        punchSearchStart = pi + 1;
        prevTime = p.time;
        found = true;
        break;
      }
    }

    if (!found) {
      matches.push({
        controlIndex: ci,
        controlCode: expectedCode,
        punchTime: 0,
        splitTime: 0,
        cumTime: 0,
        status: "missing",
        source: "",
      });
      missingCount++;
    }
  }

  const extraPunches = controlPunches.filter(
    (_, idx) => !usedPunchIndices.has(idx),
  );

  return { matches, extraPunches, startTime, cardStartTime, finishTime, missingCount };
}

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
      select: { Name: true, Course: true },
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

  // Normalize MeOS-relative times: MeOS stores punch times as (rawSITime - ZeroTime),
  // which can be negative or much smaller than absolute time-of-day values.
  // Oxygen expects absolute deciseconds since midnight. Detect and fix.
  const hasMeosRelativeTimes = cardPunches.some((p) => p.time < 0);
  let meosZeroTime = 0;
  if (hasMeosRelativeTimes) {
    const event = await client.oEvent.findFirst({ select: { ZeroTime: true } });
    meosZeroTime = event?.ZeroTime ?? 324000; // default 09:00
    const DAY = 864000; // 24 hours in deciseconds
    for (const p of cardPunches) {
      if (p.time !== 0) {
        p.time = ((p.time + meosZeroTime) % DAY + DAY) % DAY;
      }
    }
  }

  // Convert free punches to our format (free punch times are stored in deciseconds)
  const freeParsed: ParsedPunch[] = freePunches.map((p) => ({
    type: p.Type,
    time: p.Time,
    source: "free" as const,
    freePunchId: p.Id,
  }));

  // Merge card + free punches, sorted chronologically so sequential matching works
  const allPunches = [...cardPunches, ...freeParsed].sort((a, b) => a.time - b.time);

  // Parse course controls
  const courseControls = course ? parseCourseControls(course.Controls) : [];

  // If card has MeOS-relative times and runner.StartTime is also negative, normalize it
  const runnerStartTime = hasMeosRelativeTimes && runner.StartTime < 0
    ? ((runner.StartTime + meosZeroTime) % 864000 + 864000) % 864000
    : runner.StartTime;

  // Match punches to course (pass runner's assigned start time as fallback)
  const { matches, extraPunches, startTime, cardStartTime, finishTime, missingCount } =
    matchPunchesToCourse(allPunches, courseControls, runnerStartTime);

  const effectiveStartTime = startTime;
  // MeOS may store times with a negative base offset; the difference is still valid
  const runningTime =
    finishTime !== 0 && effectiveStartTime !== 0
      ? finishTime - effectiveStartTime
      : 0;

  let status: number;
  if (finishTime === 0) {
    status = RunnerStatus.DNF;
  } else if (missingCount > 0) {
    status = RunnerStatus.MissingPunch;
  } else if (runningTime > 0) {
    status = RunnerStatus.OK;
  } else {
    status = runner.Status;
  }

  const missingControls = matches
    .filter((m) => m.status === "missing")
    .map((m) => m.controlCode);

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
        controlCount: courseControls.length,
      }
      : null,
    timing: {
      cardStartTime,
      assignedStartTime: runner.StartTime,
      startTime: effectiveStartTime,
      finishTime,
      runningTime,
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
  readout: publicProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .query(async ({ input }) => {
      const client = await getCompetitionClient();
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
  readoutByRunner: publicProcedure
    .input(z.object({ runnerId: z.number().int() }))
    .query(async ({ input }) => {
      const client = await getCompetitionClient();
      const result = await performReadout(client, input.runnerId);
      return result;
    }),

  /** Add a manual punch correction (stored in oPunch table) */
  addPunch: publicProcedure
    .input(
      z.object({
        cardNo: z.number().int(),
        controlCode: z.number().int(),
        time: z.number().int(), // deciseconds
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      const punch = await client.oPunch.create({
        data: {
          CardNo: input.cardNo,
          Type: input.controlCode,
          Time: input.time,
          Origin: 0, // manual entry
        },
      });
      return { id: punch.Id };
    }),

  /** Remove a manual punch correction (soft delete in oPunch table) */
  removePunch: publicProcedure
    .input(z.object({ punchId: z.number().int() }))
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await client.oPunch.update({
        where: { Id: input.punchId },
        data: { Removed: true },
      });
      return { success: true };
    }),

  /** Update the time of a free punch */
  updatePunchTime: publicProcedure
    .input(
      z.object({
        punchId: z.number().int(),
        time: z.number().int(), // deciseconds
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await client.oPunch.update({
        where: { Id: input.punchId },
        data: { Time: input.time },
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
  storeReadout: publicProcedure
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
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      // Build the MeOS punch string
      const parts: string[] = [];

      // Check time → special type 3 (PUNCH_CHECK)
      if (input.checkTime != null && input.checkTime > 0) {
        const ds = input.checkTime * 10;
        parts.push(`${PUNCH_CHECK}-${Math.floor(ds / 10)}.${ds % 10}`);
      }

      // Start time → special type 1 (PUNCH_START)
      if (input.startTime != null && input.startTime > 0) {
        const ds = input.startTime * 10;
        parts.push(`${PUNCH_START}-${Math.floor(ds / 10)}.${ds % 10}`);
      }

      // Control punches
      for (const p of input.punches) {
        const ds = p.time * 10;
        parts.push(`${p.controlCode}-${Math.floor(ds / 10)}.${ds % 10}`);
      }

      // Finish time → special type 2 (PUNCH_FINISH)
      if (input.finishTime != null && input.finishTime > 0) {
        const ds = input.finishTime * 10;
        parts.push(`${PUNCH_FINISH}-${Math.floor(ds / 10)}.${ds % 10}`);
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
      const voltageStored = input.batteryVoltage
        ? Math.round(input.batteryVoltage * 100)
        : 0;
      const ownerDataJson = input.ownerData ? JSON.stringify(input.ownerData) : null;
      const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

      try {
        await ensureReadoutTable(client);
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

        pushToGoogleSheet(client, {
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

      // Store voltage as raw value (0-255 range matching MeOS format)
      const voltageRaw = input.batteryVoltage
        ? Math.round((input.batteryVoltage - 1.9) / 0.09)
        : undefined;

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
            ...(voltageRaw != null && voltageRaw > 0
              ? { Voltage: voltageRaw }
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
          ...(voltageRaw != null && voltageRaw > 0
            ? { Voltage: voltageRaw }
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
  readoutHistory: publicProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .query(async ({ input }) => {
      const client = await getCompetitionClient();
      try {
        await ensureReadoutTable(client);
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
          voltage: Number(r.Voltage),
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
  cardList: publicProcedure.query(async () => {
    const client = await getCompetitionClient();

    const cards = await client.oCard.findMany({
      where: { Removed: false },
      orderBy: { CardNo: "asc" },
    });

    // Batch-load runner info for linked cards
    const runnerIds = new Set(
      cards.map((c) => c.ReadId).filter((id) => id > 0),
    );
    // Also match by Card FK on oRunner
    const cardIds = new Set(cards.map((c) => c.Id));

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
      await ensureReadoutTable(client);
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

      // Battery voltage: prefer readout history (stored in hundredths of volts)
      // over oCard.Voltage (raw ADC byte, formula: 1.9 + raw * 0.09)
      let batteryVoltage: number | null = null;
      if (historyInfo && historyInfo.voltage > 0) {
        batteryVoltage = historyInfo.voltage / 100; // hundredths → volts
      } else if (card.Voltage > 0) {
        batteryVoltage = 1.9 + card.Voltage * 0.09;
      }

      return {
        id: card.Id,
        cardNo: card.CardNo,
        cardType: historyInfo?.cardType || "",
        voltage: card.Voltage,
        batteryVoltage, // precise voltage in volts (or null)
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
  cardDetail: publicProcedure
    .input(z.object({ cardNo: z.number().int().positive() }))
    .query(async ({ input }) => {
      const client = await getCompetitionClient();

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
        await ensureReadoutTable(client);
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
        voltage: Number(card.Voltage),
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
  applyResult: publicProcedure
    .input(
      z.object({
        runnerId: z.number().int(),
        status: z.number().int(),
        finishTime: z.number().int(),
        startTime: z.number().int(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await client.oRunner.update({
        where: { Id: input.runnerId },
        data: {
          Status: input.status,
          FinishTime: input.finishTime,
          StartTime: input.startTime,
        },
      });
      await incrementCounter("oRunner", input.runnerId);
      return { applied: true, runnerId: input.runnerId, status: input.status, finishTime: input.finishTime, startTime: input.startTime };
    }),
});
