import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import type { PrismaClient } from "@prisma/client";
import {
  controlStatusToValue,
  valueToControlStatus,
  runnerStatusToValue,
} from "../statusConvert.js";
import type {
  ControlInfo,
  ControlDetail,
  ControlConfig,
  ControlUnit as ControlUnitDto,
} from "@oxygen/shared";

/** Resolve a control by its per-event seq. */
async function getControlBySeq(
  db: PrismaClient,
  eventId: bigint,
  seq: number,
) {
  const c = await db.control.findFirst({
    where: { eventId, seq, removed: false },
  });
  if (!c) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Control ${seq} not found`,
    });
  }
  return c;
}

function unitToDto(u: {
  stationSerial: number;
  lastProgrammedCode: number | null;
  batteryVoltageMv: number | null;
  batteryLow: boolean;
  checkedAt: Date | null;
  memoryClearedAt: Date | null;
  firmwareVersion: string | null;
  modelId: number | null;
  modelName: string | null;
  lastSeenAt: Date | null;
}): ControlUnitDto {
  return {
    stationSerial: u.stationSerial,
    lastProgrammedCode: u.lastProgrammedCode,
    batteryVoltage: u.batteryVoltageMv != null ? u.batteryVoltageMv / 1000 : null,
    batteryLow: u.batteryLow,
    checkedAt: u.checkedAt?.toISOString() ?? null,
    memoryClearedAt: u.memoryClearedAt?.toISOString() ?? null,
    firmwareVersion: u.firmwareVersion,
    modelId: u.modelId,
    modelName: u.modelName,
    lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
  };
}

function aggregateConfig(units: ControlUnitDto[], radioType: string, airPlus: string): ControlConfig | null {
  if (units.length === 0) return null;
  // Aggregate battery: lowest mv across units, OR'd low flag
  const voltages = units.map((u) => u.batteryVoltage).filter((v): v is number => v != null);
  const batteryVoltage = voltages.length ? Math.min(...voltages) : null;
  const batteryLow = units.some((u) => u.batteryLow);
  const checkedAt = units
    .map((u) => u.checkedAt)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1) ?? null;
  const memoryClearedAt = units
    .map((u) => u.memoryClearedAt)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1) ?? null;
  return {
    radioType: radioType as ControlConfig["radioType"],
    airPlus: airPlus as ControlConfig["airPlus"],
    autosendMode: "default" as ControlConfig["autosendMode"],
    batteryVoltage,
    batteryLow,
    checkedAt,
    memoryClearedAt,
  };
}

export const controlRouter = router({
  list: eventProcedure.query(async ({ ctx }): Promise<ControlInfo[]> => {
    const eventId = ctx.event.id;
    const controls = await ctx.db.control.findMany({
      where: { eventId, removed: false },
      orderBy: { seq: "asc" },
    });
    const units = await ctx.db.controlUnit.findMany({ where: { eventId } });
    const unitsByControl = new Map<string, typeof units>();
    for (const u of units) {
      if (!u.controlId) continue;
      const arr = unitsByControl.get(u.controlId) ?? [];
      arr.push(u);
      unitsByControl.set(u.controlId, arr);
    }

    // For each control, the number of runners on courses that include it.
    const ccs = await ctx.db.courseControl.findMany({
      select: { controlId: true, courseId: true },
    });
    const coursesByControl = new Map<string, Set<string>>();
    for (const cc of ccs) {
      const set = coursesByControl.get(cc.controlId) ?? new Set();
      set.add(cc.courseId);
      coursesByControl.set(cc.controlId, set);
    }
    const runnerCountByCourse = await ctx.db.class.findMany({
      where: { eventId, removed: false, courseId: { not: null } },
      select: { id: true, courseId: true },
    });
    const courseToClasses = new Map<string, Set<string>>();
    for (const cls of runnerCountByCourse) {
      if (!cls.courseId) continue;
      const set = courseToClasses.get(cls.courseId) ?? new Set();
      set.add(cls.id);
      courseToClasses.set(cls.courseId, set);
    }
    const allClassIds = [...new Set(runnerCountByCourse.map((c) => c.id))];
    const runnerCounts = allClassIds.length
      ? await ctx.db.runner.groupBy({
          by: ["classId"],
          _count: { classId: true },
          where: {
            eventId,
            removed: false,
            classId: { in: allClassIds },
          },
        })
      : [];
    const runnerCountByClass = new Map<string, number>(
      runnerCounts.map((rc) => [rc.classId ?? "", rc._count.classId]),
    );

    return controls.map((c): ControlInfo => {
      const u = (unitsByControl.get(c.id) ?? []).map(unitToDto);
      const courseSet = coursesByControl.get(c.id) ?? new Set();
      let runners = 0;
      for (const courseId of courseSet) {
        const classes = courseToClasses.get(courseId) ?? new Set();
        for (const clsId of classes) {
          runners += runnerCountByClass.get(clsId) ?? 0;
        }
      }
      return {
        id: c.seq,
        name: c.name,
        codes: c.codes,
        status: controlStatusToValue(c.status),
        timeAdjust: c.timeAdjust,
        minTime: c.minTime,
        runnerCount: runners,
        config: aggregateConfig(u, c.radioType, c.airPlus),
        units: u,
      };
    });
  }),

  getById: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }): Promise<ControlDetail> => {
      const c = await getControlBySeq(ctx.db, ctx.event.id, input.id);
      const units = await ctx.db.controlUnit.findMany({
        where: { eventId: ctx.event.id, controlId: c.id },
      });
      const u = units.map(unitToDto);
      const ccs = await ctx.db.courseControl.findMany({
        where: { controlId: c.id },
        include: { course: { select: { id: true, seq: true, name: true } } },
      });
      const courseOccurrences = new Map<string, { seq: number; name: string; count: number }>();
      for (const cc of ccs) {
        const existing = courseOccurrences.get(cc.course.id);
        if (existing) existing.count++;
        else
          courseOccurrences.set(cc.course.id, {
            seq: cc.course.seq,
            name: cc.course.name,
            count: 1,
          });
      }
      const courses = await Promise.all(
        [...courseOccurrences.entries()].map(async ([courseId, info]) => {
          const classes = await ctx.db.class.findMany({
            where: { eventId: ctx.event.id, courseId, removed: false },
            select: { id: true },
          });
          const runnerCount = classes.length
            ? await ctx.db.runner.count({
                where: {
                  eventId: ctx.event.id,
                  removed: false,
                  classId: { in: classes.map((cl) => cl.id) },
                },
              })
            : 0;
          return {
            courseId: info.seq,
            courseName: info.name,
            occurrences: info.count,
            runnerCount,
          };
        }),
      );
      return {
        id: c.seq,
        name: c.name,
        codes: c.codes,
        status: controlStatusToValue(c.status),
        timeAdjust: c.timeAdjust,
        minTime: c.minTime,
        runnerCount: courses.reduce((sum, c) => sum + c.runnerCount, 0),
        config: aggregateConfig(u, c.radioType, c.airPlus),
        units: u,
        courses,
      };
    }),

  create: eventProcedure
    .input(
      z.object({
        name: z.string().optional().default(""),
        codes: z.string().min(1),
        status: z.number().int().optional().default(0),
        timeAdjust: z.number().int().optional().default(0),
        minTime: z.number().int().optional().default(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await ctx.db.control.create({
        data: {
          eventId: ctx.event.id,
          name: input.name,
          codes: input.codes,
          status: valueToControlStatus(input.status),
          timeAdjust: input.timeAdjust,
          minTime: input.minTime,
        },
        select: { seq: true },
      });
      return { id: created.seq };
    }),

  update: eventProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().optional(),
        codes: z.string().optional(),
        status: z.number().int().optional(),
        timeAdjust: z.number().int().optional(),
        minTime: z.number().int().optional(),
        radioType: z.string().optional(),
        airPlus: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = await getControlBySeq(ctx.db, ctx.event.id, input.id);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.codes !== undefined) data.codes = input.codes;
      if (input.status !== undefined)
        data.status = valueToControlStatus(input.status);
      if (input.timeAdjust !== undefined) data.timeAdjust = input.timeAdjust;
      if (input.minTime !== undefined) data.minTime = input.minTime;
      if (input.radioType !== undefined) data.radioType = input.radioType;
      if (input.airPlus !== undefined) data.airPlus = input.airPlus;
      await ctx.db.control.update({ where: { id: c.id }, data });
      return { ok: true };
    }),

  delete: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const c = await getControlBySeq(ctx.db, ctx.event.id, input.id);
      await ctx.db.control.update({
        where: { id: c.id },
        data: { removed: true },
      });
      return { ok: true };
    }),

  /** Alias for getById so the web side can read `control.detail`. */
  detail: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const c = await getControlBySeq(ctx.db, ctx.event.id, input.id);
      const units = await ctx.db.controlUnit.findMany({
        where: { eventId: ctx.event.id, controlId: c.id },
      });
      const u = units.map(unitToDto);
      return {
        id: c.seq,
        name: c.name,
        codes: c.codes,
        status: controlStatusToValue(c.status),
        timeAdjust: c.timeAdjust,
        minTime: c.minTime,
        runnerCount: 0,
        config: aggregateConfig(u, c.radioType, c.airPlus),
        units: u,
        courses: [] as Array<{
          courseId: number;
          courseName: string;
          occurrences: number;
          runnerCount: number;
        }>,
      };
    }),

  /**
   * Per-event AIR+ defaults exposed to ControlsPage. `airPlusEnabled`
   * is the global toggle; `awakeHours` is how long stations should
   * stay awake after the last programming touch. Returned in the
   * legacy field names so the page renders without a follow-up patch.
   */
  getAirPlusConfig: eventProcedure.query(async ({ ctx }) => {
    const event = await ctx.db.event.findUnique({
      where: { id: ctx.event.id },
      select: { airPlus: true, awakeHours: true },
    });
    return {
      airPlusEnabled: event?.airPlus ?? false,
      awakeHours: event?.awakeHours ?? 6,
    };
  }),

  setAirPlusConfig: eventProcedure
    .input(
      z.object({
        enabled: z.boolean().optional(),
        airPlus: z.boolean().optional(),
        awakeHours: z.number().int().min(1).max(48).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data: Record<string, unknown> = {};
      const enabled = input.enabled ?? input.airPlus;
      if (enabled !== undefined) data.airPlus = enabled;
      if (input.awakeHours !== undefined) data.awakeHours = input.awakeHours;
      if (Object.keys(data).length > 0) {
        await ctx.db.event.update({
          where: { id: ctx.event.id },
          data,
        });
      }
      return { ok: true as const };
    }),

  /**
   * Persist control config (radio + air-plus override + station serial).
   *
   * Accepts either a single `controlId` or a bulk `controlIds` list so
   * the ControlsPage "bulk select + edit" UI can flip the radio type or
   * AIR+ override across many rows in one round-trip. `stationSerial`
   * is single-control only — it doesn't make sense for bulk edits.
   */
  upsertConfig: eventProcedure
    .input(
      z.object({
        controlId: z.number().int().optional(),
        controlIds: z.array(z.number().int()).optional(),
        radioType: z
          .enum(["normal", "internal_radio", "public_radio"])
          .optional(),
        airPlus: z.enum(["default", "on", "off"]).optional(),
        /**
         * Per-control AIR+ "autosend" override. The protocol values
         * are 'last' (send only the most recent unsent punch), 'unsent'
         * (send only never-sent punches), and 'all' (re-transmit
         * everything). Stored as a pass-through for now — the column
         * will move into a per-control JSONB once the EventPage AIR+
         * panel needs to read it back.
         */
        autosendMode: z.enum(["last", "unsent", "all"]).optional(),
        stationSerial: z.number().int().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const seqs =
        input.controlIds && input.controlIds.length > 0
          ? input.controlIds
          : input.controlId != null
            ? [input.controlId]
            : [];
      if (seqs.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Provide controlId or controlIds.",
        });
      }
      const ctrls = await Promise.all(
        seqs.map((s) => getControlBySeq(ctx.db, ctx.event.id, s)),
      );

      // `autosendMode` doesn't have a column yet in the PG schema —
      // it lived on the old `oxygen_control_config` table. Swallow it
      // silently so the UI keeps working; we'll restore the toggle
      // once we add a per-control config JSONB column.
      void input.autosendMode;
      const data: Record<string, unknown> = {};
      if (input.radioType !== undefined) data.radioType = input.radioType;
      if (input.airPlus !== undefined) data.airPlus = input.airPlus;
      if (Object.keys(data).length > 0) {
        await ctx.db.control.updateMany({
          where: { id: { in: ctrls.map((c) => c.id) } },
          data,
        });
      }

      // stationSerial only applies to a single-control upsert.
      if (input.stationSerial !== undefined && ctrls.length === 1) {
        const cid = ctrls[0].id;
        if (input.stationSerial === null) {
          await ctx.db.controlUnit.deleteMany({
            where: { eventId: ctx.event.id, controlId: cid },
          });
        } else {
          await ctx.db.controlUnit.upsert({
            where: {
              eventId_stationSerial: {
                eventId: ctx.event.id,
                stationSerial: input.stationSerial,
              },
            },
            create: {
              eventId: ctx.event.id,
              stationSerial: input.stationSerial,
              controlId: cid,
            },
            update: { controlId: cid },
          });
        }
      }
      return { ok: true as const };
    }),

  /**
   * Server time for clock-drift checks at controls.
   *
   * Returns:
   *   - `unixMs`: server wall clock right now (ms since epoch).
   *   - `now`: legacy alias for `unixMs`.
   *   - `ntpDriftMs`/`ntpSource`: populated when we have a recent NTP
   *     handshake from the time-sync helper; null otherwise (no
   *     external NTP probe is run here — that's the OS's job).
   */
  serverTime: eventProcedure.query(() => {
    const now = Date.now();
    return {
      now,
      unixMs: now,
      ntpDriftMs: null as number | null,
      ntpSource: null as string | null,
    };
  }),

  /** Record that a station was programmed (stub — full hardware sync pending). */
  recordProgramming: eventProcedure
    .input(
      z.object({
        stationSerial: z.number().int(),
        controlId: z.number().int().optional(),
        /**
         * `programmedCode` is the legacy input name (the code the
         * station was just programmed to advertise); the DB column
         * was renamed to `lastProgrammedCode` in the PG schema so we
         * accept both shapes.
         */
        programmedCode: z.number().int().optional(),
        lastProgrammedCode: z.number().int().optional(),
        firmwareVersion: z.string().optional(),
        modelId: z.number().int().optional(),
        modelName: z.string().optional(),
        /**
         * Battery voltage in millivolts read from the station during
         * programming. Currently a no-op pass-through — the column
         * lives on `oxygen_control_config` in the legacy schema and
         * hasn't been migrated to the PG `control_units` table yet.
         */
        batteryVoltage: z.number().int().optional(),
        batteryLow: z.boolean().optional(),
        /** Operator flagged that they wiped the station's backup memory. */
        memoryCleared: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      void input.batteryVoltage;
      void input.batteryLow;
      void input.memoryCleared;
      const controlUuid = input.controlId
        ? (await getControlBySeq(ctx.db, ctx.event.id, input.controlId)).id
        : null;
      await ctx.db.controlUnit.upsert({
        where: {
          eventId_stationSerial: {
            eventId: ctx.event.id,
            stationSerial: input.stationSerial,
          },
        },
        create: {
          eventId: ctx.event.id,
          stationSerial: input.stationSerial,
          controlId: controlUuid,
          lastProgrammedCode:
            input.lastProgrammedCode ?? input.programmedCode ?? null,
          firmwareVersion: input.firmwareVersion ?? null,
          modelId: input.modelId ?? null,
          modelName: input.modelName ?? null,
          checkedAt: new Date(),
        },
        update: {
          ...(controlUuid != null ? { controlId: controlUuid } : {}),
          ...(input.lastProgrammedCode !== undefined ||
          input.programmedCode !== undefined
            ? {
                lastProgrammedCode:
                  input.lastProgrammedCode ?? input.programmedCode!,
              }
            : {}),
          ...(input.firmwareVersion !== undefined
            ? { firmwareVersion: input.firmwareVersion }
            : {}),
          ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
          ...(input.modelName !== undefined ? { modelName: input.modelName } : {}),
          checkedAt: new Date(),
        },
      });
      return { ok: true as const };
    }),

  /** Import punches from an SI station's backup memory. */
  /**
   * List every backup-memory punch for the event, joined with runner +
   * control info so the Backup Punches page can show match status at
   * a glance.
   *
   * `matchStatus` classifies each punch into one of:
   *   - no_runner       — no runner has this card
   *   - no_result       — runner exists but hasn't finished
   *   - matched         — start/finish punch within ±1s of the
   *                       stored start/finish time on the runner
   *   - time_mismatch   — start/finish punch but time differs >1s
   *   - unknown         — regular control (no canonical reference time)
   */
  listAllBackupPunches: eventProcedure.query(async ({ ctx }) => {
    const eventId = ctx.event.id;
    const punches = await ctx.db.punch.findMany({
      where: { eventId, source: "backup_memory", removed: false },
      orderBy: [{ controlId: "asc" }, { punchedAt: "asc" }, { time: "asc" }],
      include: {
        control: { select: { codes: true, name: true, status: true, seq: true } },
        unit: { select: { stationSerial: true } },
      },
    });

    // Pre-fetch the matching runners by card number for the join.
    const cardNos = [...new Set(punches.map((p) => p.cardNo))];
    const runners = cardNos.length
      ? await ctx.db.runner.findMany({
          where: { eventId, cardNo: { in: cardNos }, removed: false },
          select: {
            seq: true,
            name: true,
            cardNo: true,
            status: true,
            startTime: true,
            finishTime: true,
          },
        })
      : [];
    const runnerByCard = new Map(runners.map((r) => [r.cardNo, r]));

    return punches.map((p) => {
      const ctrl = p.control;
      const isFinish = ctrl?.status === "finish";
      const isStart = ctrl?.status === "start";
      const r = runnerByCard.get(p.cardNo);
      const registeredTime = isFinish
        ? r?.finishTime ?? null
        : isStart
          ? r?.startTime ?? null
          : null;
      const timeMatch =
        registeredTime != null && registeredTime > 0
          ? Math.abs(registeredTime - p.time) <= 10
          : false;

      let matchStatus: "matched" | "no_runner" | "no_result" | "time_mismatch" | "unknown";
      if (!r) matchStatus = "no_runner";
      else if (r.status === "not_competing") matchStatus = "no_result";
      else if (isFinish || isStart)
        matchStatus = timeMatch ? "matched" : "time_mismatch";
      else matchStatus = "unknown";

      return {
        id: p.id,
        controlId: ctrl?.seq ?? 0,
        controlCodes: ctrl?.codes ?? "",
        controlName: ctrl?.name ?? "",
        cardNo: p.cardNo,
        punchTime: p.time,
        punchDatetime: p.punchedAt ? p.punchedAt.toISOString() : null,
        subSecond: p.subSecond,
        stationSerial: p.unit?.stationSerial ?? null,
        importedAt: p.importedAt.toISOString(),
        pushedToPunch: !p.isOriginal,
        runnerName: r?.name ?? null,
        runnerId: r?.seq ?? null,
        runnerStatus: r ? runnerStatusToValue(r.status) : null,
        registeredTime,
        matchStatus,
      };
    });
  }),

  /**
   * Push a single backup-memory punch into the canonical punch stream.
   * In the new schema we don't dedupe between source streams, so we
   * just flip `isOriginal` to mark the backup row as "processed" and
   * insert a `source: 'manual'` mirror so downstream consumers (the
   * matcher) see it.
   */
  pushBackupPunch: eventProcedure
    .input(z.object({ punchId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const bp = await ctx.db.punch.findUnique({ where: { id: input.punchId } });
      if (!bp || bp.eventId !== ctx.event.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Backup punch ${input.punchId} not found`,
        });
      }
      await ctx.db.punch.create({
        data: {
          eventId: ctx.event.id,
          cardNo: bp.cardNo,
          controlCode: bp.controlCode,
          controlId: bp.controlId,
          unitId: bp.unitId,
          time: bp.time,
          punchedAt: bp.punchedAt,
          subSecond: bp.subSecond,
          source: "manual",
        },
      });
      await ctx.db.punch.update({
        where: { id: bp.id },
        data: { isOriginal: false },
      });
      return { success: true as const };
    }),

  /**
   * Bulk-import backup-memory punches for a single station.
   *
   * The ControlsPage uploader sends `punches` in the legacy
   * `{ cardNo, punchTime, punchDatetime, subSecond }` shape. The new
   * `punches` table also wants a `controlCode` and a ZeroTime-relative
   * `time`; we derive both from the station's mapped control (when
   * `controlId` is set) and rewrite `punchTime` (seconds × 10) into
   * `time`. New callers can send `{ controlCode, time, punchedAt }`
   * directly — both shapes are accepted.
   */
  importBackupPunches: eventProcedure
    .input(
      z.object({
        controlId: z.number().int().optional(),
        stationSerial: z.number().int().optional(),
        punches: z.array(
          z.object({
            cardNo: z.number().int(),
            punchTime: z.number().int().optional(),
            punchDatetime: z.string().optional(),
            controlCode: z.number().int().optional(),
            time: z.number().int().optional(),
            punchedAt: z.string().optional(),
            subSecond: z.number().int().optional(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ctrl = input.controlId
        ? await getControlBySeq(ctx.db, ctx.event.id, input.controlId)
        : null;
      const controlUuid = ctrl?.id ?? null;
      const fallbackControlCode = ctrl
        ? parseInt(ctrl.codes.split(";")[0]?.trim() ?? "0", 10) || 0
        : 0;
      const unitRow = input.stationSerial
        ? await ctx.db.controlUnit.findUnique({
            where: {
              eventId_stationSerial: {
                eventId: ctx.event.id,
                stationSerial: input.stationSerial,
              },
            },
            select: { id: true },
          })
        : null;
      const data = input.punches.map((p) => ({
        eventId: ctx.event.id,
        cardNo: p.cardNo,
        controlCode: p.controlCode ?? fallbackControlCode,
        controlId: controlUuid,
        unitId: unitRow?.id ?? null,
        time: p.time ?? p.punchTime ?? 0,
        punchedAt: p.punchedAt
          ? new Date(p.punchedAt)
          : p.punchDatetime
            ? new Date(p.punchDatetime)
            : null,
        subSecond: p.subSecond ?? null,
        source: "backup_memory",
      }));
      const result = await ctx.db.punch.createMany({ data, skipDuplicates: true });
      return { ok: true as const, inserted: result.count, count: result.count };
    }),
});
