/**
 * Integration tests for the competition backup route.
 *
 * Hits a freshly-seeded test competition database via a Fastify instance
 * with the backup route registered, and verifies the streamed .sql payload
 * is well-formed (header + mysqldump output) and that error cases return
 * the expected HTTP status codes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import mysql from "mysql2/promise";
import {
  registerBackupRoute,
  getBackupTarget,
  buildBackupHeader,
  buildBackupFilename,
} from "../../backup.js";
import { createTestDb, type TestDbContext } from "../helpers/test-db.js";

let ctx: TestDbContext;
let server: FastifyInstance;

beforeAll(async () => {
  ctx = await createTestDb("backup");

  // Seed minimal data so the dump is non-trivial.
  await ctx.client.oClass.create({
    data: {
      Name: "H21",
      Course: 0,
      FirstStart: 0,
      StartInterval: 0,
      SortIndex: 1,
      Removed: false,
      Counter: 0,
      FreeStart: 0,
    },
  });

  server = Fastify({ logger: false });
  registerBackupRoute(server);
  await server.ready();
}, 60000);

afterAll(async () => {
  await server.close();
  await ctx.cleanup();
}, 30000);

describe("backup helpers", () => {
  it("buildBackupFilename produces a sortable timestamped name", () => {
    const fn = buildBackupFilename(
      "Vinterserien",
      new Date("2026-03-15T13:18:24Z"),
    );
    expect(fn).toMatch(/^Vinterserien_backup_\d{8}_\d{6}\.sql$/);
  });

  it("buildBackupFilename strips unsafe characters from the NameId", () => {
    const fn = buildBackupFilename(
      "weird name/with..stuff",
      new Date("2026-03-15T13:18:24Z"),
    );
    expect(fn.startsWith("weird_name_with__stuff_backup_")).toBe(true);
    expect(fn.endsWith(".sql")).toBe(true);
    expect(fn).not.toMatch(/[/.]{2,}/);
  });

  it("buildBackupHeader includes a commented INSERT for MeOSMain re-registration", () => {
    const header = buildBackupHeader({
      Id: 1,
      Name: "Test's Race",
      NameId: "test_race",
      Date: "2026-03-15",
      ZeroTime: 324000,
      Annotation: "demo",
      Version: 96,
    });
    expect(header).toMatch(/^-- Oxygen backup/);
    expect(header).toContain("-- Database:   test_race");
    expect(header).toContain("-- ZeroTime:   324000");
    expect(header).toContain("-- INSERT INTO MeOSMain.oEvent (");
    // The NameId appears verbatim
    expect(header).toContain("'test_race'");
    // Single quotes in Name are escaped (\\' in the SQL, which is \\\\' in the source)
    expect(header).toContain("'Test\\'s Race'");
    // Numeric values are not quoted
    expect(header).toContain(", 324000, ");
    expect(header).toContain(", 96, ");
  });
});

describe("getBackupTarget", () => {
  it("returns row + connection params for an active competition", async () => {
    const target = await getBackupTarget(ctx.dbName);
    expect(target).not.toBeNull();
    expect(target!.row.NameId).toBe(ctx.dbName);
    expect(target!.row.Name).toMatch(/^Test Competition /);
    expect(target!.params.database).toBe(ctx.dbName);
    expect(target!.params.host).toBeTruthy();
    expect(target!.params.port).toBeGreaterThan(0);
  });

  it("returns null for an unknown NameId", async () => {
    const target = await getBackupTarget("does_not_exist_xxx");
    expect(target).toBeNull();
  });

  it("returns null for invalid NameIds", async () => {
    expect(await getBackupTarget("")).toBeNull();
    expect(await getBackupTarget("has space")).toBeNull();
    expect(await getBackupTarget("with;semi")).toBeNull();
  });

  it("returns null for soft-deleted rows", async () => {
    const main = await mysql.createConnection(process.env.MEOS_MAIN_DB_URL!);
    try {
      await main.execute("UPDATE oEvent SET Removed = 1 WHERE NameId = ?", [
        ctx.dbName,
      ]);
      const target = await getBackupTarget(ctx.dbName);
      expect(target).toBeNull();
    } finally {
      // Restore so the rest of the suite still sees the row.
      await main.execute("UPDATE oEvent SET Removed = 0 WHERE NameId = ?", [
        ctx.dbName,
      ]);
      await main.end();
    }
  });
});

describe("GET /api/backup/competition", () => {
  it("streams a valid backup for an existing competition", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/backup/competition?name=${encodeURIComponent(ctx.dbName)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/sql");

    const disposition = String(res.headers["content-disposition"] ?? "");
    expect(disposition).toMatch(
      new RegExp(`attachment; filename="${ctx.dbName}_backup_\\d{8}_\\d{6}\\.sql"`),
    );

    const body = res.body;
    // Header
    expect(body.startsWith("-- Oxygen backup")).toBe(true);
    expect(body).toContain(`-- Database:   ${ctx.dbName}`);
    expect(body).toContain("-- INSERT INTO MeOSMain.oEvent (");

    // mysqldump output
    expect(body).toContain("CREATE TABLE `oEvent`");
    expect(body).toContain("CREATE TABLE `oClass`");
    // Class we seeded above appears in the data section
    expect(body).toContain("'H21'");
    // No failure marker
    expect(body).not.toContain("-- BACKUP FAILED");
  });

  it("returns 400 when the name parameter is missing", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/backup/competition",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for an invalid NameId", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/backup/competition?name=has%20space",
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown NameId", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/backup/competition?name=does_not_exist_xxx",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a soft-deleted competition", async () => {
    const main = await mysql.createConnection(process.env.MEOS_MAIN_DB_URL!);
    try {
      await main.execute("UPDATE oEvent SET Removed = 1 WHERE NameId = ?", [
        ctx.dbName,
      ]);
      const res = await server.inject({
        method: "GET",
        url: `/api/backup/competition?name=${encodeURIComponent(ctx.dbName)}`,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await main.execute("UPDATE oEvent SET Removed = 0 WHERE NameId = ?", [
        ctx.dbName,
      ]);
      await main.end();
    }
  });
});
