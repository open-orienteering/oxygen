import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { ClubClassPreset } from "@oxygen/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { authedProcedure, router } from "../trpc.js";

const sexSchema = z.enum(["", "M", "F"]);
const presetFields = {
  name: z.string().trim().min(1),
  sex: sexSchema.optional(),
  lowAge: z.number().int().optional(),
  highAge: z.number().int().optional(),
  classType: z.string().optional(),
  noTiming: z.boolean().optional(),
  freeStart: z.boolean().optional(),
  allowQuickEntry: z.boolean().optional(),
  sortIndex: z.number().int().optional(),
};

function conflict(error: unknown, name: string): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Class preset "${name}" already exists`,
    });
  }
  throw error;
}

function toPreset(row: {
  id: string;
  name: string;
  sex: string;
  lowAge: number;
  highAge: number;
  classType: string;
  noTiming: boolean;
  freeStart: boolean;
  allowQuickEntry: boolean;
  sortIndex: number;
  createdAt: Date;
  updatedAt: Date;
}): ClubClassPreset {
  return {
    id: row.id,
    name: row.name,
    sex: row.sex as ClubClassPreset["sex"],
    lowAge: row.lowAge,
    highAge: row.highAge,
    classType: row.classType,
    noTiming: row.noTiming,
    freeStart: row.freeStart,
    allowQuickEntry: row.allowQuickEntry,
    sortIndex: row.sortIndex,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const classPresetRouter = router({
  list: authedProcedure.query(async () => {
    const rows = await prisma().clubClassPreset.findMany({
      orderBy: [{ sortIndex: "asc" }, { name: "asc" }],
    });
    return rows.map(toPreset);
  }),

  create: authedProcedure
    .input(z.object(presetFields))
    .mutation(async ({ input }) => {
      try {
        const row = await prisma().clubClassPreset.create({
          data: {
            name: input.name,
            sex: input.sex ?? "",
            lowAge: input.lowAge ?? 0,
            highAge: input.highAge ?? 0,
            classType: input.classType ?? "",
            noTiming: input.noTiming ?? false,
            freeStart: input.freeStart ?? false,
            allowQuickEntry: input.allowQuickEntry ?? false,
            sortIndex: input.sortIndex ?? 0,
          },
        });
        return toPreset(row);
      } catch (error) {
        conflict(error, input.name);
      }
    }),

  update: authedProcedure
    .input(z.object({ id: z.string().uuid(), ...presetFields }).partial().required({ id: true }))
    .mutation(async ({ input }) => {
      const { id, ...fields } = input;
      try {
        const row = await prisma().clubClassPreset.update({
          where: { id },
          data: fields,
        });
        return toPreset(row);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2025"
        ) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Class preset ${id} not found`,
          });
        }
        conflict(error, input.name ?? id);
      }
    }),

  delete: authedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      try {
        await prisma().clubClassPreset.delete({ where: { id: input.id } });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2025"
        ) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Class preset ${input.id} not found`,
          });
        }
        throw error;
      }
      return { ok: true as const };
    }),
});
