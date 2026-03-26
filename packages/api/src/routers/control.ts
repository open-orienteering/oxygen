import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";
import {
  getCompetitionClient,
  incrementCounter,
  ensureControlConfigTable,
  ensureControlPunchesTable,
  ensureCompetitionConfigTable,
  getZeroTime,
} from "../db.js";
import { toRelative, toAbsolute } from "../timeConvert.js";
import type {
  ControlInfo,
  ControlDetail,
  ControlConfig,
  RadioType,
  AirPlusOverride,
} from "@oxygen/shared";

// ─── Helpers ──────────────────────────────────────────────

/** Format a Date from MySQL DATETIME as an ISO-like local-time string.
 *  Prisma treats DATETIME as UTC, but MySQL NOW() returns server-local time.
 *  Using getUTC* avoids the double timezone shift. */
function fmtDatetimeLocal(d: Date): string {
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, "0");
  const D = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

interface ControlConfigRow {
  control_id: number;
  radio_type: string;
  air_plus: string;
  battery_voltage: number | null;
  battery_low: number | null;
  checked_at: Date | null;
  memory_cleared_at: Date | null;
  station_serial: number | null;
}

function rowToConfig(row: ControlConfigRow): ControlConfig {
  return {
    radioType: row.radio_type as RadioType,
    airPlus: row.air_plus as AirPlusOverride,
    batteryVoltage: row.battery_voltage,
    batteryLow: row.battery_low !== null ? row.battery_low !== 0 : null,
    checkedAt: row.checked_at?.toISOString() ?? null,
    memoryClearedAt: row.memory_cleared_at?.toISOString() ?? null,
  };
}

async function getConfigMap(
  client: Awaited<ReturnType<typeof getCompetitionClient>>,
): Promise<Map<number, ControlConfig>> {
  await ensureControlConfigTable(client);
  const rows = (await client.$queryRawUnsafe(
    "SELECT * FROM oxygen_control_config",
  )) as ControlConfigRow[];
  const map = new Map<number, ControlConfig>();
  for (const row of rows) {
    map.set(row.control_id, rowToConfig(row));
  }
  return map;
}

// ─── Router ───────────────────────────────────────────────

export const controlRouter = router({
  /**
   * List all controls with config data.
   */
  list: publicProcedure
    .input(
      z
        .object({
          search: z.string().optional(),
          status: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input }): Promise<ControlInfo[]> => {
      const client = await getCompetitionClient();

      const controls = await client.oControl.findMany({
        where: { Removed: false },
        orderBy: { Id: "asc" },
      });

      let filtered = controls;

      // Filter by status
      if (input?.status !== undefined) {
        filtered = filtered.filter((c) => c.Status === input.status);
      }

      // Filter by search (name or code)
      if (input?.search) {
        const term = input.search.toLowerCase();
        filtered = filtered.filter(
          (c) =>
            c.Name.toLowerCase().includes(term) ||
            c.Numbers.toLowerCase().includes(term) ||
            String(c.Id).includes(term),
        );
      }

      // Compute runner counts per control
      const courses = await client.oCourse.findMany({
        where: { Removed: false },
        select: { Id: true, Controls: true, StartName: true, FirstAsStart: true, LastAsFinish: true },
      });
      const classes = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Course: true },
      });
      const runners = await client.oRunner.findMany({
        where: { Removed: false },
        select: { Class: true },
      });
      const runnersByClass = new Map<number, number>();
      for (const r of runners) {
        runnersByClass.set(r.Class, (runnersByClass.get(r.Class) ?? 0) + 1);
      }
      const runnersPerCourse = new Map<number, number>();
      for (const cl of classes) {
        if (cl.Course > 0) {
          runnersPerCourse.set(cl.Course, (runnersPerCourse.get(cl.Course) ?? 0) + (runnersByClass.get(cl.Id) ?? 0));
        }
      }
      // controlId → total runner count
      const controlRunnerCount = new Map<number, number>();
      for (const course of courses) {
        const courseRunners = runnersPerCourse.get(course.Id) ?? 0;
        if (courseRunners === 0) continue;
        const ctrlIds = new Set<number>();
        for (const idStr of course.Controls.split(";").filter(Boolean)) {
          const id = parseInt(idStr, 10);
          if (!isNaN(id)) ctrlIds.add(id);
        }
        for (const ctrlId of ctrlIds) {
          controlRunnerCount.set(ctrlId, (controlRunnerCount.get(ctrlId) ?? 0) + courseRunners);
        }
      }

      // Handle Start (Status 4) and Finish (Status 5) controls.
      const startControls = filtered.filter((c) => c.Status === 4);
      const finishControls = filtered.filter((c) => c.Status === 5);

      if (startControls.length > 0) {
        const startNameToCtrl = new Map<string, number>();
        for (const sc of startControls) {
          startNameToCtrl.set(sc.Name.toUpperCase(), sc.Id);
        }
        const defaultStartId = startControls[0].Id;

        for (const course of courses) {
          if (course.FirstAsStart) continue;
          const courseRunners = runnersPerCourse.get(course.Id) ?? 0;
          if (courseRunners === 0) continue;
          const startKey = course.StartName.trim().toUpperCase();
          const startCtrlId = (startKey && startNameToCtrl.get(startKey)) || defaultStartId;
          controlRunnerCount.set(startCtrlId, (controlRunnerCount.get(startCtrlId) ?? 0) + courseRunners);
        }
      }

      if (finishControls.length > 0) {
        const defaultFinishId = finishControls[0].Id;

        for (const course of courses) {
          if (course.LastAsFinish) continue;
          const courseRunners = runnersPerCourse.get(course.Id) ?? 0;
          if (courseRunners === 0) continue;
          controlRunnerCount.set(defaultFinishId, (controlRunnerCount.get(defaultFinishId) ?? 0) + courseRunners);
        }
      }

      // Load config data
      const configMap = await getConfigMap(client);

      return filtered.map(
        (c): ControlInfo => ({
          id: c.Id,
          name: c.Name,
          codes: c.Numbers,
          status: c.Status as ControlInfo["status"],
          timeAdjust: c.TimeAdjust,
          minTime: c.MinTime,
          runnerCount: controlRunnerCount.get(c.Id) ?? 0,
          config: configMap.get(c.Id) ?? null,
        }),
      );
    }),

  /**
   * Get a single control with detailed course usage info.
   */
  detail: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }): Promise<ControlDetail | null> => {
      const client = await getCompetitionClient();

      const control = await client.oControl.findFirst({
        where: { Id: input.id, Removed: false },
      });
      if (!control) return null;

      // Get all courses and classes to compute usage
      const courses = await client.oCourse.findMany({
        where: { Removed: false },
      });
      const classes = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Course: true },
      });

      // Count runners per class
      const runners = await client.oRunner.findMany({
        where: { Removed: false },
        select: { Class: true },
      });
      const runnersByClass = new Map<number, number>();
      for (const r of runners) {
        runnersByClass.set(r.Class, (runnersByClass.get(r.Class) ?? 0) + 1);
      }

      // Map course ID to runner count (sum of all classes using that course)
      const runnersByCourse = new Map<number, number>();
      for (const cls of classes) {
        if (cls.Course > 0) {
          const current = runnersByCourse.get(cls.Course) ?? 0;
          runnersByCourse.set(
            cls.Course,
            current + (runnersByClass.get(cls.Id) ?? 0),
          );
        }
      }

      // Find which courses use this control (by checking the codes)
      const controlCodes = control.Numbers.split(";")
        .map((s) => s.trim())
        .filter(Boolean);

      const courseUsage: ControlDetail["courses"] = [];
      for (const course of courses) {
        const courseControls = course.Controls.split(";").filter(Boolean);
        let occurrences = 0;
        for (const cc of courseControls) {
          if (controlCodes.includes(cc)) {
            occurrences++;
          }
        }
        if (occurrences > 0) {
          courseUsage.push({
            courseId: course.Id,
            courseName: course.Name,
            occurrences,
            runnerCount: runnersByCourse.get(course.Id) ?? 0,
          });
        }
      }

      // Load config
      const configMap = await getConfigMap(client);

      return {
        id: control.Id,
        name: control.Name,
        codes: control.Numbers,
        status: control.Status as ControlInfo["status"],
        timeAdjust: control.TimeAdjust,
        minTime: control.MinTime,
        runnerCount: courseUsage.reduce((sum, c) => sum + c.runnerCount, 0),
        courses: courseUsage,
        config: configMap.get(control.Id) ?? null,
      };
    }),

  /**
   * Create a new control.
   */
  create: publicProcedure
    .input(
      z.object({
        codes: z.string().min(1),
        name: z.string().optional().default(""),
        status: z.number().int().optional().default(0),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      // Use the first numeric code as the ID
      const firstCode = parseInt(
        input.codes.split(";")[0]?.trim() ?? "0",
        10,
      );
      if (isNaN(firstCode) || firstCode <= 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid control code — must be a positive number" });
      }

      // Check if control with that ID already exists (active)
      const existing = await client.oControl.findFirst({
        where: { Id: firstCode },
      });

      let control;
      if (existing && !existing.Removed) {
        throw new TRPCError({ code: "CONFLICT", message: `Control ${firstCode} already exists` });
      } else if (existing && existing.Removed) {
        // Re-activate a previously deleted control
        control = await client.oControl.update({
          where: { Id: firstCode },
          data: {
            Numbers: input.codes,
            Name: input.name,
            Status: input.status,
            Removed: false,
          },
        });
      } else {
        control = await client.oControl.create({
          data: {
            Id: firstCode,
            Numbers: input.codes,
            Name: input.name,
            Status: input.status,
          },
        });
      }

      return {
        id: control.Id,
        name: control.Name,
        codes: control.Numbers,
      };
    }),

  /**
   * Update an existing control.
   */
  update: publicProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().optional(),
        codes: z.string().optional(),
        status: z.number().int().optional(),
        timeAdjust: z.number().int().optional(),
        minTime: z.number().int().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.Name = input.name;
      if (input.codes !== undefined) data.Numbers = input.codes;
      if (input.status !== undefined) data.Status = input.status;
      if (input.timeAdjust !== undefined) data.TimeAdjust = input.timeAdjust;
      if (input.minTime !== undefined) data.MinTime = input.minTime;

      const control = await client.oControl.update({
        where: { Id: input.id },
        data,
      });

      return {
        id: control.Id,
        name: control.Name,
        codes: control.Numbers,
        status: control.Status,
      };
    }),

  /**
   * Soft-delete a control.
   */
  delete: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      await client.oControl.update({
        where: { Id: input.id },
        data: { Removed: true },
      });

      return { success: true };
    }),

  // ─── Control config (radio type, AIR+) ────────────────

  /**
   * Upsert config for one or more controls (bulk).
   * Also syncs oControl.Radio for liveresults compatibility.
   */
  upsertConfig: publicProcedure
    .input(
      z.object({
        controlIds: z.array(z.number().int()).min(1),
        radioType: z.enum(["normal", "internal_radio", "public_radio"]).optional(),
        airPlus: z.enum(["default", "on", "off"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureControlConfigTable(client);

      for (const controlId of input.controlIds) {
        // Upsert config row — use parameterized queries for safety
        if (input.radioType !== undefined && input.airPlus !== undefined) {
          await client.$executeRaw`
            INSERT INTO oxygen_control_config (control_id, radio_type, air_plus, battery_voltage)
            VALUES (${controlId}, ${input.radioType}, ${input.airPlus}, NULL)
            ON DUPLICATE KEY UPDATE radio_type = ${input.radioType}, air_plus = ${input.airPlus}`;
        } else if (input.radioType !== undefined) {
          await client.$executeRaw`
            INSERT INTO oxygen_control_config (control_id, radio_type, battery_voltage)
            VALUES (${controlId}, ${input.radioType}, NULL)
            ON DUPLICATE KEY UPDATE radio_type = ${input.radioType}`;
        } else if (input.airPlus !== undefined) {
          await client.$executeRaw`
            INSERT INTO oxygen_control_config (control_id, air_plus, battery_voltage)
            VALUES (${controlId}, ${input.airPlus}, NULL)
            ON DUPLICATE KEY UPDATE air_plus = ${input.airPlus}`;
        }

        // Sync oControl.Radio flag for liveresults
        if (input.radioType !== undefined) {
          const radioFlag = input.radioType === "public_radio" ? 1 : 0;
          await client.oControl.update({
            where: { Id: controlId },
            data: { Radio: radioFlag },
          });
          await incrementCounter("oControl", controlId);
        }
      }

      return { success: true, count: input.controlIds.length };
    }),

  /**
   * Record the result of programming a physical control.
   */
  recordProgramming: publicProcedure
    .input(
      z.object({
        controlId: z.number().int(),
        batteryVoltage: z.number(),
        stationSerial: z.number().int().optional(),
        memoryClearedAt: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureControlConfigTable(client);

      const batteryLow = input.batteryVoltage < 2.5 ? 1 : 0;

      if (input.stationSerial !== undefined && input.memoryClearedAt) {
        await client.$executeRaw`
          INSERT INTO oxygen_control_config (control_id, battery_voltage, battery_low, checked_at, station_serial)
          VALUES (${input.controlId}, ${input.batteryVoltage}, ${batteryLow}, NOW(), ${input.stationSerial})
          ON DUPLICATE KEY UPDATE
            battery_voltage = ${input.batteryVoltage}, battery_low = ${batteryLow},
            checked_at = NOW(), station_serial = ${input.stationSerial}, memory_cleared_at = NOW()`;
      } else if (input.stationSerial !== undefined) {
        await client.$executeRaw`
          INSERT INTO oxygen_control_config (control_id, battery_voltage, battery_low, checked_at, station_serial)
          VALUES (${input.controlId}, ${input.batteryVoltage}, ${batteryLow}, NOW(), ${input.stationSerial})
          ON DUPLICATE KEY UPDATE
            battery_voltage = ${input.batteryVoltage}, battery_low = ${batteryLow},
            checked_at = NOW(), station_serial = ${input.stationSerial}`;
      } else if (input.memoryClearedAt) {
        await client.$executeRaw`
          INSERT INTO oxygen_control_config (control_id, battery_voltage, battery_low, checked_at)
          VALUES (${input.controlId}, ${input.batteryVoltage}, ${batteryLow}, NOW())
          ON DUPLICATE KEY UPDATE
            battery_voltage = ${input.batteryVoltage}, battery_low = ${batteryLow},
            checked_at = NOW(), memory_cleared_at = NOW()`;
      } else {
        await client.$executeRaw`
          INSERT INTO oxygen_control_config (control_id, battery_voltage, battery_low, checked_at)
          VALUES (${input.controlId}, ${input.batteryVoltage}, ${batteryLow}, NOW())
          ON DUPLICATE KEY UPDATE
            battery_voltage = ${input.batteryVoltage}, battery_low = ${batteryLow},
            checked_at = NOW()`;
      }

      return { success: true, batteryLow: batteryLow !== 0 };
    }),

  // ─── Backup punch management ──────────────────────────

  /**
   * Import backup punches from a control's memory readout.
   */
  importBackupPunches: publicProcedure
    .input(
      z.object({
        controlId: z.number().int(),
        stationSerial: z.number().int().optional(),
        punches: z.array(
          z.object({
            cardNo: z.number().int(),
            punchTime: z.number().int(), // deciseconds since midnight (for MeOS)
            punchDatetime: z.string().optional(), // full ISO datetime
            subSecond: z.number().int().min(0).max(255).optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureControlPunchesTable(client);

      if (input.punches.length === 0) return { count: 0 };

      // Convert absolute punch times to ZeroTime-relative for DB storage
      const zeroTime = await getZeroTime(client);
      const punchesRelative = input.punches.map((p) => ({
        ...p,
        punchTime: toRelative(p.punchTime, zeroTime),
      }));

      // Deduplicate: skip punches already imported for this control
      const existing = (await client.$queryRawUnsafe(
        `SELECT card_no, punch_time FROM oxygen_control_punches WHERE control_id = ?`,
        input.controlId,
      )) as Array<{ card_no: number; punch_time: number }>;

      const existingSet = new Set(
        existing.map((e) => `${e.card_no}:${e.punch_time}`),
      );
      const newPunches = punchesRelative.filter(
        (p) => !existingSet.has(`${p.cardNo}:${p.punchTime}`),
      );

      if (newPunches.length === 0) return { count: 0 };

      // Bulk insert new punches with parameterized queries
      const serial = input.stationSerial ?? null;
      for (const p of newPunches) {
        const dt = p.punchDatetime
          ? new Date(p.punchDatetime).toISOString().slice(0, 23).replace("T", " ")
          : null;
        const ss = p.subSecond ?? null;
        await client.$executeRaw`
          INSERT INTO oxygen_control_punches (control_id, card_no, punch_time, punch_datetime, sub_second, station_serial)
          VALUES (${input.controlId}, ${p.cardNo}, ${p.punchTime}, ${dt}, ${ss}, ${serial})`;
      }

      return { count: newPunches.length };
    }),

  /**
   * List backup punches for a control, with matched runner names.
   */
  listBackupPunches: publicProcedure
    .input(z.object({ controlId: z.number().int() }))
    .query(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureControlPunchesTable(client);

      const zeroTime = await getZeroTime(client);

      const punches = (await client.$queryRawUnsafe(
        `SELECT p.id, p.card_no, p.punch_time, p.punch_datetime, p.sub_second,
                p.station_serial, p.imported_at, p.pushed_to_punch,
                r.Name as runner_name, r.Id as runner_id
         FROM oxygen_control_punches p
         LEFT JOIN oRunner r ON r.CardNo = p.card_no AND r.Removed = 0
         WHERE p.control_id = ?
         ORDER BY p.punch_datetime, p.punch_time`,
        input.controlId,
      )) as Array<{
        id: number;
        card_no: number;
        punch_time: number;
        punch_datetime: Date | null;
        sub_second: number | null;
        station_serial: number | null;
        imported_at: Date;
        pushed_to_punch: number;
        runner_name: string | null;
        runner_id: number | null;
      }>;

      return punches.map((p) => ({
        id: p.id,
        cardNo: p.card_no,
        punchTime: toAbsolute(p.punch_time, zeroTime),
        punchDatetime: p.punch_datetime?.toISOString() ?? null,
        subSecond: p.sub_second,
        stationSerial: p.station_serial != null ? Number(p.station_serial) : null,
        importedAt: fmtDatetimeLocal(p.imported_at),
        pushedToPunch: p.pushed_to_punch !== 0,
        runnerName: p.runner_name,
        runnerId: p.runner_id,
      }));
    }),

  /**
   * Push a single backup punch into the oPunch table (manual import).
   */
  pushBackupPunch: publicProcedure
    .input(z.object({ punchId: z.number().int() }))
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureControlPunchesTable(client);

      // Fetch the backup punch
      const rows = (await client.$queryRawUnsafe(
        "SELECT id, control_id, card_no, punch_time FROM oxygen_control_punches WHERE id = ?",
        input.punchId,
      )) as Array<{
        id: number;
        control_id: number;
        card_no: number;
        punch_time: number;
      }>;
      if (rows.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: `Punch ${input.punchId} not found` });
      const bp = rows[0];

      // Get control code from oControl.Numbers (first code)
      const control = await client.oControl.findFirst({
        where: { Id: bp.control_id, Removed: false },
        select: { Numbers: true },
      });
      if (!control) throw new TRPCError({ code: "NOT_FOUND", message: `Control ${bp.control_id} not found` });
      const controlCode = parseInt(control.Numbers.split(";")[0]?.trim() ?? "0", 10);
      if (isNaN(controlCode) || controlCode <= 0) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid control code" });

      // Create oPunch record
      await client.oPunch.create({
        data: {
          CardNo: bp.card_no,
          Time: bp.punch_time,
          Type: controlCode,
          Origin: 5, // origin=5 for "imported from backup"
        },
      });

      // Mark as pushed
      await client.$executeRawUnsafe(
        "UPDATE oxygen_control_punches SET pushed_to_punch = 1 WHERE id = ?",
        input.punchId,
      );

      return { success: true };
    }),

  /**
   * List all backup punches across all controls, grouped by control.
   */
  listAllBackupPunches: publicProcedure.query(async () => {
    const client = await getCompetitionClient();
    await ensureControlPunchesTable(client);

    const zeroTime = await getZeroTime(client);

    const punches = (await client.$queryRawUnsafe(
      `SELECT p.id, p.control_id, p.card_no, p.punch_time, p.punch_datetime, p.sub_second,
              p.station_serial, p.imported_at, p.pushed_to_punch,
              r.Name as runner_name, r.Id as runner_id, r.Status as runner_status,
              r.StartTime as runner_start, r.FinishTime as runner_finish,
              c.Numbers as control_codes, c.Name as control_name
       FROM oxygen_control_punches p
       LEFT JOIN oRunner r ON r.CardNo = p.card_no AND r.Removed = 0
       LEFT JOIN oControl c ON c.Id = p.control_id AND c.Removed = 0
       ORDER BY p.control_id, p.punch_datetime, p.punch_time`,
    )) as Array<{
      id: number;
      control_id: number;
      card_no: number;
      punch_time: number;
      punch_datetime: Date | null;
      sub_second: number | null;
      station_serial: number | null;
      imported_at: Date;
      pushed_to_punch: number;
      runner_name: string | null;
      runner_id: number | null;
      runner_status: number | null;
      runner_start: number | null;
      runner_finish: number | null;
      control_codes: string | null;
      control_name: string | null;
    }>;

    return punches.map((p) => {
      const isFinish = p.control_id >= 311100 && p.control_id < 400000;
      const isStart = p.control_id >= 211100 && p.control_id < 300000;
      const registeredTime = isFinish ? p.runner_finish : isStart ? p.runner_start : null;
      const timeMatch = registeredTime != null && registeredTime > 0
        ? Math.abs(registeredTime - p.punch_time) <= 10
        : false;

      let matchStatus: "matched" | "no_runner" | "no_result" | "time_mismatch" | "unknown";
      if (p.runner_id == null) matchStatus = "no_runner";
      else if (p.runner_status == null || p.runner_status === 0) matchStatus = "no_result";
      else if (isFinish || isStart) matchStatus = timeMatch ? "matched" : "time_mismatch";
      else matchStatus = "unknown";

      return {
        id: p.id,
        controlId: p.control_id,
        controlCodes: p.control_codes ?? "",
        controlName: p.control_name ?? "",
        cardNo: p.card_no,
        punchTime: toAbsolute(p.punch_time, zeroTime),
        punchDatetime: p.punch_datetime instanceof Date ? p.punch_datetime.toISOString() : (p.punch_datetime as string | null),
        subSecond: p.sub_second,
        stationSerial: p.station_serial != null ? Number(p.station_serial) : null,
        importedAt: fmtDatetimeLocal(p.imported_at),
        pushedToPunch: !!p.pushed_to_punch,
        runnerName: p.runner_name,
        runnerId: p.runner_id,
        runnerStatus: p.runner_status,
        registeredTime,
        matchStatus,
      };
    });
  }),

  // ─── Competition-wide AIR+ config ─────────────────────

  /**
   * Get competition-wide AIR+ setting.
   */
  getAirPlusConfig: publicProcedure.query(async () => {
    const client = await getCompetitionClient();
    await ensureCompetitionConfigTable(client);

    const rows = (await client.$queryRawUnsafe(
      "SELECT air_plus, awake_hours FROM oxygen_competition_config WHERE id = 1",
    )) as Array<{ air_plus: number; awake_hours: number }>;

    return {
      airPlusEnabled: rows.length > 0 && rows[0].air_plus !== 0,
      awakeHours: rows.length > 0 ? rows[0].awake_hours : 6,
    };
  }),

  /**
   * Set competition-wide AIR+ and awake hours settings.
   */
  setAirPlusConfig: publicProcedure
    .input(z.object({
      enabled: z.boolean().optional(),
      awakeHours: z.number().int().min(1).max(12).optional(),
    }))
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureCompetitionConfigTable(client);

      const setClauses: string[] = [];
      if (input.enabled !== undefined) {
        setClauses.push(`air_plus = ${input.enabled ? 1 : 0}`);
      }
      if (input.awakeHours !== undefined) {
        setClauses.push(`awake_hours = ${input.awakeHours}`);
      }
      if (setClauses.length > 0) {
        await client.$executeRawUnsafe(
          `UPDATE oxygen_competition_config SET ${setClauses.join(", ")} WHERE id = 1`,
        );
      }

      return { success: true };
    }),

  /**
   * Return server time + NTP verification.
   * Checks the server clock against Cloudflare's trace endpoint.
   */
  serverTime: publicProcedure.query(async () => {
    const serverMs = Date.now();
    let ntpDriftMs: number | null = null;
    let ntpSource: string | null = null;

    try {
      const t1 = Date.now();
      const resp = await fetch("https://1.1.1.1/cdn-cgi/trace", {
        signal: AbortSignal.timeout(3000),
      });
      const t2 = Date.now();
      const text = await resp.text();
      const tsMatch = text.match(/ts=(\d+\.?\d*)/);
      if (tsMatch) {
        const cfUnixSec = parseFloat(tsMatch[1]);
        const localSec = (t1 + t2) / 2 / 1000;
        ntpDriftMs = Math.round((localSec - cfUnixSec) * 1000);
        ntpSource = "Cloudflare";
      }
    } catch {
      // NTP check failed — still return server time
    }

    return { unixMs: serverMs, ntpDriftMs, ntpSource };
  }),
});
