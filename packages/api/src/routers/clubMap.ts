import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../trpc.js";
import { prisma } from "../db.js";
import {
  applyClubMapRotationCorrection,
  detectNorthFromBuffer,
  resolveMapNorth,
} from "../event-map.js";
import { renderOcadPreview } from "../club-map-preview.js";
import type { Prisma } from "../generated/prisma/client.js";
import {
  canDownloadClubMapVersion,
  canRemoveClubMap,
  latestVersionOrRefuse,
  projectClubMapRow,
} from "../club-map-library.js";
import { computeRenderKey, hashMapFileData } from "../map-render-key.js";
import {
  gcOrphanTiles,
  refreshClubMapRenderKey,
} from "../map-render-cache.js";
import { colorProfileSchema, colorStackOverridesSchema } from "@oxygen/shared";
import { invalidateRenderKey } from "../map-tiles.js";
import { startImportJob, type ImportJobRow } from "../map-store/jobs.js";

const clubMapId = z.string().uuid();

const PERSON = { select: { email: true, displayName: true } } as const;

/**
 * Everything `projectClubMapRow` reads for one series: the latest
 * version with its source and document header, the newest import job,
 * and the linked legacy row (raster-path metadata, §6.5).
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
  legacyRows: {
    orderBy: { id: "asc" },
    take: 1,
    select: { id: true, scale: true, bounds: true, northOffset: true, northDetection: true },
  },
  _count: { select: { versions: true } },
} satisfies Prisma.ClubMapInclude;

function notFound(id: string): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: `Club map ${id} not found` });
}

/** The series' linked legacy rows, or NOT_FOUND when the series does not exist. */
async function legacyRowIds(id: string): Promise<bigint[]> {
  const series = await prisma().clubMap.findUnique({
    where: { id },
    select: { legacyRows: { select: { id: true } } },
  });
  if (!series) throw notFound(id);
  return series.legacyRows.map((r) => r.id);
}

/**
 * Create a club-library map from bytes: the `club_maps` series, the
 * content-addressed source row and an import job that adds version 1
 * when it finishes (docs/map-storage.md §6.5), plus the write-through
 * `club_map_files` row the raster path still reads until slice F.
 */
async function createClubMap(
  buffer: Buffer,
  fileName: string,
  name: string | undefined,
  userId: string | null,
  opts: { fileHash?: string } = {},
) {
  const resolved = await resolveMapNorth(buffer);
  const previewPng = await renderOcadPreview(buffer);
  const displayName = name?.trim() || fileName;
  const fileHash = opts.fileHash ?? hashMapFileData(buffer);
  const colorProfile = "auto" as const;
  const northLinesBelow = true;
  const renderKey = computeRenderKey({
    fileHash,
    rotationCorrection: resolved.rotationCorrection,
    colorProfile,
    northLinesBelow,
  });
  // One transaction: a series without its legacy row and source would be
  // listed with no file and is invisible to the backfill (§6.7), which
  // retries only series that have a legacy row.
  const series = await prisma().$transaction(
    async (tx) => {
      const created = await tx.clubMap.create({
        data: {
          name: displayName,
          colourProfile: colorProfile,
          northLinesBelow,
          rotationCorrection: resolved.rotationCorrection,
          createdBy: userId,
        },
        select: { id: true, name: true, rotationCorrection: true },
      });
      await tx.clubMapFile.create({
        data: {
          name: displayName,
          fileName,
          fileData: Uint8Array.from(buffer),
          previewPng: previewPng ? Uint8Array.from(previewPng) : undefined,
          sizeBytes: buffer.length,
          scale: resolved.metadata.scale,
          bounds: (resolved.metadata.bounds ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
          northOffset: resolved.metadata.northOffset,
          rotationCorrection: resolved.rotationCorrection,
          northDetection: resolved.northDetection
            ? (resolved.northDetection as unknown as Prisma.InputJsonValue)
            : undefined,
          colorProfile,
          northLinesBelow,
          fileHash,
          renderKey,
          uploadedBy: userId,
          clubMapId: created.id,
        },
        select: { id: true },
      });
      await tx.mapSource.createMany({
        data: [{ fileHash, kind: "ocad", bytes: Uint8Array.from(buffer), sizeBytes: buffer.length, fileName, uploadedBy: userId }],
        skipDuplicates: true,
      });
      return created;
    },
    // Two copies of a map up to the 128 MiB upload limit go over the wire.
    { timeout: 120_000 },
  );
  const job: ImportJobRow | null = await startImportJob(prisma(), { sourceHash: fileHash, clubMapId: series.id, startedBy: userId })
    .catch((err: unknown) => {
      console.error(`[map-import] club map ${series.id}: could not start the import of ${fileName}:`, err);
      return null;
    });
  // The job labels the version from the source row (whoever first uploaded
  // these bytes); when it finished inside the hold, prefer this upload's
  // name and uploader. A slow import keeps the source's; the backfill
  // (§6.7) only relabels versions it creates itself.
  if (job?.state === "done") {
    await prisma().clubMapVersion.updateMany({
      where: { clubMapId: series.id, sourceHash: fileHash },
      data: { label: fileName, uploadedBy: userId },
    });
  }
  return {
    id: series.id,
    name: series.name,
    fileName,
    sizeBytes: buffer.length,
    rotationCorrection: series.rotationCorrection,
    meridianStalenessDeg: resolved.meridianStalenessDeg,
    importJob: job ? { id: job.id, state: job.state, error: job.error } : null,
  };
}

export const clubMapRouter = router({
  /**
   * The library: one row per `club_maps` series (§6.5). A legacy row the
   * backfill has not linked yet is not listed, and nothing here starts an
   * import.
   */
  list: authedProcedure.query(async () => {
    const series = await prisma().clubMap.findMany({
      orderBy: { createdAt: "desc" },
      include: SERIES_INCLUDE,
    });

    // Rows uploaded before the north_detection column exist with NULL,
    // which is indistinguishable from "analysed, no 601 lines" in the UI.
    // Backfill once on first read — same pattern as the preview
    // thumbnail backfill. Unparseable blobs persist an all-null
    // detection so they are not re-parsed on every list call. Read from
    // the linked legacy row until stage 5 puts it in the document.
    for (const s of series) {
      const legacy = s.legacyRows[0];
      if (!legacy || legacy.northDetection != null) continue;
      const blob = await prisma().clubMapFile.findUnique({
        where: { id: legacy.id },
        select: { fileData: true },
      });
      if (!blob) continue;
      const detection = await detectNorthFromBuffer(Buffer.from(blob.fileData));
      await prisma().clubMapFile.update({
        where: { id: legacy.id },
        data: {
          northDetection: detection as unknown as Prisma.InputJsonValue,
        },
      });
      legacy.northDetection = detection as unknown as Prisma.JsonValue;
    }

    return series.map((s) =>
      projectClubMapRow({
        series: s,
        version: s.versions[0] ?? null,
        versionCount: s._count.versions,
        job: s.importJobs[0] ?? null,
        legacy: s.legacyRows[0] ?? null,
      }),
    );
  }),

  upload: authedProcedure
    .input(
      z.object({
        name: z.string().min(1).optional(),
        fileName: z.string().min(1),
        fileDataBase64: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const buffer = Buffer.from(input.fileDataBase64, "base64");
      return createClubMap(buffer, input.fileName, input.name, ctx.user?.id ?? null);
    }),

  /**
   * Second half of the chunked upload (docs/map-storage.md §5): the file
   * already sits in `map_sources` under `fileHash`; create the library
   * entry from it.
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
        select: { kind: true, fileName: true, bytes: true },
      });
      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Uploaded file not found; upload it again" });
      }
      if (source.kind !== "ocad") {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${source.kind} files cannot be used as a club map yet` });
      }
      return createClubMap(Buffer.from(source.bytes), input.fileName?.trim() || source.fileName, input.name, ctx.user?.id ?? null, { fileHash: input.fileHash });
    }),

  setColorStack: authedProcedure
    .input(
      z.object({
        id: clubMapId,
        profile: colorProfileSchema.optional(),
        northLinesBelow: z.boolean().optional(),
        overrides: colorStackOverridesSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const legacyIds = await legacyRowIds(input.id);
      const series: Prisma.ClubMapUpdateInput = {};
      const legacy: Prisma.ClubMapFileUpdateManyMutationInput = {};
      if (input.profile !== undefined) {
        series.colourProfile = input.profile;
        legacy.colorProfile = input.profile;
      }
      if (input.northLinesBelow !== undefined) {
        series.northLinesBelow = input.northLinesBelow;
        legacy.northLinesBelow = input.northLinesBelow;
      }
      if (input.overrides !== undefined) {
        series.colourOverrides = input.overrides as Prisma.InputJsonValue;
        legacy.colorOverrides = input.overrides as Prisma.InputJsonValue;
      }
      if (Object.keys(series).length > 0) {
        await prisma().clubMap.update({ where: { id: input.id }, data: series });
        await prisma().clubMapFile.updateMany({ where: { id: { in: legacyIds } }, data: legacy });
      }
      // Write-through: the legacy rows' render keys drive the tile cache.
      let renderKey: string | null = null;
      for (const id of legacyIds) {
        const before = await prisma().clubMapFile.findUnique({ where: { id }, select: { renderKey: true } });
        const key = await refreshClubMapRenderKey(prisma(), id);
        if (before?.renderKey && before.renderKey !== key) invalidateRenderKey(before.renderKey);
        invalidateRenderKey(key);
        renderKey ??= key;
      }
      await gcOrphanTiles(prisma());
      return { success: true as const, renderKey };
    }),

  /**
   * Ops-only escape hatch: manual georeference correction on a
   * club-library map. Not exposed in the UI — ScalePar is authoritative
   * and a mis-registered file belongs back in OCAD. Re-derives the legacy
   * rows' bounds / northOffset. Events that already copied this map keep
   * their own MapFile.rotationCorrection until re-copied.
   */
  setRotation: authedProcedure
    .input(
      z.object({
        id: clubMapId,
        degrees: z.number().min(-180).max(180),
      }),
    )
    .mutation(async ({ input }) => {
      const legacyIds = await legacyRowIds(input.id);
      await prisma().clubMap.update({ where: { id: input.id }, data: { rotationCorrection: input.degrees } });
      let result: Awaited<ReturnType<typeof applyClubMapRotationCorrection>> | null = null;
      for (const id of legacyIds) {
        const applied = await applyClubMapRotationCorrection(prisma(), id, input.degrees);
        result ??= applied;
      }
      return { success: true as const, ...(result ?? { rotationCorrection: input.degrees }) };
    }),

  rename: authedProcedure
    .input(z.object({ id: clubMapId, name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const legacyIds = await legacyRowIds(input.id);
      const name = input.name.trim();
      await prisma().clubMap.update({ where: { id: input.id }, data: { name } });
      await prisma().clubMapFile.updateMany({ where: { id: { in: legacyIds } }, data: { name } });
      return { success: true as const };
    }),

  /**
   * Delete a series: its versions cascade and events that pinned one keep
   * their copy with `club_map_version_id` nulled. Blobs are left to the
   * GC (§8). The linked legacy rows go first — `club_map_id` is
   * `SET NULL`, so the other order would leave an unlinked row for the
   * backfill to import again.
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
      await prisma().$transaction([
        prisma().clubMapFile.deleteMany({ where: { clubMapId: input.id } }),
        prisma().clubMap.delete({ where: { id: input.id } }),
      ]);
      await gcOrphanTiles(prisma());
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
