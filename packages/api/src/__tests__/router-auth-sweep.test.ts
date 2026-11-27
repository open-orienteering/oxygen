/**
 * Authorisation sweep over every tRPC procedure (API-36, package 20).
 *
 * With AUTH_MODE=proxy an anonymous caller must be refused (UNAUTHORIZED or
 * FORBIDDEN) by every procedure except the ones listed in `ANONYMOUS_OK`,
 * each of which decides inside its handler. A new `publicProcedure` therefore
 * fails this test until someone writes down why it is public.
 *
 * The database is unreachable here, so a procedure that is not gated either
 * answers something else quickly (validation, a refusal of its own) or fails
 * on the connection; both count as "not gated by authentication".
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { EventRef } from "../db.js";

process.env.SYNC_SHARED_SECRET = "test";
process.env.DATABASE_URL = "postgresql://nobody:nobody@127.0.0.1:1/none";

/** Procedures an anonymous caller may reach, each with its own check. */
const ANONYMOUS_OK = [
  // The signed-in user, or null (the login screen's first question).
  "users.me",
  // Decide inside the handler: selecting an event the caller has no grant on answers FORBIDDEN, no event answers NOT_FOUND.
  "event.select",
  "competition.select",
  // Node secret or signed-in user, then a per-entry capability check (journal ingestion).
  "events.push",
  // Check the document through `requireDocument` (map-access rules: a kiosk key or a user).
  "mapImport.review",
  "mapImport.exportCrt",
];

const FAKE_EVENT: EventRef = {
  id: 1n,
  nameId: "sweep",
  zeroTime: 324000,
  timeZone: "Europe/Stockholm",
  date: new Date("2030-06-01T00:00:00Z"),
  kioskKey: null,
};

type Outcome = "gated" | "ungated";

const TIMEOUT = Symbol("timeout");

describe("router authorisation sweep (anonymous, AUTH_MODE=proxy)", () => {
  let paths: string[];
  let callerFor: (ctx: unknown) => Record<string, unknown>;

  beforeAll(async () => {
    const { appRouter } = await import("../routers/index.js");
    const { createCallerFactory } = await import("../trpc.js");
    paths = Object.keys(appRouter._def.procedures).sort();
    callerFor = createCallerFactory(appRouter) as unknown as (ctx: unknown) => Record<string, unknown>;
  });

  const baseCtx = {
    event: FAKE_EVENT,
    syncSecret: null,
    peerNodeId: null,
    user: null,
    identityEmail: null,
    authEnabled: true,
    authMode: "proxy" as const,
    kioskKey: null,
    nodeForward: null,
  };

  async function call(ctx: unknown, path: string): Promise<{ outcome: Outcome; code?: string; message?: string }> {
    const caller = callerFor(ctx);
    const fn = path.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], caller) as (input?: unknown) => Promise<unknown>;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), 2000);
    });
    try {
      const result = await Promise.race([fn(undefined).then(() => "ok" as const), timeout]);
      return { outcome: "ungated", code: result === TIMEOUT ? "TIMEOUT" : "OK" };
    } catch (err) {
      const { code = "ERROR", message = "" } = err as { code?: string; message?: string };
      return { outcome: code === "UNAUTHORIZED" || code === "FORBIDDEN" ? "gated" : "ungated", code, message };
    } finally {
      clearTimeout(timer);
    }
  }

  it("lists a plausible number of procedures", () => {
    expect(paths.length).toBeGreaterThan(300);
  });

  it("refuses every procedure to an anonymous caller except the allowlist", async () => {
    const ungated: string[] = [];
    for (const path of paths) {
      const r = await call(baseCtx, path);
      if (r.outcome === "ungated") ungated.push(path);
    }
    expect(ungated).toEqual([...ANONYMOUS_OK].sort());
  }, 120_000);

  it("keeps every allowlist entry real", () => {
    for (const path of ANONYMOUS_OK) expect(paths, path).toContain(path);
  });

  it("never lets a forwarded node call into an adminProcedure", async () => {
    // adminProcedure refuses a signed-in non-admin with this message before anything else runs.
    const nonAdmin = { ...baseCtx, user: { id: "u1", email: "a@b.c", displayName: "A", isAdmin: false } };
    const adminPaths: string[] = [];
    for (const path of paths) {
      const r = await call(nonAdmin, path);
      if (r.code === "FORBIDDEN" && r.message === "Admin access required") adminPaths.push(path);
    }
    expect(adminPaths).toEqual(expect.arrayContaining(["eventor.setKey", "eventor.clearKey"]));

    // A node-forwarded call has no user: authed-level, never admin.
    const forwarded = { ...baseCtx, nodeForward: { nodeId: "venue-1" } };
    for (const path of adminPaths) {
      const r = await call(forwarded, path);
      expect(r, path).toMatchObject({ code: "FORBIDDEN", message: "Admin access required" });
    }
  }, 120_000);
});
