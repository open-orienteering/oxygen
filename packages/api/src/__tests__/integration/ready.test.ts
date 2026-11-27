/**
 * GET /ready against the migrated test database (BLD-09 / DB-32). The shared
 * database is only read: a pending migration is simulated by expecting one
 * the database cannot have.
 */
import { afterAll, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { disconnectAll, prisma } from "../../db.js";
import { readMigrationNames, registerReadyRoute } from "../../ready.js";

describe("GET /ready (integration)", () => {
  afterAll(async () => {
    await disconnectAll();
  });

  it("is 200 on a migrated database", async () => {
    const server = Fastify();
    registerReadyRoute(server, { db: () => prisma(), expectedMigrations: readMigrationNames });
    const res = await server.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("is 503 reason=migrations naming a migration the database has not applied", async () => {
    const missing = "99999999999999_not_applied";
    const server = Fastify();
    registerReadyRoute(server, {
      db: () => prisma(),
      expectedMigrations: () => [...readMigrationNames(), missing],
    });
    const res = await server.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", reason: "migrations", pending: [missing] });
  });
});
