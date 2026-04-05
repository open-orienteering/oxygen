import { z } from "zod";
import { router, competitionProcedure } from "../trpc.js";
import {
  getMainDbConnection,
  incrementCounter,
  ensureRunnerDbTable,
  ensureClubDbTable,
  getZeroTime,
} from "../db.js";
import { toAbsolute } from "../timeConvert.js";
import { RunnerStatus } from "@oxygen/shared";
import { generateDrawPreview } from "../draw/index.js";
import type { PrismaClient } from "@prisma/client";
import type mysql from "mysql2/promise";
import {
  MALE_FIRST_NAMES,
  FEMALE_FIRST_NAMES,
  LAST_NAMES,
  CLUBS,
  SI_CARD_RANGES,
} from "./fictional-names.js";

// ─── Class definitions (standard Swedish long-distance) ─────

interface ClassDef {
  name: string;
  sex: string; // "M", "F", ""
  lowAge: number;
  highAge: number;
  courseTier: number; // 1-8, maps to course difficulty
  sortIndex: number;
}

const CLASS_DEFS: ClassDef[] = [
  // Youth
  { name: "H10", sex: "M", lowAge: 0, highAge: 10, courseTier: 1, sortIndex: 10 },
  { name: "D10", sex: "F", lowAge: 0, highAge: 10, courseTier: 1, sortIndex: 11 },
  { name: "H12", sex: "M", lowAge: 0, highAge: 12, courseTier: 2, sortIndex: 20 },
  { name: "D12", sex: "F", lowAge: 0, highAge: 12, courseTier: 2, sortIndex: 21 },
  { name: "H14", sex: "M", lowAge: 0, highAge: 14, courseTier: 3, sortIndex: 30 },
  { name: "D14", sex: "F", lowAge: 0, highAge: 14, courseTier: 3, sortIndex: 31 },
  { name: "H16", sex: "M", lowAge: 0, highAge: 16, courseTier: 4, sortIndex: 40 },
  { name: "D16", sex: "F", lowAge: 0, highAge: 16, courseTier: 4, sortIndex: 41 },
  // Junior / Senior
  { name: "H18", sex: "M", lowAge: 0, highAge: 18, courseTier: 5, sortIndex: 50 },
  { name: "D18", sex: "F", lowAge: 0, highAge: 18, courseTier: 5, sortIndex: 51 },
  { name: "H20", sex: "M", lowAge: 0, highAge: 20, courseTier: 6, sortIndex: 60 },
  { name: "D20", sex: "F", lowAge: 0, highAge: 20, courseTier: 6, sortIndex: 61 },
  { name: "H21", sex: "M", lowAge: 17, highAge: 0, courseTier: 8, sortIndex: 70 },
  { name: "D21", sex: "F", lowAge: 17, highAge: 0, courseTier: 7, sortIndex: 71 },
  // Veteran
  { name: "H35", sex: "M", lowAge: 35, highAge: 0, courseTier: 6, sortIndex: 100 },
  { name: "D35", sex: "F", lowAge: 35, highAge: 0, courseTier: 5, sortIndex: 101 },
  { name: "H40", sex: "M", lowAge: 40, highAge: 0, courseTier: 6, sortIndex: 110 },
  { name: "D40", sex: "F", lowAge: 40, highAge: 0, courseTier: 5, sortIndex: 111 },
  { name: "H45", sex: "M", lowAge: 45, highAge: 0, courseTier: 5, sortIndex: 120 },
  { name: "D45", sex: "F", lowAge: 45, highAge: 0, courseTier: 4, sortIndex: 121 },
  { name: "H50", sex: "M", lowAge: 50, highAge: 0, courseTier: 5, sortIndex: 130 },
  { name: "D50", sex: "F", lowAge: 50, highAge: 0, courseTier: 4, sortIndex: 131 },
  { name: "H55", sex: "M", lowAge: 55, highAge: 0, courseTier: 4, sortIndex: 140 },
  { name: "D55", sex: "F", lowAge: 55, highAge: 0, courseTier: 3, sortIndex: 141 },
  { name: "H60", sex: "M", lowAge: 60, highAge: 0, courseTier: 4, sortIndex: 150 },
  { name: "D60", sex: "F", lowAge: 60, highAge: 0, courseTier: 3, sortIndex: 151 },
  { name: "H65", sex: "M", lowAge: 65, highAge: 0, courseTier: 3, sortIndex: 160 },
  { name: "D65", sex: "F", lowAge: 65, highAge: 0, courseTier: 2, sortIndex: 161 },
  { name: "H70", sex: "M", lowAge: 70, highAge: 0, courseTier: 2, sortIndex: 170 },
  { name: "D70", sex: "F", lowAge: 70, highAge: 0, courseTier: 2, sortIndex: 171 },
  { name: "H75", sex: "M", lowAge: 75, highAge: 0, courseTier: 2, sortIndex: 180 },
  { name: "D75", sex: "F", lowAge: 75, highAge: 0, courseTier: 1, sortIndex: 181 },
  { name: "H80", sex: "M", lowAge: 80, highAge: 0, courseTier: 1, sortIndex: 190 },
  { name: "D80", sex: "F", lowAge: 80, highAge: 0, courseTier: 1, sortIndex: 191 },
  // Open
  { name: "Inskolning", sex: "", lowAge: 0, highAge: 0, courseTier: 1, sortIndex: 200 },
  { name: "Öppen kort", sex: "", lowAge: 0, highAge: 0, courseTier: 2, sortIndex: 210 },
  { name: "Öppen mellan", sex: "", lowAge: 0, highAge: 0, courseTier: 4, sortIndex: 220 },
  { name: "Öppen lång", sex: "", lowAge: 0, highAge: 0, courseTier: 6, sortIndex: 230 },
];

// ─── Course definitions ─────────────────────────────────────

interface CourseDef {
  tier: number;
  name: string;
  numControls: number;
  lengthMeters: number;
  firstControlGroup: number; // 1-4 — determines which first control this course uses
}

const COURSE_DEFS: CourseDef[] = [
  { tier: 1, name: "Bana 1 (Mycket lätt)", numControls: 5, lengthMeters: 2000, firstControlGroup: 1 },
  { tier: 2, name: "Bana 2 (Lätt)", numControls: 8, lengthMeters: 3500, firstControlGroup: 2 },
  { tier: 3, name: "Bana 3 (Lätt-medel)", numControls: 10, lengthMeters: 4500, firstControlGroup: 1 },
  { tier: 4, name: "Bana 4 (Medel)", numControls: 13, lengthMeters: 5500, firstControlGroup: 3 },
  { tier: 5, name: "Bana 5 (Medel-svår)", numControls: 15, lengthMeters: 7000, firstControlGroup: 2 },
  { tier: 6, name: "Bana 6 (Svår)", numControls: 18, lengthMeters: 9000, firstControlGroup: 4 },
  { tier: 7, name: "Bana 7 (Dam lång)", numControls: 20, lengthMeters: 10500, firstControlGroup: 3 },
  { tier: 8, name: "Bana 8 (Herr lång)", numControls: 24, lengthMeters: 12500, firstControlGroup: 4 },
];

// Base pace per tier (seconds per km) — used for simulation
const TIER_PACE: Record<number, { base: number; spread: number }> = {
  1: { base: 600, spread: 0.25 }, // ~10 min/km, youth/easy
  2: { base: 540, spread: 0.22 },
  3: { base: 480, spread: 0.20 },
  4: { base: 440, spread: 0.18 },
  5: { base: 400, spread: 0.17 },
  6: { base: 370, spread: 0.16 },
  7: { base: 350, spread: 0.15 }, // ~5:50 min/km, elite women
  8: { base: 330, spread: 0.15 }, // ~5:30 min/km, elite men
};

// Distribution weights for class sizes (per-class weights summing to ~1.0)
function getClassWeight(def: ClassDef): number {
  if (def.name === "H21" || def.name === "D21") return 10;
  if (def.name.startsWith("H20") || def.name.startsWith("D20")) return 5;
  if (def.name.startsWith("H18") || def.name.startsWith("D18")) return 4;
  if (def.name.startsWith("H16") || def.name.startsWith("D16")) return 3;
  if (def.name.startsWith("H14") || def.name.startsWith("D14")) return 2.5;
  if (def.name.startsWith("H12") || def.name.startsWith("D12")) return 2;
  if (def.name.startsWith("H10") || def.name.startsWith("D10")) return 1.5;
  // Veteran: decreasing with age
  const ageMatch = def.name.match(/\d+/);
  if (ageMatch) {
    const age = parseInt(ageMatch[0], 10);
    if (age >= 35) return Math.max(0.5, 4 - (age - 35) / 10);
  }
  // Open classes
  if (def.name.startsWith("Öppen") || def.name === "Inskolning") return 1;
  return 1;
}

// ─── Simulation state ───────────────────────────────────────

interface SimulatedReadout {
  runnerId: number;
  cardNo: number;
  finishTimeDs: number; // deciseconds since midnight — when readout triggers
  punchString: string; // MeOS format
  status: number; // RunnerStatus value
  finishDs: number; // finish punch time in deciseconds
}

interface SimulationState {
  running: boolean;
  timer: ReturnType<typeof setInterval> | null;
  schedule: SimulatedReadout[];
  processed: number;
  total: number;
  startedAtReal: number; // Date.now()
  simTimeOriginDs: number; // simulated time origin (earliest start)
  speedMultiplier: number;
  simTimeAtLastSpeedChange: number; // simulated time (ds) when speed last changed
  realTimeAtLastSpeedChange: number; // Date.now() when speed last changed
  dbName: string;
}

const simulations = new Map<string, SimulationState>();

// ─── Helpers ────────────────────────────────────────────────

function gaussianRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function buildControls(): { controlsByTier: Map<number, number[]>; allControlCodes: number[] } {
  // Generate a pool of control codes 31-80 (50 controls)
  const pool: number[] = [];
  for (let i = 31; i <= 80; i++) pool.push(i);

  // Shuffle the pool
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  // Reserve 4 controls as dedicated "first controls" — one per group.
  // These are the first control runners visit after start, used by the
  // draw to separate consecutive starters heading to different controls.
  const firstControls = pool.splice(0, 4); // group 1-4 → firstControls[0-3]

  // Map from firstControlGroup (1-4) → first control code for each tier
  const tierFirstControl = new Map<number, number>();
  for (const def of COURSE_DEFS) {
    tierFirstControl.set(def.tier, firstControls[def.firstControlGroup - 1]);
  }

  // Build courses top-down: tier 8 gets the most controls, each lower tier
  // is roughly a subset with ~60% overlap from the tier above.
  // The numControls count includes the first control, so we allocate
  // (numControls - 1) body controls from the pool.
  const controlsByTier = new Map<number, number[]>();
  let cursor = 0;

  // Tier 8 (24 total = 1 first + 23 body)
  const body8 = pool.slice(cursor, cursor + 23);
  cursor += 23;
  controlsByTier.set(8, [tierFirstControl.get(8)!, ...body8]);

  // Tier 7 (20 total = 1 first + 19 body) — 13 shared with tier 8's body, 6 new
  const body7 = [...body8.slice(0, 13), ...pool.slice(cursor, cursor + 6)];
  cursor += 6;
  controlsByTier.set(7, [tierFirstControl.get(7)!, ...body7]);

  // Tier 6 (18 total = 1 first + 17 body) — 11 shared with tier 7's body, 6 new
  const body6 = [...body7.slice(0, 11), ...pool.slice(cursor, cursor + 6)];
  cursor += 6;
  controlsByTier.set(6, [tierFirstControl.get(6)!, ...body6]);

  // Tier 5 (15 total = 1 first + 14 body) — subset of tier 6 body
  controlsByTier.set(5, [tierFirstControl.get(5)!, ...body6.slice(0, 14)]);

  // Tier 4 (13 total = 1 first + 12 body) — subset of tier 5 body
  controlsByTier.set(4, [tierFirstControl.get(4)!, ...body6.slice(0, 12)]);

  // Tier 3 (10 total = 1 first + 9 body) — subset of tier 4 body
  controlsByTier.set(3, [tierFirstControl.get(3)!, ...body6.slice(0, 9)]);

  // Tier 2 (8 total = 1 first + 7 body) — subset of tier 3 body
  controlsByTier.set(2, [tierFirstControl.get(2)!, ...body6.slice(0, 7)]);

  // Tier 1 (5 total = 1 first + 4 body) — subset of tier 2 body
  controlsByTier.set(1, [tierFirstControl.get(1)!, ...body6.slice(0, 4)]);

  // Collect all unique control codes
  const allCodes = new Set<number>();
  for (const codes of controlsByTier.values()) {
    for (const c of codes) allCodes.add(c);
  }

  return { controlsByTier, allControlCodes: [...allCodes].sort((a, b) => a - b) };
}

async function upsertControl(
  client: PrismaClient,
  dbName: string,
  id: number,
  numbers: string,
  name: string,
  status: number,
) {
  const existing = await client.oControl.findFirst({ where: { Id: id } });
  if (existing) {
    if (existing.Removed) {
      await client.oControl.update({
        where: { Id: id },
        data: { Numbers: numbers, Name: name, Status: status, Removed: false },
      });
    }
    return;
  }
  await client.oControl.create({
    data: { Id: id, Numbers: numbers, Name: name, Status: status },
  });
  await incrementCounter("oControl", id, dbName);
}

const PUNCH_START = 1;
const PUNCH_FINISH = 2;
const PUNCH_CHECK = 3;

function buildMeosPunchString(opts: {
  checkTimeDs?: number;
  startTimeDs: number;
  controlPunches: { code: number; timeDs: number }[];
  finishTimeDs?: number;
}): string {
  const parts: string[] = [];
  if (opts.checkTimeDs && opts.checkTimeDs > 0) {
    const s = Math.floor(opts.checkTimeDs / 10);
    const t = opts.checkTimeDs % 10;
    parts.push(`${PUNCH_CHECK}-${s}.${t}`);
  }
  if (opts.startTimeDs > 0) {
    const s = Math.floor(opts.startTimeDs / 10);
    const t = opts.startTimeDs % 10;
    parts.push(`${PUNCH_START}-${s}.${t}`);
  }
  for (const p of opts.controlPunches) {
    const s = Math.floor(p.timeDs / 10);
    const t = p.timeDs % 10;
    parts.push(`${p.code}-${s}.${t}`);
  }
  if (opts.finishTimeDs && opts.finishTimeDs > 0) {
    const s = Math.floor(opts.finishTimeDs / 10);
    const t = opts.finishTimeDs % 10;
    parts.push(`${PUNCH_FINISH}-${s}.${t}`);
  }
  return parts.length > 0 ? parts.join(";") + ";" : "";
}

async function processSimulatedReadout(
  client: PrismaClient,
  dbName: string,
  readout: SimulatedReadout,
) {
  // Upsert oCard
  const existingCard = await client.oCard.findFirst({
    where: { CardNo: readout.cardNo, Removed: false },
  }) ?? await client.oCard.findFirst({
    where: { CardNo: readout.cardNo },
  });

  let cardId: number;
  if (existingCard) {
    await client.oCard.update({
      where: { Id: existingCard.Id },
      data: { Punches: readout.punchString, Removed: false },
    });
    cardId = existingCard.Id;
  } else {
    const card = await client.oCard.create({
      data: { CardNo: readout.cardNo, Punches: readout.punchString, ReadId: 0 },
    });
    cardId = card.Id;
    await incrementCounter("oCard", cardId, dbName);
  }

  // Link card to runner and update status/finish
  await client.oRunner.update({
    where: { Id: readout.runnerId },
    data: {
      Card: cardId,
      FinishTime: readout.finishDs,
      Status: readout.status,
    },
  });
  await incrementCounter("oRunner", readout.runnerId, dbName);
}

// ─── Router ─────────────────────────────────────────────────

export const testLabRouter = router({
  status: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;
    const [classes, courses, controls, runners] = await Promise.all([
      client.oClass.count({ where: { Removed: false } }),
      client.oCourse.count({ where: { Removed: false } }),
      client.oControl.count({ where: { Removed: false } }),
      client.oRunner.count({ where: { Removed: false } }),
    ]);
    const runnersWithStart = await client.oRunner.count({
      where: { Removed: false, StartTime: { gt: 0 } },
    });
    return { classes, courses, controls, runners, runnersWithStart };
  }),

  generateClasses: competitionProcedure.mutation(async ({ ctx }) => {
    const client = ctx.db;

    const existing = await client.oClass.findMany({
      where: { Removed: false },
      select: { Name: true },
    });
    const existingNames = new Set(existing.map((c) => c.Name));

    let created = 0;
    let skipped = 0;

    for (const def of CLASS_DEFS) {
      if (existingNames.has(def.name)) {
        skipped++;
        continue;
      }
      const cls = await client.oClass.create({
        data: {
          Name: def.name,
          Course: 0,
          MultiCourse: "",
          Qualification: "",
          SortIndex: def.sortIndex,
          Sex: def.sex,
          LowAge: def.lowAge,
          HighAge: def.highAge,
        },
      });
      await incrementCounter("oClass", cls.Id, ctx.dbName);
      created++;
    }

    return { created, skipped, total: CLASS_DEFS.length };
  }),

  generateCourses: competitionProcedure.mutation(async ({ ctx }) => {
    const client = ctx.db;

    const { controlsByTier, allControlCodes } = buildControls();

    // Create start and finish controls
    await upsertControl(client, ctx.dbName, 211101, "", "Start 1", 4);
    await upsertControl(client, ctx.dbName, 311101, "", "Mål 1", 5);

    // Create regular controls
    for (const code of allControlCodes) {
      await upsertControl(client, ctx.dbName, code, String(code), "", 0);
    }

    // Create courses — each course's control sequence already starts
    // with the correct first control from buildControls()
    const courseIdByTier = new Map<number, number>();
    for (const def of COURSE_DEFS) {
      const controls = controlsByTier.get(def.tier)!;
      const controlsStr = controls.join(";") + ";";

      const existing = await client.oCourse.findFirst({
        where: { Name: def.name, Removed: false },
      });

      let courseId: number;
      if (existing) {
        await client.oCourse.update({
          where: { Id: existing.Id },
          data: { Controls: controlsStr, Length: def.lengthMeters },
        });
        courseId = existing.Id;
      } else {
        const course = await client.oCourse.create({
          data: {
            Name: def.name,
            Controls: controlsStr,
            Length: def.lengthMeters,
            NumberMaps: 1,
          },
        });
        courseId = course.Id;
        await incrementCounter("oCourse", courseId, ctx.dbName);
      }
      courseIdByTier.set(def.tier, courseId);
    }

    // Assign courses to classes
    const classes = await client.oClass.findMany({ where: { Removed: false } });
    let assigned = 0;
    for (const cls of classes) {
      const classDef = CLASS_DEFS.find((d) => d.name === cls.Name);
      if (!classDef) continue;
      const courseId = courseIdByTier.get(classDef.courseTier);
      if (!courseId) continue;
      if (cls.Course === courseId) continue;
      await client.oClass.update({
        where: { Id: cls.Id },
        data: { Course: courseId },
      });
      await incrementCounter("oClass", cls.Id, ctx.dbName);
      assigned++;
    }

    return {
      controlsCreated: allControlCodes.length + 2,
      coursesCreated: COURSE_DEFS.length,
      classesAssigned: assigned,
      firstControlGroups: 4,
    };
  }),

  registerRunners: competitionProcedure
    .input(z.object({ count: z.number().int().min(1).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      const mainConn = await getMainDbConnection();

      try {
        await ensureRunnerDbTable(mainConn);
        await ensureClubDbTable(mainConn);

        // Load classes
        const classes = await client.oClass.findMany({
          where: { Removed: false },
        });
        if (classes.length === 0) {
          throw new Error("No classes found. Generate classes first.");
        }

        // Get competition year from oEvent
        const event = await client.oEvent.findFirst({ where: { Removed: false } });
        const competitionYear = event?.Date
          ? new Date(event.Date).getFullYear()
          : new Date().getFullYear();

        // Determine class weights and target counts
        const classTargets: { cls: typeof classes[number]; def: ClassDef | undefined; target: number }[] = [];
        let totalWeight = 0;
        for (const cls of classes) {
          const def = CLASS_DEFS.find((d) => d.name === cls.Name);
          const weight = def ? getClassWeight(def) : 1;
          totalWeight += weight;
          classTargets.push({ cls, def, target: weight });
        }
        // Normalize to actual count
        for (const ct of classTargets) {
          ct.target = Math.max(1, Math.round((ct.target / totalWeight) * input.count));
        }

        // Load runners from oxygen_runner_db (must have valid birth year and SI card)
        const [dbRunnerRows] = await mainConn.execute<mysql.RowDataPacket[]>(
          "SELECT ExtId, Name, CardNo, ClubId, BirthYear, Sex FROM oxygen_runner_db WHERE BirthYear > 0 AND CardNo > 0",
        );
        const dbRunners = (dbRunnerRows as Record<string, unknown>[]).map((r) => ({
          extId: Number(r.ExtId),
          name: String(r.Name),
          cardNo: Number(r.CardNo),
          clubId: Number(r.ClubId),
          birthYear: Number(r.BirthYear),
          sex: String(r.Sex),
        }));

        if (dbRunners.length === 0) {
          throw new Error("Runner database is empty. Sync from Eventor first.");
        }

        // Shuffle runners
        for (let i = dbRunners.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [dbRunners[i], dbRunners[j]] = [dbRunners[j], dbRunners[i]];
        }

        // Load existing card numbers to avoid duplicates
        const existingRunners = await client.oRunner.findMany({
          where: { Removed: false },
          select: { CardNo: true },
        });
        const usedCards = new Set(existingRunners.map((r) => r.CardNo));

        // Load club name map
        const [clubRows] = await mainConn.execute<mysql.RowDataPacket[]>(
          "SELECT EventorId, Name, ShortName FROM oxygen_club_db",
        );
        const clubNameMap = new Map<number, { name: string; shortName: string }>();
        for (const row of clubRows as Record<string, unknown>[]) {
          clubNameMap.set(Number(row.EventorId), {
            name: String(row.Name),
            shortName: String(row.ShortName),
          });
        }

        // Track which clubs we've created in this competition
        const existingClubs = await client.oClub.findMany({
          where: { Removed: false },
          select: { Id: true },
        });
        const createdClubIds = new Set(existingClubs.map((c) => c.Id));

        let runnerIdx = 0;
        let totalCreated = 0;
        let clubsCreated = 0;

        for (const ct of classTargets) {
          const { cls } = ct;
          const sex = cls.Sex;
          const lowAge = cls.LowAge;
          const highAge = cls.HighAge;

          let classCount = 0;
          while (classCount < ct.target && runnerIdx < dbRunners.length) {
            const runner = dbRunners[runnerIdx];
            runnerIdx++;

            // Check eligibility
            if (sex && runner.sex !== sex) continue;
            const age = competitionYear - runner.birthYear;
            if (lowAge > 0 && age < lowAge) continue;
            if (highAge > 0 && age > highAge) continue;
            if (runner.cardNo > 0 && usedCards.has(runner.cardNo)) continue;

            // Ensure club exists
            if (runner.clubId > 0 && !createdClubIds.has(runner.clubId)) {
              const clubInfo = clubNameMap.get(runner.clubId);
              const clubName = clubInfo?.name ?? `Club ${runner.clubId}`;
              const shortName = clubInfo?.shortName ?? "";
              try {
                await client.oClub.create({
                  data: {
                    Id: runner.clubId,
                    Name: clubName,
                    ShortName: shortName,
                  },
                });
                await incrementCounter("oClub", runner.clubId, ctx.dbName);
                clubsCreated++;
              } catch {
                // ID conflict — already exists, just un-remove
                try {
                  await client.oClub.update({
                    where: { Id: runner.clubId },
                    data: { Removed: false },
                  });
                } catch { /* ok */ }
              }
              createdClubIds.add(runner.clubId);
            }

            // Create runner
            const r = await client.oRunner.create({
              data: {
                Name: runner.name,
                CardNo: runner.cardNo,
                Club: runner.clubId > 0 ? runner.clubId : 0,
                Class: cls.Id,
                BirthYear: runner.birthYear,
                Sex: runner.sex,
                InputResult: "",
                Annotation: "",
              },
            });
            await incrementCounter("oRunner", r.Id, ctx.dbName);

            if (runner.cardNo > 0) usedCards.add(runner.cardNo);
            classCount++;
            totalCreated++;
          }
        }

        return { created: totalCreated, clubsCreated };
      } finally {
        await mainConn.end();
      }
    }),

  registerFictionalRunners: competitionProcedure
    .input(z.object({ count: z.number().int().min(1).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;

      // Load classes
      const classes = await client.oClass.findMany({ where: { Removed: false } });
      if (classes.length === 0) {
        throw new Error("No classes found. Generate classes first.");
      }

      // Get competition year from oEvent
      const event = await client.oEvent.findFirst({ where: { Removed: false } });
      const competitionYear = event?.Date
        ? new Date(event.Date).getFullYear()
        : new Date().getFullYear();

      // Build class targets with the same weighting logic
      const classTargets: { cls: typeof classes[number]; def: ClassDef | undefined; target: number }[] = [];
      let totalWeight = 0;
      for (const cls of classes) {
        const def = CLASS_DEFS.find((d) => d.name === cls.Name);
        const weight = def ? getClassWeight(def) : 1;
        totalWeight += weight;
        classTargets.push({ cls, def, target: weight });
      }
      for (const ct of classTargets) {
        ct.target = Math.max(1, Math.round((ct.target / totalWeight) * input.count));
      }

      // Load existing card numbers to avoid duplicates
      const existingRunners = await client.oRunner.findMany({
        where: { Removed: false },
        select: { CardNo: true },
      });
      const usedCards = new Set(existingRunners.map((r) => r.CardNo));

      // Prepare SI card range picker (weighted)
      const totalCardWeight = SI_CARD_RANGES.reduce((s, r) => s + r.weight, 0);

      function pickCardNumber(): number {
        let roll = Math.random() * totalCardWeight;
        for (const range of SI_CARD_RANGES) {
          roll -= range.weight;
          if (roll <= 0) {
            return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
          }
        }
        const last = SI_CARD_RANGES[SI_CARD_RANGES.length - 1];
        return last.min + Math.floor(Math.random() * (last.max - last.min + 1));
      }

      function uniqueCardNumber(): number {
        for (let attempt = 0; attempt < 100; attempt++) {
          const card = pickCardNumber();
          if (!usedCards.has(card)) {
            usedCards.add(card);
            return card;
          }
        }
        // Fallback: sequential in SIAC range
        let card = 9500000;
        while (usedCards.has(card)) card++;
        usedCards.add(card);
        return card;
      }

      // Create clubs
      const createdClubIds = new Set<number>();
      const existingClubs = await client.oClub.findMany({
        where: { Removed: false },
        select: { Id: true },
      });
      for (const c of existingClubs) createdClubIds.add(c.Id);

      let clubsCreated = 0;
      for (const club of CLUBS) {
        if (createdClubIds.has(club.id)) continue;
        try {
          await client.oClub.create({
            data: { Id: club.id, Name: club.name, ShortName: club.shortName },
          });
          await incrementCounter("oClub", club.id, ctx.dbName);
          clubsCreated++;
        } catch {
          try {
            await client.oClub.update({
              where: { Id: club.id },
              data: { Removed: false, Name: club.name, ShortName: club.shortName },
            });
          } catch { /* ok */ }
        }
        createdClubIds.add(club.id);
      }

      // Generate runners
      let totalCreated = 0;

      for (const ct of classTargets) {
        const { cls } = ct;
        const sex = cls.Sex; // "M", "F", or ""
        const lowAge = cls.LowAge;
        const highAge = cls.HighAge;

        const firstNames = sex === "F"
          ? FEMALE_FIRST_NAMES
          : sex === "M"
            ? MALE_FIRST_NAMES
            : [...MALE_FIRST_NAMES, ...FEMALE_FIRST_NAMES];

        for (let i = 0; i < ct.target; i++) {
          // Pick random name
          const firstName = firstNames[Math.floor(Math.random() * firstNames.length)];
          const lastName = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
          const name = `${firstName} ${lastName}`;

          // Pick random club
          const club = CLUBS[Math.floor(Math.random() * CLUBS.length)];

          // Compute birth year from class age constraints
          let birthYear: number;
          if (lowAge > 0 && highAge > 0) {
            // Both bounds: random between them
            const minBirthYear = competitionYear - highAge;
            const maxBirthYear = competitionYear - lowAge;
            birthYear = minBirthYear + Math.floor(Math.random() * (maxBirthYear - minBirthYear + 1));
          } else if (highAge > 0) {
            // Youth classes: age 0–highAge, spread across lower range
            birthYear = competitionYear - highAge + Math.floor(Math.random() * 3);
          } else if (lowAge > 0) {
            // Veteran/senior: lowAge and up, spread within ~10 years
            birthYear = competitionYear - lowAge - Math.floor(Math.random() * 10);
          } else {
            // Open: random age 10–70
            birthYear = competitionYear - 10 - Math.floor(Math.random() * 60);
          }

          // Determine sex for open classes
          const runnerSex = sex || (Math.random() < 0.5 ? "M" : "F");

          const cardNo = uniqueCardNumber();

          const r = await client.oRunner.create({
            data: {
              Name: name,
              CardNo: cardNo,
              Club: club.id,
              Class: cls.Id,
              BirthYear: birthYear,
              Sex: runnerSex,
              InputResult: "",
              Annotation: "",
            },
          });
          await incrementCounter("oRunner", r.Id, ctx.dbName);
          totalCreated++;
        }
      }

      return { created: totalCreated, clubsCreated };
    }),

  startSimulation: competitionProcedure
    .input(
      z.object({
        speed: z.number().min(0).default(10),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;

      // Check for existing simulation
      const event = await client.oEvent.findFirst({ where: { Removed: false } });
      const simKey = event?.NameId ?? ctx.dbName;

      const existingSim = simulations.get(simKey);
      if (existingSim?.running) {
        throw new Error("Simulation already running. Stop it first.");
      }

      // Load runners with start times and valid SI cards
      const runners = await client.oRunner.findMany({
        where: { Removed: false, StartTime: { gt: 0 }, CardNo: { gt: 0 } },
      });
      if (runners.length === 0) {
        throw new Error("No runners with start times and SI cards found. Draw start times first.");
      }

      // Load classes and courses
      const classes = await client.oClass.findMany({ where: { Removed: false } });
      const classMap = new Map(classes.map((c) => [c.Id, c]));
      const courses = await client.oCourse.findMany({ where: { Removed: false } });
      const courseMap = new Map(courses.map((c) => [c.Id, c]));

      // Generate simulated readouts
      const schedule: SimulatedReadout[] = [];
      const dnsRate = 0.02;
      const dnfRate = 0.05;
      const mpRate = 0.03;

      for (const runner of runners) {
        // DNS — no readout at all
        if (Math.random() < dnsRate) continue;

        const cls = classMap.get(runner.Class);
        const courseId = runner.Course || cls?.Course || 0;
        const course = courseMap.get(courseId);
        if (!course) continue;

        const courseControls = course.Controls.split(";").filter(Boolean).map(Number).filter((n) => !isNaN(n));
        if (courseControls.length === 0) continue;

        // Determine pace from class tier
        const classDef = CLASS_DEFS.find((d) => d.name === cls?.Name);
        const tier = classDef?.courseTier ?? 4;
        const paceInfo = TIER_PACE[tier] ?? TIER_PACE[4];
        const basePace = paceInfo.base;
        const spread = paceInfo.spread;

        // Total time with random variation (seconds)
        const courseLengthKm = (course.Length || 5000) / 1000;
        const paceVariation = 1 + gaussianRandom() * spread;
        const totalTimeSeconds = Math.max(
          courseLengthKm * basePace * 0.5,
          courseLengthKm * basePace * paceVariation,
        );

        const isDNF = Math.random() < dnfRate;
        const isMP = !isDNF && Math.random() < mpRate;
        const mpControlIdx = isMP ? Math.floor(Math.random() * courseControls.length) : -1;

        // Start time (already in deciseconds)
        const startTimeDs = runner.StartTime;
        const checkTimeDs = startTimeDs - 600; // 1 minute before start

        // Distribute time across legs
        const numLegs = courseControls.length + 1; // controls + finish
        const legTimes: number[] = [];
        let legTimeSum = 0;
        for (let i = 0; i < numLegs; i++) {
          const raw = 1 + gaussianRandom() * 0.3;
          const legTime = Math.max(0.3, raw);
          legTimes.push(legTime);
          legTimeSum += legTime;
        }

        // Normalize leg times to total
        const scaleFactor = totalTimeSeconds / legTimeSum;
        for (let i = 0; i < legTimes.length; i++) {
          legTimes[i] *= scaleFactor;
        }

        // Build punch data
        const controlPunches: { code: number; timeDs: number }[] = [];
        let cumulativeDs = startTimeDs;

        const controlsToVisit = isDNF
          ? courseControls.slice(0, Math.floor(courseControls.length * (0.3 + Math.random() * 0.5)))
          : courseControls;

        for (let i = 0; i < controlsToVisit.length; i++) {
          cumulativeDs += Math.round(legTimes[i] * 10);
          if (isMP && i === mpControlIdx) continue; // skip this control
          controlPunches.push({ code: controlsToVisit[i], timeDs: cumulativeDs });
        }

        // Finish time
        let finishDs = 0;
        if (!isDNF) {
          cumulativeDs += Math.round(legTimes[legTimes.length - 1] * 10);
          finishDs = cumulativeDs;
        }

        // Build MeOS punch string
        const punchString = buildMeosPunchString({
          checkTimeDs,
          startTimeDs,
          controlPunches,
          finishTimeDs: finishDs > 0 ? finishDs : undefined,
        });

        // Determine status
        let status: number;
        if (isDNF) {
          status = RunnerStatus.DNF;
        } else if (isMP) {
          status = RunnerStatus.MissingPunch;
        } else {
          status = RunnerStatus.OK;
        }

        schedule.push({
          runnerId: runner.Id,
          cardNo: runner.CardNo,
          finishTimeDs: finishDs > 0 ? finishDs : cumulativeDs,
          punchString,
          status,
          finishDs,
        });
      }

      // Sort by finish time (when readout would happen)
      schedule.sort((a, b) => a.finishTimeDs - b.finishTimeDs);

      const earliestStart = Math.min(...runners.map((r) => r.StartTime));

      if (input.speed === 0) {
        // Instant mode — process all readouts immediately
        for (const readout of schedule) {
          await processSimulatedReadout(client, ctx.dbName, readout);
        }

        return {
          simKey,
          mode: "instant" as const,
          processed: schedule.length,
          total: schedule.length,
        };
      }

      // Timed simulation
      const now = Date.now();
      const state: SimulationState = {
        running: true,
        timer: null,
        schedule,
        processed: 0,
        total: schedule.length,
        startedAtReal: now,
        simTimeOriginDs: earliestStart,
        speedMultiplier: input.speed,
        simTimeAtLastSpeedChange: earliestStart,
        realTimeAtLastSpeedChange: now,
        dbName: simKey,
      };

      const tick = async () => {
        if (!state.running || state.processed >= state.total) {
          if (state.timer) clearInterval(state.timer);
          state.running = false;
          return;
        }

        const elapsedSinceSpeedChangeMs = Date.now() - state.realTimeAtLastSpeedChange;
        const elapsedSimDs = Math.floor((elapsedSinceSpeedChangeMs / 100) * state.speedMultiplier);
        const currentSimTimeDs = state.simTimeAtLastSpeedChange + elapsedSimDs;

        // Process all readouts up to current simulated time
        while (
          state.processed < state.total &&
          state.schedule[state.processed].finishTimeDs <= currentSimTimeDs
        ) {
          try {
            await processSimulatedReadout(client, ctx.dbName, state.schedule[state.processed]);
          } catch (err) {
            console.warn("[testLab] Failed to process readout:", err);
          }
          state.processed++;
        }

        if (state.processed >= state.total) {
          if (state.timer) clearInterval(state.timer);
          state.running = false;
        }
      };

      state.timer = setInterval(tick, 500);
      simulations.set(simKey, state);

      return {
        simKey,
        mode: "timed" as const,
        processed: 0,
        total: schedule.length,
      };
    }),

  simulationStatus: competitionProcedure.query(async ({ ctx }) => {
    const client = ctx.db;
    const event = await client.oEvent.findFirst({ where: { Removed: false } });
    const simKey = event?.NameId ?? ctx.dbName;
    const state = simulations.get(simKey);

    if (!state) {
      return { running: false, processed: 0, total: 0, elapsedMs: 0, speed: 0 };
    }

    return {
      running: state.running,
      processed: state.processed,
      total: state.total,
      elapsedMs: Date.now() - state.startedAtReal,
      speed: state.speedMultiplier,
    };
  }),

  updateSpeed: competitionProcedure
    .input(z.object({ speed: z.number().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;
      const event = await client.oEvent.findFirst({ where: { Removed: false } });
      const simKey = event?.NameId ?? ctx.dbName;
      const state = simulations.get(simKey);

      if (!state?.running) {
        throw new Error("No simulation running.");
      }

      const now = Date.now();
      const elapsedSinceSpeedChangeMs = now - state.realTimeAtLastSpeedChange;
      const elapsedSimDs = Math.floor((elapsedSinceSpeedChangeMs / 100) * state.speedMultiplier);

      state.simTimeAtLastSpeedChange += elapsedSimDs;
      state.realTimeAtLastSpeedChange = now;
      state.speedMultiplier = input.speed;

      return { speed: input.speed };
    }),

  stopSimulation: competitionProcedure.mutation(async ({ ctx }) => {
    const client = ctx.db;
    const event = await client.oEvent.findFirst({ where: { Removed: false } });
    const simKey = event?.NameId ?? ctx.dbName;
    const state = simulations.get(simKey);

    if (!state) {
      return { stopped: false, processed: 0, total: 0 };
    }

    state.running = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }

    const result = { stopped: true, processed: state.processed, total: state.total };
    simulations.delete(simKey);
    return result;
  }),

  // ─── Quick Draw ──────────────────────────────────────────

  quickDraw: competitionProcedure.mutation(async ({ ctx }) => {
    const client = ctx.db;

    const event = await client.oEvent.findFirst({ where: { Removed: false } });
    const zeroTime = event?.ZeroTime ?? 324000; // default 09:00

    // Load all non-free-start classes that have runners
    const classes = await client.oClass.findMany({
      where: { Removed: false },
      orderBy: { SortIndex: "asc" },
    });

    const runners = await client.oRunner.findMany({
      where: { Removed: false },
      select: { Class: true },
    });
    const countByClass = new Map<number, number>();
    for (const r of runners) {
      countByClass.set(r.Class, (countByClass.get(r.Class) ?? 0) + 1);
    }

    // Filter: skip free-start classes and classes with no runners
    const drawClasses = classes
      .filter((c) => c.FreeStart !== 1 && (countByClass.get(c.Id) ?? 0) > 0)
      .map((c) => ({
        classId: c.Id,
        method: "random" as const,
        interval: 1200, // 120 seconds in deciseconds
      }));

    if (drawClasses.length === 0) {
      return { totalDrawn: 0, classesDrawn: 0 };
    }

    const settings = {
      firstStart: zeroTime,
      baseInterval: 1200,
      maxParallelStarts: 1,
      detectCourseOverlap: false,
    };

    const result = await generateDrawPreview(client, drawClasses, settings);

    // Draw engine produces absolute times; convert to ZeroTime-relative for DB storage
    let totalDrawn = 0;
    const configMap = new Map(drawClasses.map((c) => [c.classId, c]));

    for (const cls of result.classes) {
      const config = configMap.get(cls.classId);

      for (const entry of cls.entries) {
        await client.oRunner.update({
          where: { Id: entry.runnerId },
          data: {
            StartTime: entry.startTime - zeroTime,
            StartNo: entry.startNo,
          },
        });
        await incrementCounter("oRunner", entry.runnerId, ctx.dbName);
        totalDrawn++;
      }

      if (config) {
        await client.oClass.update({
          where: { Id: cls.classId },
          data: {
            FirstStart: cls.computedFirstStart - zeroTime,
            StartInterval: config.interval,
          },
        });
        await incrementCounter("oClass", cls.classId, ctx.dbName);
      }
    }

    return { totalDrawn, classesDrawn: result.classes.length };
  }),

  // ─── Generate Readout (preview for editing) ──────────────

  generateReadout: competitionProcedure
    .input(z.object({
      runnerId: z.number().int(),
      mode: z.enum(["ok", "mp", "dnf", "dns"]),
    }))
    .mutation(async ({ ctx, input }) => {
      const client = ctx.db;

      // Load runner
      const runner = await client.oRunner.findFirst({
        where: { Id: input.runnerId, Removed: false },
      });
      if (!runner) throw new Error("Runner not found");

      // Load class
      const cls = await client.oClass.findFirst({
        where: { Id: runner.Class, Removed: false },
      });
      if (!cls) throw new Error("Class not found");

      // Load course
      const courseId = runner.Course || cls.Course || 0;
      const course = courseId ? await client.oCourse.findFirst({
        where: { Id: courseId, Removed: false },
      }) : null;

      const courseControls = course
        ? course.Controls.split(";").filter(Boolean).map(Number).filter((n) => !isNaN(n))
        : [];

      // Determine pace from class tier
      const classDef = CLASS_DEFS.find((d) => d.name === cls.Name);
      const tier = classDef?.courseTier ?? 4;
      const paceInfo = TIER_PACE[tier] ?? TIER_PACE[4];

      // Runner's start time is ZeroTime-relative in DB → convert to absolute deciseconds
      const zeroTime = await getZeroTime(client);
      const startTimeDs = runner.StartTime > 0 ? toAbsolute(runner.StartTime, zeroTime) : 324000; // default 09:00
      const startTimeSec = Math.floor(startTimeDs / 10);
      const checkTimeSec = startTimeSec - 60; // 1 min before start
      const clearTimeSec = checkTimeSec - 30; // 30s before check

      // Generate punches based on mode
      const courseLengthKm = (course?.Length || 5000) / 1000;
      const paceVariation = 1 + gaussianRandom() * paceInfo.spread;
      const totalTimeSec = Math.max(
        courseLengthKm * paceInfo.base * 0.5,
        courseLengthKm * paceInfo.base * paceVariation,
      );

      // Determine which controls to include
      let controlsToVisit: number[];
      if (input.mode === "dns") {
        controlsToVisit = [];
      } else if (input.mode === "dnf") {
        // Visit 30-80% of controls then stop
        const fraction = 0.3 + Math.random() * 0.5;
        controlsToVisit = courseControls.slice(0, Math.floor(courseControls.length * fraction));
      } else if (input.mode === "mp") {
        // Skip one random control
        const skipIdx = Math.floor(Math.random() * courseControls.length);
        controlsToVisit = courseControls.filter((_, i) => i !== skipIdx);
      } else {
        controlsToVisit = [...courseControls];
      }

      // Distribute time across legs
      const numLegs = controlsToVisit.length + (input.mode === "dnf" || input.mode === "dns" ? 0 : 1);
      const legTimes: number[] = [];
      let legTimeSum = 0;
      for (let i = 0; i < Math.max(1, numLegs); i++) {
        const raw = 1 + gaussianRandom() * 0.3;
        const t = Math.max(0.3, raw);
        legTimes.push(t);
        legTimeSum += t;
      }
      const scaleFactor = totalTimeSec / Math.max(1, legTimeSum);
      for (let i = 0; i < legTimes.length; i++) {
        legTimes[i] *= scaleFactor;
      }

      // Build punch array (times in seconds since midnight)
      const punches: { controlCode: number; time: number }[] = [];
      let cumulativeSec = startTimeSec;
      for (let i = 0; i < controlsToVisit.length; i++) {
        cumulativeSec += Math.round(legTimes[i] ?? legTimes[legTimes.length - 1] ?? 60);
        punches.push({ controlCode: controlsToVisit[i], time: cumulativeSec });
      }

      // Finish time
      let finishTimeSec: number | null = null;
      if (input.mode !== "dnf" && input.mode !== "dns" && numLegs > 0) {
        cumulativeSec += Math.round(legTimes[legTimes.length - 1] ?? 60);
        finishTimeSec = cumulativeSec;
      }

      // Status
      let status: number;
      if (input.mode === "ok") status = RunnerStatus.OK;
      else if (input.mode === "mp") status = RunnerStatus.MissingPunch;
      else if (input.mode === "dnf") status = RunnerStatus.DNF;
      else status = RunnerStatus.DNS;

      return {
        runnerId: input.runnerId,
        cardNo: runner.CardNo,
        runnerName: runner.Name,
        className: cls.Name,
        courseName: course?.Name ?? "Unknown",
        courseLength: course?.Length ?? 0,
        controlCount: courseControls.length,
        startTime: startTimeSec,
        checkTime: checkTimeSec,
        clearTime: clearTimeSec,
        finishTime: finishTimeSec,
        status,
        punches,
      };
    }),
});
