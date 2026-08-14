/**
 * Single Prisma client + helpers for resolving the active event and reading
 * the per-event ZeroTime. All tables live in the `oxygen` schema; routers
 * filter by `eventId` instead of switching Prisma clients.
 *
 * Replaces the previous MySQL multi-DB layout (one DB per competition +
 * MeOSMain registry). See docs/migrations/2026-drop-meos.md.
 */

import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

// ─── Singleton client ───────────────────────────────────────

/**
 * Lazy singleton — created on first call so that scripts (migration tool,
 * test helpers) can swap `process.env.DATABASE_URL` before any tRPC code
 * touches the client. Prisma 7 requires an explicit driver adapter and no
 * longer reads the datasource URL itself.
 */
let _prisma: PrismaClient | undefined;

export function prisma(): PrismaClient {
  if (!_prisma) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    _prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString,
        // node-postgres defaults to 10 connections — noticeably below the
        // old Rust engine's default (2 × cores + 1) and small enough to
        // starve under interactive-transaction load (observed as hung
        // requests in the E2E suite). Keep the old headroom.
        max: parseInt(process.env.DATABASE_POOL_MAX ?? "25", 10),
      }),
    });
  }
  return _prisma;
}

/**
 * Map upload listeners — fired when a new OCAD map is uploaded to an event.
 * Used to invalidate cached course geometry.
 */
const mapUploadListeners: ((eventId: bigint) => void)[] = [];
export function onMapUpload(cb: (eventId: bigint) => void) {
  mapUploadListeners.push(cb);
}
export function fireMapUpload(eventId: bigint) {
  for (const cb of mapUploadListeners) cb(eventId);
}

// ─── Event resolution ──────────────────────────────────────

export interface EventRef {
  /** Internal DB id (BIGSERIAL). */
  id: bigint;
  /** URL slug — stable across the event's lifetime. */
  nameId: string;
  /** Deciseconds since midnight, the reference point for all race times. */
  zeroTime: number;
}

/**
 * Look up an event row by its URL slug. Returns null if not found or removed.
 * Used by the tRPC context resolver.
 */
export async function resolveEvent(nameId: string): Promise<EventRef | null> {
  const row = await prisma().event.findUnique({
    where: { nameId },
    select: { id: true, nameId: true, zeroTime: true, removed: true },
  });
  if (!row || row.removed) return null;
  return { id: row.id, nameId: row.nameId, zeroTime: row.zeroTime };
}

/**
 * Look up the ZeroTime for an event. Defaults to 09:00:00 (324000) if the
 * event has no row (defensive; should never happen post-resolver).
 */
export async function getZeroTime(eventId: bigint): Promise<number> {
  const row = await prisma().event.findUnique({
    where: { id: eventId },
    select: { zeroTime: true },
  });
  return row?.zeroTime ?? 324000;
}

// ─── Slug sanitization ──────────────────────────────────────

/**
 * Sanitize a string to a URL-safe event slug. Used when an operator creates
 * a new event from the UI.
 */
export function sanitizeNameId(name: string): string {
  return (
    name
      .replace(/[åä]/gi, "a")
      .replace(/[ö]/gi, "o")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .substring(0, 64) || "event"
  );
}

// ─── Global settings (key-value store) ─────────────────────

/**
 * Truly global, cross-event settings. The only keys that live here:
 *
 *   - `eventor_api_key`, `eventor_api_key_test`
 *   - `runnerdb_last_sync`, `runnerdb_runner_count`, `runnerdb_club_count`
 *
 * Per-event settings (eventor env, liveresults config) live as columns on
 * the `events` row.
 */
export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma().setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(
  key: string,
  value: string | null,
): Promise<void> {
  if (value === null) {
    await prisma().setting.deleteMany({ where: { key } });
    return;
  }
  await prisma().setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

// ─── Shutdown ──────────────────────────────────────────────

export async function disconnectAll(): Promise<void> {
  if (_prisma) {
    try {
      await _prisma.$disconnect();
    } catch {
      /* ignore */
    }
    _prisma = undefined;
  }
}

// ─── Re-exported types ─────────────────────────────────────

export type { PrismaClient } from "./generated/prisma/client.js";
