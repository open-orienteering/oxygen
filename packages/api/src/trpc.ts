import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma, resolveEvent, type EventRef } from "./db.js";
import {
  SYNC_SECRET_HEADER,
  syncSharedSecret,
} from "./sync/nodeIdentity.js";
import { assertRaceWritable } from "./sync/lease.js";
import {
  authDevEmail,
  authHeaderName,
  authMode,
  parseIdentityEmail,
  resolveUser,
  runWithActor,
  type AuthMode,
  type AuthUser,
} from "./auth.js";
import type { Capability } from "@oxygen/shared";
import { ALL_CAPABILITIES } from "@oxygen/shared";
import { resolveEventCapabilities } from "./permissions.js";
import { timingSafeEqual } from "node:crypto";

export const KIOSK_KEY_HEADER = "x-kiosk-key";

/** Context available to all tRPC procedures. */
export interface Context {
  /** Resolved active event from the x-competition-id header, or null. */
  event: EventRef | null;
  /** Node-to-node shared secret from the request, if any (see peerProcedure). */
  syncSecret?: string | null;
  /** Invited user matching the proxy identity, or null. */
  user: AuthUser | null;
  /** Parsed identity email even when the user is not invited. */
  identityEmail: string | null;
  /** True when AUTH_MODE is proxy or dev. */
  authEnabled: boolean;
  authMode: AuthMode;
  /** Device token from `x-kiosk-key` / `?k=`. */
  kioskKey: string | null;
}

/**
 * Build the per-request context. The header is `x-competition-id` for
 * backwards compatibility with the running web clients during the
 * MeOS → Postgres cutover; the next major release renames it to
 * `x-event-id`.
 */
export async function createContext(
  opts: CreateFastifyContextOptions,
): Promise<Context> {
  const raw =
    opts.req.headers["x-event-id"] ?? opts.req.headers["x-competition-id"];
  const nameId = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  const event = nameId ? await resolveEvent(nameId) : null;
  const secretRaw = opts.req.headers[SYNC_SECRET_HEADER];
  const syncSecret = (Array.isArray(secretRaw) ? secretRaw[0] : secretRaw) ?? null;
  const kioskRaw = opts.req.headers[KIOSK_KEY_HEADER];
  const kioskKey = (Array.isArray(kioskRaw) ? kioskRaw[0] : kioskRaw)?.trim() || null;

  const mode = authMode();
  const enabled = mode !== "off";
  let identityEmail: string | null = null;
  let user: AuthUser | null = null;

  if (mode === "proxy") {
    identityEmail = parseIdentityEmail(opts.req.headers[authHeaderName()]);
    if (identityEmail) user = await resolveUser(identityEmail);
  } else if (mode === "dev") {
    identityEmail = parseIdentityEmail(authDevEmail()) ?? "dev@localhost";
    user = await resolveUser(identityEmail, { implicitAdmin: true });
  }

  return {
    event,
    syncSecret,
    user,
    identityEmail,
    authEnabled: enabled,
    authMode: mode,
    kioskKey,
  };
}

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure.use(async ({ path, next }) => {
  const result = await next();
  if (!result.ok) {
    console.error(`[tRPC ERROR] ${path}:`, result.error);
  }
  return result;
});

/** Require an invited user when AUTH_MODE is on; pass through when off. */
export const authedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (ctx.authEnabled && !ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Not authenticated",
    });
  }
  return runWithActor(ctx.user?.id ?? null, () => next());
});

/** Authed, and an instance admin when AUTH_MODE is on. */
export const adminProcedure = authedProcedure.use(async ({ ctx, next }) => {
  if (ctx.authEnabled && !ctx.user?.isAdmin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }
  return next();
});

/** Context shape inside an eventProcedure handler. */
export interface EventContext extends Context {
  event: EventRef;
  db: PrismaClient;
  capabilities?: Set<Capability>;
}

const requireEvent = middleware(async ({ ctx, next }) => {
  if (!ctx.event) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "No event selected (missing or unresolved x-event-id / x-competition-id header)",
    });
  }
  return next({
    ctx: { ...ctx, event: ctx.event, db: prisma() } as EventContext,
  });
});

/**
 * Base procedure for all event-scoped operations.
 * Resolves the active event from the request header; injects `ctx.event`
 * (the resolved row) and `ctx.db` (the singleton Prisma client).
 * Throws BAD_REQUEST if no event is identified, NOT_FOUND if the slug
 * doesn't resolve.
 *
 * Chains authedProcedure: when AUTH_MODE is on, a known invited user is
 * required. Peer-to-peer journal shipping uses `peerProcedure` instead.
 */
export const eventProcedure = authedProcedure.use(requireEvent);

/**
 * Event-scoped procedure for race-critical mutations (the journaled set).
 * Adds the single-writer lease guard: when the event is checked out to
 * another node, the mutation fails with a typed PRECONDITION_FAILED before
 * any write happens. `events.push` is NOT guarded — it is the journal
 * ingestion sink and must accept shipped/drained entries on every node.
 */
export const raceProcedure = eventProcedure.use(async ({ ctx, next }) => {
  const ectx = ctx as EventContext;
  await assertRaceWritable(ectx.db, ectx.event.id);
  return next();
});

/**
 * Event-scoped procedure reserved for node-to-node calls (journal shipping).
 * Requires `SYNC_SHARED_SECRET` to be configured on this node AND presented
 * by the caller in the `x-oxygen-sync-secret` header. Without a configured
 * secret every call is refused — peering is opt-in.
 *
 * Does not require a human user — machine identity is the shared secret.
 */
export const peerProcedure = publicProcedure.use(requireEvent).use(async ({ ctx, next }) => {
  const expected = syncSharedSecret();
  if (!expected) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Node-to-node sync is not configured on this node (no SYNC_SHARED_SECRET)",
    });
  }
  if (ctx.syncSecret !== expected) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid or missing node sync secret",
    });
  }
  return next();
});

export function kioskKeyMatches(
  presented: string | null | undefined,
  stored: string | null | undefined,
): boolean {
  if (!presented || !stored) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function eventDateFor(
  ctx: EventContext,
): Promise<Date> {
  if (ctx.event.date) return ctx.event.date;
  const row = await ctx.db.event.findUnique({
    where: { id: ctx.event.id },
    select: { date: true },
  });
  return row?.date ?? new Date(0);
}

export async function capabilitiesForContext(
  ctx: EventContext,
): Promise<Set<Capability>> {
  const date = await eventDateFor(ctx);
  return resolveEventCapabilities({
    db: ctx.db,
    eventId: ctx.event.id,
    eventDate: date,
    user: ctx.user,
    authEnabled: ctx.authEnabled,
  });
}

function requireCapability(cap: Capability) {
  return middleware(async ({ ctx, next }) => {
    const ectx = ctx as EventContext;
    const caps = await capabilitiesForContext(ectx);
    if (!caps.has(cap)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Missing capability ${cap}`,
      });
    }
    return next({ ctx: { ...ectx, capabilities: caps } });
  });
}

/**
 * Event-scoped, not user-gated. Allowed when AUTH_MODE=off, a valid kiosk
 * key is presented, or the invited user holds `cap`.
 */
export function kioskOrCapProcedure(cap: Capability) {
  return publicProcedure.use(requireEvent).use(async ({ ctx, next }) => {
    const ectx = ctx as EventContext;
    if (!ectx.authEnabled) {
      return next({
        ctx: { ...ectx, capabilities: new Set(ALL_CAPABILITIES) },
      });
    }
    const stored = ectx.event.kioskKey ?? null;
    if (kioskKeyMatches(ectx.kioskKey, stored)) {
      return next({
        ctx: { ...ectx, capabilities: new Set([cap]) },
      });
    }
    if (!ectx.user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Not authenticated",
      });
    }
    const caps = await capabilitiesForContext(ectx);
    if (!caps.has(cap)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Missing capability ${cap}`,
      });
    }
    return next({ ctx: { ...ectx, capabilities: caps } });
  });
}

export const viewProcedure = eventProcedure.use(requireCapability("event.view"));
export const manageProcedure = eventProcedure.use(requireCapability("event.manage"));
export const manageRaceProcedure = raceProcedure.use(requireCapability("event.manage"));
export const coursesViewProcedure = eventProcedure.use(requireCapability("courses.view"));
export const coursesEditProcedure = eventProcedure.use(
  requireCapability("courses.edit"),
);
export const coursesEditRaceProcedure = raceProcedure.use(
  requireCapability("courses.edit"),
);
export const raceOperateProcedure = eventProcedure.use(
  requireCapability("race.operate"),
);
export const raceOperateRaceProcedure = raceProcedure.use(
  requireCapability("race.operate"),
);
export const resultsViewProcedure = eventProcedure.use(
  requireCapability("results.view"),
);
export const kioskOrViewProcedure = kioskOrCapProcedure("event.view");
/**
 * Read-only course/map data. Kiosk-key devices need these for the
 * post-readout course map (MapPanel), mirroring the REST map-tile rule
 * that treats a kiosk key as sufficient for map access.
 */
export const kioskOrCoursesViewProcedure = kioskOrCapProcedure("courses.view");
export const kioskOrRaceOperateProcedure = kioskOrCapProcedure("race.operate");
export const kioskOrRaceOperateRaceProcedure = kioskOrCapProcedure(
  "race.operate",
).use(async ({ ctx, next }) => {
  const ectx = ctx as EventContext;
  await assertRaceWritable(ectx.db, ectx.event.id);
  return next();
});
