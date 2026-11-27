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
 * The migration comparison is cached once it matches (migrations only ever
 * get added by a deploy, which restarts the process), so later calls cost one
 * `SELECT 1`. Unauthenticated in every AUTH_MODE like `/health`: it is a plain
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
}

const DEFAULT_TIMEOUT_MS = 2000;

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

export function registerReadyRoute(server: FastifyInstance, deps: ReadyDeps): void {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let expected: string[] | null = null;
  let migrationsMatched = false;

  server.get("/ready", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    const db = deps.db();
    try {
      await withTimeout(db.$queryRawUnsafe("SELECT 1"), timeoutMs);
    } catch (err) {
      server.log.warn({ err }, "[ready] database check failed");
      return reply.code(503).send({ status: "unavailable", reason: "database", pending: [] });
    }
    if (migrationsMatched) return { status: "ok" };

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
        return reply.code(503).send({ status: "unavailable", reason: "migrations", pending });
      }
      migrationsMatched = true;
      return { status: "ok" };
    } catch (err) {
      // No _prisma_migrations table (never migrated) lands here too.
      server.log.warn({ err }, "[ready] migration check failed");
      return reply
        .code(503)
        .send({ status: "unavailable", reason: "migrations", pending: expected ?? [] });
    }
  });
}
