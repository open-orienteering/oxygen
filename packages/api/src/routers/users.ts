import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, adminProcedure } from "../trpc.js";
import { prisma } from "../db.js";
import { authMode } from "../auth.js";

const userPublicSelect = {
  id: true,
  email: true,
  displayName: true,
  isAdmin: true,
  active: true,
  createdAt: true,
  lastSeenAt: true,
} as const;

export const usersRouter = router({
  /**
   * Current identity. Stays public so the UI can distinguish "no header"
   * from "signed in but not invited".
   */
  me: publicProcedure.query(async ({ ctx }) => ({
    authMode: authMode(),
    authEnabled: ctx.authEnabled,
    identityEmail: ctx.identityEmail,
    user: ctx.user
      ? {
          id: ctx.user.id,
          email: ctx.user.email,
          displayName: ctx.user.displayName,
          isAdmin: ctx.user.isAdmin,
        }
      : null,
  })),

  list: adminProcedure.query(async () => {
    const rows = await prisma().user.findMany({
      orderBy: { email: "asc" },
      select: {
        ...userPublicSelect,
        clubGroupMemberships: {
          select: { group: { select: { id: true, name: true } } },
          orderBy: { group: { name: "asc" } },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.displayName,
      isAdmin: row.isAdmin,
      active: row.active,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      groups: row.clubGroupMemberships.map((m) => m.group),
    }));
  }),

  invite: adminProcedure
    .input(
      z.object({
        email: z.string().email(),
        displayName: z.string().optional(),
        isAdmin: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const email = input.email.trim().toLowerCase();
      const displayName =
        input.displayName?.trim() || email.split("@")[0] || email;
      try {
        return await prisma().user.create({
          data: {
            email,
            displayName,
            isAdmin: input.isAdmin ?? false,
            active: true,
          },
          select: userPublicSelect,
        });
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A user with that email already exists",
          });
        }
        throw err;
      }
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        // Trimmed and non-empty: a blank rename would leave the Users
        // table with an unidentifiable row.
        displayName: z.string().trim().min(1).max(200).optional(),
        isAdmin: z.boolean().optional(),
        active: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (
        ctx.user &&
        input.id === ctx.user.id &&
        (input.active === false || input.isAdmin === false)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot deactivate or remove admin from your own account",
        });
      }
      try {
        return await prisma().user.update({
          where: { id: input.id },
          data: {
            ...(input.displayName !== undefined
              ? { displayName: input.displayName }
              : {}),
            ...(input.isAdmin !== undefined ? { isAdmin: input.isAdmin } : {}),
            ...(input.active !== undefined ? { active: input.active } : {}),
          },
          select: userPublicSelect,
        });
      } catch {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }
    }),
});
