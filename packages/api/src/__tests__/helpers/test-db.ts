/**
 * Test database helpers for API integration tests.
 *
 * Creates an isolated MySQL database per test suite using the same MeOS
 * schema as production, then drops it after the suite completes.
 * Fixtures are built programmatically via Prisma (no SQL seed files).
 */

import { randomBytes } from "crypto";
import mysql from "mysql2/promise";
import { PrismaClient } from "@prisma/client";
import {
  createCompetitionDatabase,
  getCompetitionClient,
  disconnectAll,
} from "../../db.js";

export interface TestDbContext {
  dbName: string;
  client: PrismaClient;
  cleanup: () => Promise<void>;
}

/**
 * Create a fresh test competition database.
 * Call in beforeAll; call ctx.cleanup() in afterAll.
 */
export async function createTestDb(label = "test"): Promise<TestDbContext> {
  const suffix = randomBytes(4).toString("hex");
  const dbName = `oos_test_${label}_${suffix}`;

  await createCompetitionDatabase(
    `Test Competition ${suffix}`,
    "2026-01-01",
    dbName,
  );

  // Point the module-level singleton to this test DB
  const client = await getCompetitionClient(dbName);

  const cleanup = async () => {
    await disconnectAll();

    // Drop the test database
    const baseUrl = process.env.DATABASE_URL ?? "";
    if (!baseUrl) return;
    const conn = await mysql.createConnection(baseUrl);
    try {
      await conn.execute(`DROP DATABASE IF EXISTS \`${dbName}\``);
    } finally {
      await conn.end();
    }

    // Remove the competition registration from MeOSMain
    const mainUrl = process.env.MEOS_MAIN_DB_URL ?? "";
    if (mainUrl) {
      const mainConn = await mysql.createConnection(mainUrl);
      try {
        await mainConn.execute(
          "DELETE FROM oEvent WHERE NameId = ?",
          [dbName],
        );
      } finally {
        await mainConn.end();
      }
    }
  };

  return { dbName, client, cleanup };
}
