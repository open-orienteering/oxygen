import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../trpc.js";
import { prisma } from "../db.js";
import {
  applyClubMapRotationCorrection,
  currentMeridianStaleness,
  detectNorthFromBuffer,
  resolveMapNorth,
} from "../event-map.js";
import { canDownloadClubLibraryMap } from "../ocad-export.js";
import { renderOcadPreview } from "../club-map-preview.js";
import type { WGS84Bounds } from "../map-projection.js";
import type { NorthDetection } from "../map-north.js";
import type { Prisma } from "../generated/prisma/client.js";
import { computeRenderKey, hashMapFileData } from "../map-render-key.js";
import {
  gcOrphanTiles,
  refreshClubMapRenderKey,
} from "../map-render-cache.js";
import { colorProfileSchema, colorStackOverridesSchema } from "@oxygen/shared";
import { invalidateRenderKey } from "../map-tiles.js";
import { startImportJob, type ImportJobRow } from "../map-store/jobs.js";

function toId(id: bigint): number {
  return Number(id);
}

const UPLOAD_SELECT = {
  id: true,
  name: true,
  fileName: true,
  sizeBytes: true,
  rotationCorrection: true,
  renderKey: true,
} as const;

/**
 * Create a club-library map from bytes: the legacy `club_map_files` row
 * the UI lists today, plus — dual-written for the document pipeline
 * (docs/map-storage.md §6.5) — a `club_maps` series, the content-
 * addressed source row, and an import job that adds the first
 * `club_map_versions` entry when it finishes.
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
  const series = await prisma().clubMap.create({
    data: {
      name: displayName,
      colourProfile: colorProfile,
      northLinesBelow,
      rotationCorrection: resolved.rotationCorrection,
      createdBy: userId,
    },
    select: { id: true },
  });
  const row = await prisma().clubMapFile.create({
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
      clubMapId: series.id,
    },
    select: UPLOAD_SELECT,
  });
  await prisma().mapSource.createMany({
    data: [{ fileHash, kind: "ocad", bytes: Uint8Array.from(buffer), sizeBytes: buffer.length, fileName, uploadedBy: userId }],
    skipDuplicates: true,
  });
  const job: ImportJobRow | null = await startImportJob(prisma(), { sourceHash: fileHash, clubMapId: series.id })
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
    id: toId(row.id),
    name: row.name,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    rotationCorrection: row.rotationCorrection,
    renderKey: row.renderKey,
    meridianStalenessDeg: resolved.meridianStalenessDeg,
    clubMapId: series.id,
    importJob: job ? { id: job.id, state: job.state, error: job.error } : null,
  };
}

/** Mirror a legacy-row settings change onto its series, when linked. */
async function mirrorToSeries(legacyId: bigint, data: Prisma.ClubMapUpdateInput): Promise<void> {
  const row = await prisma().clubMapFile.findUnique({ where: { id: legacyId }, select: { clubMapId: true } });
  if (row?.clubMapId) await prisma().clubMap.update({ where: { id: row.clubMapId }, data });
}

export const clubMapRouter = router({
  list: authedProcedure.query(async () => {
    const rows = await prisma().clubMapFile.findMany({
      orderBy: { uploadedAt: "desc" },
      select: {
        id: true,
        name: true,
        fileName: true,
        sizeBytes: true,
        scale: true,
        bounds: true,
        northOffset: true,
        rotationCorrection: true,
        northDetection: true,
        colorProfile: true,
        northLinesBelow: true,
        renderKey: true,
        uploadedAt: true,
        uploadedBy: true,
        uploader: { select: { email: true, displayName: true } },
      },
    });

    // Rows uploaded before the north_detection column exist with NULL,
    // which is indistinguishable from "analysed, no 601 lines" in the UI.
    // Backfill once on first read — same pattern as the preview
    // thumbnail backfill. Unparseable blobs persist an all-null
    // detection so they are not re-parsed on every list call.
    for (const row of rows) {
      if (row.northDetection != null) continue;
      const blob = await prisma().clubMapFile.findUnique({
        where: { id: row.id },
        select: { fileData: true },
      });
      if (!blob) continue;
      const detection = await detectNorthFromBuffer(Buffer.from(blob.fileData));
      await prisma().clubMapFile.update({
        where: { id: row.id },
        data: {
          northDetection: detection as unknown as Prisma.InputJsonValue,
        },
      });
      row.northDetection = detection as unknown as Prisma.JsonValue;
    }

    return rows.map((row) => ({
      id: toId(row.id),
      name: row.name,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      scale: row.scale,
      bounds: (row.bounds as WGS84Bounds | null) ?? null,
      northOffset: row.northOffset,
      rotationCorrection: row.rotationCorrection,
      northDetection: (row.northDetection as NorthDetection | null) ?? null,
      colorProfile: row.colorProfile,
      northLinesBelow: row.northLinesBelow,
      renderKey: row.renderKey,
      // Evaluated for today, not import time, so a library map starts
      // to flag its north lines as the declination drifts away from them.
      meridianStalenessDeg: currentMeridianStaleness(row.northDetection),
      uploadedAt: row.uploadedAt.toISOString(),
      uploadedBy: row.uploadedBy,
      uploader: row.uploader,
    }));
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
        id: z.number().int().positive(),
        profile: colorProfileSchema.optional(),
        northLinesBelow: z.boolean().optional(),
        overrides: colorStackOverridesSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const id = BigInt(input.id);
      const existing = await prisma().clubMapFile.findUnique({
        where: { id },
        select: { id: true, renderKey: true },
      });
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Club map ${input.id} not found`,
        });
      }
      const data: Record<string, unknown> = {};
      if (input.profile !== undefined) data.colorProfile = input.profile;
      if (input.northLinesBelow !== undefined) {
        data.northLinesBelow = input.northLinesBelow;
      }
      if (input.overrides !== undefined) {
        data.colorOverrides = input.overrides;
      }
      if (Object.keys(data).length > 0) {
        await prisma().clubMapFile.update({ where: { id }, data });
        await mirrorToSeries(id, {
          ...(input.profile !== undefined ? { colourProfile: input.profile } : {}),
          ...(input.northLinesBelow !== undefined ? { northLinesBelow: input.northLinesBelow } : {}),
          ...(input.overrides !== undefined ? { colourOverrides: input.overrides as Prisma.InputJsonValue } : {}),
        });
      }
      const oldKey = existing.renderKey;
      const renderKey = await refreshClubMapRenderKey(prisma(), id);
      if (oldKey && oldKey !== renderKey) invalidateRenderKey(oldKey);
      invalidateRenderKey(renderKey);
      await gcOrphanTiles(prisma());
      return { success: true as const, renderKey };
    }),

  /**
   * Ops-only escape hatch: manual georeference correction on a
   * club-library map. Not exposed in the UI — ScalePar is authoritative
   * and a mis-registered file belongs back in OCAD. Re-derives bounds /
   * northOffset. Events that already copied this map keep their own
   * MapFile.rotationCorrection until re-copied.
   */
  setRotation: authedProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        degrees: z.number().min(-180).max(180),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const result = await applyClubMapRotationCorrection(
          prisma(),
          BigInt(input.id),
          input.degrees,
        );
        await mirrorToSeries(BigInt(input.id), { rotationCorrection: input.degrees });
        return { success: true as const, ...result };
      } catch (err) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            err instanceof Error ? err.message : `Club map ${input.id} not found`,
        });
      }
    }),

  rename: authedProcedure
    .input(z.object({ id: z.number().int().positive(), name: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await prisma().clubMapFile.update({
          where: { id: BigInt(input.id) },
          data: { name: input.name.trim() },
        });
        await mirrorToSeries(BigInt(input.id), { name: input.name.trim() });
      } catch {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Club map ${input.id} not found`,
        });
      }
      return { success: true as const };
    }),

  remove: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const row = await prisma().clubMapFile.findUnique({
        where: { id: BigInt(input.id) },
        select: { uploadedBy: true, clubMapId: true },
      });
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Club map ${input.id} not found`,
        });
      }
      if (ctx.authEnabled) {
        const user = ctx.user;
        const isUploader = Boolean(user && row.uploadedBy === user.id);
        const isAdmin = Boolean(user?.isAdmin);
        if (!isUploader && !isAdmin) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only the uploader or an admin can delete this map",
          });
        }
      }
      await prisma().clubMapFile.delete({ where: { id: BigInt(input.id) } });
      // The series goes with its legacy row while the two are dual-written;
      // versions cascade, documents stay for the GC, event pins null out.
      if (row.clubMapId) await prisma().clubMap.delete({ where: { id: row.clubMapId } });
      await gcOrphanTiles(prisma());
      return { success: true as const };
    }),

  download: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ ctx, input }) => {
      const row = await prisma().clubMapFile.findUnique({
        where: { id: BigInt(input.id) },
        select: { fileName: true, fileData: true, uploadedBy: true },
      });
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Club map ${input.id} not found`,
        });
      }
      if (
        !canDownloadClubLibraryMap({
          authEnabled: ctx.authEnabled,
          isAdmin: Boolean(ctx.user?.isAdmin),
          isUploader: Boolean(ctx.user && row.uploadedBy === ctx.user.id),
        })
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only the uploader or an admin can download this map",
        });
      }
      return {
        fileName: row.fileName,
        fileDataBase64: Buffer.from(row.fileData).toString("base64"),
      };
    }),
});
