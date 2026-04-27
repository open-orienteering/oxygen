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

// Prisma clients cached by competition database name (one per competition)
const competitionClients = new Map<string, PrismaClient>();

// In-memory cache of stored remote connections (NameId → connection info)
let remoteConnectionCache: Map<string, DbConnectionInfo> | null = null;

// Listeners called when a new map is uploaded (to invalidate caches)
const mapUploadListeners: ((nameId: string) => void)[] = [];
export function onMapUpload(cb: (nameId: string) => void) { mapUploadListeners.push(cb); }
export function fireMapUpload(nameId: string) { for (const cb of mapUploadListeners) cb(nameId); }

// oMonitor heartbeat state — one handle per competition database
interface MonitorHandle {
  id: number;
  interval: ReturnType<typeof setInterval>;
  conn: mysql.Connection;
}
const monitorHandles = new Map<string, MonitorHandle>();

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

/**
 * Resolve the host/port/user/password/database for a competition database.
 * Honours per-competition remote connections stored in MeOSMain, falling back
 * to DATABASE_URL for local competitions. Used by backup/restore and other
 * CLI-style operations that need raw connection parameters.
 */
export async function getCompetitionConnectionParams(
  nameId: string,
): Promise<{
  host: string;
  port: number;
  user?: string;
  password?: string;
  database: string;
}> {
  const remote = await getRemoteConnection(nameId);
  const url = buildDbUrl(nameId, remote);
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 3306,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    database: u.pathname.replace(/^\//, "") || nameId,
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
 * No-ops if a heartbeat for this dbName is already running.
 */
async function startMonitorHeartbeat(dbName: string): Promise<void> {
  if (monitorHandles.has(dbName)) return; // already running for this DB

  let conn: mysql.Connection | null = null;
  try {
    conn = await getCompetitionDbConnection(dbName);

    const [result] = await conn.execute<mysql.ResultSetHeader>(
      "INSERT INTO oMonitor (Count, Client, Modified) VALUES (1, 'Oxygen', NOW())",
    );
    const id = result.insertId;
    console.log(`  [monitor] Registered as client #${id} in ${dbName}`);

    const interval = setInterval(async () => {
      const handle = monitorHandles.get(dbName);
      if (!handle) return;
      try {
        await handle.conn.execute(
          "UPDATE oMonitor SET Count = Count + 1, Client = 'Oxygen', Modified = NOW() WHERE Id = ?",
          [handle.id],
        );
      } catch {
        // Connection may have been lost; stop heartbeat silently
        await stopMonitorHeartbeat(dbName);
      }
    }, MONITOR_INTERVAL_MS);

    monitorHandles.set(dbName, { id, interval, conn });
  } catch (err) {
    // oMonitor table may not exist (e.g. test databases).
    // This is non-critical — just skip registration.
    console.warn(`  [monitor] Failed to register in ${dbName}:`, err);
    if (conn) { try { await conn.end(); } catch { /* ignore */ } }
  }
}

/**
 * Stop the oMonitor heartbeat for a specific competition (or all if no dbName given).
 */
async function stopMonitorHeartbeat(dbName?: string): Promise<void> {
  const toStop = dbName ? [dbName] : [...monitorHandles.keys()];
  for (const name of toStop) {
    const handle = monitorHandles.get(name);
    if (!handle) continue;
    clearInterval(handle.interval);
    try {
      await handle.conn.execute(
        "UPDATE oMonitor SET Removed = 1, Modified = NOW() WHERE Id = ?",
        [handle.id],
      );
      console.log(`  [monitor] Unregistered client #${handle.id}`);
    } catch { /* ignore */ }
    try { await handle.conn.end(); } catch { /* ignore */ }
    monitorHandles.delete(name);
  }
}

// ─── Competition Prisma client ─────────────────────────────

/**
 * Get or create the Prisma client for a specific competition database.
 * Multiple clients are cached simultaneously (one per competition).
 * Automatically checks for stored remote connections.
 * Also starts the oMonitor heartbeat to register Oxygen as a connected client.
 */
export async function getCompetitionClient(
  dbName: string,
): Promise<PrismaClient> {
  const existing = competitionClients.get(dbName);
  if (existing) return existing;

  // Check if this competition has a remote connection
  const remote = await getRemoteConnection(dbName);
  const url = buildDbUrl(dbName, remote);

  const client = new PrismaClient({
    datasources: {
      db: { url },
    },
  });

  await client.$connect();
  competitionClients.set(dbName, client);

  // Start oMonitor heartbeat for this database (fire-and-forget)
  startMonitorHeartbeat(dbName).catch(() => {});

  return client;
}

/**
 * Remove a cached competition client and clear its ensure-caches.
 * Use this in tests to allow a fresh setup of the same database.
 */
export async function clearCachedClient(dbName: string): Promise<void> {
  await stopMonitorHeartbeat(dbName);
  const client = competitionClients.get(dbName);
  if (client) {
    try { await client.$disconnect(); } catch { /* ignore */ }
    competitionClients.delete(dbName);
  }
  logoTableReady.delete(dbName);
  readoutTableReady.delete(dbName);
  mapFilesTableReady.delete(dbName);
  controlConfigTableReady.delete(dbName);
  controlPunchesTableReady.delete(dbName);
  controlUnitsTableReady.delete(dbName);
  competitionConfigTableReady.delete(dbName);
  renderedMapsTableReady.delete(dbName);
  mapTilesTableReady.delete(dbName);
  tracksTableReady.delete(dbName);
  routesTableReady.delete(dbName);
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
  // Version must be >= 89 to prevent MeOS from running upgradeTimeFormat()
  // which multiplies all time columns by 10 (seconds→deciseconds migration).
  // Oxygen already stores deciseconds, so the upgrade would corrupt all times.
  // MeOS current dbVersion is 96.
  const MEOS_DB_VERSION = 96;
  const mainConn = await getTargetMainConn();
  let eventId: number;
  try {
    const [result] = await mainConn.execute(
      "INSERT INTO oEvent (Name, Date, NameId, Version) VALUES (?, ?, ?, ?)",
      [eventName, eventDate, dbName, MEOS_DB_VERSION],
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
        "INSERT IGNORE INTO oEvent (Name, Date, NameId, Version) VALUES (?, ?, ?, ?)",
        [eventName, eventDate, dbName, MEOS_DB_VERSION],
      );
    } finally {
      await localConn.end();
    }
    await storeRemoteConnection(dbName, remote);
  }

  // 4. Also insert the oEvent record inside the competition database itself.
  //    The Id must match MeOSMain.oEvent.Id so MeOS can find it.
  const client = await getCompetitionClient(dbName);
  await client.oEvent.create({
    data: {
      Id: eventId,
      Name: eventName,
      Date: eventDate,
      NameId: dbName,
      ZeroTime: 324000, // 09:00:00 in deciseconds (MeOS default zero hour)
      Organizer: "",
      EMail: "",
      Homepage: "",
      Lists: "",
      Machine: "",
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
      ExtId BIGINT NOT NULL DEFAULT 0,
      Modified timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB CHARACTER SET utf8 COLLATE utf8_general_ci
  `);
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS dbClub (
      Id INT NOT NULL,
      Name VARCHAR(64) NOT NULL DEFAULT '',
      Modified timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB CHARACTER SET utf8 COLLATE utf8_general_ci
  `);
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oImage (
      Id BIGINT UNSIGNED DEFAULT NULL,
      Filename TEXT,
      Image LONGBLOB
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3
  `);

  // 7. Set up Oxygen-specific config table + columns on the fresh database
  //    so that the first dashboard/getRegistrationConfig request doesn't race.
  await ensureCompetitionConfigTable(client, dbName);

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
  dbName: string,
): Promise<void> {
  if (logoTableReady.has(dbName)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_club_logo (
      EventorId  INT NOT NULL PRIMARY KEY,
      SmallPng   MEDIUMBLOB NOT NULL,
      LargePng   MEDIUMBLOB NULL,
      UpdatedAt  TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  logoTableReady.add(dbName);
}

// ─── Card readout history table ────────────────────────────

const readoutTableReady = new Set<string>();

export async function ensureReadoutTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  if (readoutTableReady.has(dbName)) return;

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

  // One-shot voltage encoding migration (idempotent).
  await migrateVoltageToMillivolts(client);

  readoutTableReady.add(dbName);
}

/**
 * Migrate any rows still using legacy voltage encodings to integer millivolts.
 *
 * - `oCard.Voltage`: older Oxygen versions wrote raw SIAC ADC bytes (1..255),
 *   but MeOS expects millivolts. Convert via `mV = 1900 + raw × 90`.
 * - `oxygen_card_readouts.Voltage`: older Oxygen versions wrote hundredths of
 *   a volt (≤ ~330). Convert via `mV = raw × 10`.
 *
 * Real battery readings always exceed ~2 V, so the value-range checks below
 * unambiguously identify legacy rows. The migration is safe to run repeatedly.
 */
async function migrateVoltageToMillivolts(client: PrismaClient): Promise<void> {
  try {
    await client.$executeRawUnsafe(
      `UPDATE oCard SET Voltage = 1900 + Voltage * 90 WHERE Voltage > 0 AND Voltage < 256`,
    );
  } catch {
    // Non-fatal — oCard always exists in MeOS-shaped DBs, but be defensive.
  }
  try {
    await client.$executeRawUnsafe(
      `UPDATE oxygen_card_readouts SET Voltage = Voltage * 10 WHERE Voltage > 0 AND Voltage < 1000`,
    );
  } catch {
    // Non-fatal — table was just ensured above.
  }
}

// ─── Map files table ────────────────────────────────────────

const mapFilesTableReady = new Set<string>();

export async function ensureMapFilesTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  if (mapFilesTableReady.has(dbName)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_map_files (
      Id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      FileName   VARCHAR(255) NOT NULL DEFAULT '',
      FileData   LONGBLOB NOT NULL,
      UploadedAt TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  mapFilesTableReady.add(dbName);
}

// ─── Rendered maps cache table ──────────────────────────────

const renderedMapsTableReady = new Set<string>();

export async function ensureRenderedMapsTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  if (renderedMapsTableReady.has(dbName)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_rendered_maps (
      Id         INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      MaxWidth   INT NOT NULL,
      ImageData  LONGBLOB NOT NULL,
      Bounds     TEXT NOT NULL,
      MapScale   INT NOT NULL DEFAULT 0,
      Width      INT NOT NULL DEFAULT 0,
      Height     INT NOT NULL DEFAULT 0,
      RenderedAt TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  renderedMapsTableReady.add(dbName);
}

// ─── Map tiles cache table ─────────────────────────────────

const mapTilesTableReady = new Set<string>();

export async function ensureMapTilesTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  if (mapTilesTableReady.has(dbName)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_map_tiles (
      Id       INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      Z        INT NOT NULL,
      X        INT NOT NULL,
      Y        INT NOT NULL,
      TileData MEDIUMBLOB NOT NULL,
      UNIQUE KEY tile_zxy (Z, X, Y)
    )
  `);
  mapTilesTableReady.add(dbName);
}

// ─── Control config table ──────────────────────────────────

const controlConfigTableReady = new Set<string>();

export async function ensureControlConfigTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  if (controlConfigTableReady.has(dbName)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_control_config (
      control_id        INT NOT NULL PRIMARY KEY,
      radio_type        VARCHAR(20) NOT NULL DEFAULT 'normal',
      air_plus          VARCHAR(10) NOT NULL DEFAULT 'default',
      battery_voltage   FLOAT NULL,
      battery_low       TINYINT(1) NULL,
      checked_at        TIMESTAMP(0) NULL,
      memory_cleared_at TIMESTAMP(0) NULL,
      station_serial    INT NULL
    )
  `);
  controlConfigTableReady.add(dbName);
}

// ─── Control physical units table ──────────────────────────

const controlUnitsTableReady = new Set<string>();

/**
 * Ensure the oxygen_control_units table exists. Each row represents a physical
 * SI station (identified by hardware serial) and optionally maps to a logical
 * oControl. Battery, checked_at, last programmed code etc. are tracked per
 * unit, so two physical units fulfilling the same logical control don't
 * overwrite each other's state. On first run, back-fills from the legacy
 * oxygen_control_config and oxygen_control_punches tables.
 */
export async function ensureControlUnitsTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  if (controlUnitsTableReady.has(dbName)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_control_units (
      station_serial       INT UNSIGNED NOT NULL PRIMARY KEY,
      control_id           INT NULL,
      last_programmed_code INT NULL,
      battery_voltage      FLOAT NULL,
      battery_low          TINYINT(1) NOT NULL DEFAULT 0,
      checked_at           DATETIME NULL,
      memory_cleared_at    DATETIME NULL,
      firmware_version     VARCHAR(16) NULL,
      last_seen_at         DATETIME NULL,
      created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_control_id (control_id)
    )
  `);

  // Backfill from oxygen_control_config (one unit per config row that has a
  // serial). Only inserts if the row doesn't exist yet — safe to run repeatedly.
  try {
    await client.$executeRawUnsafe(`
      INSERT IGNORE INTO oxygen_control_units
        (station_serial, control_id, last_programmed_code,
         battery_voltage, battery_low, checked_at, memory_cleared_at)
      SELECT cc.station_serial, cc.control_id,
             CAST(SUBSTRING_INDEX(c.Numbers, ';', 1) AS UNSIGNED),
             cc.battery_voltage, COALESCE(cc.battery_low, 0),
             cc.checked_at, cc.memory_cleared_at
      FROM oxygen_control_config cc
      LEFT JOIN oControl c ON c.Id = cc.control_id
      WHERE cc.station_serial IS NOT NULL
    `);
  } catch {
    // oxygen_control_config may not exist yet on a brand-new database — ignore.
  }

  // Backfill from oxygen_control_punches: for each distinct (control_id,
  // station_serial) pair, create a unit row with last_seen_at = MAX(imported_at).
  try {
    await client.$executeRawUnsafe(`
      INSERT IGNORE INTO oxygen_control_units
        (station_serial, control_id, last_seen_at)
      SELECT station_serial, control_id, MAX(imported_at)
      FROM oxygen_control_punches
      WHERE station_serial IS NOT NULL
      GROUP BY station_serial, control_id
    `);
  } catch {
    // oxygen_control_punches may not exist yet — ignore.
  }

  controlUnitsTableReady.add(dbName);
}

// ─── Control backup punches table ──────────────────────────

const controlPunchesTableReady = new Set<string>();

export async function ensureControlPunchesTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  if (controlPunchesTableReady.has(dbName)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_control_punches (
      id              INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      control_id      INT NOT NULL,
      card_no         INT NOT NULL,
      punch_time      INT NOT NULL COMMENT 'deciseconds since midnight (MeOS format)',
      punch_datetime  DATETIME(3) NULL COMMENT 'full punch datetime from backup record',
      sub_second      TINYINT UNSIGNED NULL COMMENT 'raw sub-second fraction 0-255',
      station_serial  INT UNSIGNED NULL COMMENT 'SI station hardware serial number',
      imported_at     TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      pushed_to_punch TINYINT(1) NOT NULL DEFAULT 0,
      INDEX idx_control (control_id)
    )
  `);
  // Add columns if table already exists from previous version
  try {
    await client.$executeRawUnsafe(
      `ALTER TABLE oxygen_control_punches ADD COLUMN punch_datetime DATETIME(3) NULL AFTER punch_time`,
    );
  } catch { /* column already exists */ }
  try {
    await client.$executeRawUnsafe(
      `ALTER TABLE oxygen_control_punches ADD COLUMN sub_second TINYINT UNSIGNED NULL AFTER punch_datetime`,
    );
  } catch { /* column already exists */ }
  try {
    await client.$executeRawUnsafe(
      `ALTER TABLE oxygen_control_punches ADD COLUMN station_serial INT UNSIGNED NULL AFTER sub_second`,
    );
  } catch { /* column already exists */ }
  controlPunchesTableReady.add(dbName);
}

// ─── Competition config table ──────────────────────────────

const competitionConfigTableReady = new Set<string>();
const competitionConfigTablePending = new Map<string, Promise<void>>();

export async function ensureCompetitionConfigTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  if (competitionConfigTableReady.has(dbName)) return;

  // Prevent concurrent callers from running DDL in parallel (race on fresh DBs)
  const pending = competitionConfigTablePending.get(dbName);
  if (pending) return pending;

  const promise = _doEnsureCompetitionConfigTable(client, dbName);
  competitionConfigTablePending.set(dbName, promise);
  try {
    await promise;
  } finally {
    competitionConfigTablePending.delete(dbName);
  }
}

async function _doEnsureCompetitionConfigTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_competition_config (
      id          INT NOT NULL PRIMARY KEY DEFAULT 1,
      air_plus    TINYINT(1) NOT NULL DEFAULT 0,
      awake_hours INT NOT NULL DEFAULT 6
    )
  `);

  // Ensure default row exists
  await client.$executeRawUnsafe(`
    INSERT IGNORE INTO oxygen_competition_config (id, air_plus, awake_hours) VALUES (1, 0, 6)
  `);

  // Migration: add awake_hours column if table existed before this column was added
  try {
    await client.$executeRawUnsafe(
      `ALTER TABLE oxygen_competition_config ADD COLUMN awake_hours INT NOT NULL DEFAULT 6`,
    );
  } catch {
    // Column already exists — ignore
  }

  // Migration: add registration/payment columns
  const regColumns = [
    `payment_methods VARCHAR(255) NOT NULL DEFAULT 'billed'`,
    `swish_number VARCHAR(20) NOT NULL DEFAULT ''`,
    `swish_payee_name VARCHAR(100) NOT NULL DEFAULT ''`,
    `print_registration_receipt TINYINT(1) NOT NULL DEFAULT 0`,
    `registration_receipt_message VARCHAR(500) NOT NULL DEFAULT ''`,
    `finish_receipt_message VARCHAR(500) NOT NULL DEFAULT ''`,
    `organizer_eventor_id INT NOT NULL DEFAULT 0`,
  ];
  for (const col of regColumns) {
    try {
      await client.$executeRawUnsafe(
        `ALTER TABLE oxygen_competition_config ADD COLUMN ${col}`,
      );
    } catch {
      // Column already exists — ignore
    }
  }

  // Migration: add receipt/kvitto columns for friskvardsbidrag
  const receiptColumns = [
    `org_number VARCHAR(20) NOT NULL DEFAULT ''`,
    `vat_exempt TINYINT(1) NOT NULL DEFAULT 1`,
    `receipt_friskvard_note TINYINT(1) NOT NULL DEFAULT 0`,
    `web_url VARCHAR(255) NOT NULL DEFAULT ''`,
  ];
  for (const col of receiptColumns) {
    try {
      await client.$executeRawUnsafe(
        `ALTER TABLE oxygen_competition_config ADD COLUMN ${col}`,
      );
    } catch {
      // Column already exists — ignore
    }
  }

  // Migration: add Google Sheets backup webhook URL
  try {
    await client.$executeRawUnsafe(
      `ALTER TABLE oxygen_competition_config ADD COLUMN google_sheets_webhook_url VARCHAR(500) NOT NULL DEFAULT ''`,
    );
  } catch {
    // Column already exists — ignore
  }

  // Migration: add Livelox event ID for GPS route sync
  try {
    await client.$executeRawUnsafe(
      `ALTER TABLE oxygen_competition_config ADD COLUMN livelox_event_id INT NULL`,
    );
  } catch {
    // Column already exists — ignore
  }

  // Migration: add Oxygen-only rental card return tracking column
  try {
    await client.$executeRawUnsafe(
      `ALTER TABLE oRunner ADD COLUMN oos_card_returned TINYINT(1) NOT NULL DEFAULT 0`,
    );
  } catch {
    // Column already exists — ignore
  }

  // Ensure oRunner has a CardNo index for fast lookups and duplicate checks
  try {
    await client.$executeRawUnsafe(
      `CREATE INDEX idx_runner_cardno ON oRunner (CardNo)`,
    );
  } catch {
    // Index already exists — ignore
  }

  // Migration: add Modified column to dbRunner/dbClub for MeOS 4.x SYNCREAD compatibility
  for (const table of [`dbRunner`, `dbClub`]) {
    try {
      await client.$executeRawUnsafe(
        `ALTER TABLE \`${table}\` ADD COLUMN Modified timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP`,
      );
    } catch {
      // Column already exists — ignore
    }
  }

  competitionConfigTableReady.add(dbName);
}

// ─── GPS tracks table ─────────────────────────────────────

const tracksTableReady = new Set<string>();

export async function ensureTracksTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  if (tracksTableReady.has(dbName)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_tracks (
      Id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      DeviceId    VARCHAR(255) NOT NULL,
      TrackName   VARCHAR(255) NOT NULL DEFAULT '',
      StartTime   BIGINT NOT NULL,
      EndTime     BIGINT NULL,
      Distance    DOUBLE NOT NULL DEFAULT 0,
      PointCount  INT NOT NULL DEFAULT 0,
      Geometry    LONGTEXT NOT NULL,
      UploadedAt  TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UpdatedAt   TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_device_track (DeviceId, StartTime)
    )
  `);
  tracksTableReady.add(dbName);
}

// ─── GPS routes table (Livelox / GPX / device) ─────────────

const routesTableReady = new Set<string>();

export async function ensureRoutesTable(
  client: PrismaClient,
  dbName: string,
): Promise<void> {
  if (routesTableReady.has(dbName)) return;

  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_routes (
      Id                INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      RunnerId          INT NULL     COMMENT 'FK → oRunner.Id; NULL if no name match found',
      ClassId           INT NULL     COMMENT 'FK → oClass.Id; NULL if no match found',
      LiveloxClassId    INT NULL     COMMENT 'Livelox class ID, for re-sync',
      SourceType        VARCHAR(20)  NOT NULL DEFAULT 'livelox' COMMENT 'livelox | gps | gpx',
      Color             VARCHAR(20)  NOT NULL DEFAULT '',
      RaceStartMs       BIGINT NULL  COMMENT 'Race start epoch ms',
      WaypointsJson     LONGTEXT     NOT NULL COMMENT 'JSON [{timeMs,lat,lng}]',
      InterruptionsJson TEXT         NULL COMMENT 'JSON array of waypoint indices',
      ResultJson        TEXT         NULL COMMENT 'JSON of {status,timeMs,rank,splitTimes}',
      SyncedAt          TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_runner  (RunnerId),
      INDEX idx_class   (ClassId),
      INDEX idx_livelox (LiveloxClassId)
    )
  `);
  routesTableReady.add(dbName);
}

// ─── Raw competition DB connection ─────────────────────────

/**
 * Get a raw mysql2 connection to a specific competition database.
 * Used for operations that need explicit table locking (e.g., counter increment).
 */
async function getCompetitionDbConnection(
  dbName: string,
): Promise<mysql.Connection> {
  const remote = await getRemoteConnection(dbName);
  const url = buildDbUrl(dbName, remote);
  return mysql.createConnection(url);
}

/**
 * Get a raw mysql2 connection to a specific competition database with
 * `multipleStatements: true` enabled. Used for bulk DDL/DML dumps
 * (e.g. seeding the showcase fixture for docs screenshots).
 *
 * Callers must end the returned connection.
 */
export async function getCompetitionMultiStatementConnection(
  dbName: string,
): Promise<mysql.Connection> {
  const remote = await getRemoteConnection(dbName);
  const url = buildDbUrl(dbName, remote);
  return mysql.createConnection({
    ...parseMysqlUrl(url),
    multipleStatements: true,
  });
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
/**
 * Get the competition's ZeroTime (reference point for all MeOS time values).
 * MeOS stores all times relative to ZeroTime. Default is 324000 (09:00:00).
 */
export async function getZeroTime(client: PrismaClient): Promise<number> {
  const event = await client.oEvent.findFirst({
    where: { Removed: false },
    select: { ZeroTime: true },
  });
  return event?.ZeroTime ?? 324000;
}

/**
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
  dbName: string,
): Promise<void> {
  const conn = await getCompetitionDbConnection(dbName);
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

    // 3. Update the record's Counter (parameterized for safety)
    await conn.query(
      `UPDATE \`${table}\` SET Counter = ? WHERE Id = ?`,
      [Number(nextCounter), Number(recordId)],
    );

    // 4. Unlock the table
    await conn.query(`UNLOCK TABLES`);

    // 5. Update oCounter tracking table (outside lock, matching MeOS)
    await conn.query(
      `UPDATE oCounter SET \`${table}\` = GREATEST(?, COALESCE(\`${table}\`, 0))`,
      [Number(nextCounter)],
    );
  } finally {
    await conn.end();
  }
}

/**
 * Batch version of incrementCounter — assigns sequential Counter values to
 * multiple records in a single LOCK/UNLOCK cycle instead of one per record.
 */
export async function incrementCounterBatch(
  table: CounterTable,
  recordIds: number[],
  dbName: string,
): Promise<void> {
  if (recordIds.length === 0) return;
  if (recordIds.length === 1) return incrementCounter(table, recordIds[0], dbName);

  const conn = await getCompetitionDbConnection(dbName);
  try {
    await conn.query(`LOCK TABLES \`${table}\` WRITE`);

    const [rows] = await conn.query(
      `SELECT COALESCE(MAX(Counter), 0) as maxCounter FROM \`${table}\``,
    );
    const baseCounter =
      (Number((rows as mysql.RowDataPacket[])[0]?.maxCounter) || 0) + 1;

    // Build CASE expression to assign sequential counters
    const cases = recordIds
      .map((id, i) => `WHEN Id = ${Number(id)} THEN ${baseCounter + i}`)
      .join(" ");
    const idList = recordIds.map((id) => Number(id)).join(",");
    await conn.query(
      `UPDATE \`${table}\` SET Counter = CASE ${cases} END WHERE Id IN (${idList})`,
    );

    await conn.query(`UNLOCK TABLES`);

    const finalCounter = baseCounter + recordIds.length - 1;
    await conn.query(
      `UPDATE oCounter SET \`${table}\` = GREATEST(?, COALESCE(\`${table}\`, 0))`,
      [finalCounter],
    );
  } finally {
    await conn.end();
  }
}

// ─── Shutdown ──────────────────────────────────────────────

/** Graceful shutdown — disconnects all cached competition clients */
export async function disconnectAll(): Promise<void> {
  await stopMonitorHeartbeat(); // stops all heartbeats
  for (const [, client] of competitionClients) {
    try { await client.$disconnect(); } catch { /* ignore */ }
  }
  competitionClients.clear();
  logoTableReady.clear();
  readoutTableReady.clear();
  mapFilesTableReady.clear();
  controlConfigTableReady.clear();
  controlPunchesTableReady.clear();
  controlUnitsTableReady.clear();
  competitionConfigTableReady.clear();
  renderedMapsTableReady.clear();
  mapTilesTableReady.clear();
  tracksTableReady.clear();
  routesTableReady.clear();
  remoteConnectionCache = null;
}
