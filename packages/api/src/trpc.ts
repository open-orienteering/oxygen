import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { PrismaClient } from "./generated/prisma/client.js";
import { prisma, resolveEvent, type EventRef } from "./db.js";
import {
  SYNC_SECRET_HEADER,
  SYNC_NODE_ID_HEADER,
  SYNC_FORWARDED_CAPS_HEADER,
  SYNC_FORWARDED_HEADER,
  nodeId,
  syncSharedSecret,
} from "./sync/nodeIdentity.js";
import { assertRaceWritable, getActiveLease } from "./sync/lease.js";
import { VersionConflictError } from "./version-conflict.js";
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
import { ALL_CAPABILITIES, isCapability } from "@oxygen/shared";
import { resolveEventCapabilities } from "./permissions.js";
import { timingSafeEqual } from "node:crypto";

export const KIOSK_KEY_HEADER = "x-kiosk-key";

/** Context available to all tRPC procedures. */
export interface Context {
  /** Resolved active event from the x-competition-id header, or null. */
  event: EventRef | null;
  /** Node-to-node shared secret from the request, if any (see peerProcedure). */
  syncSecret?: string | null;
  /** `NODE_ID` the calling peer announced (`x-oxygen-node-id`), if any. */
  peerNodeId?: string | null;
  /** Invited user matching the proxy identity, or null. */
  user: AuthUser | null;
  /** Parsed identity email even when the user is not invited. */
  identityEmail: string | null;
  /** True when AUTH_MODE is proxy or dev. */
  authEnabled: boolean;
  authMode: AuthMode;
  /** Device token from `x-kiosk-key` / `?k=`. */
  kioskKey: string | null;
  /**
   * Set when a venue forwarded this call (`x-oxygen-forwarded`) with this
   * node's secret: the call runs as that node, not as a user. It passes
   * `authedProcedure`, never `adminProcedure`, and holds capabilities only
   * on an event whose active lease the node holds (`capabilitiesForEventRow`).
   * Null for every other request, including a marked one with a wrong secret.
   */
  nodeForward?: { nodeId: string | null } | null;
  /**
   * The capabilities the forwarding box vouched for (`x-oxygen-forwarded-caps`:
   * a list, `*` or `none`), only on a `nodeForward` call; an absent header is
   * the empty set. Null on every other request.
   */
  forwardedCaps?: Set<Capability> | null;
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
  const first = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h) || "";
  // `||`: an empty x-event-id does not shadow x-competition-id.
  const nameId = first(opts.req.headers["x-event-id"]) || first(opts.req.headers["x-competition-id"]);
  const event = nameId ? await resolveEvent(nameId) : null;
  const secretRaw = opts.req.headers[SYNC_SECRET_HEADER];
  const syncSecret = (Array.isArray(secretRaw) ? secretRaw[0] : secretRaw) ?? null;
  const peerRaw = opts.req.headers[SYNC_NODE_ID_HEADER];
  const peerNodeId = (Array.isArray(peerRaw) ? peerRaw[0] : peerRaw)?.trim() || null;
  const kioskRaw = opts.req.headers[KIOSK_KEY_HEADER];
  const kioskKey = (Array.isArray(kioskRaw) ? kioskRaw[0] : kioskRaw)?.trim() || null;

  const mode = authMode();
  const enabled = mode !== "off";
  let identityEmail: string | null = null;
  let user: AuthUser | null = null;
  // A venue's forwarded call is the node, never a user: whatever identity
  // header rides along is ignored, and a marker without the node secret
  // leaves the caller anonymous (UNAUTHORIZED), not a user by their header.
  const forwarded = opts.req.headers[SYNC_FORWARDED_HEADER] !== undefined;
  // The peer must name itself, and not as this node: a forward that claims
  // the cloud's own id (or none) is treated as anonymous.
  const nodeForward =
    forwarded && syncSecretMatches(syncSecret) && peerNodeId && peerNodeId !== nodeId()
      ? { nodeId: peerNodeId }
      : null;

  const capsRaw = opts.req.headers[SYNC_FORWARDED_CAPS_HEADER];
  const capsHeader = Array.isArray(capsRaw) ? capsRaw[0] : capsRaw;
  // Fail closed: a forward without the header holds nothing; `*` (a box with login off) is every capability, `none` none.
  const forwardedCaps = nodeForward
    ? capsHeader?.trim() === "*"
      ? new Set<Capability>(ALL_CAPABILITIES)
      : new Set((capsHeader ?? "").split(",").map((c) => c.trim()).filter(isCapability))
    : null;

  if (mode === "proxy") {
    if (!forwarded) {
      identityEmail = parseIdentityEmail(opts.req.headers[authHeaderName()]);
      if (identityEmail) user = await resolveUser(identityEmail);
    }
  } else if (mode === "dev") {
    identityEmail = parseIdentityEmail(authDevEmail()) ?? "dev@localhost";
    user = await resolveUser(identityEmail, { implicitAdmin: true });
  }

  return {
    event,
    syncSecret,
    peerNodeId,
    user,
    identityEmail,
    authEnabled: enabled,
    authMode: mode,
    kioskKey,
    nodeForward,
    forwardedCaps,
  };
}

/**
 * A stale `baseVersion` (version-conflict.ts) answers CONFLICT with the
 * server's row in `data` (docs/course-layer.md §7); every other error keeps
 * tRPC's default shape.
 */
export function withVersionConflict<S extends { data: object }>(shape: S, error: TRPCError): S {
  if (error.cause instanceof VersionConflictError) {
    return { ...shape, data: { ...shape.data, ...error.cause.data } };
  }
  return shape;
}

const t = initTRPC.context<Context>().create({
  errorFormatter: ({ shape, error }) => withVersionConflict(shape, error),
});

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
  if (ctx.authEnabled && !ctx.user && !ctx.nodeForward) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Not authenticated",
    });
  }
  return runWithActor(ctx.user?.id ?? null, () => next());
});

/**
 * Authed, and an instance admin when AUTH_MODE is on. A forwarded node call
 * has no user, so it is never admin.
 */
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
 * any write happens. `events.push` is NOT guarded and is not an
 * `eventProcedure` at all (`publicEventProcedure`: node secret or signed-in
 * user, then a per-entry capability check) — it is the journal ingestion
 * sink and must accept shipped/drained entries on every node.
 */
export const raceProcedure = eventProcedure.use(async ({ ctx, next }) => {
  const ectx = ctx as EventContext;
  await assertRaceWritable(ectx.db, ectx.event.id);
  return next();
});

/**
 * Event-scoped, no user gate: the base of procedures that decide their own
 * authentication (`events.push`: node secret or signed-in user; the kiosk
 * variants). Unlike `eventProcedure` it does not chain `authedProcedure`, so
 * a request authenticated only by the node secret passes on an invite-only
 * node.
 */
export const publicEventProcedure = publicProcedure.use(requireEvent);

/**
 * Whether a presented node secret equals this node's `SYNC_SHARED_SECRET`
 * (length check, then `timingSafeEqual`, like `kioskKeyMatches`). False when
 * either side is empty.
 */
export function syncSecretMatches(
  presented: string | null | undefined,
  expected: string | null | undefined = syncSharedSecret(),
): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The node-secret check shared by `peerProcedure` and `events.push`. Throws
 * `PRECONDITION_FAILED` when this node has no `SYNC_SHARED_SECRET` (peering
 * is opt-in) and `UNAUTHORIZED` when the presented secret is wrong.
 */
export function assertNodeSecret(presented: string | null | undefined): void {
  const expected = syncSharedSecret();
  if (!expected) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Node-to-node sync is not configured on this node (no SYNC_SHARED_SECRET)",
    });
  }
  if (!syncSecretMatches(presented, expected)) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid or missing node sync secret",
    });
  }
}

/**
 * Event-scoped procedure reserved for node-to-node calls (journal pull).
 * Requires `SYNC_SHARED_SECRET` to be configured on this node AND presented
 * by the caller in the `x-oxygen-sync-secret` header. Without a configured
 * secret every call is refused — peering is opt-in.
 *
 * Does not require a human user — machine identity is the shared secret.
 * `events.push` accepts the same secret as an alternative to a signed-in
 * user (see `assertNodeSecret`).
 */
export const peerProcedure = publicEventProcedure.use(async ({ ctx, next }) => {
  assertNodeSecret(ctx.syncSecret);
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

/**
 * A forwarded node call is the box, not a person: it may not create or delete
 * events (they would be ownerless, or the checked-out event could be removed
 * from under its own lease) or import one from Eventor. Do these on the cloud.
 */
export function assertNotNodeForward(ctx: Pick<Context, "user" | "nodeForward">): void {
  if (!ctx.user && ctx.nodeForward) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Do this on the cloud: a venue box may not create, import or delete events",
    });
  }
}

/**
 * The capabilities a request holds on one event row. A signed-in user: their
 * grants. A forwarded node call (no user): everything on an event whose
 * active lease this node holds (the event is checked out to it, so it is the
 * node's to administer), nothing otherwise. Handlers that check an event
 * other than `ctx.event` (`event.delete`) call this instead of
 * `resolveEventCapabilities`, so the node rule cannot be forgotten there.
 */
export async function capabilitiesForEventRow(
  ctx: Pick<Context, "user" | "authEnabled" | "nodeForward"> & { forwardedCaps?: Set<Capability> | null },
  event: { id: bigint; date: Date },
  db: PrismaClient = prisma(),
): Promise<Set<Capability>> {
  if (!ctx.authEnabled) return new Set(ALL_CAPABILITIES);
  if (!ctx.user && ctx.nodeForward) {
    const holder = ctx.nodeForward.nodeId;
    if (!holder) return new Set();
    const lease = await getActiveLease(db, event.id);
    if (lease?.holderNodeId !== holder) return new Set();
    // The box vouches for what its signed-in caller may do; the node never does more than that.
    return new Set(ALL_CAPABILITIES.filter((c) => ctx.forwardedCaps?.has(c)));
  }
  return resolveEventCapabilities({
    db,
    eventId: event.id,
    eventDate: event.date,
    user: ctx.user,
    authEnabled: ctx.authEnabled,
  });
}

export async function capabilitiesForContext(
  ctx: EventContext,
): Promise<Set<Capability>> {
  const date = await eventDateFor(ctx);
  return capabilitiesForEventRow(ctx, { id: ctx.event.id, date }, ctx.db);
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
/** Controller writes: `control.check` (SLICES.md slice D, decision 4). */
export const coursesReviewRaceProcedure = raceProcedure.use(
  requireCapability("courses.review"),
);
/**
 * Either capability; the procedure checks per field which one a write needs
 * (`control.update`: notes need `courses.review`, everything else
 * `courses.edit`).
 */
export const coursesEditOrReviewRaceProcedure = raceProcedure.use(
  middleware(async ({ ctx, next }) => {
    const ectx = ctx as EventContext;
    const caps = await capabilitiesForContext(ectx);
    if (!caps.has("courses.edit") && !caps.has("courses.review")) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Missing capability courses.edit",
      });
    }
    return next({ ctx: { ...ectx, capabilities: caps } });
  }),
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
 * post-readout course map (MapPanel), mirroring the map-document route
 * (`/api/map-documents/:hash`), which treats a kiosk key as sufficient
 * for map access.
 */
export const kioskOrCoursesViewProcedure = kioskOrCapProcedure("courses.view");
export const kioskOrRaceOperateProcedure = kioskOrCapProcedure("race.operate");
