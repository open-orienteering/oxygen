/**
 * Presence and "moved by X at T" (slice D, row D11; docs/course-layer.md §7
 * "Presence and live refresh", docs/course-editor.md §11):
 *
 *   - course.presence upserts the caller's row and answers everyone else's
 *   - a row older than the 30 s TTL is neither shown nor kept
 *   - the heartbeat of one client id is one row, moving with its mode / course
 *   - a row goes with its course
 *   - control.lastChange names the actor and time of the control's last write
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { makeCaller } from "../helpers/caller.js";
import { PRESENCE_TTL_MS } from "../../course-presence.js";
import type { AuthUser } from "../../auth.js";

let ctx: TestEventContext;
let caller: ReturnType<typeof makeCaller>;
let a: number;
let b: number;

beforeAll(async () => {
  ctx = await createTestEvent("course_presence");
  caller = makeCaller(ctx.event);
  for (const [code, x] of [[31, 30], [32, 50]] as const) await caller.control.create({ codes: String(code), xpos: x, ypos: 20 });
  a = (await caller.course.create({ name: "Lång", controlIds: [31, 32] })).id;
  b = (await caller.course.create({ name: "Kort", controlIds: [31] })).id;
});

afterAll(async () => {
  await ctx.db.user.deleteMany({ where: { email: { endsWith: "@d11-presence.example" } } });
  await ctx.cleanup();
  await disconnect();
});

const backdate = (clientId: string, ms: number) =>
  ctx.db.coursePresence.updateMany({ where: { clientId }, data: { seenAt: new Date(Date.now() - ms) } });

describe("course.presence", () => {
  it("shows a client the others, never itself", async () => {
    const first = await caller.course.presence({ courseId: a, mode: "course", clientId: "tab-one" });
    expect(first.others).toEqual([]);
    expect(first.ttlMs).toBe(PRESENCE_TTL_MS);
    const second = await caller.course.presence({ courseId: a, mode: "field", clientId: "tab-two" });
    expect(second.others).toEqual([expect.objectContaining({ courseId: a, courseName: "Lång", mode: "course", name: "" })]);
    const again = await caller.course.presence({ courseId: a, mode: "course", clientId: "tab-one" });
    expect(again.others).toEqual([expect.objectContaining({ courseId: a, mode: "field" })]);
  });

  it("is one row per client: a new course or mode moves it", async () => {
    await caller.course.presence({ courseId: b, mode: "layout", clientId: "tab-one" });
    expect(await ctx.db.coursePresence.count({ where: { clientId: "tab-one" } })).toBe(1);
    const seen = await caller.course.presence({ courseId: a, mode: "field", clientId: "tab-two" });
    expect(seen.others).toEqual([expect.objectContaining({ courseId: b, courseName: "Kort", mode: "layout" })]);
  });

  it("expires after the TTL: hidden at read, swept by the next heartbeat", async () => {
    await backdate("tab-one", PRESENCE_TTL_MS + 1_000);
    const seen = await caller.course.presence({ courseId: a, mode: "field", clientId: "tab-two" });
    expect(seen.others).toEqual([]);
    expect(await ctx.db.coursePresence.count({ where: { clientId: "tab-one" } })).toBe(0);
  });

  it("keeps a row just inside the TTL", async () => {
    await caller.course.presence({ courseId: a, mode: "course", clientId: "tab-three" });
    await backdate("tab-three", PRESENCE_TTL_MS - 5_000);
    const seen = await caller.course.presence({ courseId: a, mode: "field", clientId: "tab-two" });
    expect(seen.others.map((o) => o.mode)).toEqual(["course"]);
  });

  it("names the signed-in user (display name, else email)", async () => {
    const user = await ctx.db.user.create({ data: { email: "anna@d11-presence.example", displayName: "Anna" } });
    const anna = makeCaller(ctx.event, { user: { id: user.id, email: user.email, displayName: "Anna", isAdmin: true, active: true } as AuthUser });
    await anna.course.presence({ courseId: b, mode: "course", clientId: "tab-anna" });
    const seen = await caller.course.presence({ courseId: a, mode: "field", clientId: "tab-two" });
    expect(seen.others.find((o) => o.courseId === b)).toMatchObject({ name: "Anna" });
  });

  it("goes with its course", async () => {
    const { id } = await caller.course.create({ name: "Temp", controlIds: [31] });
    await caller.course.presence({ courseId: id, mode: "course", clientId: "tab-temp" });
    await ctx.db.course.deleteMany({ where: { eventId: ctx.eventId, seq: id } });
    expect(await ctx.db.coursePresence.count({ where: { clientId: "tab-temp" } })).toBe(0);
  });

  it("refuses an unknown course", async () => {
    await expect(caller.course.presence({ courseId: 9999, mode: "course", clientId: "x-tab" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("control.lastChange", () => {
  it("names who last wrote the control and when", async () => {
    const user = await ctx.db.user.create({ data: { email: "bo@d11-presence.example", displayName: "Bo" } });
    const bo = makeCaller(ctx.event, { user: { id: user.id, email: user.email, displayName: "Bo", isAdmin: true, active: true } as AuthUser });
    const before = Date.now();
    await bo.control.update({ id: 32, xpos: 55, ypos: 21 });
    const last = await caller.control.lastChange({ id: 32 });
    expect(last?.name).toBe("Bo");
    expect(Math.abs(new Date(last!.at).getTime() - before)).toBeLessThan(10_000);
  });

  it("is null for a control nobody wrote through the API as a user, or unknown", async () => {
    expect((await caller.control.lastChange({ id: 31 }))?.name ?? "").toBe("");
  });
});
