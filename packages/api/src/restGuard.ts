import type { FastifyReply, FastifyRequest } from "fastify";
import type { Capability } from "@oxygen/shared";
import {
  authDevEmail,
  authHeaderName,
  authMode,
  parseIdentityEmail,
  resolveUser,
  type AuthUser,
} from "./auth.js";
import { prisma, resolveEvent, type EventRef } from "./db.js";
import { resolveEventCapabilities } from "./permissions.js";
import { kioskKeyMatches, KIOSK_KEY_HEADER } from "./trpc.js";

async function identityFromRequest(req: FastifyRequest): Promise<{
  user: AuthUser | null;
  authEnabled: boolean;
  kioskKey: string | null;
}> {
  const mode = authMode();
  const authEnabled = mode !== "off";
  const kioskRaw = req.headers[KIOSK_KEY_HEADER];
  const headerKey = (Array.isArray(kioskRaw) ? kioskRaw[0] : kioskRaw)?.trim() || null;
  const queryK = typeof req.query === "object" && req.query && "k" in req.query
    ? String((req.query as { k?: string }).k ?? "").trim() || null
    : null;
  const kioskKey = headerKey || queryK;
  let user: AuthUser | null = null;
  if (mode === "proxy") {
    const email = parseIdentityEmail(req.headers[authHeaderName()]);
    if (email) user = await resolveUser(email);
  } else if (mode === "dev") {
    const email = parseIdentityEmail(authDevEmail()) ?? "dev@localhost";
    user = await resolveUser(email, { implicitAdmin: true });
  }
  return { user, authEnabled, kioskKey };
}

/**
 * Club-library REST assets are visible to every invited user. This is
 * intentionally broader than event-scoped assets, which require a capability.
 */
export async function assertClubRestAccess(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const { user, authEnabled } = await identityFromRequest(req);
  if (!authEnabled) return true;
  if (!user) {
    void reply.code(401).send({ error: "Not authenticated" });
    return false;
  }
  return true;
}

/**
 * Returns the resolved event if the request may proceed, or `null` after
 * sending the failure reply (404 unknown event, 401, 403).
 *
 * The event is always resolved — auth on or off — and returned so route
 * handlers reuse it instead of looking the slug up a second time. On the
 * tile path that second lookup ran for every tile in a viewport.
 */
export async function assertRestAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  args: {
    nameId: string;
    cap: Capability;
    allowKiosk?: boolean;
    /** Already-resolved event, when the caller had to look it up anyway. */
    event?: EventRef | null;
  },
): Promise<EventRef | null> {
  const [{ user, authEnabled, kioskKey }, event] = await Promise.all([
    identityFromRequest(req),
    args.event !== undefined ? args.event : resolveEvent(args.nameId),
  ]);
  if (!event) {
    void reply.code(404).send({ error: "Unknown event" });
    return null;
  }
  if (!authEnabled) return event;

  if (args.allowKiosk && kioskKeyMatches(kioskKey, event.kioskKey ?? null)) {
    return event;
  }

  if (!user) {
    void reply.code(401).send({ error: "Not authenticated" });
    return null;
  }

  const caps = await resolveEventCapabilities({
    db: prisma(),
    eventId: event.id,
    eventDate: event.date ?? new Date(0),
    user,
    authEnabled: true,
  });
  if (!caps.has(args.cap)) {
    void reply.code(403).send({ error: `Missing capability ${args.cap}` });
    return null;
  }
  return event;
}

/**
 * Instance-admin REST gate. Used for OCAD-bearing dumps: an event manager
 * can back up their own uploaded map, but a club-library copy is club
 * property and only an instance admin may take it out.
 */
export async function assertRestAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const { user, authEnabled } = await identityFromRequest(req);
  if (!authEnabled) return true;
  if (!user) {
    void reply.code(401).send({ error: "Not authenticated" });
    return false;
  }
  if (!user.isAdmin) {
    void reply.code(403).send({ error: "Instance admin required" });
    return false;
  }
  return true;
}
