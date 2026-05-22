import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, eventProcedure } from "../trpc.js";
import type { PrismaClient } from "@prisma/client";
import {
  controlStatusToValue,
  valueToControlStatus,
} from "../statusConvert.js";
import {
  type CourseSummary,
  type CourseDetail,
  type ExpectedPosition,
  ControlStatus,
} from "@oxygen/shared";
import {
  parseIOFCourseDataWithGeometry,
  type ParsedCourse,
  type ParsedCourseData,
  type ClassAssignment,
  type GeoJSONFeatureCollection,
} from "../iof-course-parser.js";
import { parseOCDCourseData } from "../ocd-course-parser.js";
import {
  ocadBoundsToWgs84,
  computeMapNorthOffset,
  mapMmToWgs84,
  type OcadCrs,
} from "../map-projection.js";
import { fireMapUpload } from "../db.js";

// ─── Class-name matching for the import preview ─────────────

export type ClassMatchType = "exact" | "normalized" | "substring" | "none";

export function normalizeClassName(name: string): string {
  return name.toLowerCase().replace(/[\s.,;:_\-/\\]+/g, "");
}

export function findBestClassMatch<T extends { id: string; name: string; seq: number }>(
  xmlClassName: string,
  dbClasses: T[],
): { id: string; seq: number; name: string; matchType: Exclude<ClassMatchType, "none"> } | null {
  const lower = xmlClassName.toLowerCase();
  const exact = dbClasses.find((c) => c.name.toLowerCase() === lower);
  if (exact) return { id: exact.id, seq: exact.seq, name: exact.name, matchType: "exact" };

  const xmlNorm = normalizeClassName(xmlClassName);
  if (xmlNorm.length === 0) return null;

  const normExact = dbClasses.find((c) => normalizeClassName(c.name) === xmlNorm);
  if (normExact) {
    return { id: normExact.id, seq: normExact.seq, name: normExact.name, matchType: "normalized" };
  }

  let best: { class: T; normLen: number } | null = null;
  for (const c of dbClasses) {
    const dbNorm = normalizeClassName(c.name);
    if (dbNorm.length === 0) continue;
    if (!dbNorm.includes(xmlNorm) && !xmlNorm.includes(dbNorm)) continue;
    if (!best || dbNorm.length > best.normLen) best = { class: c, normLen: dbNorm.length };
  }
  return best
    ? { id: best.class.id, seq: best.class.seq, name: best.class.name, matchType: "substring" }
    : null;
}

/** Parse either an IOF XML or an OCAD OCD file into the unified ParsedCourseData. */
function parseCourseFile(input: {
  xmlContent?: string;
  ocdBase64?: string;
}): ParsedCourseData {
  if (input.ocdBase64) {
    return parseOCDCourseData(Buffer.from(input.ocdBase64, "base64"));
  }
  if (input.xmlContent) {
    return parseIOFCourseDataWithGeometry(input.xmlContent);
  }
  throw new Error("No course data: supply xmlContent or ocdBase64");
}

/**
 * Decide whether a previously-stored OCD geometry for a course should be
 * preferred over a freshly-built XML straight-line geometry. We keep OCD
 * unless the OCD control positions have drifted noticeably from the
 * canonical XML ones (>30 m).
 */
export function isOcdGeometryStaleVsXml(
  ocd: GeoJSONFeatureCollection,
  xml: GeoJSONFeatureCollection,
): boolean {
  const ocdPts = ocd.features.filter((f) => f.geometry.type === "Point");
  const xmlPts = xml.features.filter((f) => f.geometry.type === "Point");
  if (xmlPts.length === 0) return false;
  const byId = new Map<string, [number, number]>();
  for (const f of xmlPts) {
    const id = (f.properties as { id?: string } | undefined)?.id;
    if (!id) continue;
    byId.set(
      id,
      (f.geometry as { coordinates: [number, number] }).coordinates,
    );
  }
  let drift = 0;
  let pairs = 0;
  for (const f of ocdPts) {
    const id = (f.properties as { id?: string } | undefined)?.id;
    if (!id) continue;
    const xy = byId.get(id);
    if (!xy) continue;
    const ocdXy = (f.geometry as { coordinates: [number, number] }).coordinates;
    // Rough planar distance — fine for stale-detection thresholds.
    const dLng = (ocdXy[0] - xy[0]) * 111_000 * Math.cos((xy[1] * Math.PI) / 180);
    const dLat = (ocdXy[1] - xy[1]) * 111_000;
    drift += Math.sqrt(dLng * dLng + dLat * dLat);
    pairs++;
  }
  return pairs > 0 && drift / pairs > 30;
}

async function getCourseBySeq(
  db: PrismaClient,
  eventId: bigint,
  seq: number,
) {
  const c = await db.course.findFirst({
    where: { eventId, seq, removed: false },
  });
  if (!c) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `Course ${seq} not found`,
    });
  }
  return c;
}

/**
 * Resolve a public control id (the primary punch code, e.g. 31) to the
 * internal control UUID. Falls back to matching by `seq` for backwards
 * compatibility with legacy clients that still reference controls by
 * their per-event sequence number.
 */
async function controlSeqToId(
  db: PrismaClient,
  eventId: bigint,
  publicId: number,
): Promise<string> {
  const target = String(publicId);
  // Primary match: any control whose first code equals publicId.
  const candidates = await db.control.findMany({
    where: { eventId, removed: false },
    select: { id: true, codes: true, seq: true },
  });
  const byCode = candidates.find((c) => {
    const first = c.codes.split(";")[0];
    return first && first.trim() === target;
  });
  if (byCode) return byCode.id;
  const bySeq = candidates.find((c) => c.seq === publicId);
  if (bySeq) return bySeq.id;
  throw new TRPCError({
    code: "NOT_FOUND",
    message: `Control ${publicId} not found`,
  });
}

/**
 * Resolve a course's status-aware ExpectedPosition[] used by the offline
 * matcher and start-list / dashboard pre-computations.
 */
export async function resolveCourseExpectedPositions(
  db: PrismaClient,
  courseId: string,
): Promise<ExpectedPosition[]> {
  const rows = await db.courseControl.findMany({
    where: { courseId },
    include: { control: true },
    orderBy: { position: "asc" },
  });

  const positions: ExpectedPosition[] = [];
  let prevWasBadNoTiming = false;
  for (const row of rows) {
    const ctrl = row.control;
    const codes = (ctrl.codes ?? "")
      .split(";")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !isNaN(n) && n > 0);
    const statusVal = controlStatusToValue(ctrl.status);
    let skip = false;
    let noTiming = false;
    switch (statusVal) {
      case ControlStatus.Bad:
      case ControlStatus.Optional:
      case ControlStatus.BadNoTiming:
        skip = true;
        break;
      case ControlStatus.NoTiming:
        noTiming = true;
        break;
    }
    if (prevWasBadNoTiming && !skip) noTiming = true;
    prevWasBadNoTiming = statusVal === ControlStatus.BadNoTiming;
    positions.push({ codes, skipMatching: skip, noTimingLeg: noTiming });
  }
  return positions;
}

async function loadCourseDetail(
  db: PrismaClient,
  eventId: bigint,
  seq: number,
): Promise<CourseDetail> {
  const c = await getCourseBySeq(db, eventId, seq);
  const ccs = await db.courseControl.findMany({
    where: { courseId: c.id },
    include: { control: { select: { seq: true, codes: true } } },
    orderBy: { position: "asc" },
  });
  const classes = await db.class.findMany({
    where: { eventId, courseId: c.id, removed: false },
    select: { id: true, seq: true, name: true },
  });
  const runnerCounts = classes.length
    ? await db.runner.groupBy({
        by: ["classId"],
        _count: { classId: true },
        where: {
          eventId,
          classId: { in: classes.map((cl) => cl.id) },
          removed: false,
        },
      })
    : [];
  const runnerCountMap = new Map<string, number>(
    runnerCounts.map((rc) => [rc.classId ?? "", rc._count.classId]),
  );
  return {
    id: c.seq,
    name: c.name,
    controls: ccs
      .map((cc) => {
        const first = (cc.control.codes ?? "").split(";")[0];
        const code = first ? parseInt(first, 10) : NaN;
        return String(Number.isFinite(code) ? code : cc.control.seq);
      })
      .join(";"),
    controlCount: ccs.length,
    length: c.lengthM,
    climb: c.climbM,
    numberOfMaps: c.numberOfMaps,
    firstAsStart: c.firstAsStart,
    lastAsFinish: c.lastAsFinish,
    controlCodes: ccs.map((cc) => {
      const first = (cc.control.codes ?? "").split(";")[0] ?? "";
      const code = first ? parseInt(first, 10) : NaN;
      return {
        id: Number.isFinite(code) ? code : cc.control.seq,
        code: first,
      };
    }),
    classes: classes.map((cl) => ({
      classId: cl.seq,
      className: cl.name,
      runnerCount: runnerCountMap.get(cl.id) ?? 0,
    })),
  };
}

export const courseRouter = router({
  list: eventProcedure.query(async ({ ctx }): Promise<CourseSummary[]> => {
    const eventId = ctx.event.id;
    const courses = await ctx.db.course.findMany({
      where: { eventId, removed: false },
      orderBy: { name: "asc" },
    });
    const courseIds = courses.map((c) => c.id);
    const ccs = courseIds.length
      ? await ctx.db.courseControl.findMany({
          where: { courseId: { in: courseIds } },
          include: { control: { select: { seq: true, codes: true } } },
          orderBy: [{ courseId: "asc" }, { position: "asc" }],
        })
      : [];
    // Build a per-course ordered controls string. The web `MapPanel`
    // fallback leg renderer relies on this when a course isn't the
    // currently-highlighted one (which uses the richer `controlCodes`
    // from `course.detail`). Without it, non-highlighted courses render
    // controls but no leg lines.
    const controlsByCourse = new Map<string, string[]>();
    for (const cc of ccs) {
      const first = (cc.control.codes ?? "").split(";")[0];
      const code = first ? parseInt(first, 10) : NaN;
      const token = String(Number.isFinite(code) ? code : cc.control.seq);
      const arr = controlsByCourse.get(cc.courseId) ?? [];
      arr.push(token);
      controlsByCourse.set(cc.courseId, arr);
    }
    return courses.map(
      (c): CourseSummary => {
        const tokens = controlsByCourse.get(c.id) ?? [];
        return {
          id: c.seq,
          name: c.name,
          controls: tokens.join(";"),
          controlCount: tokens.length,
          length: c.lengthM,
          climb: c.climbM,
          numberOfMaps: c.numberOfMaps,
          firstAsStart: c.firstAsStart,
          lastAsFinish: c.lastAsFinish,
        };
      },
    );
  }),

  detail: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) =>
      loadCourseDetail(ctx.db, ctx.event.id, input.id),
    ),

  getById: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) =>
      loadCourseDetail(ctx.db, ctx.event.id, input.id),
    ),

  create: eventProcedure
    .input(
      z.object({
        name: z.string().min(1),
        length: z.number().int().optional().default(0),
        climb: z.number().int().optional().default(0),
        numberOfMaps: z.number().int().optional().default(0),
        firstAsStart: z.boolean().optional().default(false),
        lastAsFinish: z.boolean().optional().default(false),
        controlIds: z.array(z.number().int()).optional().default([]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await ctx.db.course.create({
        data: {
          eventId: ctx.event.id,
          name: input.name,
          lengthM: input.length,
          climbM: input.climb,
          numberOfMaps: input.numberOfMaps,
          firstAsStart: input.firstAsStart,
          lastAsFinish: input.lastAsFinish,
        },
        select: { id: true, seq: true },
      });
      if (input.controlIds.length > 0) {
        const controlUuids = await Promise.all(
          input.controlIds.map((seq) =>
            controlSeqToId(ctx.db, ctx.event.id, seq),
          ),
        );
        await ctx.db.courseControl.createMany({
          data: controlUuids.map((uuid, idx) => ({
            courseId: created.id,
            position: idx + 1,
            controlId: uuid,
          })),
        });
      }
      return { id: created.seq };
    }),

  update: eventProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().min(1).optional(),
        length: z.number().int().optional(),
        climb: z.number().int().optional(),
        numberOfMaps: z.number().int().optional(),
        firstAsStart: z.boolean().optional(),
        lastAsFinish: z.boolean().optional(),
        controlIds: z.array(z.number().int()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const c = await getCourseBySeq(ctx.db, ctx.event.id, input.id);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.length !== undefined) data.lengthM = input.length;
      if (input.climb !== undefined) data.climbM = input.climb;
      if (input.numberOfMaps !== undefined)
        data.numberOfMaps = input.numberOfMaps;
      if (input.firstAsStart !== undefined)
        data.firstAsStart = input.firstAsStart;
      if (input.lastAsFinish !== undefined)
        data.lastAsFinish = input.lastAsFinish;
      await ctx.db.course.update({ where: { id: c.id }, data });

      if (input.controlIds !== undefined) {
        await ctx.db.courseControl.deleteMany({ where: { courseId: c.id } });
        if (input.controlIds.length > 0) {
          const controlUuids = await Promise.all(
            input.controlIds.map((seq) =>
              controlSeqToId(ctx.db, ctx.event.id, seq),
            ),
          );
          await ctx.db.courseControl.createMany({
            data: controlUuids.map((uuid, idx) => ({
              courseId: c.id,
              position: idx + 1,
              controlId: uuid,
            })),
          });
        }
      }
      return { ok: true };
    }),

  bulkUpdate: eventProcedure
    .input(
      z.object({
        ids: z.array(z.number().int()),
        numberOfMaps: z.number().int().optional(),
        climb: z.number().int().optional(),
        firstAsStart: z.boolean().optional(),
        lastAsFinish: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await ctx.db.course.findMany({
        where: { eventId: ctx.event.id, seq: { in: input.ids } },
        select: { id: true },
      });
      const data: Record<string, unknown> = {};
      if (input.numberOfMaps !== undefined)
        data.numberOfMaps = input.numberOfMaps;
      if (input.climb !== undefined) data.climbM = input.climb;
      if (input.firstAsStart !== undefined)
        data.firstAsStart = input.firstAsStart;
      if (input.lastAsFinish !== undefined)
        data.lastAsFinish = input.lastAsFinish;
      await ctx.db.course.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data,
      });
      return { ok: true as const, count: rows.length };
    }),

  delete: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const c = await getCourseBySeq(ctx.db, ctx.event.id, input.id);
      await ctx.db.course.update({
        where: { id: c.id },
        data: { removed: true },
      });
      return { ok: true };
    }),

  /** GeoJSON FeatureCollection for one course (control circles + leg lines). */
  geometry: eventProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ ctx, input }) => {
      const c = await ctx.db.course.findFirst({
        where: { eventId: ctx.event.id, seq: input.id },
        select: { geometry: true },
      });
      if (!c?.geometry)
        return { type: "FeatureCollection" as const, features: [] as unknown[] };
      return c.geometry as unknown as {
        type: "FeatureCollection";
        features: unknown[];
      };
    }),

  /**
   * Per-course geometry for many courses at once (used by map overlays).
   * Returns a name-keyed map (legacy shape) — the web `MapPanel` joins
   * several feature collections into one before handing to the viewer.
   */
  courseGeometries: eventProcedure
    .input(
      z
        .object({
          ids: z.array(z.number().int()).optional(),
          courseNames: z.array(z.string()).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {
        eventId: ctx.event.id,
        removed: false,
      };
      if (input?.ids && input.ids.length > 0) where.seq = { in: input.ids };
      if (input?.courseNames && input.courseNames.length > 0) {
        where.name = { in: input.courseNames };
      }
      const rows = await ctx.db.course.findMany({
        where,
        select: { seq: true, name: true, geometry: true, geometrySource: true },
      });
      const out: Record<
        string,
        { type: "FeatureCollection"; features: unknown[] }
      > = {};
      for (const r of rows) {
        if (!r.geometry) continue;
        out[r.name] = r.geometry as unknown as {
          type: "FeatureCollection";
          features: unknown[];
        };
      }
      return out;
    }),

  /**
   * Lightweight map metadata (bounds, scale, north offset) for the
   * tile-based MapViewer. Reads the latest uploaded OCD file and runs
   * the OCAD parser to extract CRS + bounds.
   */
  mapMetadata: eventProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.event.id },
      orderBy: { uploadedAt: "desc" },
      select: { fileData: true, uploadedAt: true },
    });
    if (!row) return null;
    try {
      const ocadMod = await import("ocad2geojson");
      const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
        buf: Buffer,
        opts?: Record<string, unknown>,
      ) => Promise<{ getCrs(): OcadCrs; getBounds(): number[] }>;
      const ocadFile = await readOcad(Buffer.from(row.fileData), {
        quietWarnings: true,
      });
      const crs = ocadFile.getCrs();
      const ocadBounds = ocadFile.getBounds();
      const bounds = ocadBoundsToWgs84(ocadBounds, crs);
      const northOffset = computeMapNorthOffset(ocadBounds, crs);
      return {
        scale: crs.scale,
        bounds,
        northOffset,
        uploadedAt: row.uploadedAt.getTime(),
      };
    } catch (err) {
      console.warn("[mapMetadata] OCAD parse failed:", err);
      return null;
    }
  }),

  /** Info about the uploaded OCAD map file (if any). */
  mapFileInfo: eventProcedure.query(async ({ ctx }) => {
    const f = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.event.id },
      orderBy: { uploadedAt: "desc" },
      select: { id: true, fileName: true, uploadedAt: true, fileData: true },
    });
    if (!f) return null;
    return {
      id: Number(f.id),
      fileName: f.fileName,
      uploadedAt: f.uploadedAt.toISOString(),
      size: f.fileData.length,
    };
  }),

  /** Download the OCD map file (base64-encoded). */
  downloadMap: eventProcedure.query(async ({ ctx }) => {
    const f = await ctx.db.mapFile.findFirst({
      where: { eventId: ctx.event.id },
      orderBy: { uploadedAt: "desc" },
      select: { fileName: true, fileData: true },
    });
    if (!f) return null;
    return {
      fileName: f.fileName,
      fileDataBase64: Buffer.from(f.fileData).toString("base64"),
    };
  }),

  /** Controls with their coordinates (for map overlay). */
  controlCoordinates: eventProcedure.query(async ({ ctx }) => {
    const controls = await ctx.db.control.findMany({
      where: { eventId: ctx.event.id, removed: false },
      select: {
        seq: true,
        name: true,
        codes: true,
        status: true,
        lat: true,
        lng: true,
        xpos: true,
        ypos: true,
      },
    });

    // If any control has only map-mm coords (no usable lat/lng),
    // fall back to converting via the OCAD CRS extracted from the
    // uploaded map file.
    //
    // We treat both `null` *and* `0` as "no lat/lng" because the OCD
    // parser used to emit `(0, 0)` for every control, leaving legacy
    // rows with explicit zeros that would otherwise plot at the
    // equator and be invisible. Real coordinates near the equator
    // are not a concern for orienteering data.
    let crs: OcadCrs | null = null;
    const isMissingLatLng = (c: { lat: number | null; lng: number | null }) =>
      c.lat == null || c.lng == null || (c.lat === 0 && c.lng === 0);
    const needsConversion = controls.some(
      (c) => isMissingLatLng(c) && (c.xpos !== 0 || c.ypos !== 0),
    );
    if (needsConversion) {
      try {
        const f = await ctx.db.mapFile.findFirst({
          where: { eventId: ctx.event.id },
          orderBy: { uploadedAt: "desc" },
          select: { fileData: true },
        });
        if (f) {
          const ocadMod = await import("ocad2geojson");
          const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
            buf: Buffer,
            opts?: Record<string, unknown>,
          ) => Promise<{ getCrs(): OcadCrs }>;
          const ocadFile = await readOcad(Buffer.from(f.fileData), {
            quietWarnings: true,
          });
          crs = ocadFile.getCrs();
        }
      } catch (err) {
        console.warn("[controlCoordinates] OCAD CRS load failed:", err);
      }
    }

    return controls
      .filter(
        (c) => !isMissingLatLng(c) || c.xpos !== 0 || c.ypos !== 0,
      )
      .map((c) => {
        let lat = c.lat ?? 0;
        let lng = c.lng ?? 0;
        if (isMissingLatLng(c) && crs && (c.xpos !== 0 || c.ypos !== 0)) {
          const wgs84 = mapMmToWgs84(c.xpos, c.ypos, crs);
          if (wgs84) {
            lat = wgs84.lat;
            lng = wgs84.lng;
          }
        }
        return {
          id: c.seq,
          name: c.name,
          code: (c.codes ?? "").split(";")[0] || c.name,
          status: controlStatusToValue(c.status),
          lat,
          lng,
          mapX: c.xpos,
          mapY: c.ypos,
        };
      });
  }),

  /**
   * Completion status per control across all runners on the given course
   * (or all courses when none supplied). For each course control we
   * report `total` (runners expected to pass) and `passed` (runners with
   * at least one matching punch code on their card).
   *
   * Uses card.punches_raw as the source of punches; this is fast (one
   * cache row per card) and matches what the matcher consumes.
   */
  controlCompletionStatus: eventProcedure
    .input(z.object({ courseId: z.number().int().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const eventId = ctx.event.id;
      const courseFilter = input?.courseId
        ? await ctx.db.course.findFirst({
            where: { eventId, seq: input.courseId },
            select: { id: true },
          })
        : null;
      // Collect (course → control) bindings to consider.
      const courseControls = await ctx.db.courseControl.findMany({
        where: courseFilter ? { courseId: courseFilter.id } : undefined,
        include: {
          control: { select: { id: true, seq: true, codes: true } },
          course: { select: { id: true } },
        },
      });
      if (courseControls.length === 0) return [];

      // Runners on classes whose course matches.
      const classes = await ctx.db.class.findMany({
        where: { eventId, removed: false, courseId: { not: null } },
        select: { id: true, courseId: true },
      });
      const classCourse = new Map<string, string>();
      for (const c of classes) if (c.courseId) classCourse.set(c.id, c.courseId);

      const runners = await ctx.db.runner.findMany({
        where: { eventId, removed: false, classId: { not: null } },
        select: { id: true, cardNo: true, classId: true, courseId: true },
      });
      if (runners.length === 0) return [];

      const cards = await ctx.db.card.findMany({
        where: { eventId, removed: false },
        select: { cardNo: true, punchesRaw: true },
      });
      const cardByNo = new Map<number, string>(
        cards.map((c) => [c.cardNo, c.punchesRaw]),
      );

      // For each control on the course, count runners-on-that-course and
      // how many of them have at least one matching punch code.
      const out: Array<{
        controlId: number;
        code: number;
        total: number;
        passed: number;
      }> = [];
      const ccsByControl = new Map<string, typeof courseControls>();
      for (const cc of courseControls) {
        const list = ccsByControl.get(cc.control.id) ?? [];
        list.push(cc);
        ccsByControl.set(cc.control.id, list);
      }

      for (const [controlId, ccs] of ccsByControl) {
        const courseIds = new Set(ccs.map((cc) => cc.course.id));
        const expectedRunners = runners.filter((r) => {
          const cid = r.courseId ?? classCourse.get(r.classId ?? "") ?? null;
          return cid ? courseIds.has(cid) : false;
        });
        const codes = (ccs[0].control.codes ?? "")
          .split(";")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => !isNaN(n) && n > 0);
        const codeSet = new Set(codes);
        let passed = 0;
        for (const r of expectedRunners) {
          const raw = cardByNo.get(r.cardNo);
          if (!raw) continue;
          // Quick scan of the packed punch string for any matching code.
          // Format is `code-time;code-time;...` so a simple regex
          // catches it without parsing every punch into objects.
          const hit = codes.some((c) =>
            new RegExp(`(?:^|;)${c}-`).test(raw),
          );
          if (hit) passed++;
          void codeSet;
        }
        out.push({
          controlId: ccs[0].control.seq,
          code: codes[0] ?? 0,
          total: expectedRunners.length,
          passed,
        });
      }
      return out;
    }),

  /** Upload an OCAD map file (base64). Replaces any previous file + tiles. */
  uploadMap: eventProcedure
    .input(
      z.object({
        fileName: z.string(),
        fileDataBase64: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const buffer = Buffer.from(input.fileDataBase64, "base64");
      // Only keep the latest map.
      await ctx.db.mapFile.deleteMany({ where: { eventId: ctx.event.id } });
      await ctx.db.mapFile.create({
        data: {
          eventId: ctx.event.id,
          fileName: input.fileName,
          fileData: buffer,
        },
      });
      // Invalidate tile + rendered-map caches so the new map gets used.
      await ctx.db.mapTile.deleteMany({ where: { eventId: ctx.event.id } });
      await ctx.db.renderedMap.deleteMany({ where: { eventId: ctx.event.id } });
      fireMapUpload(ctx.event.id);
      return {
        success: true as const,
        fileName: input.fileName,
        size: buffer.length,
      };
    }),

  /**
   * Preview an IOF XML or OCD course-bundle import. Parses the file,
   * auto-matches XML class names to DB classes, and returns the per-
   * course preview without writing anything.
   */
  previewImport: eventProcedure
    .input(
      z.object({
        xmlContent: z.string().optional(),
        ocdBase64: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const parsed = parseCourseFile(input);

      const dbClasses = await ctx.db.class.findMany({
        where: { eventId: ctx.event.id, removed: false },
        select: { id: true, seq: true, name: true, courseId: true },
      });

      const dbControls = await ctx.db.control.findMany({
        where: { eventId: ctx.event.id, removed: false },
        select: { id: true, name: true, codes: true },
      });
      const existingControlIds = new Set(
        dbControls.map((c) => c.name.toLowerCase()).filter(Boolean),
      );
      for (const c of dbControls) {
        for (const code of (c.codes ?? "").split(";").filter(Boolean)) {
          existingControlIds.add(code.toLowerCase());
        }
      }

      const classMap: Record<
        string,
        Array<{
          dbClassId: number;
          dbClassName: string;
          matched: boolean;
          matchType: ClassMatchType;
        }>
      > = {};
      for (const a of parsed.classAssignments as ClassAssignment[]) {
        const best = findBestClassMatch(a.className, dbClasses);
        if (!classMap[a.courseName]) classMap[a.courseName] = [];
        classMap[a.courseName].push({
          dbClassId: best?.seq ?? 0,
          dbClassName: best?.name ?? "",
          matched: !!best,
          matchType: best?.matchType ?? "none",
        });
      }

      const coursePreview = parsed.courses.map((c: ParsedCourse) => {
        const controlCount = c.controls.filter((cc) => cc.type === "Control").length;
        const assignments = parsed.classAssignments
          .filter((a) => a.courseName === c.name)
          .map((a) => a.className);
        return {
          name: c.name,
          length: c.length,
          climb: c.climb,
          controlCount,
          xmlClassNames: assignments,
          classMatches: classMap[c.name] ?? [],
        };
      });

      const newControls = parsed.controls.filter(
        (c) =>
          c.type === "Control" && !existingControlIds.has(c.id.toLowerCase()),
      ).length;
      const existingControls = parsed.controls.filter(
        (c) =>
          c.type === "Control" && existingControlIds.has(c.id.toLowerCase()),
      ).length;

      return {
        courses: coursePreview,
        totalControls: parsed.controls.filter((c) => c.type === "Control").length,
        newControls,
        existingControls,
        startControls: parsed.controls.filter((c) => c.type === "Start").length,
        finishControls: parsed.controls.filter((c) => c.type === "Finish").length,
        mapScale: parsed.mapScale,
        dbClasses: dbClasses.map((c) => ({ id: c.seq, name: c.name })),
      };
    }),

  /**
   * Commit a preview: create/update controls, courses (+ course_controls
   * join rows), optionally assign courses to classes, and save per-course
   * GeoJSON geometry. When `replaceAll: true`, all existing courses and
   * controls are soft-deleted first and class→course assignments cleared.
   */
  importCourses: eventProcedure
    .input(
      z.object({
        xmlContent: z.string().optional(),
        ocdBase64: z.string().optional(),
        classMapping: z
          .record(z.string(), z.array(z.number().int()))
          .optional(),
        replaceAll: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const eventId = ctx.event.id;
      const parsed = parseCourseFile(input);
      const { courseGeometry, geometrySource } = parsed;

      // ── 0a. Resolve WGS84 lat/lng for OCD imports ───────────
      //
      // The OCD parser only knows map-mm coordinates and emits
      // `lat: 0, lng: 0` for every control. If we write those zeros
      // through, two things break:
      //   1. Subsequent reads see (0, 0) and plot controls at the
      //      equator, so they disappear off the map.
      //   2. Re-importing an OCD bundle silently clobbers any
      //      previously-resolved lat/lng (e.g. imported earlier via
      //      IOF XML or computed on the fly by `controlCoordinates`).
      //
      // Fix: when we have an OCD file we re-open it through
      // `ocad2geojson` to recover the CRS, then convert each control's
      // (mapX, mapY) → WGS84 up-front. Controls whose CRS we don't
      // support fall back to lat/lng = null below, and
      // `controlCoordinates` keeps its on-the-fly conversion as a
      // belt-and-braces fallback. IOF XML imports already carry good
      // lat/lng from the parser and are not affected.
      let ocdCrs: OcadCrs | null = null;
      if (input.ocdBase64) {
        try {
          const ocadMod = await import("ocad2geojson");
          const readOcad = (ocadMod as Record<string, unknown>).readOcad as (
            buf: Buffer,
            opts?: Record<string, unknown>,
          ) => Promise<{ getCrs(): OcadCrs }>;
          const ocadFile = await readOcad(
            Buffer.from(input.ocdBase64, "base64"),
            { quietWarnings: true },
          );
          ocdCrs = ocadFile.getCrs();
        } catch (err) {
          console.warn("[importCourses] OCAD CRS load failed:", err);
        }
      }

      let controlsCreated = 0;
      let controlsUpdated = 0;
      let coursesCreated = 0;
      let coursesUpdated = 0;
      let classesAssigned = 0;

      // ── 0. Optional wipe ────────────────────────────────────
      if (input.replaceAll) {
        // Soft-delete existing courses + controls; clear class→course
        // assignments. Imports below re-activate matching rows by name.
        await ctx.db.course.updateMany({
          where: { eventId, removed: false },
          data: { removed: true },
        });
        await ctx.db.control.updateMany({
          where: { eventId, removed: false },
          data: { removed: true },
        });
        await ctx.db.class.updateMany({
          where: { eventId, removed: false, courseId: { not: null } },
          data: { courseId: null },
        });
      }

      // ── 1. Controls ─────────────────────────────────────────
      const existingControls = await ctx.db.control.findMany({
        where: { eventId },
        select: {
          id: true,
          name: true,
          codes: true,
          removed: true,
        },
      });
      const controlByKey = new Map<string, (typeof existingControls)[number]>();
      for (const c of existingControls) {
        if (c.name) controlByKey.set(c.name.toLowerCase(), c);
        for (const code of (c.codes ?? "").split(";").filter(Boolean)) {
          if (!controlByKey.has(code.toLowerCase())) {
            controlByKey.set(code.toLowerCase(), c);
          }
        }
      }

      /** Map: parsed control id (e.g. "31", "STA1") → PG control UUID. */
      const controlIdMap = new Map<string, string>();

      for (const pc of parsed.controls) {
        const status =
          pc.type === "Start"
            ? valueToControlStatus(4)
            : pc.type === "Finish"
              ? valueToControlStatus(5)
              : valueToControlStatus(0);

        // MeOS-style names for start/finish controls; regular controls
        // store the code in `codes` and have an empty name.
        let name: string;
        let codes: string;
        const suffix = pc.id.match(/(\d+)\s*$/)?.[1] ?? "1";
        if (pc.type === "Start") {
          name = parseInt(suffix, 10) > 1 ? `Start ${suffix}` : "Start 1";
          codes = "";
        } else if (pc.type === "Finish") {
          name = parseInt(suffix, 10) > 1 ? `Mål ${suffix}` : "Mål 1";
          codes = "";
        } else {
          name = "";
          codes = pc.id;
        }

        // Decide what to write for lat/lng. Priority:
        //   1. Parser-provided non-zero lat/lng (IOF XML path).
        //   2. CRS-converted (pc.mapX, pc.mapY) for OCD bundles
        //      whose grid we recognise.
        //   3. Leave existing values intact on update; on insert
        //      store null so `controlCoordinates` can convert later.
        let nextLat: number | null = pc.lat || 0;
        let nextLng: number | null = pc.lng || 0;
        if ((nextLat === 0 && nextLng === 0) && ocdCrs && (pc.mapX !== 0 || pc.mapY !== 0)) {
          const wgs = mapMmToWgs84(pc.mapX, pc.mapY, ocdCrs);
          if (wgs) {
            nextLat = wgs.lat;
            nextLng = wgs.lng;
          } else {
            nextLat = null;
            nextLng = null;
          }
        } else if (nextLat === 0 && nextLng === 0) {
          nextLat = null;
          nextLng = null;
        }

        // Match priority:
        //   1. By the parser-supplied id (e.g. "31", "STA1") — works for
        //      regular controls whose `codes` we keyed by, and also for
        //      OCD start/finish ids that happen to round-trip.
        //   2. By the synthesized display name (e.g. "Start 1", "Mål 1") —
        //      this is how start/finish controls survive a re-import,
        //      because they're stored with name = "Start N"/"Mål N" and
        //      empty `codes`, so step 1 never finds them on round two.
        const matched =
          controlByKey.get(pc.id.toLowerCase()) ??
          (name ? controlByKey.get(name.toLowerCase()) : undefined);
        const baseData = {
          name,
          codes,
          status,
          xpos: pc.mapX,
          ypos: pc.mapY,
          removed: false,
        };

        if (matched) {
          // Only overwrite lat/lng when we have a real, non-zero pair.
          // Otherwise preserve whatever the DB already has so a re-
          // import of an OCD whose CRS we don't recognise doesn't blow
          // away previously-resolved coordinates.
          const data: Record<string, unknown> = { ...baseData };
          if (nextLat !== null && nextLng !== null) {
            data.lat = nextLat;
            data.lng = nextLng;
          }
          await ctx.db.control.update({
            where: { id: matched.id },
            data,
          });
          controlIdMap.set(pc.id, matched.id);
          if (matched.removed) controlsCreated++;
          else controlsUpdated++;
        } else {
          const created = await ctx.db.control.create({
            data: {
              eventId,
              ...baseData,
              lat: nextLat,
              lng: nextLng,
            },
            select: { id: true },
          });
          controlIdMap.set(pc.id, created.id);
          controlsCreated++;
        }
      }

      // ── 2. Courses ──────────────────────────────────────────
      const existingCourses = await ctx.db.course.findMany({
        where: { eventId },
        select: { id: true, name: true, removed: true },
      });
      const courseByName = new Map<string, (typeof existingCourses)[number]>();
      for (const c of existingCourses) {
        const key = c.name.toLowerCase();
        const prev = courseByName.get(key);
        if (!prev || (prev.removed && !c.removed)) courseByName.set(key, c);
      }

      /** Map: parsed course name → PG course UUID. */
      const courseIdMap = new Map<string, string>();

      for (const pc of parsed.courses) {
        // Build (position, controlUuid) pairs for the join table; only
        // include "Control" entries (start/finish live as control rows
        // and don't appear in course_controls, mirroring MeOS).
        const ordered = pc.controls
          .filter((cc) => cc.type === "Control")
          .map((cc) => controlIdMap.get(cc.controlId))
          .filter((u): u is string => !!u);

        // Encoded legs string (used by the matcher for leg-length stats).
        const legsArr = pc.controls
          .filter((cc) => cc.type === "Control")
          .map((cc) => Math.round(cc.legLength));
        const finishLeg = pc.controls.find((cc) => cc.type === "Finish");
        if (finishLeg) legsArr.push(Math.round(finishLeg.legLength));
        const legsStr = legsArr.length ? legsArr.join(";") + ";" : "";

        // Per-course geometry: prefer OCD when fresh; otherwise XML.
        const geom = courseGeometry[pc.name] ?? null;
        const startCtrl = pc.controls.find((cc) => cc.type === "Start");
        const startName = startCtrl
          ? (() => {
              const m = startCtrl.controlId.match(/(\d+)\s*$/)?.[1] ?? "1";
              return parseInt(m, 10) > 1 ? `Start ${m}` : "Start 1";
            })()
          : "";

        const existing = courseByName.get(pc.name.toLowerCase());
        let courseUuid: string;
        if (existing) {
          // Resolve geometry vs existing one: keep OCD unless drift > 30m.
          let nextGeom: GeoJSONFeatureCollection | null = geom;
          const prev = await ctx.db.course.findUnique({
            where: { id: existing.id },
            select: { geometry: true, geometrySource: true },
          });
          if (
            prev?.geometrySource === "ocd" &&
            geometrySource === "xml" &&
            geom &&
            prev.geometry &&
            !isOcdGeometryStaleVsXml(
              prev.geometry as unknown as GeoJSONFeatureCollection,
              geom,
            )
          ) {
            nextGeom = prev.geometry as unknown as GeoJSONFeatureCollection;
          }
          await ctx.db.course.update({
            where: { id: existing.id },
            data: {
              name: pc.name,
              lengthM: Math.round(pc.length),
              climbM: Math.round(pc.climb),
              legs: legsStr,
              startName,
              firstAsStart: false,
              lastAsFinish: false,
              removed: false,
              geometry: (nextGeom ?? undefined) as never,
              geometrySource:
                nextGeom === geom ? geometrySource : prev?.geometrySource ?? "",
            },
          });
          courseUuid = existing.id;
          if (existing.removed) coursesCreated++;
          else coursesUpdated++;
        } else {
          const created = await ctx.db.course.create({
            data: {
              eventId,
              name: pc.name,
              lengthM: Math.round(pc.length),
              climbM: Math.round(pc.climb),
              legs: legsStr,
              startName,
              firstAsStart: false,
              lastAsFinish: false,
              geometry: (geom ?? undefined) as never,
              geometrySource: geom ? geometrySource : "",
            },
            select: { id: true },
          });
          courseUuid = created.id;
          coursesCreated++;
        }
        courseIdMap.set(pc.name, courseUuid);

        // Replace course_controls rows for this course.
        await ctx.db.courseControl.deleteMany({
          where: { courseId: courseUuid },
        });
        if (ordered.length > 0) {
          await ctx.db.courseControl.createMany({
            data: ordered.map((uuid, idx) => ({
              courseId: courseUuid,
              position: idx + 1,
              controlId: uuid,
            })),
          });
        }
      }

      // ── 3. Class → Course assignments ───────────────────────
      if (input.classMapping) {
        for (const [courseName, classSeqs] of Object.entries(input.classMapping)) {
          const courseUuid = courseIdMap.get(courseName);
          if (!courseUuid) continue;
          for (const classSeq of classSeqs) {
            if (classSeq <= 0) continue;
            const cls = await ctx.db.class.findFirst({
              where: { eventId, seq: classSeq, removed: false },
              select: { id: true },
            });
            if (!cls) continue;
            await ctx.db.class.update({
              where: { id: cls.id },
              data: { courseId: courseUuid },
            });
            classesAssigned++;
          }
        }
      }

      // ── 4. Invalidate map tile cache (course overlays changed) ──
      //
      // Course overlays (control circles + leg lines) are baked into
      // the rendered tiles, so a course import must invalidate the
      // tile cache. We also bump `map_files.uploaded_at` because the
      // client uses that timestamp as the tile-URL cache buster — if
      // we don't touch it, the browser keeps serving the stale tiles
      // out of its HTTP cache even though the server-side `renderedMap`
      // rows are gone.
      await ctx.db.renderedMap.deleteMany({ where: { eventId } });
      await ctx.db.mapFile.updateMany({
        where: { eventId },
        data: { uploadedAt: new Date() },
      });
      fireMapUpload(eventId);

      return {
        controlsCreated,
        controlsUpdated,
        coursesCreated,
        coursesUpdated,
        classesAssigned,
      };
    }),
});
