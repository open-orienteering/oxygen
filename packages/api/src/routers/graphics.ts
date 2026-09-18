import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  MAX_GRAPHIC_BYTES,
  validateGraphicUpload,
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
  /** True for club-library graphics shared across events. */
  club: boolean;
}

function listItem(row: {
  id: bigint;
  name: string;
  mime: string;
  sizeBytes: number;
  eventId: bigint | null;
}): GraphicListItem {
  return {
    id: Number(row.id),
    name: row.name,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    club: row.eventId === null,
  };
}

export const graphicsRouter = router({
  /** Event graphics first, then the shared club library. */
  list: coursesViewProcedure.query(async ({ ctx }): Promise<GraphicListItem[]> => {
    const rows = await ctx.db.graphic.findMany({
      where: { OR: [{ eventId: ctx.event.id }, { eventId: null }] },
      orderBy: [{ eventId: { sort: "desc", nulls: "last" } }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        mime: true,
        sizeBytes: true,
        eventId: true,
      },
    });
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
          .max(Math.ceil((MAX_GRAPHIC_BYTES * 4) / 3) + 1024),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const data = Buffer.from(input.fileDataBase64, "base64");
      let mime: string;
      try {
        mime = validateGraphicUpload(data);
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
          mime,
          data,
          sizeBytes: data.byteLength,
        },
        select: {
          id: true,
          name: true,
          mime: true,
          sizeBytes: true,
          eventId: true,
        },
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
        },
        select: {
          id: true,
          name: true,
          mime: true,
          sizeBytes: true,
          eventId: true,
        },
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
