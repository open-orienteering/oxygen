import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getCompetitionClient, ensureReadoutTable } from "../db.js";
import { RunnerStatus } from "@oxygen/shared";
import type { PrismaClient } from "@prisma/client";

/** Special punch type codes in MeOS */
const PUNCH_START = 1;
const PUNCH_FINISH = 2;
const PUNCH_CHECK = 3;

interface ParsedPunch {
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
function parsePunches(punchString: string): ParsedPunch[] {
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

function parseCourseControls(controls: string): number[] {
  return controls
    .split(";")
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n));
}

function matchPunchesToCourse(
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
  const startTime = cardStartTime > 0 ? cardStartTime : fallbackStartTime;
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
 */
async function performReadout(client: PrismaClient, runnerId: number) {
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
  const card = runner.Card
    ? await client.oCard.findUnique({ where: { Id: runner.Card } })
    : null;

  // Get free punches (radio punches + manual corrections)
  const freePunches = await client.oPunch.findMany({
    where: { CardNo: runner.CardNo, Removed: false },
    orderBy: { Time: "asc" },
  });

  // Parse card punches
  const cardPunches = parsePunches(card?.Punches ?? "");

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

  // Match punches to course (pass runner's assigned start time as fallback)
  const { matches, extraPunches, startTime, cardStartTime, finishTime, missingCount } =
    matchPunchesToCourse(allPunches, courseControls, runner.StartTime);

  const effectiveStartTime = startTime;
  const runningTime =
    finishTime > 0 && effectiveStartTime > 0
      ? finishTime - effectiveStartTime
      : 0;

  let status: number;
  if (finishTime <= 0) {
    status = RunnerStatus.DNF;
  } else if (missingCount > 0) {
    status = RunnerStatus.MissingPunch;
  } else if (effectiveStartTime > 0 && finishTime > 0) {
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
      return { found: true as const, cardNo: input.cardNo, ...result };
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

      // ── Save readout history ────────────────────────────
      try {
        await ensureReadoutTable(client);
        await client.$executeRawUnsafe(
          `INSERT INTO oxygen_card_readouts (CardNo, CardType, Punches, Voltage, OwnerData, Metadata)
           VALUES (?, ?, ?, ?, ?, ?)`,
          input.cardNo,
          input.cardType ?? "",
          punchString,
          input.batteryVoltage
            ? Math.round(input.batteryVoltage * 100)
            : 0,
          input.ownerData ? JSON.stringify(input.ownerData) : null,
          input.metadata ? JSON.stringify(input.metadata) : null,
        );
      } catch {
        // Non-critical — readout history is supplementary
        console.warn("[cardReadout] Failed to save readout history");
      }

      // ── Upsert into oCard ──────────────────────────────
      // Prefer non-removed cards; fall back to any card with same number
      const existing =
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

      if (existing) {
        await client.oCard.update({
          where: { Id: existing.Id },
          data: {
            Punches: punchString,
            Removed: false, // ensure card is visible after re-read
            ...(voltageRaw != null && voltageRaw > 0
              ? { Voltage: voltageRaw }
              : {}),
          },
        });
        return { cardId: existing.Id, created: false };
      }

      const card = await client.oCard.create({
        data: {
          CardNo: input.cardNo,
          Punches: punchString,
          ReadId: 0,
          ...(voltageRaw != null && voltageRaw > 0
            ? { Voltage: voltageRaw }
            : {}),
        },
      });

      // Link the card to the runner if one exists with this card number
      const runner = await client.oRunner.findFirst({
        where: { CardNo: input.cardNo, Removed: false },
      });
      if (runner && !runner.Card) {
        await client.oRunner.update({
          where: { Id: runner.Id },
          data: { Card: card.Id },
        });
      }

      return { cardId: card.Id, created: true };
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
});
