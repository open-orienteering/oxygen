import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../trpc.js";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  canDownloadClubMapVersion,
  canRemoveClubMap,
  latestVersionOrRefuse,
  projectClubMapRow,
} from "../club-map-library.js";
import { startImportJob, type ImportJobRow } from "../map-store/jobs.js";
import { documentNorth } from "../map-store/event-document.js";
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
  // name and uploader. A slow import keeps the source's.
  if (job?.state === "done") {
    await prisma().clubMapVersion.updateMany({
      where: { clubMapId: series.id, sourceHash: source.fileHash },
      data: { label: fileName, uploadedBy: userId },
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
  list: authedProcedure.query(async () => {
    const series = await prisma().clubMap.findMany({
      orderBy: { createdAt: "desc" },
      include: SERIES_INCLUDE,
    });

    return series.map((s) =>
      projectClubMapRow({
        series: s,
        version: s.versions[0] ?? null,
        versionCount: s._count.versions,
        job: s.importJobs[0] ?? null,
      }),
    );
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
      await prisma().clubMap.delete({ where: { id: input.id } });
      return { success: true as const };
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
            select: { label: true, sourceHash: true, uploadedBy: true },
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
        fileName: version.label || source.fileName,
        fileDataBase64: Buffer.from(source.bytes).toString("base64"),
      };
    }),
});
