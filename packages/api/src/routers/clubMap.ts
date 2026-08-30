import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure } from "../trpc.js";
import { prisma } from "../db.js";
import { parseOcadMapMetadata } from "../event-map.js";
import { renderOcadPreview } from "../club-map-preview.js";
import type { WGS84Bounds } from "../map-projection.js";
import type { Prisma } from "../generated/prisma/client.js";

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
        uploadedAt: true,
        uploadedBy: true,
        uploader: { select: { email: true, displayName: true } },
      },
    });
    return rows.map((row) => ({
      id: toId(row.id),
      name: row.name,
      fileName: row.fileName,
      sizeBytes: row.sizeBytes,
      scale: row.scale,
      bounds: (row.bounds as WGS84Bounds | null) ?? null,
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
      const meta = await parseOcadMapMetadata(buffer);
      const previewPng = await renderOcadPreview(buffer);
      const name = input.name?.trim() || input.fileName;
      const row = await prisma().clubMapFile.create({
        data: {
          name,
          fileName: input.fileName,
          fileData: Uint8Array.from(buffer),
          previewPng: previewPng ? Uint8Array.from(previewPng) : undefined,
          sizeBytes: buffer.length,
          scale: meta.scale,
          bounds: (meta.bounds ?? undefined) as Prisma.InputJsonValue | undefined,
          northOffset: meta.northOffset,
          uploadedBy: ctx.user?.id ?? null,
        },
        select: { id: true, name: true, fileName: true, sizeBytes: true },
      });
      return {
        id: toId(row.id),
        name: row.name,
        fileName: row.fileName,
        sizeBytes: row.sizeBytes,
      };
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
      return { success: true as const };
    }),

  download: authedProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      const row = await prisma().clubMapFile.findUnique({
        where: { id: BigInt(input.id) },
        select: { fileName: true, fileData: true },
      });
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Club map ${input.id} not found`,
        });
      }
      return {
        fileName: row.fileName,
        fileDataBase64: Buffer.from(row.fileData).toString("base64"),
      };
    }),
});
