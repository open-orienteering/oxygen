import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../trpc.js";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { mapDocument } from "@oxygen/shared";
import {
  canDownloadClubMapVersion,
  canRemoveClubMap,
  canRemoveClubMapVersion,
  latestVersionOrRefuse,
  projectClubMapRow,
} from "../club-map-library.js";
import { assertMayConsumeSource } from "../map-store/source-possession.js";
import { startImportJob, type ImportJobRow } from "../map-store/jobs.js";
import { documentNorth } from "../map-store/event-document.js";
import { validContourInterval } from "../map-store/contour-interval.js";
import { enqueueContourInterval, eventsOnClubMap, requireMayChangeClubMapInterval } from "../map-store/contour-interval-apply.js";
import { meridianStalenessFromDetection } from "../map-north.js";

const clubMapId = z.string().uuid();

const PERSON = { select: { email: true, displayName: true } } as const;

/**
 * Everything `projectClubMapRow` reads for one series: the latest
 * version with its source and document header and the newest import job
 * (§6.5).
 */
const SERIES_INCLUDE = {
  creator: PERSON,
  versions: {
    orderBy: { seq: "desc" },
    take: 1,
    include: {
      uploader: PERSON,
      source: { select: { fileName: true, sizeBytes: true } },
      document: { select: { header: true, report: true } },
    },
  },
  importJobs: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { id: true, state: true, error: true, source: { select: { fileName: true, sizeBytes: true } } },
  },
  _count: { select: { versions: true } },
} satisfies Prisma.ClubMapInclude;

function notFound(id: string): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: `Club map ${id} not found` });
}

/** NOT_FOUND unless the series exists. */
async function requireSeries(id: string): Promise<void> {
  const series = await prisma().clubMap.findUnique({ where: { id }, select: { id: true } });
  if (!series) throw notFound(id);
}

/**
 * Create a club-library map from a stored source: the `club_maps` series
 * and an import job that adds version 1 when it finishes
 * (docs/map-storage.md §6.5).
 */
async function createClubMap(
  source: { fileHash: string; sizeBytes: number },
  fileName: string,
  name: string | undefined,
  userId: string | null,
) {
  const displayName = name?.trim() || fileName;
  const series = await prisma().clubMap.create({
    data: { name: displayName, createdBy: userId },
    select: { id: true, name: true, rotationCorrection: true },
  });
  const job: ImportJobRow | null = await startImportJob(prisma(), { sourceHash: source.fileHash, clubMapId: series.id, startedBy: userId })
    .catch((err: unknown) => {
      console.error(`[map-import] club map ${series.id}: could not start the import of ${fileName}:`, err);
      return null;
    });
  // The job labels the version from the source row (whoever first uploaded
  // these bytes); when it finished inside the hold, prefer this upload's
  // name. The uploader is the job's starter (`applyJobResult`), never
  // rewritten here.
  if (job?.state === "done") {
    await prisma().clubMapVersion.updateMany({
      where: { clubMapId: series.id, sourceHash: source.fileHash },
      data: { label: fileName },
    });
  }
  const documentHash = job?.state === "done" ? job.documentHash : null;
  return {
    id: series.id,
    name: series.name,
    fileName,
    sizeBytes: source.sizeBytes,
    rotationCorrection: series.rotationCorrection,
    meridianStalenessDeg: documentHash
      ? meridianStalenessFromDetection(await documentNorth(prisma(), documentHash))
      : null,
    importJob: job ? { id: job.id, state: job.state, error: job.error } : null,
  };
}

export const clubMapRouter = router({
  /**
   * The library: one row per `club_maps` series (§6.5). Nothing here
   * starts an import.
   */
  list: authedProcedure.query(async ({ ctx }) => {
    const series = await prisma().clubMap.findMany({
      orderBy: { createdAt: "desc" },
      include: SERIES_INCLUDE,
    });

    return Promise.all(series.map(async (s) => ({
      ...(await projectClubMapRow({
        series: s,
        version: s.versions[0] ?? null,
        versionCount: s._count.versions,
        job: s.importJobs[0] ?? null,
      })),
      /** Whether the caller may change the series' contour interval (its uploader or an admin; §0.43). */
      mayChange: canRemoveClubMap({ authEnabled: ctx.authEnabled, user: ctx.user, createdBy: s.createdBy }),
    })));
  }),

  /**
   * Second half of the chunked upload (docs/map-storage.md §5), the only
   * way into the library: the file already sits in `map_sources` under
   * `fileHash` (an OCAD or Mapper file); create the library entry from it.
   */
  addFromSource: authedProcedure
    .input(
      z.object({
        fileHash: z.string().regex(/^[0-9a-f]{64}$/),
        /** The name the user uploaded under; the source row keeps the first-ever name for these bytes. */
        fileName: z.string().min(1).max(512).optional(),
        name: z.string().min(1).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const source = await prisma().mapSource.findUnique({
        where: { fileHash: input.fileHash },
        select: { fileHash: true, fileName: true, sizeBytes: true },
      });
      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Uploaded file not found; upload it again" });
      }
      await assertMayConsumeSource(ctx, input.fileHash);
      return createClubMap(source, input.fileName?.trim() || source.fileName, input.name, ctx.user?.id ?? null);
    }),

  /**
   * Ops-only escape hatch: manual georeference correction on a
   * club-library map. Not exposed in the UI — ScalePar is authoritative
   * and a mis-registered file belongs back in OCAD. Events that already
   * copied this map keep their own MapFile.rotationCorrection until
   * re-copied.
   */
  setRotation: authedProcedure
    .input(
      z.object({
        id: clubMapId,
        degrees: z.number().min(-180).max(180),
      }),
    )
    .mutation(async ({ input }) => {
      await requireSeries(input.id);
      await prisma().clubMap.update({ where: { id: input.id }, data: { rotationCorrection: input.degrees } });
      return { success: true as const, rotationCorrection: input.degrees };
    }),

  rename: authedProcedure
    .input(z.object({ id: clubMapId, name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await requireSeries(input.id);
      await prisma().clubMap.update({ where: { id: input.id }, data: { name: input.name.trim() } });
      return { success: true as const };
    }),

  /**
   * Confirm (or clear, with null) the map's contour interval (docs/course-elevation.md §0.43). It follows every event that
   * uses the map: their computed climbs are cleared and computed again. Only who may delete the map (its uploader or an admin: it changes every event's climbs); the climbs are computed in the background.
   */
  setContourInterval: authedProcedure
    .input(z.object({ id: clubMapId, intervalM: z.number().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (input.intervalM !== null && !validContourInterval(input.intervalM)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The contour interval is above 0 and at most 100 m, with at most two decimals" });
      }
      const series = await prisma().clubMap.findUnique({ where: { id: input.id }, select: { createdBy: true } });
      if (!series) throw notFound(input.id);
      requireMayChangeClubMapInterval(ctx, series.createdBy);
      await prisma().clubMap.update({ where: { id: input.id }, data: { contourIntervalM: input.intervalM } });
      const events = await eventsOnClubMap(prisma(), input.id);
      enqueueContourInterval(prisma(), events);
      return { success: true as const, contourIntervalM: input.intervalM, events: events.length };
    }),

  /**
   * Delete a series: its versions cascade and events that pinned one keep
   * their copy with `club_map_version_id` nulled. Blobs are left to the
   * GC (§8).
   */
  remove: authedProcedure
    .input(z.object({ id: clubMapId }))
    .mutation(async ({ ctx, input }) => {
      const series = await prisma().clubMap.findUnique({
        where: { id: input.id },
        select: { createdBy: true },
      });
      if (!series) throw notFound(input.id);
      if (!canRemoveClubMap({ authEnabled: ctx.authEnabled, user: ctx.user, createdBy: series.createdBy })) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the uploader or an admin can delete this map",
        });
      }
      // The events keep their copy but lose the series: a value a person confirmed on it stays theirs (§0.43).
      await prisma().$transaction(async (tx) => {
        const club = await tx.clubMap.findUnique({ where: { id: input.id }, select: { contourIntervalM: true } });
        if (club?.contourIntervalM != null) {
          await tx.mapFile.updateMany({ where: { clubMapVersion: { clubMapId: input.id }, contourIntervalM: null }, data: { contourIntervalM: club.contourIntervalM } });
        }
        await tx.clubMap.delete({ where: { id: input.id } });
      });
      return { success: true as const };
    }),

  /**
   * Delete the latest version when it is a promoted one (docs/map-patches.md §5 answer 7): its promoter or an
   * admin. Events on it keep their document (`club_map_version_id` set null); version 1 goes with the series.
   */
  removeVersion: authedProcedure
    .input(z.object({ id: clubMapId, versionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return prisma().$transaction(async (db) => {
        // The series locked, as promote locks it: no promote from this version starts in between.
        await db.$queryRaw`SELECT 1 FROM "oxygen"."club_maps" WHERE "id" = ${input.id}::uuid FOR UPDATE`;
        const version = await db.clubMapVersion.findFirst({
          where: { id: input.versionId, clubMapId: input.id },
          select: { id: true, seq: true, sourceHash: true, uploadedBy: true, patch: true },
        });
        if (!version) throw new TRPCError({ code: "NOT_FOUND", message: `Version ${input.versionId} of club map ${input.id} not found` });
        if (!canRemoveClubMapVersion({ authEnabled: ctx.authEnabled, user: ctx.user, uploadedBy: version.uploadedBy })) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who saved this version or an admin can delete it" });
        }
        const latest = await db.clubMapVersion.aggregate({ where: { clubMapId: input.id }, _max: { seq: true } });
        if (version.seq !== latest._max.seq) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "VERSION_NOT_LATEST: only the latest version can be deleted" });
        }
        const layers = mapDocument.parseVersionPatch(version.patch);
        if (layers.length === 0) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "VERSION_NOT_PROMOTED: an uploaded version goes with its club map" });
        }
        // Its promote job still running would pin the event onto a deleted version.
        const jobs = await db.mapImportJob.findMany({
          where: { clubMapId: input.id, eventId: { not: null }, sourceHash: version.sourceHash, state: { in: ["queued", "running"] } },
          select: { patch: true },
        });
        if (jobs.some((j) => mapDocument.sameVersionPatch(j.patch, layers))) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PATCH_PROMOTING: the version is still being saved" });
        }
        // The events on it keep their document but lose the series: the club's confirmed interval stays theirs (§0.43).
        const club = await db.clubMap.findUnique({ where: { id: input.id }, select: { contourIntervalM: true } });
        if (club?.contourIntervalM != null) {
          await db.mapFile.updateMany({ where: { clubMapVersionId: version.id, contourIntervalM: null }, data: { contourIntervalM: club.contourIntervalM } });
        }
        await db.clubMapVersion.delete({ where: { id: version.id } });
        return { success: true as const };
      });
    }),

  /** The latest version's original file (`map_sources`), under the version's label. */
  download: authedProcedure
    .input(z.object({ id: clubMapId }))
    .query(async ({ ctx, input }) => {
      const series = await prisma().clubMap.findUnique({
        where: { id: input.id },
        select: {
          name: true,
          versions: {
            orderBy: { seq: "desc" },
            take: 1,
            select: { label: true, sourceHash: true, uploadedBy: true, patch: true },
          },
        },
      });
      if (!series) throw notFound(input.id);
      const version = latestVersionOrRefuse(series.name, series.versions[0]);
      if (!canDownloadClubMapVersion({ authEnabled: ctx.authEnabled, user: ctx.user, uploadedBy: version.uploadedBy })) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the uploader or an admin can download this map",
        });
      }
      const source = await prisma().mapSource.findUniqueOrThrow({
        where: { fileHash: version.sourceHash },
        select: { fileName: true, bytes: true },
      });
      return {
        // The original file (docs/map-patches.md §5 answer 8): a promoted version's label is free text, so it is named by its source.
        fileName: (mapDocument.parseVersionPatch(version.patch).length > 0 ? "" : version.label) || source.fileName,
        fileDataBase64: Buffer.from(source.bytes).toString("base64"),
      };
    }),
});
