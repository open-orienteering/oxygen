import { createSocket } from "node:dgram";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure, raceProcedure } from "../trpc.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import {
  controlStatusToValue,
  valueToControlStatus,
  runnerStatusToValue,
} from "../statusConvert.js";
import type {
  ControlInfo,
  ControlDetail,
  ControlConfig,
  ControlDescription,
  ControlUnit as ControlUnitDto,
} from "@oxygen/shared";
import { uuidv7 } from "uuidv7";
import { toAbsolute } from "../timeConvert.js";
import { appendJournal } from "../journalEmit.js";
import { emitControlUpserted, emitCourseUpserted } from "../referenceJournal.js";
import { Prisma as PrismaNs } from "../generated/prisma/client.js";
import { loadEventCrs } from "../event-crs.js";
import { loadEventMapObjects } from "../event-map-objects.js";
import { suggestDescriptions } from "../description-autodetect.js";
import { mapMmToWgs84 } from "../map-projection.js";
import { rebuildCourseGeometry } from "../course-geometry.js";

// ─── SNTP client (used by control.serverTime) ──────────────────────

/** NTP epoch is 1900-01-01; Unix epoch is 1970-01-01. */
const NTP_UNIX_EPOCH_DELTA_SEC = 2208988800;

/** Decode an 8-byte NTP timestamp at `offset` into a Unix ms value. */
function readNtpTimestampMs(buf: Buffer, offset: number): number {
  const seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  // Convert NTP seconds → Unix seconds, then add fractional component
  // (fraction is /2^32 of a second).
  return (seconds - NTP_UNIX_EPOCH_DELTA_SEC) * 1000 + (fraction / 0x1_0000_0000) * 1000;
}

/**
 * Issue one SNTPv4 query to `host:123` and return offset + RTT.
 *
 * Offset formula (RFC 5905 §8): ((T2 - T1) + (T3 - T4)) / 2 where
 *   T1 = client send time, T2 = server receive, T3 = server transmit,
 *   T4 = client receive. A POSITIVE offset means local clock is BEHIND
 *   the server; we flip the sign at the caller so a positive drift
 *   means local is AHEAD (matches the user-visible "drift: +N ms" UI).
 */
async function sntpQuery(host: string, timeoutMs: number): Promise<{
  driftMs: number;
  rttMs: number;
} | null> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const packet = Buffer.alloc(48);
    // LI=0 (no warning), VN=4, Mode=3 (client) → 0x23
    packet[0] = 0x23;

    let settled = false;
    const settle = (value: { driftMs: number; rttMs: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close();
      resolve(value);
    };

    const timer = setTimeout(() => settle(null), timeoutMs);
    socket.on("error", () => settle(null));
    socket.on("message", (msg) => {
      const t4 = Date.now();
      if (msg.length < 48) return settle(null);
      const buf = Buffer.from(msg);
      const t2 = readNtpTimestampMs(buf, 32); // server receive
      const t3 = readNtpTimestampMs(buf, 40); // server transmit
      // (t2 - t1) + (t3 - t4) / 2 — but flip the sign so positive = local ahead
      const localOffsetMs = -((t2 - t1) + (t3 - t4)) / 2;
      const rttMs = (t4 - t1) - (t3 - t2);
      settle({ driftMs: localOffsetMs, rttMs: Math.max(0, rttMs) });
    });

    const t1 = Date.now();
    socket.send(packet, 123, host, (err) => {
      if (err) settle(null);
    });
  });
}

/**
 * Measure local clock drift against a public NTP server. Takes 4 samples
 * against `pool.ntp.org`, keeps the one with the lowest RTT (symmetric
 * delay = most accurate offset), and returns the result. Falls through
 * to {null, null} when all samples fail (UDP/123 blocked, offline).
 */
async function measureNtpDrift(): Promise<{
  driftMs: number | null;
  sourceLabel: string | null;
}> {
  const SAMPLES = 4;
  const PER_SAMPLE_TIMEOUT_MS = 1500;
  const samples: { rttMs: number; driftMs: number }[] = [];

  for (let i = 0; i < SAMPLES; i++) {
    const result = await sntpQuery("pool.ntp.org", PER_SAMPLE_TIMEOUT_MS);
    if (result) samples.push(result);
  }

  if (samples.length === 0) {
    return { driftMs: null, sourceLabel: null };
  }
  // Lowest-RTT sample wins. Tie-break by smaller |drift| for determinism.
  const best = samples.reduce((a, b) =>
    b.rttMs < a.rttMs || (b.rttMs === a.rttMs && Math.abs(b.driftMs) < Math.abs(a.driftMs))
      ? b
      : a,
  );
  return {
    driftMs: Math.round(best.driftMs),
    sourceLabel: `pool.ntp.org (best of ${samples.length}, RTT ${Math.round(best.rttMs)}ms)`,
  };
}

/**
 * Resolve a control by its user-facing numeric identifier.
 *
 * Controls are addressed by their punch code (e.g. 50, 100, 150) — the same
 * value runners see on the map. The page exposes the code as `id` in URLs
 * (`?control=50`) and table keys, so all mutation endpoints accept it too.
 * Falls back to per-event seq for legacy / non-coded controls (start /
 * finish punches stored without a numeric code).
 */
async function getControlByCode(
  db: PrismaClient,
  eventId: bigint,
  code: number,
) {
  const codeStr = String(code);
  const c = await db.control.findFirst({
    where: {
      eventId,
      removed: false,
      OR: [
        { codes: codeStr },
        { codes: { startsWith: `${codeStr};` } },
        { codes: { contains: `;${codeStr};` } },
        { codes: { endsWith: `;${codeStr}` } },
      ],
    },
  });
  if (c) return c;
  // Fallback: treat the input as a seq for controls without a code.
  const bySeq = await db.control.findFirst({
    where: { eventId, seq: code, removed: false },
  });
  if (!bySeq) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Control ${code} not found`,
    });
  }
  return bySeq;
}

/**
 * Ids of every course whose geometry depends on a control: courses that
 * visit it via `course_controls`, plus — for start/finish controls —
 * courses that reference it by role (startName / finishControlId, or by
 * the lowest-seq default when unset, mirroring rebuildCourseGeometry).
 * Used by control.update (position moves) and control.delete (cascade).
 */
async function courseIdsUsingControl(
  tx: PrismaNs.TransactionClient,
  eventId: bigint,
  c: { id: string; name: string; status: string },
): Promise<string[]> {
  const ccs = await tx.courseControl.findMany({
    where: {
      controlId: c.id,
      course: { eventId, removed: false },
    },
    select: { courseId: true },
  });
  // Start/finish controls don't appear in course_controls — they are
  // referenced by startName / finishControlId (with a lowest-seq
  // fallback).
  let asStartOrFinish: Array<{ id: string }> = [];
  if (c.status === "start" || c.status === "finish") {
    const peers = await tx.control.findMany({
      where: { eventId, removed: false, status: c.status },
      orderBy: { seq: "asc" },
      select: { id: true },
    });
    const isDefault = peers[0]?.id === c.id;
    asStartOrFinish = await tx.course.findMany({
      where: {
        eventId,
        removed: false,
        ...(c.status === "start"
          ? {
              firstAsStart: false,
              OR: [
                ...(c.name ? [{ startName: c.name }] : []),
                ...(isDefault ? [{ startName: "" }] : []),
              ],
            }
          : {
              lastAsFinish: false,
              OR: [
                { finishControlId: c.id },
                ...(isDefault ? [{ finishControlId: null }] : []),
              ],
            }),
      },
      select: { id: true },
    });
  }
  return [
    ...new Set([
      ...ccs.map((cc) => cc.courseId),
      ...asStartOrFinish.map((co) => co.id),
    ]),
  ];
}

/** Extract the first numeric code from a control's `codes` string. */
function firstCode(codes: string): number {
  const head = codes.split(";")[0]?.trim();
  const n = parseInt(head ?? "", 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * User-facing id for a control: first code, falling back to seq.
 * Exported because every endpoint that exposes control ids to the web
 * app (control.list, course.controlCoordinates, …) must use the same
 * ID space — the MapPanel filters compare them directly.
 */
export function publicControlId(c: { codes: string; seq: number }): number {
  return firstCode(c.codes) || c.seq;
}

/**
 * Station battery reading in millivolts.
 *
 * SI stations report volts (`(raw * 5) / 65536`, so at most ~5 V), and
 * `control_units.battery_voltage_mv` is an INT. The range makes the
 * volts-vs-millivolts mistake fail loudly at the boundary instead of
 * storing a nonsense value.
 */
const batteryMvSchema = z.number().int().min(500).max(10_000).optional();

/**
 * IOF control description input ({ c, d, g, s, f } in the OCAD text
 * encoding — see `ControlDescription` in @oxygen/shared).
 */
const controlDescriptionSchema = z.object({
  c: z.string().max(20).optional(),
  d: z.string().max(20).optional(),
  g: z.string().max(20).optional(),
  s: z.string().max(20).optional(),
  f: z.string().max(20).optional(),
});

/** Read the JSONB description column into the shared DTO type. */
function descriptionDto(row: { description: unknown }): ControlDescription | null {
  return (row.description as ControlDescription | null) ?? null;
}

/**
 * Derive WGS84 lat/lng from a paper-mm position via the event map's CRS.
 * Returns nulls when there is no map, the grid is unsupported, or the
 * position is the "unplaced" origin — `course.controlCoordinates` keeps
 * its on-the-fly conversion as a fallback for the null case.
 */
async function positionToWgs84(
  db: Parameters<typeof loadEventCrs>[0],
  eventId: bigint,
  xpos: number,
  ypos: number,
): Promise<{ lat: number | null; lng: number | null }> {
  if (xpos === 0 && ypos === 0) return { lat: null, lng: null };
  const crs = await loadEventCrs(db, eventId);
  if (!crs) return { lat: null, lng: null };
  const wgs = mapMmToWgs84(xpos, ypos, crs);
  return wgs ? { lat: wgs.lat, lng: wgs.lng } : { lat: null, lng: null };
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
  srrCfg: boolean;
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
    srrCfg: u.srrCfg,
    lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
  };
}

function aggregateConfig(
  units: ControlUnitDto[],
  radioType: string,
  airPlus: string,
  autosendMode: string,
): ControlConfig | null {
  // Aggregate per-unit telemetry (battery, last-checked, last-cleared).
  // Only present once at least one station has been programmed against
  // this control — otherwise these fall back to null.
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
  // `radioType`, `airPlus`, `autosendMode` are persisted on the control
  // row itself, not the unit — return them even when no unit exists yet
  // so a freshly-created control's dropdowns reflect the saved values.
  return {
    radioType: radioType as ControlConfig["radioType"],
    airPlus: airPlus as ControlConfig["airPlus"],
    autosendMode: autosendMode as ControlConfig["autosendMode"],
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
        id: publicControlId(c),
        name: c.name,
        codes: c.codes,
        status: controlStatusToValue(c.status),
        timeAdjust: c.timeAdjust,
        minTime: c.minTime,
        runnerCount: runners,
        config: aggregateConfig(u, c.radioType, c.airPlus, c.autosendMode),
        units: u,
        description: descriptionDto(c),
      };
    });
  }),

  getById: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }): Promise<ControlDetail> => {
      const c = await getControlByCode(ctx.db, ctx.event.id, input.id);
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
        id: publicControlId(c),
        name: c.name,
        codes: c.codes,
        status: controlStatusToValue(c.status),
        timeAdjust: c.timeAdjust,
        minTime: c.minTime,
        runnerCount: courses.reduce((sum, c) => sum + c.runnerCount, 0),
        config: aggregateConfig(u, c.radioType, c.airPlus, c.autosendMode),
        units: u,
        courses,
        description: descriptionDto(c),
      };
    }),

  create: raceProcedure
    .input(
      z
        .object({
          name: z.string().optional().default(""),
          codes: z.string().min(1),
          status: z.number().int().optional().default(0),
          timeAdjust: z.number().int().optional().default(0),
          minTime: z.number().int().optional().default(0),
          /** Map position in paper mm (course editor). Both or neither. */
          xpos: z.number().finite().optional(),
          ypos: z.number().finite().optional(),
          description: controlDescriptionSchema.optional(),
        })
        .refine((v) => (v.xpos === undefined) === (v.ypos === undefined), {
          message: "xpos and ypos must be provided together",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      // Validate codes: each part must be a positive integer.
      const parts = input.codes.split(";").map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid control code: at least one code is required",
        });
      }
      const parsed: number[] = [];
      for (const p of parts) {
        const n = parseInt(p, 10);
        if (!Number.isFinite(n) || n <= 0 || String(n) !== p) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Invalid control code: "${p}" is not a positive integer`,
          });
        }
        parsed.push(n);
      }
      // Reject duplicates (codes already used by another control).
      for (const n of parsed) {
        const dup = await ctx.db.control.findFirst({
          where: {
            eventId: ctx.event.id,
            removed: false,
            OR: [
              { codes: String(n) },
              { codes: { startsWith: `${n};` } },
              { codes: { contains: `;${n};` } },
              { codes: { endsWith: `;${n}` } },
            ],
          },
          select: { id: true },
        });
        if (dup) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Control with code ${n} already exists`,
          });
        }
      }
      // Resolve WGS84 coordinates up-front (outside the transaction — the
      // CRS load may parse the whole map file on a cache miss).
      const hasPosition = input.xpos !== undefined && input.ypos !== undefined;
      const wgs = hasPosition
        ? await positionToWgs84(ctx.db, ctx.event.id, input.xpos!, input.ypos!)
        : null;

      // Table write + control.upserted journal entry commit together.
      const created = await ctx.db.$transaction(async (tx) => {
        const c = await tx.control.create({
          data: {
            eventId: ctx.event.id,
            name: input.name,
            codes: input.codes,
            status: valueToControlStatus(input.status),
            timeAdjust: input.timeAdjust,
            minTime: input.minTime,
            ...(hasPosition
              ? { xpos: input.xpos!, ypos: input.ypos!, lat: wgs!.lat, lng: wgs!.lng }
              : {}),
            ...(input.description
              ? { description: input.description as Record<string, string> }
              : {}),
          },
          select: { id: true, seq: true, codes: true },
        });
        await emitControlUpserted(tx, ctx.event.id, c.id);
        return c;
      });
      return { id: publicControlId(created) };
    }),

  update: raceProcedure
    .input(
      z
        .object({
          id: z.number().int(),
          name: z.string().optional(),
          codes: z.string().optional(),
          status: z.number().int().optional(),
          timeAdjust: z.number().int().optional(),
          minTime: z.number().int().optional(),
          radioType: z.string().optional(),
          airPlus: z.string().optional(),
          /** Map position in paper mm (course editor). Both or neither. */
          xpos: z.number().finite().optional(),
          ypos: z.number().finite().optional(),
          /** IOF description; null clears it. */
          description: controlDescriptionSchema.nullable().optional(),
        })
        .refine((v) => (v.xpos === undefined) === (v.ypos === undefined), {
          message: "xpos and ypos must be provided together",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = await getControlByCode(ctx.db, ctx.event.id, input.id);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.codes !== undefined) data.codes = input.codes;
      if (input.status !== undefined)
        data.status = valueToControlStatus(input.status);
      if (input.timeAdjust !== undefined) data.timeAdjust = input.timeAdjust;
      if (input.minTime !== undefined) data.minTime = input.minTime;
      if (input.radioType !== undefined) data.radioType = input.radioType;
      if (input.airPlus !== undefined) data.airPlus = input.airPlus;
      if (input.description !== undefined) {
        data.description = input.description === null ? PrismaNs.DbNull : input.description;
      }

      const positionChanged =
        input.xpos !== undefined &&
        input.ypos !== undefined &&
        (input.xpos !== c.xpos || input.ypos !== c.ypos);
      if (input.xpos !== undefined && input.ypos !== undefined) {
        // Always re-derive lat/lng with the position so a stale WGS84 pair
        // from the previous location can't survive a move.
        const wgs = await positionToWgs84(ctx.db, ctx.event.id, input.xpos, input.ypos);
        data.xpos = input.xpos;
        data.ypos = input.ypos;
        data.lat = wgs.lat;
        data.lng = wgs.lng;
      }

      await ctx.db.$transaction(async (tx) => {
        await tx.control.update({ where: { id: c.id }, data });
        await emitControlUpserted(tx, ctx.event.id, c.id);
        if (positionChanged) {
          // A moved control invalidates the stored overlay geometry of
          // every course that visits it — regenerate straight-leg
          // 'editor' geometry and ship the updated course rows.
          const courseIds = await courseIdsUsingControl(tx, ctx.event.id, c);
          await rebuildCourseGeometry(tx, ctx.event.id, courseIds);
          for (const courseId of courseIds) {
            await emitCourseUpserted(tx, ctx.event.id, courseId);
          }
        }
      });
      return { ok: true };
    }),

  delete: raceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const c = await getControlByCode(ctx.db, ctx.event.id, input.id);
      await ctx.db.$transaction(async (tx) => {
        // Dependent courses are computed while the control still counts
        // as active — the start/finish default (lowest live seq) must
        // see the pre-delete world.
        const courseIds = await courseIdsUsingControl(tx, ctx.event.id, c);
        await tx.control.update({
          where: { id: c.id },
          data: { removed: true },
        });
        // Cascade out of every course sequence. A soft-deleted control
        // must not leave ghost rows behind: routes through a missing
        // circle, symbol-less description rows, and sequence entries
        // that can't be removed (course.update resolves ids against
        // ACTIVE controls only and would 404 on the dead reference).
        await tx.courseControl.deleteMany({ where: { controlId: c.id } });
        // Deletes are upserts with removed: true on the wire.
        await emitControlUpserted(tx, ctx.event.id, c.id);
        await rebuildCourseGeometry(tx, ctx.event.id, courseIds);
        for (const courseId of courseIds) {
          await emitCourseUpserted(tx, ctx.event.id, courseId);
        }
      });
      return { ok: true };
    }),

  /**
   * Undo a soft delete. The course editor's undo stack needs this to
   * reverse a control deletion without minting a new row (course
   * references and journal identity stay intact).
   */
  restore: raceProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const codeStr = String(input.id);
      // Deleted controls are invisible to getControlByCode, so match the
      // same code/seq ID space among removed rows. Most-recently-updated
      // wins when several deleted rows share a code.
      const c = await ctx.db.control.findFirst({
        where: {
          eventId: ctx.event.id,
          removed: true,
          OR: [
            { codes: codeStr },
            { codes: { startsWith: `${codeStr};` } },
            { codes: { contains: `;${codeStr};` } },
            { codes: { endsWith: `;${codeStr}` } },
            { seq: input.id },
          ],
        },
        orderBy: { updatedAt: "desc" },
      });
      if (!c) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Deleted control ${input.id} not found`,
        });
      }
      // The code may have been reused by a new control in the meantime.
      const activeDup = await ctx.db.control.findFirst({
        where: {
          eventId: ctx.event.id,
          removed: false,
          OR: [
            { codes: codeStr },
            { codes: { startsWith: `${codeStr};` } },
            { codes: { contains: `;${codeStr};` } },
            { codes: { endsWith: `;${codeStr}` } },
          ],
        },
        select: { id: true },
      });
      if (activeDup) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Control with code ${input.id} already exists`,
        });
      }
      await ctx.db.$transaction(async (tx) => {
        await tx.control.update({
          where: { id: c.id },
          data: { removed: false },
        });
        await emitControlUpserted(tx, ctx.event.id, c.id);
      });
      return { id: publicControlId(c) };
    }),

  /** Alias for getById so the web side can read `control.detail`. */
  detail: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const c = await getControlByCode(ctx.db, ctx.event.id, input.id);
      const units = await ctx.db.controlUnit.findMany({
        where: { eventId: ctx.event.id, controlId: c.id },
      });
      const u = units.map(unitToDto);

      // Compute course usage: which courses include this control, how
      // many times each one references it, and how many runners are
      // registered to those courses.
      const courseRows = await ctx.db.courseControl.findMany({
        where: { controlId: c.id, course: { eventId: ctx.event.id, removed: false } },
        select: { courseId: true, course: { select: { seq: true, name: true } } },
      });
      const occByCourse = new Map<
        string,
        { seq: number; name: string; occurrences: number }
      >();
      for (const row of courseRows) {
        const prev = occByCourse.get(row.courseId);
        if (prev) {
          prev.occurrences += 1;
        } else {
          occByCourse.set(row.courseId, {
            seq: row.course.seq,
            name: row.course.name,
            occurrences: 1,
          });
        }
      }
      const courseIds = Array.from(occByCourse.keys());
      const runnerCountsRaw =
        courseIds.length > 0
          ? await ctx.db.runner.groupBy({
              by: ["courseId"],
              where: {
                eventId: ctx.event.id,
                removed: false,
                courseId: { in: courseIds },
              },
              _count: { _all: true },
            })
          : [];
      const runnerCountByCourse = new Map<string, number>();
      for (const r of runnerCountsRaw) {
        if (r.courseId) runnerCountByCourse.set(r.courseId, r._count._all);
      }
      // Runners with no explicit courseId fall back to their class's course.
      // Count those by joining classes → course.
      const classRunnerCounts =
        courseIds.length > 0
          ? await ctx.db.class.findMany({
              where: {
                eventId: ctx.event.id,
                courseId: { in: courseIds },
              },
              select: {
                courseId: true,
                _count: {
                  select: {
                    runners: {
                      where: { removed: false, courseId: null },
                    },
                  },
                },
              },
            })
          : [];
      for (const cr of classRunnerCounts) {
        if (!cr.courseId) continue;
        runnerCountByCourse.set(
          cr.courseId,
          (runnerCountByCourse.get(cr.courseId) ?? 0) + cr._count.runners,
        );
      }
      const courses = Array.from(occByCourse.entries())
        .map(([cid, meta]) => ({
          courseId: meta.seq,
          courseName: meta.name,
          occurrences: meta.occurrences,
          runnerCount: runnerCountByCourse.get(cid) ?? 0,
        }))
        .sort((a, b) => a.courseName.localeCompare(b.courseName));

      return {
        id: publicControlId(c),
        name: c.name,
        codes: c.codes,
        status: controlStatusToValue(c.status),
        timeAdjust: c.timeAdjust,
        minTime: c.minTime,
        runnerCount: courses.reduce((sum, x) => sum + x.runnerCount, 0),
        config: aggregateConfig(u, c.radioType, c.airPlus, c.autosendMode),
        units: u,
        courses,
        description: descriptionDto(c),
      };
    }),

  /**
   * Description candidates for a point on the base map.
   *
   * The course editor calls this after placing a control: the terrain
   * features around the point are ranked and offered as one-click
   * column D (+ G) suggestions. Coordinates are paper mm, matching
   * `controls.xpos/ypos`. No map, or a map with no recognised symbols
   * nearby, simply yields an empty list — the editor then shows nothing
   * extra.
   */
  suggestDescription: eventProcedure
    .input(
      z.object({
        x: z.number().finite(),
        y: z.number().finite(),
        radiusMm: z.number().positive().max(20).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const objects = await loadEventMapObjects(ctx.db, ctx.event.id);
      if (!objects || objects.length === 0) return { candidates: [] };
      return {
        candidates: suggestDescriptions(objects, input.x, input.y, {
          radiusMm: input.radiusMm,
        }),
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
        seqs.map((s) => getControlByCode(ctx.db, ctx.event.id, s)),
      );

      const data: Record<string, unknown> = {};
      if (input.radioType !== undefined) data.radioType = input.radioType;
      if (input.airPlus !== undefined) data.airPlus = input.airPlus;
      if (input.autosendMode !== undefined) data.autosendMode = input.autosendMode;
      if (Object.keys(data).length > 0) {
        // Radio / AIR+ config lives on the control row, so it journals like
        // any other control edit (the per-unit telemetry below does not).
        await ctx.db.$transaction(async (tx) => {
          await tx.control.updateMany({
            where: { id: { in: ctrls.map((c) => c.id) } },
            data,
          });
          for (const c of ctrls) {
            await emitControlUpserted(tx, ctx.event.id, c.id);
          }
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
   * Speaks SNTPv4 over UDP/123 to a public NTP server. Takes several
   * samples and keeps the one with the lowest round-trip time — that's
   * the classic NTP technique, since low RTT means symmetric delay and
   * therefore the most accurate offset estimate.
   *
   * Why SNTP rather than an HTTP time source:
   *   - Cloudflare's `/cdn-cgi/trace` truncates `ts=` to whole seconds,
   *     giving a ±500ms precision floor regardless of RTT.
   *   - timeapi.io exposes ms-precision but its own server clock is
   *     ~1 second behind UTC (verified against pool.ntp.org).
   *   - HTTP `Date` headers are RFC 7231 second-precision.
   *   - SNTP is what real NTP clients use; gives ms-or-better accuracy.
   *
   * Falls back to null/null if outbound UDP/123 is blocked or all
   * samples time out — the page then shows browser-vs-server drift only.
   *
   * Returns:
   *   - `unixMs` / `now`: server wall clock right now (ms since epoch).
   *   - `ntpDriftMs` / `ntpSource`: drift of THIS server's clock vs the
   *     NTP reference, or null when the probe failed. `ntpSource`
   *     includes the best sample's RTT so the operator can judge
   *     trust — sub-50ms RTT means the reading is accurate to a couple ms.
   */
  serverTime: eventProcedure.query(async () => {
    const serverMs = Date.now();
    const { driftMs, sourceLabel } = await measureNtpDrift();
    return {
      now: serverMs,
      unixMs: serverMs,
      ntpDriftMs: driftMs,
      ntpSource: sourceLabel,
    };
  }),

  /**
   * Record that a station was programmed.
   *
   * Upserts a `control_units` row keyed by `(event_id, station_serial)`
   * with every field the operator captured during programming —
   * programmed code, firmware / model identity, battery state, and an
   * optional "memory cleared" timestamp. Stamps `checked_at` +
   * `last_seen_at` so the Controls page can show recency, and uses the
   * `battery_low` flag to drive the low-battery badge.
   */
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
         * Battery voltage in **millivolts** read from the station during
         * programming. Persisted on `control_units.battery_voltage_mv`
         * so the Controls page can light up the low-battery badge and
         * the operator can see exactly when a unit was last seen.
         *
         * `batteryVoltage` is the legacy input name and carries the same
         * unit; `batteryVoltageMv` spells it out. The lower bound rejects
         * a reading accidentally passed through in volts (SI hardware
         * reports volts), which would otherwise persist as a few mV and
         * permanently mark the unit as flat.
         */
        batteryVoltage: batteryMvSchema,
        batteryVoltageMv: batteryMvSchema,
        batteryLow: z.boolean().optional(),
        /** Operator flagged that they wiped the station's backup memory. */
        memoryCleared: z.boolean().optional(),
        /**
         * SRR_CFG bit read from the station while programming. The
         * Controls page surfaces this as an "SRR+" badge so the
         * operator can confirm the hardware short-range radio is
         * actually enabled on the unit (vs the station merely being
         * an AIR+ unit without SRR). Optional because older callers
         * never sent it; absent → leave the persisted value alone.
         */
        srrCfg: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const controlUuid = input.controlId
        ? (await getControlByCode(ctx.db, ctx.event.id, input.controlId)).id
        : null;
      const now = new Date();
      // The operator's "memory cleared" checkbox stamps the wall-clock
      // time the backup memory was wiped. We never clear the column
      // automatically — once stamped, the most-recent wipe sticks
      // until the next operator action.
      const memoryClearedAt = input.memoryCleared ? now : undefined;
      const batteryVoltageMv = input.batteryVoltageMv ?? input.batteryVoltage;
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
          batteryVoltageMv: batteryVoltageMv ?? null,
          batteryLow: input.batteryLow ?? false,
          memoryClearedAt: memoryClearedAt ?? null,
          srrCfg: input.srrCfg ?? false,
          checkedAt: now,
          lastSeenAt: now,
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
          ...(batteryVoltageMv !== undefined ? { batteryVoltageMv } : {}),
          ...(input.batteryLow !== undefined
            ? { batteryLow: input.batteryLow }
            : {}),
          ...(memoryClearedAt !== undefined ? { memoryClearedAt } : {}),
          ...(input.srrCfg !== undefined ? { srrCfg: input.srrCfg } : {}),
          checkedAt: now,
          lastSeenAt: now,
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
  pushBackupPunch: raceProcedure
    .input(z.object({ punchId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const bp = await ctx.db.punch.findUnique({ where: { id: input.punchId } });
      if (!bp || bp.eventId !== ctx.event.id) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Backup punch ${input.punchId} not found`,
        });
      }
      // Mirror insert + flag flip + punch.recorded journal entry commit or
      // roll back together. The minted id travels in the payload so every
      // node stores the mirror under the same UUID.
      const mirrorId = uuidv7();
      await ctx.db.$transaction(async (tx) => {
        await tx.punch.create({
          data: {
            id: mirrorId,
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
        await tx.punch.update({
          where: { id: bp.id },
          data: { isOriginal: false },
        });
        await appendJournal(tx, {
          eventId: ctx.event.id,
          type: "punch.recorded",
          payload: {
            id: mirrorId,
            cardNo: bp.cardNo,
            controlCode: bp.controlCode,
            time: bp.time !== 0 ? toAbsolute(bp.time, ctx.event.zeroTime) : 0,
            origin: "backup_memory",
          },
        });
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
  importBackupPunches: raceProcedure
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
        ? await getControlByCode(ctx.db, ctx.event.id, input.controlId)
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
      // Ids are minted up front so each punch.recorded entry can carry its
      // row UUID; inserts + journal entries commit or roll back together.
      const data = input.punches.map((p) => ({
        id: uuidv7(),
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
      const result = await ctx.db.$transaction(
        async (tx) => {
          const r = await tx.punch.createMany({ data, skipDuplicates: true });
          for (const row of data) {
            await appendJournal(tx, {
              eventId: ctx.event.id,
              type: "punch.recorded",
              payload: {
                id: row.id,
                cardNo: row.cardNo,
                controlCode: row.controlCode,
                time:
                  row.time !== 0
                    ? toAbsolute(row.time, ctx.event.zeroTime)
                    : 0,
                origin: "backup_memory",
              },
            });
          }
          return r;
        },
        { timeout: 60_000 },
      );
      return { ok: true as const, inserted: result.count, count: result.count };
    }),
});
