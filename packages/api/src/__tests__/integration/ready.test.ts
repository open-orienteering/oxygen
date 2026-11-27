/**
 * GET /ready against the migrated test database (BLD-09 / DB-32).
 */
import { afterAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { disconnectAll, prisma } from "../../db.js";
import { registerReadyRoute } from "../../ready.js";

describe("GET /ready (integration)", () => {
  afterAll(async () => {
    await disconnectAll();
  });

  it("is 200 on a migrated database and 503 reason=migrations while one migration row is missing", async () => {
    // Fresh route registration: nothing cached from an earlier call.
    const server = Fastify();
    registerReadyRoute(server, { db: () => prisma() });

    const okRes = await server.inject({ method: "GET", url: "/ready" });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.json()).toEqual({ status: "ok" });

    const rows = await prisma().$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "oxygen"."_prisma_migrations" ORDER BY started_at DESC LIMIT 1`,
    );
    const row = rows[0];
    const fresh = Fastify();
    registerReadyRoute(fresh, { db: () => prisma() });
    try {
      await prisma().$executeRaw`DELETE FROM "oxygen"."_prisma_migrations" WHERE id = ${row.id as string}`;
      const bad = await fresh.inject({ method: "GET", url: "/ready" });
      expect(bad.statusCode).toBe(503);
      expect(bad.json()).toEqual({
        status: "unavailable",
        reason: "migrations",
        pending: [row.migration_name],
      });
    } finally {
      await prisma().$executeRaw`
        INSERT INTO "oxygen"."_prisma_migrations"
          (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
        VALUES (${row.id as string}, ${row.checksum as string}, ${row.finished_at as Date},
                ${row.migration_name as string}, ${row.logs as string | null},
                ${row.rolled_back_at as Date | null}, ${row.started_at as Date},
                ${row.applied_steps_count as number})`;
    }
    const restored = Fastify();
    registerReadyRoute(restored, { db: () => prisma() });
    expect((await restored.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
  });
});
