/**
 * Authorisation sweep, signed-in edition (API-36, package 20).
 *
 * A member with no grant on a real event, in proxy mode, calls every
 * procedure with no input. Everything is refused FORBIDDEN (or UNAUTHORIZED)
 * except the procedures below, which are club-wide by design: any invited
 * user may use them (or they decide inside the handler). A new procedure that
 * a member can reach fails this test until it is gated or listed here with its
 * reason. The anonymous half is the unit test `router-auth-sweep.test.ts`.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "../../routers/index.js";
import { createCallerFactory } from "../../trpc.js";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";

const suffix = randomBytes(3).toString("hex");
const DOMAIN = `@auth-sweep-${suffix}.example`;

/** Club-wide for any invited user, or deciding inside the handler. */
const MEMBER_REACHABLE: Array<string | RegExp> = [
  // The signed-in user, and the selector's own per-event check.
  "users.me",
  "event.select",
  "competition.select",
  // Node secret or signed-in user, then a per-entry capability check.
  "events.push",
  // The map documents' own access rules (`requireDocument`).
  "mapImport.review",
  "mapImport.exportCrt",
  // The club's groups, event list and creation (a creator is granted Event admin on it).
  "permission.myCapabilities", // the caller's own capabilities on the selected event
  "permission.groups",
  "permission.clubGroups",
  "event.list",
  "event.create",
  "event.delete", // refuses inside the handler: no event.manage on the named event
  "competition.list",
  "competition.create",
  "competition.delete",
  // The club's map library, class presets and control series: club-wide data for any member.
  /^clubMap\./,
  /^classPreset\./,
  /^controlSeries\./,
  // Map import steps a member drives on their own uploads; each checks the document or job inside.
  "mapImport.status",
  "mapImport.decide",
  "mapImport.setColourOrder",
  "mapImport.setDeviation",
  "mapImport.importCrt",
  "mapImport.finalise",
  // Eventor browse (the key is club-wide; reads are for any member) and the trends built on it.
  "eventor.keyStatus",
  "eventor.getKey",
  "eventor.importEvent",
  "eventor.events",
  "eventor.searchEvents",
  "eventor.eventDetail",
  "eventor.fetchEntryHistory",
  /^registrationTrends\./,
  // Club names only; the DB load figure; a checkout checks event.manage / admin in its handler.
  "club.searchDirectory",
  "event.dbStatus",
  "competition.dbStatus",
  "lease.checkout",
];

const isListed = (path: string) => MEMBER_REACHABLE.some((e) => (typeof e === "string" ? e === path : e.test(path)));

let ctx: TestEventContext;
let member: { id: string; email: string; displayName: string; isAdmin: boolean; active: boolean };

beforeAll(async () => {
  process.env.SYNC_SHARED_SECRET = "test";
  ctx = await createTestEvent("auth_sweep");
  await ctx.db.event.update({ where: { id: ctx.eventId }, data: { date: new Date("2099-06-01T00:00:00Z") } });
  ctx.event.date = new Date("2099-06-01T00:00:00Z");
  member = await ctx.db.user.create({ data: { email: `member${DOMAIN}`, displayName: "Member", isAdmin: false, active: true } });
});

afterAll(async () => {
  await ctx.db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  await ctx.cleanup();
  await disconnect();
});

describe("router authorisation sweep (member without grants, AUTH_MODE=proxy)", () => {
  it("refuses every procedure except the club-wide ones", async () => {
    const caller = createCallerFactory(appRouter)({
      event: ctx.event,
      syncSecret: null,
      peerNodeId: null,
      user: member,
      identityEmail: member.email,
      authEnabled: true,
      authMode: "proxy",
      kioskKey: null,
      nodeForward: null,
    }) as unknown as Record<string, unknown>;
    const paths = Object.keys(appRouter._def.procedures).sort();
    const reached: string[] = [];
    for (const path of paths) {
      const fn = path.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], caller) as (input?: unknown) => Promise<unknown>;
      try {
        await Promise.race([fn(undefined), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), 5000))]);
        reached.push(path);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "FORBIDDEN" && code !== "UNAUTHORIZED") reached.push(path);
      }
    }
    expect(reached.filter((p) => !isListed(p))).toEqual([]);
    // The list stays honest: nothing on it that no longer exists.
    for (const entry of MEMBER_REACHABLE) {
      const hit = typeof entry === "string" ? paths.includes(entry) : paths.some((p) => entry.test(p));
      expect(hit, String(entry)).toBe(true);
    }
  }, 180_000);
});
