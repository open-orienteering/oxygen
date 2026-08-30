import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authedProcedure, adminProcedure, eventProcedure, manageProcedure, capabilitiesForContext } from "../trpc.js";
import { prisma } from "../db.js";
import { grantSystemGroup, parseCapabilities } from "../permissions.js";
import type { Capability } from "@oxygen/shared";

export const permissionRouter = router({
  /** Capability roles (system permission groups). UI label: "Role". */
  groups: authedProcedure.query(async () => {
    const rows = await prisma().permissionGroup.findMany({
      orderBy: { name: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      capabilities: parseCapabilities(row.capabilities),
      isSystem: row.isSystem,
    }));
  }),

  // ─── Club user groups (defined once, granted per event) ──────────
  //
  // Membership gates event permissions, so mutations are instance-admin
  // only. Reads are open to any authed user (the grant form needs the
  // list, and the library page shows it).

  clubGroups: authedProcedure.query(async () => {
    const rows = await prisma().clubUserGroup.findMany({
      orderBy: { name: "asc" },
      include: {
        members: {
          include: { user: { select: { email: true, displayName: true } } },
          orderBy: { addedAt: "asc" },
        },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      members: row.members.map((m) => ({
        userId: m.userId,
        email: m.user.email,
        displayName: m.user.displayName,
      })),
    }));
  }),

  createClubGroup: adminProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ input }) => {
      const existing = await prisma().clubUserGroup.findUnique({
        where: { name: input.name },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "A group with that name already exists",
        });
      }
      const row = await prisma().clubUserGroup.create({
        data: { name: input.name },
      });
      return { id: row.id, name: row.name };
    }),

  renameClubGroup: adminProcedure
    .input(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(100) }))
    .mutation(async ({ input }) => {
      try {
        await prisma().clubUserGroup.update({
          where: { id: input.id },
          data: { name: input.name },
        });
      } catch {
        throw new TRPCError({ code: "NOT_FOUND", message: "Group not found" });
      }
      return { ok: true as const };
    }),

  deleteClubGroup: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      // Grants referencing the group cascade away with it.
      const deleted = await prisma().clubUserGroup.deleteMany({
        where: { id: input.id },
      });
      if (deleted.count === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Group not found" });
      }
      return { ok: true as const };
    }),

  addClubGroupMember: adminProcedure
    .input(z.object({ groupId: z.string().uuid(), userEmail: z.string().email() }))
    .mutation(async ({ input }) => {
      const email = input.userEmail.trim().toLowerCase();
      const user = await prisma().user.findUnique({ where: { email } });
      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No invited user with that email",
        });
      }
      const group = await prisma().clubUserGroup.findUnique({
        where: { id: input.groupId },
      });
      if (!group) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Group not found" });
      }
      await prisma().clubUserGroupMember.upsert({
        where: { groupId_userId: { groupId: group.id, userId: user.id } },
        create: { groupId: group.id, userId: user.id },
        update: {},
      });
      return { ok: true as const };
    }),

  removeClubGroupMember: adminProcedure
    .input(z.object({ groupId: z.string().uuid(), userId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await prisma().clubUserGroupMember.deleteMany({
        where: { groupId: input.groupId, userId: input.userId },
      });
      return { ok: true as const };
    }),

  // ─── Per-event grants ─────────────────────────────────────────────

  listGrants: manageProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.eventPermission.findMany({
      where: { eventId: ctx.event.id },
      include: {
        user: { select: { email: true, displayName: true } },
        clubGroup: {
          select: { name: true, _count: { select: { members: true } } },
        },
        group: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((row) => ({
      id: row.id,
      subjectType: row.clubGroupId ? ("clubGroup" as const) : ("user" as const),
      userEmail: row.user?.email ?? null,
      userDisplayName: row.user?.displayName ?? null,
      clubGroupId: row.clubGroupId,
      clubGroupName: row.clubGroup?.name ?? null,
      clubGroupMemberCount: row.clubGroup?._count.members ?? null,
      groupId: row.groupId,
      groupName: row.group.name,
      grantedBy: row.grantedBy,
      createdAt: row.createdAt.toISOString(),
    }));
  }),

  grant: manageProcedure
    .input(
      z
        .object({
          groupId: z.string().uuid(),
          userEmail: z.string().email().optional(),
          clubGroupId: z.string().uuid().optional(),
        })
        .refine((v) => (v.userEmail === undefined) !== (v.clubGroupId === undefined), {
          message: "Provide exactly one of userEmail / clubGroupId",
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.db.permissionGroup.findUnique({
        where: { id: input.groupId },
      });
      if (!group) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Unknown role" });
      }

      if (input.userEmail !== undefined) {
        const email = input.userEmail.trim().toLowerCase();
        const user = await ctx.db.user.findUnique({ where: { email } });
        if (!user) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "No invited user with that email",
          });
        }
        await grantSystemGroup(ctx.db, {
          eventId: ctx.event.id,
          userId: user.id,
          groupId: group.id,
          grantedBy: ctx.user?.id ?? null,
        });
        return { ok: true as const };
      }

      const clubGroup = await ctx.db.clubUserGroup.findUnique({
        where: { id: input.clubGroupId! },
      });
      if (!clubGroup) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Group not found" });
      }
      const existing = await ctx.db.eventPermission.findFirst({
        where: {
          eventId: ctx.event.id,
          clubGroupId: clubGroup.id,
          groupId: group.id,
        },
      });
      if (!existing) {
        await ctx.db.eventPermission.create({
          data: {
            eventId: ctx.event.id,
            clubGroupId: clubGroup.id,
            groupId: group.id,
            grantedBy: ctx.user?.id ?? null,
          },
        });
      }
      return { ok: true as const };
    }),

  revoke: manageProcedure
    .input(z.object({ grantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await ctx.db.eventPermission.deleteMany({
        where: { id: input.grantId, eventId: ctx.event.id },
      });
      if (deleted.count === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Grant not found" });
      }
      return { ok: true as const };
    }),

  myCapabilities: eventProcedure.query(async ({ ctx }): Promise<Capability[]> => {
    const caps = await capabilitiesForContext(ctx);
    return [...caps];
  }),
});
