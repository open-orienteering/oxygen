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

function toId(id: bigint): number {
  return Number(id);
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
      const resolved = await resolveMapNorth(buffer);
      const previewPng = await renderOcadPreview(buffer);
      const name = input.name?.trim() || input.fileName;
      const fileHash = hashMapFileData(buffer);
      const colorProfile = "auto" as const;
      const northLinesBelow = true;
      const renderKey = computeRenderKey({
        fileHash,
        rotationCorrection: resolved.rotationCorrection,
        colorProfile,
        northLinesBelow,
      });
      const row = await prisma().clubMapFile.create({
        data: {
          name,
          fileName: input.fileName,
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
          uploadedBy: ctx.user?.id ?? null,
        },
        select: {
          id: true,
          name: true,
          fileName: true,
          sizeBytes: true,
          rotationCorrection: true,
          renderKey: true,
        },
      });
      return {
        id: toId(row.id),
        name: row.name,
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
        rotationCorrection: row.rotationCorrection,
        renderKey: row.renderKey,
        meridianStalenessDeg: resolved.meridianStalenessDeg,
      };
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
        select: { uploadedBy: true },
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
