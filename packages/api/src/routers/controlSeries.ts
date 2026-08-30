import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { CLUB_CONTROL_TYPES } from "@oxygen/shared";
import { router, authedProcedure } from "../trpc.js";
import { prisma } from "../db.js";

const uuid = z.string().uuid();
const clubType = z.enum(CLUB_CONTROL_TYPES);

export const controlSeriesRouter = router({
  list: authedProcedure.query(async () => {
    const rows = await prisma().clubControlSeries.findMany({
      orderBy: { priority: "asc" },
      include: {
        controls: { orderBy: { code: "asc" } },
      },
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      ownerName: s.ownerName,
      borrowed: s.borrowed,
      priority: s.priority,
      notes: s.notes,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      counts: {
        total: s.controls.length,
        active: s.controls.filter((c) => c.active).length,
        srr: s.controls.filter((c) => c.type === "srr").length,
      },
      controls: s.controls.map((c) => ({
        id: c.id,
        code: c.code,
        type: c.type,
        active: c.active,
        notes: c.notes,
      })),
    }));
  }),

  createSeries: authedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        ownerName: z.string().optional(),
        borrowed: z.boolean().optional(),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const agg = await prisma().clubControlSeries.aggregate({
        _max: { priority: true },
      });
      const priority = (agg._max.priority ?? 0) + 1;
      const row = await prisma().clubControlSeries.create({
        data: {
          name: input.name.trim(),
          ownerName: input.ownerName ?? "",
          borrowed: input.borrowed ?? false,
          notes: input.notes ?? "",
          priority,
        },
      });
      return { id: row.id, priority: row.priority };
    }),

  updateSeries: authedProcedure
    .input(
      z.object({
        id: uuid,
        name: z.string().min(1).optional(),
        ownerName: z.string().optional(),
        borrowed: z.boolean().optional(),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const data: {
        name?: string;
        ownerName?: string;
        borrowed?: boolean;
        notes?: string;
      } = {};
      if (input.name !== undefined) data.name = input.name.trim();
      if (input.ownerName !== undefined) data.ownerName = input.ownerName;
      if (input.borrowed !== undefined) data.borrowed = input.borrowed;
      if (input.notes !== undefined) data.notes = input.notes;
      try {
        await prisma().clubControlSeries.update({
          where: { id: input.id },
          data,
        });
      } catch {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Series ${input.id} not found`,
        });
      }
      return { ok: true };
    }),

  moveSeries: authedProcedure
    .input(z.object({ id: uuid, direction: z.enum(["up", "down"]) }))
    .mutation(async ({ input }) => {
      const db = prisma();
      await db.$transaction(async (tx) => {
        const all = await tx.clubControlSeries.findMany({
          orderBy: { priority: "asc" },
          select: { id: true, priority: true },
        });
        const idx = all.findIndex((s) => s.id === input.id);
        if (idx < 0) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Series ${input.id} not found`,
          });
        }
        const swapWith = input.direction === "up" ? idx - 1 : idx + 1;
        if (swapWith < 0 || swapWith >= all.length) return;
        const a = all[idx]!;
        const b = all[swapWith]!;
        const tmp = -1;
        await tx.clubControlSeries.update({
          where: { id: a.id },
          data: { priority: tmp },
        });
        await tx.clubControlSeries.update({
          where: { id: b.id },
          data: { priority: a.priority },
        });
        await tx.clubControlSeries.update({
          where: { id: a.id },
          data: { priority: b.priority },
        });
      });
      return { ok: true };
    }),

  deleteSeries: authedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ input }) => {
      try {
        await prisma().clubControlSeries.delete({ where: { id: input.id } });
      } catch {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Series ${input.id} not found`,
        });
      }
      return { ok: true };
    }),

  addControls: authedProcedure
    .input(
      z.object({
        seriesId: uuid,
        from: z.number().int().min(1),
        to: z.number().int().max(1023),
        type: clubType.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.to < input.from) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Range end must be ≥ start",
        });
      }
      if (input.to - input.from + 1 > 500) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Range span must be ≤ 500",
        });
      }
      const series = await prisma().clubControlSeries.findUnique({
        where: { id: input.seriesId },
        select: { id: true },
      });
      if (!series) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Series ${input.seriesId} not found`,
        });
      }
      const existing = await prisma().clubSeriesControl.findMany({
        where: {
          seriesId: input.seriesId,
          code: { gte: input.from, lte: input.to },
        },
        select: { code: true },
      });
      const skip = new Set(existing.map((c) => c.code));
      const type = input.type ?? "normal";
      const toInsert: { seriesId: string; code: number; type: typeof type }[] = [];
      for (let code = input.from; code <= input.to; code++) {
        if (skip.has(code)) continue;
        toInsert.push({ seriesId: input.seriesId, code, type });
      }
      if (toInsert.length > 0) {
        await prisma().clubSeriesControl.createMany({ data: toInsert });
      }
      return { added: toInsert.length, skipped: skip.size };
    }),

  updateControl: authedProcedure
    .input(
      z.object({
        id: uuid,
        type: clubType.optional(),
        active: z.boolean().optional(),
        notes: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const data: { type?: (typeof CLUB_CONTROL_TYPES)[number]; active?: boolean; notes?: string } =
        {};
      if (input.type !== undefined) data.type = input.type;
      if (input.active !== undefined) data.active = input.active;
      if (input.notes !== undefined) data.notes = input.notes;
      try {
        await prisma().clubSeriesControl.update({
          where: { id: input.id },
          data,
        });
      } catch {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Control ${input.id} not found`,
        });
      }
      return { ok: true };
    }),

  deleteControl: authedProcedure
    .input(z.object({ id: uuid }))
    .mutation(async ({ input }) => {
      try {
        await prisma().clubSeriesControl.delete({ where: { id: input.id } });
      } catch {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Control ${input.id} not found`,
        });
      }
      return { ok: true };
    }),

  allocation: authedProcedure.query(async () => {
    const rows = await prisma().clubControlSeries.findMany({
      orderBy: { priority: "asc" },
      include: {
        controls: {
          where: { active: true },
          orderBy: { code: "asc" },
        },
      },
    });
    return rows.flatMap((s) =>
      s.controls.map((c) => ({
        code: c.code,
        type: c.type,
        seriesId: s.id,
        seriesName: s.name,
        borrowed: s.borrowed,
      })),
    );
  }),
});
