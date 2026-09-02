import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TRPCError } from "@trpc/server";
import { randomBytes } from "crypto";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { resolveUser } from "../../auth.js";
import type { AuthUser } from "../../auth.js";

const suffix = randomBytes(4).toString("hex");
const adminEmail = `admin-${suffix}@users-test.example`;
const memberEmail = `member-${suffix}@users-test.example`;
const dupEmail = `Dup-${suffix}@users-test.example`;

let ctx: TestEventContext;
let admin: AuthUser;
let member: AuthUser;
let classSeq: number;

beforeAll(async () => {
  ctx = await createTestEvent("users-auth");
  const db = ctx.db;
  const adminRow = await db.user.create({
    data: {
      email: adminEmail,
      displayName: "Admin",
      isAdmin: true,
      active: true,
    },
  });
  const memberRow = await db.user.create({
    data: {
      email: memberEmail,
      displayName: "Member",
      isAdmin: false,
      active: true,
    },
  });
  admin = {
    id: adminRow.id,
    email: adminRow.email,
    displayName: adminRow.displayName,
    isAdmin: adminRow.isAdmin,
    active: adminRow.active,
  };
  member = {
    id: memberRow.id,
    email: memberRow.email,
    displayName: memberRow.displayName,
    isAdmin: memberRow.isAdmin,
    active: memberRow.active,
  };
  const cls = await db.class.create({
    data: { eventId: ctx.eventId, name: "H21" },
    select: { seq: true },
  });
  classSeq = cls.seq;
});

afterAll(async () => {
  await ctx.db.user.deleteMany({
    where: { email: { endsWith: `@users-test.example` } },
  });
  await ctx.cleanup();
  await disconnect();
});

function adminCaller(event = ctx.event) {
  return makeCaller(event, { user: admin, authEnabled: true, identityEmail: admin.email });
}

describe("users invite / list / update", () => {
  it("invite → list → update", async () => {
    const caller = adminCaller(null);
    const invited = await caller.users.invite({
      email: `new-${suffix}@users-test.example`,
      displayName: "New User",
    });
    expect(invited.email).toBe(`new-${suffix}@users-test.example`);
    expect(invited.isAdmin).toBe(false);
    expect(invited.active).toBe(true);

    const listed = await caller.users.list();
    expect(listed.some((u) => u.id === invited.id)).toBe(true);

    const updated = await caller.users.update({
      id: invited.id,
      displayName: "Renamed",
      isAdmin: true,
    });
    expect(updated.displayName).toBe("Renamed");
    expect(updated.isAdmin).toBe(true);
  });

  it("rejects a duplicate invite, including different case", async () => {
    const caller = adminCaller(null);
    await caller.users.invite({ email: dupEmail });
    await expect(caller.users.invite({ email: dupEmail })).rejects.toMatchObject({
      code: "CONFLICT",
    } satisfies Partial<TRPCError>);
    await expect(
      caller.users.invite({ email: dupEmail.toLowerCase() }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });

  it("forbids non-admin list and invite when auth is on", async () => {
    const caller = makeCaller(null, {
      user: member,
      authEnabled: true,
      identityEmail: member.email,
    });
    await expect(caller.users.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.users.invite({ email: `x-${suffix}@users-test.example` }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("blocks self-deactivation and self de-admin", async () => {
    const caller = adminCaller(null);
    await expect(
      caller.users.update({ id: admin.id, active: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.users.update({ id: admin.id, isAdmin: false }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("resolveUser", () => {
  it("returns null for a deactivated user", async () => {
    const email = `inactive-${suffix}@users-test.example`;
    await ctx.db.user.create({
      data: { email, displayName: "Gone", isAdmin: false, active: false },
    });
    expect(await resolveUser(email)).toBeNull();
  });

  it("auto-provisions an unknown email as a non-admin member when enabled", async () => {
    const previous = process.env.AUTH_AUTO_PROVISION;
    process.env.AUTH_AUTO_PROVISION = "member";
    const email = `autoprov-${suffix}@users-test.example`;
    try {
      const user = await resolveUser(email);
      expect(user).not.toBeNull();
      expect(user!.email).toBe(email);
      expect(user!.isAdmin).toBe(false);
      expect(user!.active).toBe(true);
      const row = await ctx.db.user.findUnique({ where: { email } });
      expect(row?.displayName).toBe("autoprov-" + suffix);
    } finally {
      if (previous === undefined) delete process.env.AUTH_AUTO_PROVISION;
      else process.env.AUTH_AUTO_PROVISION = previous;
    }
  });

  it("does not auto-provision when AUTH_AUTO_PROVISION is unset", async () => {
    const previous = process.env.AUTH_AUTO_PROVISION;
    delete process.env.AUTH_AUTO_PROVISION;
    const email = `noauto-${suffix}@users-test.example`;
    try {
      expect(await resolveUser(email)).toBeNull();
      expect(await ctx.db.user.findUnique({ where: { email } })).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.AUTH_AUTO_PROVISION;
      else process.env.AUTH_AUTO_PROVISION = previous;
    }
  });
});

describe("journal attribution", () => {
  it("stamps actorId from the authenticated user on a journaled mutation", async () => {
    const caller = adminCaller(ctx.event);
    await caller.runner.create({
      name: "Attributed",
      classId: classSeq,
      clubName: "OK Test",
    });
    const entry = await ctx.db.journalEntry.findFirst({
      where: { eventId: ctx.eventId, type: "runner.registered" },
      orderBy: { hlc: "desc" },
    });
    expect(entry).not.toBeNull();
    expect(entry!.actorId).toBe(admin.id);
  });
});
