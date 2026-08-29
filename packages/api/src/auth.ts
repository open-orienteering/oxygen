/**
 * Trusted-header identity. Oxygen never sees a password: a reverse proxy
 * (oauth2-proxy, Cloudflare Access, GCP IAP) injects the authenticated
 * email, and we resolve it against the invite-only `users` table.
 *
 * AUTH_MODE=off (default) leaves ctx.user null and skips every auth gate.
 *
 * The identity header is only trustworthy when the proxy strips inbound
 * client copies. See docs/authentication.md.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { prisma } from "./db.js";

export type AuthMode = "off" | "proxy" | "dev";

/** Subset of `User` exposed on tRPC context. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  active: boolean;
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;
const LAST_SEEN_MIN_MS = 5 * 60 * 1000;

const actorStore = new AsyncLocalStorage<string | null>();

export function runWithActor<T>(actorId: string | null, fn: () => T): T {
  return actorStore.run(actorId, fn);
}

/** Actor id for the current tRPC request, or null outside authed procedures. */
export function currentActorId(): string | null {
  const stored = actorStore.getStore();
  return stored === undefined ? null : stored;
}

export function authMode(): AuthMode {
  const raw = (process.env.AUTH_MODE ?? "off").trim().toLowerCase();
  if (raw === "proxy" || raw === "dev") return raw;
  return "off";
}

export function authEnabled(): boolean {
  return authMode() !== "off";
}

export function authHeaderName(): string {
  return (process.env.AUTH_HEADER ?? "x-forwarded-email").trim().toLowerCase();
}

export function authDevEmail(): string {
  return (process.env.AUTH_DEV_EMAIL ?? "dev@localhost").trim().toLowerCase();
}

export function parseOxygenAdminEmails(): string[] {
  const raw = process.env.OXYGEN_ADMIN_EMAILS ?? "";
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((email) => EMAIL_SHAPE.test(email));
}

export function parseIdentityEmail(
  headerValue: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw == null) return null;
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  const colon = value.lastIndexOf(":");
  if (colon >= 0) value = value.slice(colon + 1).trim();
  if (!EMAIL_SHAPE.test(value)) return null;
  return value;
}

function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local;
}

function toAuthUser(row: {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  active: boolean;
}): AuthUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    isAdmin: row.isAdmin,
    active: row.active,
  };
}

/**
 * Look up an invited user. Bootstrap admins (OXYGEN_ADMIN_EMAILS, or
 * `implicitAdmin` for AUTH_MODE=dev) are created on first sight.
 * Inactive users resolve to null (lockout).
 */
export async function resolveUser(
  email: string,
  opts?: { implicitAdmin?: boolean },
): Promise<AuthUser | null> {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(normalized)) return null;
  const db = prisma();
  let row = await db.user.findUnique({ where: { email: normalized } });
  const bootstrap =
    (opts?.implicitAdmin === true) ||
    parseOxygenAdminEmails().includes(normalized);
  if (!row && bootstrap) {
    try {
      row = await db.user.create({
        data: {
          email: normalized,
          displayName: displayNameFromEmail(normalized),
          isAdmin: true,
          active: true,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") {
        row = await db.user.findUnique({ where: { email: normalized } });
      } else {
        throw err;
      }
    }
  }
  if (!row || !row.active) return null;

  const lastSeen = row.lastSeenAt?.getTime() ?? 0;
  if (Date.now() - lastSeen > LAST_SEEN_MIN_MS) {
    void db.user
      .update({
        where: { id: row.id },
        data: { lastSeenAt: new Date() },
      })
      .catch((err: unknown) => {
        console.error("[auth] lastSeenAt update failed:", err);
      });
  }

  return toAuthUser(row);
}
