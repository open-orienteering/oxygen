import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "crypto";
import {
  createTestEvent,
  disconnect,
  type TestEventContext,
} from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { SYSTEM_GROUP_IDS } from "@oxygen/shared";
import { grantSystemGroup } from "../../permissions.js";
import type { AuthUser } from "../../auth.js";
import { RunnerStatus } from "@oxygen/shared";
import { valueToRunnerStatus } from "../../statusConvert.js";

const suffix = randomBytes(4).toString("hex");

let ctx: TestEventContext;
let admin: AuthUser;
let setter: AuthUser;
let member: AuthUser;
let crew: AuthUser;

function asUser(row: {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  active: boolean;
}): AuthUser {
  return row;
}

function callerFor(user: AuthUser, event = ctx.event, extra: { kioskKey?: string | null } = {}) {
  return makeCaller(event, {
    user,
    authEnabled: true,
    identityEmail: user.email,
    kioskKey: extra.kioskKey ?? null,
  });
}

beforeAll(async () => {
  ctx = await createTestEvent("perms");
  await ctx.db.event.update({
    where: { id: ctx.eventId },
    data: { date: new Date("2099-06-15") },
  });
  ctx.event = { ...ctx.event, date: new Date("2099-06-15") };

  const mk = async (email: string, isAdmin: boolean) =>
    asUser(
      await ctx.db.user.create({
        data: {
          email: `${email}-${suffix}@perms-test.example`,
          displayName: email,
          isAdmin,
          active: true,
        },
      }),
    );
  admin = await mk("admin", true);
  setter = await mk("setter", false);
  member = await mk("member", false);
  crew = await mk("crew", false);

  await grantSystemGroup(ctx.db, {
    eventId: ctx.eventId,
    userId: setter.id,
    groupId: SYSTEM_GROUP_IDS.courseSetter,
    grantedBy: admin.id,
  });
  await grantSystemGroup(ctx.db, {
    eventId: ctx.eventId,
    userId: member.id,
    groupId: SYSTEM_GROUP_IDS.member,
    grantedBy: admin.id,
  });
  await grantSystemGroup(ctx.db, {
    eventId: ctx.eventId,
    userId: crew.id,
    groupId: SYSTEM_GROUP_IDS.raceCrew,
    grantedBy: admin.id,
  });
});

afterAll(async () => {
  await ctx.db.user.deleteMany({
    where: { email: { endsWith: "@perms-test.example" } },
  });
  await ctx.cleanup();
  await disconnect();
});

describe("event type permissions", () => {
  it("allows event managers and rejects users without event.manage", async () => {
    await expect(
      callerFor(setter).event.updateType({ kind: "training" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const updated = await callerFor(admin).event.updateType({
      kind: "other",
      kindCustom: "Night cup",
    });
    expect(updated).toMatchObject({ kind: "other", kindCustom: "Night cup" });
  });
});

describe("permission grant/revoke", () => {
  it("grant → list → revoke", async () => {
    const email = `extra-${suffix}@perms-test.example`;
    await ctx.db.user.create({
      data: { email, displayName: "Extra", isAdmin: false, active: true },
    });
    const c = callerFor(admin);
    await c.permission.grant({
      userEmail: email,
      groupId: SYSTEM_GROUP_IDS.member,
    });
    const grants = await c.permission.listGrants();
    const found = grants.find((g) => g.userEmail === email);
    expect(found?.groupName).toBe("Member");
    await c.permission.revoke({ grantId: found!.id });
    const after = await c.permission.listGrants();
    expect(after.some((g) => g.userEmail === email)).toBe(false);
  });

  it("grant to an uninvited email is NOT_FOUND", async () => {
    await expect(
      callerFor(admin).permission.grant({
        userEmail: `nobody-${suffix}@nope.example`,
        groupId: SYSTEM_GROUP_IDS.member,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("club user groups", () => {
  it("invites an unknown email and then adds it to a group", async () => {
    const c = callerFor(admin);
    const email = `inline-invite-${suffix}@perms-test.example`;
    const group = await c.permission.createClubGroup({
      name: `Inline invite-${suffix}`,
    });
    try {
      await expect(
        c.permission.addClubGroupMember({
          groupId: group.id,
          userEmail: email,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      await c.users.invite({ email });
      await c.permission.addClubGroupMember({
        groupId: group.id,
        userEmail: email,
      });

      const listed = await c.permission.clubGroups();
      expect(
        listed.find((candidate) => candidate.id === group.id)?.members,
      ).toEqual([
        expect.objectContaining({
          email,
        }),
      ]);
    } finally {
      await c.permission.deleteClubGroup({ id: group.id });
    }
  });

  it("create group → add member → grant role → member gets capabilities", async () => {
    const c = callerFor(admin);
    const group = await c.permission.createClubGroup({
      name: `Trainers-${suffix}`,
    });

    await c.permission.addClubGroupMember({
      groupId: group.id,
      userEmail: crew.email,
    });
    const listed = await c.permission.clubGroups();
    const mine = listed.find((g) => g.id === group.id);
    expect(mine?.members.map((m) => m.email)).toEqual([crew.email]);

    // Crew has no courses.edit — the group grant must add it.
    await expect(callerFor(crew).course.create({ name: "GX" })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    await c.permission.grant({
      clubGroupId: group.id,
      groupId: SYSTEM_GROUP_IDS.courseSetter,
    });
    const created = await callerFor(crew).course.create({ name: "GX" });
    expect(created.id).toBeGreaterThan(0);

    // Grant shows up with subjectType clubGroup + member count.
    const grants = await c.permission.listGrants();
    const row = grants.find((g) => g.clubGroupId === group.id);
    expect(row?.subjectType).toBe("clubGroup");
    expect(row?.clubGroupName).toBe(`Trainers-${suffix}`);
    expect(row?.clubGroupMemberCount).toBe(1);

    // Removing the member takes the capability away immediately.
    const userId = mine!.members[0].userId;
    await c.permission.removeClubGroupMember({ groupId: group.id, userId });
    await expect(callerFor(crew).course.create({ name: "GY" })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );

    // Re-add, then delete the whole group: grant cascades away.
    await c.permission.addClubGroupMember({
      groupId: group.id,
      userEmail: crew.email,
    });
    await c.permission.deleteClubGroup({ id: group.id });
    const after = await c.permission.listGrants();
    expect(after.some((g) => g.clubGroupId === group.id)).toBe(false);
    await expect(callerFor(crew).course.create({ name: "GZ" })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
  });

  it("group grants make events visible in competition.list", async () => {
    const c = callerFor(admin);
    const group = await c.permission.createClubGroup({
      name: `Visibility-${suffix}`,
    });
    try {
      await c.permission.addClubGroupMember({
        groupId: group.id,
        userEmail: crew.email,
      });
      const other = await createTestEvent("perms-vis");
      await other.db.event.update({
        where: { id: other.eventId },
        data: { date: new Date("2099-07-01") },
      });
      try {
        const before = await callerFor(crew, null).competition.list();
        expect(before.some((e) => e.nameId === other.nameId)).toBe(false);
        await callerFor(admin, other.event).permission.grant({
          clubGroupId: group.id,
          groupId: SYSTEM_GROUP_IDS.member,
        });
        const afterList = await callerFor(crew, null).competition.list();
        expect(afterList.some((e) => e.nameId === other.nameId)).toBe(true);
      } finally {
        await other.cleanup();
      }
    } finally {
      await c.permission.deleteClubGroup({ id: group.id });
    }
  });

  it("group management is admin-only; duplicate names conflict", async () => {
    await expect(
      callerFor(setter).permission.createClubGroup({ name: "Nope" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const c = callerFor(admin);
    const g = await c.permission.createClubGroup({ name: `Dup-${suffix}` });
    try {
      await expect(
        c.permission.createClubGroup({ name: `Dup-${suffix}` }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        callerFor(setter).permission.addClubGroupMember({
          groupId: g.id,
          userEmail: member.email,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await c.permission.deleteClubGroup({ id: g.id });
    }
  });

  it("granting the same group twice is idempotent", async () => {
    const c = callerFor(admin);
    const g = await c.permission.createClubGroup({ name: `Idem-${suffix}` });
    try {
      await c.permission.grant({
        clubGroupId: g.id,
        groupId: SYSTEM_GROUP_IDS.member,
      });
      await c.permission.grant({
        clubGroupId: g.id,
        groupId: SYSTEM_GROUP_IDS.member,
      });
      const grants = await c.permission.listGrants();
      expect(grants.filter((r) => r.clubGroupId === g.id)).toHaveLength(1);
    } finally {
      await c.permission.deleteClubGroup({ id: g.id });
    }
  });
});

describe("enforcement matrix", () => {
  it("member can read classes but not mutate them", async () => {
    const list = await callerFor(member).class.list();
    expect(Array.isArray(list)).toBe(true);
    await expect(
      callerFor(member).class.create({ name: "H21" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("course setter can read and edit courses; member cannot read pre-race", async () => {
    const created = await callerFor(setter).course.create({ name: "A", length: 1000 });
    expect(created.id).toBeGreaterThan(0);
    const listed = await callerFor(setter).course.list();
    expect(listed.some((c) => c.id === created.id)).toBe(true);
    await expect(callerFor(member).course.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("member can read courses after the race completes", async () => {
    await ctx.db.event.update({
      where: { id: ctx.eventId },
      data: { date: new Date("2020-01-01") },
    });
    ctx.event = { ...ctx.event, date: new Date("2020-01-01") };
    const cls = await callerFor(admin).class.create({ name: "D21" });
    await callerFor(admin).runner.create({
      name: "Finisher",
      classId: cls.id,
      clubName: "OK",
    });
    const runner = await ctx.db.runner.findFirst({
      where: { eventId: ctx.eventId, name: "Finisher" },
    });
    await ctx.db.runner.update({
      where: { id: runner!.id },
      data: {
        status: valueToRunnerStatus(RunnerStatus.OK),
        finishTime: 36000,
      },
    });
    const listed = await callerFor(member).course.list();
    expect(Array.isArray(listed)).toBe(true);
    // Restore future date for subsequent kiosk tests on this event.
    await ctx.db.event.update({
      where: { id: ctx.eventId },
      data: { date: new Date("2099-06-15") },
    });
    ctx.event = { ...ctx.event, date: new Date("2099-06-15") };
  });

  it("race crew can list cards; course setter cannot", async () => {
    const cards = await callerFor(crew).cardReadout.cardList();
    expect(Array.isArray(cards)).toBe(true);
    await expect(callerFor(setter).cardReadout.cardList()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("competition.list filtering and create grant", () => {
  it("non-admin only sees events they can access; admin sees all", async () => {
    const other = await createTestEvent("perms-other");
    await other.db.event.update({
      where: { id: other.eventId },
      data: { date: new Date("2099-07-01") },
    });
    try {
      const memberList = await callerFor(member, null).competition.list();
      expect(memberList.some((e) => e.nameId === ctx.nameId)).toBe(true);
      expect(memberList.some((e) => e.nameId === other.nameId)).toBe(false);
      const adminList = await callerFor(admin, null).competition.list();
      expect(adminList.some((e) => e.nameId === ctx.nameId)).toBe(true);
      expect(adminList.some((e) => e.nameId === other.nameId)).toBe(true);
    } finally {
      await other.cleanup();
    }
  });

  it("creator is auto-granted Event admin", async () => {
    const created = await callerFor(member, null).competition.create({
      name: "Owned",
      nameId: `oxygen_test_owned_${suffix}`,
      date: "2099-08-01",
    });
    const grants = await ctx.db.eventPermission.findMany({
      where: {
        userId: member.id,
        groupId: SYSTEM_GROUP_IDS.eventAdmin,
      },
    });
    const row = await ctx.db.event.findUnique({ where: { nameId: created.nameId } });
    expect(grants.some((g) => g.eventId === row!.id)).toBe(true);
    await ctx.db.event.delete({ where: { id: row!.id } });
  });

  it("lists the original event admin grant as the event owner", async () => {
    const created = await callerFor(member, null).competition.create({
      name: "Owned with collaborator",
      nameId: `oxygen_test_owner_${suffix}`,
      date: "2099-08-02",
    });
    const event = await ctx.db.event.findUniqueOrThrow({
      where: { nameId: created.nameId },
    });
    try {
      await grantSystemGroup(ctx.db, {
        eventId: event.id,
        userId: setter.id,
        groupId: SYSTEM_GROUP_IDS.eventAdmin,
        grantedBy: admin.id,
      });

      const listed = await callerFor(admin, null).competition.list();
      expect(listed.find((candidate) => candidate.id === Number(event.id))?.owner).toBe(
        member.displayName,
      );
    } finally {
      await ctx.db.event.delete({ where: { id: event.id } });
    }
  });
});

describe("kiosk key", () => {
  it("allows dashboard with the correct key and rejects a wrong key", async () => {
    const key = "kiosk-secret-token-aaaa";
    await ctx.db.event.update({
      where: { id: ctx.eventId },
      data: { kioskKey: key },
    });
    const event = { ...ctx.event, kioskKey: key };
    const ok = makeCaller(event, {
      user: null,
      authEnabled: true,
      identityEmail: null,
      kioskKey: key,
    });
    const dash = await ok.competition.dashboard();
    expect(dash.competition.nameId).toBe(ctx.nameId);

    const bad = makeCaller(event, {
      user: null,
      authEnabled: true,
      identityEmail: null,
      kioskKey: "wrong-key-wrong-key-wrong",
    });
    await expect(bad.competition.dashboard()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("key-only devices can read the map data set MapPanel needs, but not edit", async () => {
    // The kiosk shows the runner's course on the map after a readout —
    // all of MapPanel's queries must accept a kiosk key (mirrors the
    // REST map-tile rule).
    const key = "kiosk-secret-token-bbbb";
    await ctx.db.event.update({
      where: { id: ctx.eventId },
      data: { kioskKey: key },
    });
    const event = { ...ctx.event, kioskKey: key };
    const kiosk = makeCaller(event, {
      user: null,
      authEnabled: true,
      identityEmail: null,
      kioskKey: key,
    });

    expect(Array.isArray(await kiosk.course.list())).toBe(true);
    expect(Array.isArray(await kiosk.course.controlCoordinates())).toBe(true);
    expect(Array.isArray(await kiosk.class.list())).toBe(true);
    // May be null (no map uploaded in this suite) — must not throw.
    await kiosk.course.mapMetadata();
    await kiosk.course.mapFileInfo();
    await kiosk.course.courseGeometries({ courseNames: [] });

    // The key grants reads only — mutations still need an invited user.
    await expect(
      kiosk.course.create({ name: "KioskNope" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const wrong = makeCaller(event, {
      user: null,
      authEnabled: true,
      identityEmail: null,
      kioskKey: "wrong-key-wrong-key-wrong",
    });
    await expect(wrong.course.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
