import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  MAX_GRAPHIC_UPLOAD_BYTES,
  graphicPixelSize,
  prepareGraphicUpload,
} from "../course-maps/graphics.js";
import {
  coursesEditProcedure,
  coursesViewProcedure,
  router,
} from "../trpc.js";

export interface GraphicListItem {
  id: number;
  name: string;
  mime: string;
  sizeBytes: number;
  /** Pixel size (J2): a PNG's own, an SVG's viewBox at 4096 px on its longer side; null when unreadable. */
  widthPx: number | null;
  heightPx: number | null;
  /** True for club-library graphics shared across events. */
  club: boolean;
}

const listSelect = {
  id: true,
  name: true,
  mime: true,
  sizeBytes: true,
  widthPx: true,
  heightPx: true,
  eventId: true,
} as const;

function listItem(row: {
  id: bigint;
  name: string;
  mime: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  eventId: bigint | null;
}): GraphicListItem {
  return {
    id: Number(row.id),
    name: row.name,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    club: row.eventId === null,
  };
}

export const graphicsRouter = router({
  /** Event graphics first, then the shared club library. */
  list: coursesViewProcedure.query(async ({ ctx }): Promise<GraphicListItem[]> => {
    const rows = await ctx.db.graphic.findMany({
      where: { OR: [{ eventId: ctx.event.id }, { eventId: null }] },
      orderBy: [{ eventId: { sort: "desc", nulls: "last" } }, { name: "asc" }],
      select: listSelect,
    });
    // The backfill of rows the migration could not size (SVGs, J2): read
    // once, written back, so a later list reads the columns only.
    for (const row of rows) {
      if (row.widthPx !== null && row.heightPx !== null) continue;
      const held = await ctx.db.graphic.findUnique({ where: { id: row.id }, select: { data: true } });
      const size = held ? graphicPixelSize(held.data, row.mime) : null;
      if (!size) continue;
      await ctx.db.graphic.update({ where: { id: row.id }, data: size, select: { id: true } });
      row.widthPx = size.widthPx;
      row.heightPx = size.heightPx;
    }
    return rows.map(listItem);
  }),

  upload: coursesEditProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        /** "club" stores the graphic in the shared club library. */
        scope: z.enum(["event", "club"]).default("event"),
        fileDataBase64: z
          .string()
          .min(1)
          // Base64 inflates ~4/3, so cap the encoded payload accordingly.
          .max(Math.ceil((MAX_GRAPHIC_UPLOAD_BYTES * 4) / 3) + 1024),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let prepared: Awaited<ReturnType<typeof prepareGraphicUpload>>;
      try {
        prepared = await prepareGraphicUpload(Buffer.from(input.fileDataBase64, "base64"));
      } catch (error) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            error instanceof Error ? error.message : "Unsupported graphic",
        });
      }
      const row = await ctx.db.graphic.create({
        data: {
          eventId: input.scope === "club" ? null : ctx.event.id,
          name: input.name,
          mime: prepared.mime,
          data: Uint8Array.from(prepared.data),
          sizeBytes: prepared.data.byteLength,
          widthPx: prepared.widthPx,
          heightPx: prepared.heightPx,
        },
        select: listSelect,
      });
      return listItem(row);
    }),

  /** Copy an event graphic into the shared club library. */
  saveToClub: coursesEditProcedure
    .input(
      z.object({
        id: z.number().int().positive(),
        name: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const source = await ctx.db.graphic.findFirst({
        where: { id: BigInt(input.id), eventId: ctx.event.id },
      });
      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Graphic not found" });
      }
      const row = await ctx.db.graphic.create({
        data: {
          eventId: null,
          name: input.name ?? source.name,
          mime: source.mime,
          data: source.data,
          sizeBytes: source.sizeBytes,
          widthPx: source.widthPx,
          heightPx: source.heightPx,
        },
        select: listSelect,
      });
      return listItem(row);
    }),

  /** Deletes an event graphic, or a club graphic (shared, like club templates). */
  delete: coursesEditProcedure
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.graphic.deleteMany({
        where: {
          id: BigInt(input.id),
          OR: [{ eventId: ctx.event.id }, { eventId: null }],
        },
      });
      if (result.count === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Graphic not found" });
      }
      return { ok: true as const };
    }),
});
