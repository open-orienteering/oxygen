import { PrismaClient } from "@prisma/client";
import mysql from "mysql2/promise";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── Types ─────────────────────────────────────────────────

export interface DbConnectionInfo {
  host: string;
  port: number;
  user?: string;
  password?: string;
}

// ─── State ─────────────────────────────────────────────────

// The main Prisma client for the currently selected competition database
let competitionClient: PrismaClient | null = null;
let currentDbName: string | null = null;

// In-memory cache of stored remote connections (NameId → connection info)
let remoteConnectionCache: Map<string, DbConnectionInfo> | null = null;

// oMonitor heartbeat state (registers Oxygen as a connected client in MeOS)
let monitorId: number | null = null;
let monitorInterval: ReturnType<typeof setInterval> | null = null;
let monitorConn: mysql.Connection | null = null;

// ─── Main DB (MeOSMain) connection ─────────────────────────

/**
 * Get a raw MySQL connection to query MeOSMain (the master database listing competitions).
 * We use raw mysql2 here because Prisma is configured for the competition database,
 * and MeOSMain is a separate database.
 */
export async function getMainDbConnection() {
  const url = process.env.MEOS_MAIN_DB_URL;
  if (!url) {
    throw new Error("MEOS_MAIN_DB_URL environment variable is not set");
  }
  return mysql.createConnection(url);
}

// ─── Remote connection storage ─────────────────────────────

/**
 * Ensure the oxygen_db_connections table exists in MeOSMain.
 * This stores per-competition remote DB connection info.
 */
let dbConnectionsTableReady = false;

async function ensureDbConnectionsTable(
  conn: mysql.Connection,
): Promise<void> {
  if (dbConnectionsTableReady) return;
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS oxygen_db_connections (
      NameId   VARCHAR(128) NOT NULL PRIMARY KEY,
      Host     VARCHAR(255) NOT NULL,
      Port     INT UNSIGNED NOT NULL DEFAULT 3306,
      User     VARCHAR(128) NULL,
      Password VARCHAR(255) NULL
    )
  `);
  dbConnectionsTableReady = true;
}

/**
 * Store a remote DB connection in MeOSMain.
 */
async function storeRemoteConnection(
  nameId: string,
  info: DbConnectionInfo,
): Promise<void> {
  const conn = await getMainDbConnection();
  try {
    await ensureDbConnectionsTable(conn);
    await conn.execute(
      `INSERT INTO oxygen_db_connections (NameId, Host, Port, User, Password)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE Host=VALUES(Host), Port=VALUES(Port), User=VALUES(User), Password=VALUES(Password)`,
      [nameId, info.host, info.port, info.user ?? null, info.password ?? null],
    );
    // Invalidate cache
    remoteConnectionCache = null;
  } finally {
    await conn.end();
  }
}

/**
 * Look up a remote DB connection for a given competition NameId.
 * Returns undefined if the competition uses the default (local) connection.
 */
export async function getRemoteConnection(
  nameId: string,
): Promise<DbConnectionInfo | undefined> {
  // Load and cache all remote connections
  if (!remoteConnectionCache) {
    remoteConnectionCache = new Map();
    const conn = await getMainDbConnection();
    try {
      await ensureDbConnectionsTable(conn);
      const [rows] = await conn.execute(
        "SELECT NameId, Host, Port, User, Password FROM oxygen_db_connections",
      );
      if (Array.isArray(rows)) {
        for (const row of rows as Record<string, unknown>[]) {
          remoteConnectionCache.set(row.NameId as string, {
            host: row.Host as string,
            port: row.Port as number,
            user: (row.User as string) || undefined,
            password: (row.Password as string) || undefined,
          });
        }
      }
    } finally {
      await conn.end();
    }
  }
  return remoteConnectionCache.get(nameId);
}

// ─── URL parsing ────────────────────────────────────────────

/**
 * Parse a MySQL connection URL into mysql2 connection options.
 * Supports format: mysql://user:password@host:port/database
 */
function parseMysqlUrl(url: string): mysql.ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 3306,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: u.pathname.replace(/^\//, ""),
  };
}

// ─── URL building ──────────────────────────────────────────

/**
 * Build a MySQL connection URL for a given database name,
 * optionally using a remote connection.
 */
function buildDbUrl(dbName: string, remote?: DbConnectionInfo): string {
  if (remote) {
    const userPart = remote.user
      ? remote.password
        ? `${encodeURIComponent(remote.user)}:${encodeURIComponent(remote.password)}`
        : encodeURIComponent(remote.user)
      : "root";
    return `mysql://${userPart}@${remote.host}:${remote.port}/${dbName}`;
  }
  const baseUrl = process.env.DATABASE_URL ?? "";
  return baseUrl.replace(/\/([^/?]+)(\?|$)/, `/${dbName}$2`);
}

/**
 * Build a raw mysql2 connection URL for MeOSMain on a remote server.
 */
function buildRemoteMainDbUrl(remote: DbConnectionInfo): string {
  const userPart = remote.user
    ? remote.password
      ? `${encodeURIComponent(remote.user)}:${encodeURIComponent(remote.password)}`
      : encodeURIComponent(remote.user)
    : "root";
  return `mysql://${userPart}@${remote.host}:${remote.port}/MeOSMain`;
}

// ─── oMonitor heartbeat ────────────────────────────────────

const MONITOR_INTERVAL_MS = 15_000;

/**
 * Start the oMonitor heartbeat for a competition database.
 * Registers Oxygen as a connected client so that MeOS can see it
 * in its "connected clients" list. Sends a heartbeat UPDATE
 * every 15 seconds to keep the entry's Modified timestamp fresh.
 *
 * See MeosSQL.cpp:monitorShow() for MeOS's side of this protocol.
 */
async function startMonitorHeartbeat(dbName: string): Promise<void> {
  await stopMonitorHeartbeat();

  try {
    monitorConn = await getCompetitionDbConnection(dbName);

    const [result] = await monitorConn.execute<mysql.ResultSetHeader>(
      "INSERT INTO oMonitor (Count, Client, Modified) VALUES (1, 'Oxygen', NOW())",
    );
    monitorId = result.insertId;
    console.log(`  [monitor] Registered as client #${monitorId} in ${dbName}`);

    monitorInterval = setInterval(async () => {
      if (!monitorConn || !monitorId) return;
      try {
        await monitorConn.execute(
          "UPDATE oMonitor SET Count = Count + 1, Client = 'Oxygen', Modified = NOW() WHERE Id = ?",
          [monitorId],
        );
      } catch {
        // Connection may have been lost; stop heartbeat silently
        await stopMonitorHeartbeat();
      }
    }, MONITOR_INTERVAL_MS);
  } catch (err) {
    // oMonitor table may not exist (e.g. test databases).
    // This is non-critical — just skip registration.
    console.warn(`  [monitor] Failed to register in ${dbName}:`, err);
    if (monitorConn) {
      try { await monitorConn.end(); } catch { /* ignore */ }
    }
    monitorConn = null;
    monitorId = null;
  }
}

/**
 * Stop the oMonitor heartbeat and mark the Oxygen client as removed.
 */
async function stopMonitorHeartbeat(): Promise<void> {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }

  if (monitorConn && monitorId) {
    try {
      await monitorConn.execute(
        "UPDATE oMonitor SET Removed = 1, Modified = NOW() WHERE Id = ?",
        [monitorId],
      );
      console.log(`  [monitor] Unregistered client #${monitorId}`);
    } catch {
      // Ignore errors during cleanup
    }
  }

  if (monitorConn) {
    try {
      await monitorConn.end();
    } catch {
      // Ignore
    }
    monitorConn = null;
  }
  monitorId = null;
}

// ─── Competition Prisma client ─────────────────────────────

/**
 * Get or create the Prisma client for a specific competition database.
 * If the database name changes, the old client is disconnected and a new one is created.
 * Automatically checks for stored remote connections.
 * Also starts the oMonitor heartbeat to register Oxygen as a connected client.
 */
export async function getCompetitionClient(
  dbName?: string,
): Promise<PrismaClient> {
  const targetDb = dbName ?? currentDbName ?? getDbNameFromUrl();

  if (competitionClient && currentDbName === targetDb) {
    return competitionClient;
  }

  // Stop old heartbeat + disconnect old client if switching databases
  await stopMonitorHeartbeat();
  if (competitionClient) {
    await competitionClient.$disconnect();
  }

  // Check if this competition has a remote connection
  const remote = await getRemoteConnection(targetDb);
  const url = buildDbUrl(targetDb, remote);

  competitionClient = new PrismaClient({
    datasources: {
      db: { url },
    },
  });

  await competitionClient.$connect();
  currentDbName = targetDb;

  // Start oMonitor heartbeat for the new database (fire-and-forget)
  startMonitorHeartbeat(targetDb).catch(() => {});

  return competitionClient;
}

/** Get the default Prisma client (using DATABASE_URL as-is) */
export async function getDefaultClient(): Promise<PrismaClient> {
  if (!competitionClient) {
    competitionClient = new PrismaClient();
    await competitionClient.$connect();
    currentDbName = getDbNameFromUrl();
  }
  return competitionClient;
}

/** Get the current competition database name */
export function getCurrentDbName(): string | null {
  return currentDbName;
}

/** Extract the database name from DATABASE_URL */
function getDbNameFromUrl(): string {
  const url = process.env.DATABASE_URL ?? "";
  const match = url.match(/\/([^/?]+)(\?|$)/);
  return match?.[1] ?? "";
}

// ─── DB name sanitization ──────────────────────────────────

/**
 * Sanitize a string to be a valid MySQL database name.
 * Only allow alphanumeric chars and underscores, max 64 chars.
 */
export function sanitizeDbName(name: string): string {
  return name
    .replace(/[åä]/gi, "a")
    .replace(/[ö]/gi, "o")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .substring(0, 64) || "competition";
}

// ─── Competition database creation ─────────────────────────

/**
 * Create a new competition database:
 * 1. CREATE DATABASE in MySQL
 * 2. Run prisma db push to create all tables
 * 3. Register in MeOSMain.oEvent
 *
 * If `remote` is provided, the database is created on the remote server
 * and the connection info is stored locally in oxygen_db_connections.
 *
 * Returns the database name (NameId).
 */
export async function createCompetitionDatabase(
  eventName: string,
  eventDate: string,
  customDbName?: string,
  remote?: DbConnectionInfo,
): Promise<{ dbName: string; eventId: number }> {
  const dbName = customDbName
    ? sanitizeDbName(customDbName)
    : sanitizeDbName(eventName);
  const dbUrl = buildDbUrl(dbName, remote);

  // Helper: get a connection to the appropriate MeOSMain
  const getTargetMainConn = remote
    ? () => mysql.createConnection(buildRemoteMainDbUrl(remote))
    : getMainDbConnection;

  // 0. Check if this NameId already exists in MeOSMain
  const checkConn = await getTargetMainConn();
  try {
    const [existing] = await checkConn.execute(
      "SELECT Id FROM oEvent WHERE NameId = ? AND Removed = 0",
      [dbName],
    );
    if (Array.isArray(existing) && existing.length > 0) {
      throw new Error(
        `A competition database "${dbName}" already exists. Choose a different name.`,
      );
    }
  } finally {
    await checkConn.end();
  }

  // 1. Create the MySQL database
  const conn = await getTargetMainConn();
  try {
    await conn.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  } finally {
    await conn.end();
  }

  // 2. Create MeOS-compatible tables using raw SQL DDL
  //    (We use raw SQL instead of `prisma db push` because Prisma generates
  //     `DEFAULT ''` on MEDIUMTEXT columns which MySQL strict mode rejects.)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ddlPath = path.resolve(__dirname, "../prisma/meos-schema.sql");
  try {
    const ddlSql = readFileSync(ddlPath, "utf-8");
    const ddlConn = await mysql.createConnection({
      ...parseMysqlUrl(dbUrl),
      multipleStatements: true,
    });
    try {
      await ddlConn.query(ddlSql);
    } finally {
      await ddlConn.end();
    }
  } catch (err) {
    throw new Error(
      `Failed to initialize database schema: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3. Register in the target MeOSMain.oEvent
  const mainConn = await getTargetMainConn();
  let eventId: number;
  try {
    const [result] = await mainConn.execute(
      "INSERT INTO oEvent (Name, Date, NameId) VALUES (?, ?, ?)",
      [eventName, eventDate, dbName],
    );
    eventId = (result as { insertId: number }).insertId;
  } finally {
    await mainConn.end();
  }

  // 3b. If using a remote connection, also register in the LOCAL MeOSMain
  //     so the competition appears in the Oxygen competition list,
  //     and store the remote connection info for future use.
  if (remote) {
    const localConn = await getMainDbConnection();
    try {
      // Insert into local MeOSMain (ignore if somehow already exists)
      await localConn.execute(
        "INSERT IGNORE INTO oEvent (Name, Date, NameId) VALUES (?, ?, ?)",
        [eventName, eventDate, dbName],
      );
    } finally {
      await localConn.end();
    }
    await storeRemoteConnection(dbName, remote);
  }

  // 4. Also insert the oEvent record inside the competition database itself
  const client = await getCompetitionClient(dbName);
  await client.oEvent.create({
    data: {
      Name: eventName,
      Date: eventDate,
      NameId: dbName,
      ZeroTime: 324000, // 09:00:00 in deciseconds (MeOS default zero hour)
      Organizer: "",
      EMail: "",
      Homepage: "",
      Lists: "",
      Machine: "",
      // Default features for a typical individual competition (MeOS format)
      Features: "SL+BB+CL+CC+RF+NW+TA+RD",
      SPExtra: "",
      IVExtra: "",
      EntryExtra: "",
      PayModes: "",
      StartGroups: "",
      MergeInfo: "",
      RunnerIdTypes: "",
      ExtraFields: "",
      ControlMap: "",
      Annotation: "",
    },
  });

  // 5. Create oCounter record (required by MeOS schema)
  await client.$executeRaw`INSERT IGNORE INTO oCounter (CounterId) VALUES (1)`;

  // 6. Create MeOS-expected tables that aren't in Prisma schema
  //    (dbRunner, dbClub, oImage — MeOS auto-creates these but expects them)
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS dbRunner (
      Name VARCHAR(64) NOT NULL DEFAULT '',
      CardNo INT NOT NULL DEFAULT 0,
      Club INT NOT NULL DEFAULT 0,
      Nation VARCHAR(3) NOT NULL DEFAULT '',
      Sex VARCHAR(1) NOT NULL DEFAULT '',
      BirthYear INT NOT NULL DEFAULT 0,
      ExtId BIGINT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB CHARACTER SET utf8 COLLATE utf8_general_ci
  `);
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS dbClub (
      Id INT NOT NULL,
      Name VARCHAR(64) NOT NULL DEFAULT ''
    ) ENGINE=InnoDB CHARACTER SET utf8 COLLATE utf8_general_ci
  `);
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oImage (
      Id BIGINT UNSIGNED,
      Filename TEXT,
      Image LONGBLOB
    ) ENGINE=InnoDB CHARACTER SET utf8 COLLATE utf8_general_ci
  `);

  return { dbName, eventId };
}

// ─── Settings (key-value store in MeOSMain) ───────────────

/**
 * Ensure the oxygen_settings table exists in MeOSMain.
 * Simple key-value store for Oxygen-specific settings (API keys, etc.)
 */
let settingsTableReady = false;

async function ensureSettingsTable(
  conn: mysql.Connection,
): Promise<void> {
  if (settingsTableReady) return;
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS oxygen_settings (
      SettingKey   VARCHAR(128) NOT NULL PRIMARY KEY,
      SettingValue TEXT NULL
    )
  `);
  settingsTableReady = true;
}

/**
 * Get a setting from oxygen_settings in MeOSMain.
 */
export async function getSetting(key: string): Promise<string | null> {
  const conn = await getMainDbConnection();
  try {
    await ensureSettingsTable(conn);
    const [rows] = await conn.execute(
      "SELECT SettingValue FROM oxygen_settings WHERE SettingKey = ?",
      [key],
    );
    const arr = rows as Record<string, unknown>[];
    return arr.length > 0 ? (arr[0].SettingValue as string | null) : null;
  } finally {
    await conn.end();
  }
}

/**
 * Set a setting in oxygen_settings in MeOSMain.
 * Pass null to delete the setting.
 */
export async function setSetting(
  key: string,
  value: string | null,
): Promise<void> {
  const conn = await getMainDbConnection();
  try {
    await ensureSettingsTable(conn);
    if (value === null) {
      await conn.execute(
        "DELETE FROM oxygen_settings WHERE SettingKey = ?",
        [key],
      );
    } else {
      await conn.execute(
        `INSERT INTO oxygen_settings (SettingKey, SettingValue) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE SettingValue = VALUES(SettingValue)`,
        [key, value],
      );
    }
  } finally {
    await conn.end();
  }
}

// ─── Global Runner DB table (MeOSMain) ─────────────────────

let runnerDbTableReady = false;

export async function ensureRunnerDbTable(
  conn: mysql.Connection,
): Promise<void> {
  if (runnerDbTableReady) return;
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS oxygen_runner_db (
      ExtId       BIGINT NOT NULL PRIMARY KEY,
      Name        VARCHAR(128) NOT NULL DEFAULT '',
      CardNo      INT NOT NULL DEFAULT 0,
      ClubId      INT NOT NULL DEFAULT 0,
      BirthYear   SMALLINT NOT NULL DEFAULT 0,
      Sex         CHAR(1) NOT NULL DEFAULT '',
      Nationality VARCHAR(10) NOT NULL DEFAULT '',
      INDEX idx_cardno (CardNo),
      INDEX idx_name (Name),
      INDEX idx_club (ClubId)
    )
  `);
  // Migrate: widen Nationality if table was created with CHAR(3)
  try {
    await conn.execute(
      "ALTER TABLE oxygen_runner_db MODIFY COLUMN Nationality VARCHAR(10) NOT NULL DEFAULT ''",
    );
  } catch {
    // Already correct type — safe to ignore
  }
  runnerDbTableReady = true;
}

// ─── Global Club DB table (MeOSMain) ───────────────────────

let clubDbTableReady = false;

export async function ensureClubDbTable(
  conn: mysql.Connection,
): Promise<void> {
  if (clubDbTableReady) return;
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS oxygen_club_db (
      EventorId   INT NOT NULL PRIMARY KEY,
      Name        VARCHAR(128) NOT NULL DEFAULT '',
      ShortName   VARCHAR(64) NOT NULL DEFAULT '',
      CountryCode CHAR(3) NOT NULL DEFAULT '',
      SmallLogoPng MEDIUMBLOB NULL,
      LargeLogoPng MEDIUMBLOB NULL
    )
  `);
  clubDbTableReady = true;
}

// ─── Club logo table ───────────────────────────────────────

/**
 * Ensure the oxygen_club_logo table exists in the current competition database.
 * Uses CREATE TABLE IF NOT EXISTS so it's idempotent and safe for legacy DBs.
 * Result is cached per database name so it only runs once per connection.
 */
const logoTableReady = new Set<string>();

export async function ensureLogoTable(
  client: PrismaClient,
): Promise<void> {
  const db = currentDbName ?? "";
  if (logoTableReady.has(db)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_club_logo (
      EventorId  INT NOT NULL PRIMARY KEY,
      SmallPng   MEDIUMBLOB NOT NULL,
      LargePng   MEDIUMBLOB NULL,
      UpdatedAt  TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  logoTableReady.add(db);
}

// ─── Card readout history table ────────────────────────────

const readoutTableReady = new Set<string>();

export async function ensureReadoutTable(
  client: PrismaClient,
): Promise<void> {
  const db = currentDbName ?? "";
  if (readoutTableReady.has(db)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_card_readouts (
      Id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      CardNo     INT NOT NULL,
      CardType   VARCHAR(10) NOT NULL DEFAULT '',
      Punches    VARCHAR(3040) NOT NULL DEFAULT '',
      Voltage    INT UNSIGNED NOT NULL DEFAULT 0,
      OwnerData  TEXT NULL,
      Metadata   TEXT NULL,
      ReadAt     TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cardno (CardNo),
      INDEX idx_readat (ReadAt)
    )
  `);

  // Add Metadata column if table was created before this migration
  try {
    await client.$executeRawUnsafe(`
      ALTER TABLE oxygen_card_readouts ADD COLUMN Metadata TEXT NULL
    `);
  } catch {
    // Column already exists — safe to ignore
  }

  readoutTableReady.add(db);
}

// ─── Map files table ────────────────────────────────────────

const mapFilesTableReady = new Set<string>();

export async function ensureMapFilesTable(
  client: PrismaClient,
): Promise<void> {
  const db = currentDbName ?? "";
  if (mapFilesTableReady.has(db)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_map_files (
      Id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      FileName   VARCHAR(255) NOT NULL DEFAULT '',
      FileData   LONGBLOB NOT NULL,
      UploadedAt TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  mapFilesTableReady.add(db);
}

// ─── Raw competition DB connection ─────────────────────────

/**
 * Get a raw mysql2 connection to the current competition database.
 * Used for operations that need explicit table locking (e.g., counter increment).
 */
async function getCompetitionDbConnection(
  dbName?: string,
): Promise<mysql.Connection> {
  const targetDb = dbName ?? currentDbName ?? getDbNameFromUrl();
  if (!targetDb) {
    throw new Error("No competition database selected");
  }
  const remote = await getRemoteConnection(targetDb);
  const url = buildDbUrl(targetDb, remote);
  return mysql.createConnection(url);
}

// ─── MeOS Counter increment ────────────────────────────────

/**
 * Valid table names for Counter tracking (matching oCounter columns).
 */
type CounterTable = "oControl" | "oCourse" | "oClass" | "oCard" | "oClub" | "oPunch" | "oRunner" | "oTeam" | "oEvent";

/**
 * Atomically increment the Counter for a record in a MeOS table.
 * This enables multi-client sync: MeOS clients can detect changes by
 * comparing Counter values in the oCounter table.
 *
 * Uses LOCK TABLES ... WRITE around the SELECT MAX + UPDATE to match
 * MeOS's atomic counter increment pattern (see MeosSQL.cpp:updateCounter).
 * A raw mysql2 connection is used instead of Prisma to guarantee that
 * LOCK/UNLOCK/queries all execute on the same connection.
 *
 * Call this after any Prisma create/update on a MeOS table.
 *
 * @param table    - The table name (e.g. "oRunner")
 * @param recordId - The Id of the record that was changed
 */
export async function incrementCounter(
  table: CounterTable,
  recordId: number,
): Promise<void> {
  const conn = await getCompetitionDbConnection();
  try {
    // Note: LOCK/UNLOCK TABLES are not supported in the prepared statement
    // protocol, so we use conn.query() (text protocol) for all statements
    // in this function to keep everything on the same connection+protocol.

    // 1. Lock the table (matching MeOS: LOCK TABLES {table} WRITE)
    await conn.query(`LOCK TABLES \`${table}\` WRITE`);

    // 2. Get the next counter value
    const [rows] = await conn.query(
      `SELECT COALESCE(MAX(Counter), 0) as maxCounter FROM \`${table}\``,
    );
    const nextCounter =
      (Number((rows as mysql.RowDataPacket[])[0]?.maxCounter) || 0) + 1;

    // 3. Update the record's Counter
    await conn.query(
      `UPDATE \`${table}\` SET Counter = ${Number(nextCounter)} WHERE Id = ${Number(recordId)}`,
    );

    // 4. Unlock the table
    await conn.query(`UNLOCK TABLES`);

    // 5. Update oCounter tracking table (outside lock, matching MeOS)
    await conn.query(
      `UPDATE oCounter SET \`${table}\` = GREATEST(${Number(nextCounter)}, COALESCE(\`${table}\`, 0))`,
    );
  } finally {
    await conn.end();
  }
}

// ─── Shutdown ──────────────────────────────────────────────

/** Graceful shutdown */
export async function disconnectAll(): Promise<void> {
  await stopMonitorHeartbeat();
  if (competitionClient) {
    await competitionClient.$disconnect();
    competitionClient = null;
    currentDbName = null;
    logoTableReady.clear();
    remoteConnectionCache = null;
  }
}
