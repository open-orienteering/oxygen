/**
 * `GET /ready`: readiness, as opposed to `/health` (liveness, static, cheap).
 *
 * 200 `{status:"ok"}` only when the process can reach Postgres (`SELECT 1`
 * within a short timeout) and every migration directory shipped with this
 * build is recorded as finished in `oxygen._prisma_migrations`. Otherwise 503
 * `{status:"unavailable", reason:"database"|"migrations", pending}`. A venue
 * box over an old volume with new code, or one whose Postgres has stopped,
 * therefore does not look healthy to compose or to node discovery
 * (docs/bugfixes/deploy-venue-setup.md, BLD-09 / DB-32).
 *
 * The migration comparison is cached for 60 s once it matches, so most calls
 * cost one `SELECT 1`; concurrent probes share one in-flight check
 * (single-flight). The timeout does not cancel the query: a hung Postgres
 * parks a pool connection until Prisma's own timeout. Unauthenticated in every AUTH_MODE like `/health`: it is a plain
 * Fastify route, not a tRPC procedure, and exposes only migration names.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

export interface ReadyDb {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

export interface ReadyDeps {
  db: () => ReadyDb;
  /** Migration directory names this build expects. Default: read from disk once. */
  expectedMigrations?: () => string[];
  /** Database round-trip budget. Default 2000 ms. */
  timeoutMs?: number;
  /** How long a matching migration comparison is trusted. Default 60 000 ms. */
  matchTtlMs?: number;
  /** Clock, for tests. Default `Date.now`. */
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MATCH_TTL_MS = 60_000;

/**
 * `packages/api/prisma/migrations`, resolved from this file: `src/ready.ts`
 * (tsx, vitest) and `dist/ready.js` (the image, where `prisma/` sits beside
 * `dist/`) are both one level below `packages/api`.
 */
export function migrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prisma/migrations");
}

export function readMigrationNames(dir = migrationsDir()): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError("database timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

type Verdict =
  | { ok: true }
  | { ok: false; reason: "database" | "migrations"; pending: string[] };

export function registerReadyRoute(server: FastifyInstance, deps: ReadyDeps): void {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = deps.matchTtlMs ?? DEFAULT_MATCH_TTL_MS;
  const now = deps.now ?? Date.now;
  let expected: string[] | null = null;
  let matchedAt: number | null = null;
  let inFlight: Promise<Verdict> | null = null;

  async function check(): Promise<Verdict> {
    const db = deps.db();
    try {
      await withTimeout(db.$queryRawUnsafe("SELECT 1"), timeoutMs);
    } catch (err) {
      server.log.warn({ err }, "[ready] database check failed");
      return { ok: false, reason: "database", pending: [] };
    }
    if (matchedAt !== null && now() - matchedAt < ttlMs) return { ok: true };

    try {
      expected ??= (deps.expectedMigrations ?? readMigrationNames)();
      const rows = await withTimeout(
        db.$queryRawUnsafe<{ migration_name: string }[]>(
          `SELECT migration_name FROM "oxygen"."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
        ),
        timeoutMs,
      );
      const applied = new Set(rows.map((r) => r.migration_name));
      const pending = expected.filter((m) => !applied.has(m));
      if (pending.length > 0) {
        matchedAt = null;
        return { ok: false, reason: "migrations", pending };
      }
      matchedAt = now();
      return { ok: true };
    } catch (err) {
      // No _prisma_migrations table (never migrated) lands here too.
      server.log.warn({ err }, "[ready] migration check failed");
      matchedAt = null;
      return { ok: false, reason: "migrations", pending: expected ?? [] };
    }
  }

  server.get("/ready", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    inFlight ??= check().finally(() => {
      inFlight = null;
    });
    const v = await inFlight;
    if (v.ok) return { status: "ok" };
    return reply
      .code(503)
      .send({ status: "unavailable", reason: v.reason, pending: v.pending });
  });
}
