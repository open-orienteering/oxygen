import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { readMigrationNames, registerReadyRoute, type ReadyDb } from "../ready.js";

function setup(opts: {
  query: (sql: string) => Promise<unknown>;
  expected?: string[];
  timeoutMs?: number;
}) {
  const server = Fastify();
  const db: ReadyDb = { $queryRawUnsafe: vi.fn(opts.query) as ReadyDb["$queryRawUnsafe"] };
  registerReadyRoute(server, {
    db: () => db,
    expectedMigrations: () => opts.expected ?? ["a", "b"],
    timeoutMs: opts.timeoutMs ?? 50,
  });
  return { server, db: db.$queryRawUnsafe as ReturnType<typeof vi.fn> };
}

const applied = (...names: string[]) => names.map((migration_name) => ({ migration_name }));

describe("GET /ready", () => {
  it("answers 200 ok, no-store, when the database answers and all migrations are applied", async () => {
    const { server } = setup({
      query: async (sql) => (sql.startsWith("SELECT 1") ? [{ "?column?": 1 }] : applied("a", "b")),
    });
    const res = await server.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("answers 503 reason=database when the query hangs past the timeout", async () => {
    const { server } = setup({ query: () => new Promise(() => {}), timeoutMs: 20 });
    const res = await server.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "unavailable", reason: "database" });
  });

  it("answers 503 reason=database when SELECT 1 fails", async () => {
    const { server } = setup({ query: async () => { throw new Error("connection refused"); } });
    const res = await server.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json().reason).toBe("database");
  });

  it("lists pending migrations with reason=migrations", async () => {
    const { server } = setup({
      query: async (sql) => (sql.startsWith("SELECT 1") ? [{}] : applied("a")),
    });
    const res = await server.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "unavailable", reason: "migrations", pending: ["b"] });
  });

  it("answers 503 reason=migrations when _prisma_migrations does not exist", async () => {
    const { server } = setup({
      query: async (sql) => {
        if (sql.startsWith("SELECT 1")) return [{}];
        throw new Error('relation "oxygen._prisma_migrations" does not exist');
      },
    });
    const res = await server.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ reason: "migrations", pending: ["a", "b"] });
  });

  it("caches a full match: later calls run only SELECT 1", async () => {
    const { server, db } = setup({
      query: async (sql) => (sql.startsWith("SELECT 1") ? [{}] : applied("a", "b")),
    });
    await server.inject({ method: "GET", url: "/ready" });
    await server.inject({ method: "GET", url: "/ready" });
    await server.inject({ method: "GET", url: "/ready" });
    const sqls = db.mock.calls.map((c) => c[0] as string);
    expect(sqls.filter((s) => s.includes("_prisma_migrations"))).toHaveLength(1);
    expect(sqls.filter((s) => s === "SELECT 1")).toHaveLength(3);
  });

  it("does not cache a mismatch, and recovers when the database comes back", async () => {
    let up = false;
    const { server } = setup({
      query: async (sql) => {
        if (!up) throw new Error("down");
        return sql.startsWith("SELECT 1") ? [{}] : applied("a", "b");
      },
    });
    expect((await server.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
    up = true;
    expect((await server.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
  });
});

describe("readMigrationNames", () => {
  it("lists the migration directories of this checkout, not migration_lock.toml", () => {
    const names = readMigrationNames();
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain("20260517_init");
    expect(names.some((n) => n.endsWith(".toml"))).toBe(false);
  });
});
