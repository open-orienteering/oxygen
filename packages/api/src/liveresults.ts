/**
 * LiveResults push pipeline.
 *
 * Streams start lists, final results and radio splits to the
 * liveresultat.orientering.se MySQL database. Each enabled event owns
 * one `setInterval` timer; we share a single mysql2 pool across events
 * since the remote credentials are tenant-wide and frequently rotated.
 *
 * Wire format reference: legacy MeOS-era pump in git history (commit
 * e83654a). The wire shape is unchanged — only the Oxygen-side reads
 * are re-pointed at the new schema.
 *
 *   - Times go on the wire in **centiseconds**; the DB stores
 *     ZeroTime-relative deciseconds, so we `toAbsolute(...) * 10`.
 *   - Status maps from the new `RunnerStatus` enum via
 *     `runnerStatusToValue` (numeric) into LiveResults' 0/1/2/3/4/5/9.
 *   - Radio controls are identified by `controls.radio_type !== "normal"`.
 *     LiveResults stores them as `visit × 1000 + punchCode` (first punch
 *     of 82 → 1082, second → 2082). We encode the same way so MeOS and
 *     the official uploader can share a competition without ghost radio
 *     columns. The visit index is the Nth occurrence of that punch code
 *     on the *whole* course, not just among radios.
 *
 * The push pipeline is intentionally a fire-and-forget background task:
 * any sync error is captured into `state.lastError` and surfaced via the
 * `liveresults.getStatus` query — the timer keeps running on a best-
 * effort basis.
 */

import { createHash } from "node:crypto";
import mysql from "mysql2/promise";
import { prisma, getSetting, setSetting } from "./db.js";
import { toAbsolute, hasTime } from "./timeConvert.js";
import { runnerStatusToValue } from "./statusConvert.js";
import { RunnerStatus, runningTimeDs } from "@oxygen/shared";

const CONFIG_ENDPOINT =
  "https://liveresultat.orientering.se/configs/getConnectionSettings.php";
const CONFIG_KEY = "liveemmaclient";
const FINISH_CONTROL = 1000;

// ─── Wire status mapping ───────────────────────────────────

/**
 * Oxygen status (numeric, after statusConvert) → LiveResults status.
 *
 * LiveResults code book:
 *   0 = OK / has finish time
 *   1 = DNS                       (Cancel maps here too)
 *   2 = DNF
 *   3 = MP (missing punch)
 *   4 = DSQ
 *   5 = OT (over max time / "out of competition")
 *   9 = not started / not yet finished
 */
export function mapStatus(oxygenStatus: number, finishTime: number): number {
  if (oxygenStatus === RunnerStatus.OK) return 0;
  if (oxygenStatus === RunnerStatus.NoTiming) return 0;
  if (oxygenStatus === RunnerStatus.MissingPunch) return 3;
  if (oxygenStatus === RunnerStatus.DNF) return 2;
  if (oxygenStatus === RunnerStatus.DQ) return 4;
  if (oxygenStatus === RunnerStatus.OverMaxTime) return 5;
  if (oxygenStatus === RunnerStatus.OutOfCompetition) return 5;
  if (oxygenStatus === RunnerStatus.DNS) return 1;
  if (oxygenStatus === RunnerStatus.Cancel) return 1;
  if (oxygenStatus === RunnerStatus.NotCompeting) return 9;
  if (hasTime(finishTime)) return 0;
  return 9;
}

/**
 * The start row (absolute, centiseconds) and the finish row's elapsed time
 * (centiseconds) LiveResults gets for a runner, from the stored
 * ZeroTime-relative start and finish. A start before ZeroTime is negative
 * when stored and still a start (RES-05); a finish after midnight still
 * gives the real running time (RES-16).
 */
export function liveResultsTimes(
  startRel: number,
  finishRel: number,
  zeroTime: number,
): { startCenti: number | null; elapsedCenti: number } {
  const startAbs = toAbsolute(startRel, zeroTime);
  const finishAbs = toAbsolute(finishRel, zeroTime);
  return {
    startCenti: hasTime(startRel) ? startAbs * 10 : null,
    elapsedCenti: runningTimeDs(startAbs, finishAbs) * 10,
  };
}

/**
 * LiveResults radio / split control identity. Visit is 1-based and
 * counts every time `punchCode` appears on the course (or in the
 * runner's punch sequence).
 */
export function liveResultsRadioCode(punchCode: number, visit: number): number {
  if (visit < 1) {
    throw new Error(`LiveResults radio visit must be >= 1, got ${visit}`);
  }
  return visit * 1000 + punchCode;
}

export interface CourseControlForRadio {
  codes: string;
  radioType: string;
  name: string;
}

export interface EncodedRadioControl {
  punchCode: number;
  encoded: number;
  name: string;
}

/**
 * Walk a course in order and emit the radio controls with LiveResults
 * visit encoding. A radio that is the second 82 on the course becomes
 * 2082 even if the first 82 was a normal control.
 */
export function radioControlsFromCourse(
  courseControls: CourseControlForRadio[],
): EncodedRadioControl[] {
  const visitByCode = new Map<number, number>();
  const radios: EncodedRadioControl[] = [];
  for (const ctrl of courseControls) {
    const punchCode = parseInt((ctrl.codes ?? "").split(";")[0], 10);
    if (!Number.isFinite(punchCode)) continue;
    const visit = (visitByCode.get(punchCode) ?? 0) + 1;
    visitByCode.set(punchCode, visit);
    if (!ctrl.radioType || ctrl.radioType === "normal") continue;
    radios.push({
      punchCode,
      encoded: liveResultsRadioCode(punchCode, visit),
      name: ctrl.name || String(punchCode),
    });
  }
  return radios;
}

export interface PunchForRadio {
  controlCode: number;
  time: number;
}

/**
 * Map a runner's punches onto the class's encoded radio slots. Extra
 * punches of the same code (redundant radio units) whose visit number
 * is not on the course are dropped.
 */
export function encodedRadioPunches(
  punches: PunchForRadio[],
  expectedEncoded: Iterable<number>,
): Array<{ encoded: number; time: number }> {
  const expected = new Set(expectedEncoded);
  const visitByCode = new Map<number, number>();
  const out: Array<{ encoded: number; time: number }> = [];
  for (const p of punches) {
    const visit = (visitByCode.get(p.controlCode) ?? 0) + 1;
    visitByCode.set(p.controlCode, visit);
    const encoded = liveResultsRadioCode(p.controlCode, visit);
    if (!expected.has(encoded)) continue;
    out.push({ encoded, time: p.time });
  }
  return out;
}

/** 32-char hex md5 — the shape every official LiveResults client writes. */
export function hashLiveResultsCredential(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex");
}

/**
 * Class names whose `splitcontrols` rows we own. A sync must DELETE
 * only these, never every row for the tavid — MeOS (and other
 * uploaders) store radios under different class names on the same
 * competition.
 */
export function splitcontrolClassnamesToReplace(
  classes: Array<{ name: string }>,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const cls of classes) {
    const name = cls.name.slice(0, 50);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

// ─── Connection pool (process-wide, credentials cached) ─────

/** How long a fetched connection string is trusted before it is fetched again. */
const CONNECTION_STRING_TTL_MS = 10 * 60_000;
const CONFIG_FETCH_TIMEOUT_MS = 10_000;
/** Per-statement client-side timeout; a stalled WAN query frees its slot. */
const STATEMENT_TIMEOUT_MS = 15_000;

let pool: mysql.Pool | null = null;
let poolCredentials: string | null = null;
let poolFetchedAt = 0;
/** A connection error was seen: a failed refetch must not fall back to this pool. */
let poolSuspect = false;
/** After a failed refetch with a working pool, try again this much later. */
const REFETCH_RETRY_MS = 60_000;
/** How long an old pool's connections may finish their cycle after a swap. */
const OLD_POOL_GRACE_MS = 300_000;

export interface LiveResultsCredentials {
  host: string;
  user: string;
  password: string;
  database: string;
}

/**
 * The config endpoint answers `host;user;password;database`. Anything else
 * (an HTML error page, a proxy's 502 body, "Wrong key") is refused before it
 * can touch the working pool (EVT-16).
 */
export function parseConnectionString(text: string): LiveResultsCredentials {
  const parts = text.trim().split(";");
  if (parts.length !== 4 || parts.some((p) => p.trim().length === 0)) {
    throw new Error("Unexpected LiveResults connection settings");
  }
  const [host, user, password, database] = parts.map((p) => p.trim());
  return { host, user, password, database };
}

async function fetchConnectionString(): Promise<string> {
  const resp = await fetch(CONFIG_ENDPOINT, {
    method: "POST",
    body: new URLSearchParams({ key: CONFIG_KEY }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(CONFIG_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`Failed to fetch LiveResults connection settings (HTTP ${resp.status})`);
  }
  const text = (await resp.text()).trim();
  if (!text || text === "Wrong key") {
    throw new Error("Failed to fetch LiveResults connection settings");
  }
  parseConnectionString(text);
  return text;
}

/** MySQL errors that mean the cached credentials or host may be stale. */
const CONNECTION_ERROR_CODES = new Set([
  "ER_ACCESS_DENIED_ERROR",
  "ER_DBACCESS_DENIED_ERROR",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_SEQUENCE_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
  "EHOSTUNREACH",
]);

/** Whether the error leaves the connection unusable (or its state unknown). */
export function isConnectionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && CONNECTION_ERROR_CODES.has(code);
}

/**
 * Forget the cached connection string after a connection or auth error,
 * so the next cycle fetches it again (the remote credentials rotate).
 */
export function noteLiveResultsError(err: unknown): void {
  if (isConnectionError(err)) {
    poolFetchedAt = 0;
    poolSuspect = true;
  }
}

/**
 * The shared pool. The connection string is fetched at most every ten
 * minutes (and again after a connection error), not on every call. A
 * changed string builds the new pool first and then ends the old one in the
 * background, so a running cycle keeps its connection.
 */
export async function getLiveResultsPool(): Promise<mysql.Pool> {
  if (pool && Date.now() - poolFetchedAt < CONNECTION_STRING_TTL_MS) return pool;
  let connStr: string;
  try {
    connStr = await fetchConnectionString();
  } catch (err) {
    // The config endpoint is down but the pool has given no trouble: keep
    // pushing with it and ask again in a minute.
    if (pool && !poolSuspect) {
      poolFetchedAt = Date.now() - CONNECTION_STRING_TTL_MS + REFETCH_RETRY_MS;
      console.warn("[LiveResults] connection settings refetch failed, keeping the pool:", err);
      return pool;
    }
    throw err;
  }
  poolFetchedAt = Date.now();
  poolSuspect = false;
  if (pool && poolCredentials === connStr) return pool;
  const { host, user, password, database } = parseConnectionString(connStr);
  const next = mysql.createPool({
    host,
    user,
    password,
    database,
    port: 3306,
    connectionLimit: 5,
    queueLimit: 10,
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    charset: "utf8mb4",
  });
  const old = pool;
  pool = next;
  poolCredentials = connStr;
  // `end()` closes connections in use too: give a running cycle time to
  // finish on the old pool first.
  if (old) setTimeout(() => void old.end().catch(() => {}), OLD_POOL_GRACE_MS).unref();
  return pool;
}

/** Test seam: forget the pool and the cached connection string. */
export function _resetLiveResultsPool(): void {
  const old = pool;
  pool = null;
  poolCredentials = null;
  poolFetchedAt = 0;
  poolSuspect = false;
  if (old) void old.end().catch(() => {});
}

/** The slice of a mysql2 connection a push needs; tests pass a recorder. */
export interface LiveResultsConn {
  query<T extends mysql.RowDataPacket[] | mysql.ResultSetHeader>(
    options: mysql.QueryOptions,
    values?: unknown[],
  ): Promise<[T, mysql.FieldPacket[]]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** Close the socket now; the pool replaces the connection. */
  destroy(): void;
}

function exec<T extends mysql.RowDataPacket[] | mysql.ResultSetHeader>(
  conn: LiveResultsConn,
  sql: string,
  values: unknown[],
): Promise<[T, mysql.FieldPacket[]]> {
  return conn.query<T>({ sql, timeout: STATEMENT_TIMEOUT_MS }, values);
}

/**
 * Close a connection's socket at once. mysql2's `destroy()` ends the stream
 * politely (a FIN), which a black-holed link never delivers; destroying the
 * socket as well frees it locally. The server rolls back the open
 * transaction once it notices (its keepalive or `wait_timeout`).
 */
function hardDestroy(conn: mysql.PoolConnection): void {
  conn.destroy();
  const stream = (conn as unknown as { connection?: { stream?: { destroy?: () => void } } })
    .connection?.stream;
  stream?.destroy?.();
}

/**
 * Run `fn` on a pooled connection. A connection or auth error, at connect
 * time too, invalidates the cached connection string; a connection that hit
 * one is destroyed rather than handed back to the pool with a stalled
 * statement at the head of its queue.
 */
async function withConnection<T>(fn: (conn: LiveResultsConn) => Promise<T>): Promise<T> {
  let conn: mysql.PoolConnection;
  try {
    conn = await (await getLiveResultsPool()).getConnection();
  } catch (err) {
    noteLiveResultsError(err);
    throw err;
  }
  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    hardDestroy(conn);
  };
  const wrapped: LiveResultsConn = {
    query: (options, values) => conn.query(options, values),
    beginTransaction: () => conn.beginTransaction(),
    commit: () => conn.commit(),
    rollback: () => conn.rollback(),
    destroy,
  };
  try {
    return await fn(wrapped);
  } catch (err) {
    noteLiveResultsError(err);
    if (isConnectionError(err)) destroy();
    throw err;
  } finally {
    if (!destroyed) conn.release();
  }
}

// ─── Competition row management ────────────────────────────

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ER_DUP_ENTRY";
}

/**
 * Ensure a `login` row exists for this event. Returns the LiveResults
 * `tavid` (allocated by us, persisted on `events.liveresultsTavid`).
 *
 * `MAX(tavid) + 1` is not locked, so two clients allocating at once can pick
 * the same number: the loser's insert hits the primary key and allocates
 * again (MC-29).
 */
export async function ensureCompetition(eventId: bigint): Promise<number> {
  const event = await prisma().event.findUnique({
    where: { id: eventId },
    select: {
      name: true,
      date: true,
      liveresultsTavid: true,
      organizerName: true,
    },
  });
  if (!event) throw new Error(`Event ${eventId} not found`);
  if (event.liveresultsTavid && event.liveresultsTavid > 0) {
    return event.liveresultsTavid;
  }

  return withConnection(async (conn) => {
    let tavid = 0;
    for (let attempt = 0; ; attempt++) {
      const [rows] = await exec<mysql.RowDataPacket[]>(
        conn,
        "SELECT COALESCE(MAX(tavid), 0) + 1 AS next FROM login",
        [],
      );
      tavid = Number(rows[0].next);
      const compDate = event.date.toISOString().slice(0, 10);
      try {
        await exec(
          conn,
          `INSERT INTO login (tavid, compName, compDate, organizer, user, pass, public, timediff, country)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'SE')`,
          [
            tavid,
            event.name.slice(0, 50),
            compDate,
            (event.organizerName ?? "").slice(0, 50),
            hashLiveResultsCredential("oxygen"),
            hashLiveResultsCredential(`oxygen_${eventId}`),
          ],
        );
        break;
      } catch (err) {
        if (!isDuplicateKey(err) || attempt >= 4) throw err;
      }
    }
    await prisma().event.update({
      where: { id: eventId },
      data: { liveresultsTavid: tavid },
    });
    return tavid;
  });
}

export async function updateCompetitionMeta(
  tavid: number,
  opts: {
    compName?: string;
    organizer?: string;
    isPublic?: boolean;
    country?: string;
  },
): Promise<void> {
  await withConnection(async (conn) => {
    const parts: string[] = [];
    const vals: (string | number)[] = [];
    if (opts.compName !== undefined) {
      parts.push("compName = ?");
      vals.push(opts.compName.slice(0, 50));
    }
    if (opts.organizer !== undefined) {
      parts.push("organizer = ?");
      vals.push(opts.organizer.slice(0, 50));
    }
    if (opts.isPublic !== undefined) {
      parts.push("public = ?");
      vals.push(opts.isPublic ? 1 : 0);
    }
    if (opts.country !== undefined) {
      parts.push("country = ?");
      vals.push(opts.country.slice(0, 2));
    }
    if (parts.length === 0) return;
    vals.push(tavid);
    await exec(conn, `UPDATE login SET ${parts.join(", ")} WHERE tavid = ?`, vals);
  });
}

// ─── Main sync: plan, then apply ───────────────────────────

/**
 * Rows on the wire. `runners`, `results` and `splitcontrols` are what one
 * Oxygen event looks like on the remote competition after a cycle.
 */
export interface LiveResultsRunnerRow {
  dbid: number;
  name: string;
  club: string;
  class: string;
  bib: string;
}
export interface LiveResultsResultRow {
  dbid: number;
  control: number;
  time: number;
  status: number;
}
export interface LiveResultsSplitRow {
  classname: string;
  corder: number;
  code: number;
  name: string;
}
export interface LiveResultsRows {
  runners: LiveResultsRunnerRow[];
  results: LiveResultsResultRow[];
  splitcontrols: LiveResultsSplitRow[];
}

export interface LiveResultsSourceRunner {
  seq: number;
  name: string;
  clubName: string | null;
  classId: string | null;
  startNo: number | null;
  startTime: number;
  finishTime: number;
  /** Numeric Oxygen status (after `runnerStatusToValue`). */
  status: number;
  cardNo: number | null;
  bib: string | null;
}

export interface LiveResultsSource {
  zeroTime: number;
  classes: Array<{ id: string; name: string; courseId: string | null }>;
  /** courseId → ordered radio controls with LiveResults visit encoding. */
  radioByCourse: Map<string, EncodedRadioControl[]>;
  /** Not-removed runners. */
  runners: LiveResultsSourceRunner[];
  /** cardNo → radio-code punches, oldest first. */
  punchesByCard: Map<number, PunchForRadio[]>;
}

/**
 * What the remote competition should hold for this event (pure, SYNC-15).
 * A runner is published once drawn (a start time) or once it has a status;
 * an undrawn entry with no status is not published, so a row the remote
 * still holds for it is stale and removed by the apply.
 */
export function buildLiveResultsRows(src: LiveResultsSource): LiveResultsRows {
  const out: LiveResultsRows = { runners: [], results: [], splitcontrols: [] };
  const classById = new Map(src.classes.map((c) => [c.id, c]));

  for (const cls of src.classes) {
    if (!cls.courseId) continue;
    let corder = 1;
    for (const r of src.radioByCourse.get(cls.courseId) ?? []) {
      out.splitcontrols.push({
        classname: cls.name.slice(0, 50),
        corder: corder++,
        code: r.encoded,
        name: r.name.slice(0, 50),
      });
    }
  }

  for (const r of src.runners) {
    const oxygenStatus = r.status;
    if (oxygenStatus === RunnerStatus.Unknown && !hasTime(r.startTime)) continue;

    const cls = r.classId ? classById.get(r.classId) : undefined;
    const bib = r.bib && r.bib.length > 0 ? r.bib : String(r.startNo ?? "");
    out.runners.push({
      dbid: r.seq,
      name: r.name.slice(0, 100),
      club: (r.clubName ?? "").slice(0, 255),
      class: (cls?.name ?? "").slice(0, 50),
      bib: bib.slice(0, 10),
    });

    const { startCenti, elapsedCenti } = liveResultsTimes(r.startTime, r.finishTime, src.zeroTime);
    if (startCenti !== null) {
      out.results.push({ dbid: r.seq, control: 100, time: startCenti, status: 0 });
    }
    if (hasTime(r.finishTime) || oxygenStatus !== RunnerStatus.Unknown) {
      out.results.push({
        dbid: r.seq,
        control: FINISH_CONTROL,
        time: elapsedCenti,
        status: mapStatus(oxygenStatus, r.finishTime),
      });
    }

    if (hasTime(r.startTime) && cls?.courseId && r.cardNo != null) {
      const radios = src.radioByCourse.get(cls.courseId) ?? [];
      if (radios.length === 0) continue;
      const codes = new Set(radios.map((rad) => rad.punchCode));
      const punches = (src.punchesByCard.get(r.cardNo) ?? []).filter((p) =>
        codes.has(p.controlCode),
      );
      for (const hit of encodedRadioPunches(punches, radios.map((rad) => rad.encoded))) {
        const splitCenti = (hit.time - r.startTime) * 10;
        if (splitCenti < 0) continue;
        out.results.push({ dbid: r.seq, control: hit.encoded, time: splitCenti, status: 0 });
      }
    }
  }
  return out;
}

const runnerKey = (r: { dbid: number }) => String(r.dbid);
const resultKey = (r: { dbid: number; control: number }) => `${r.dbid}:${r.control}`;
const splitKey = (r: { classname: string; corder: number; code: number }) =>
  `${r.classname}\u0000${r.corder}\u0000${r.code}`;

export interface LiveResultsDiff {
  upsertRunners: LiveResultsRunnerRow[];
  upsertResults: LiveResultsResultRow[];
  upsertSplits: LiveResultsSplitRow[];
  /** Runner rows to drop with every result row they own. */
  deleteRunnerDbids: number[];
  deleteResults: Array<{ dbid: number; control: number }>;
  deleteSplits: Array<{ classname: string; corder: number; code: number }>;
}

/**
 * Compare the wanted rows with what the remote holds in Oxygen's scope and
 * return only the changes (pure, SYNC-15). Unchanged rows produce no
 * statement, so `results.changed` moves only for a real change and an
 * in-forest runner is never deleted and re-inserted.
 *
 * `remote` must already be limited to Oxygen's scope (runners in Oxygen
 * class names, results of those runners or of wanted dbids, split controls
 * of Oxygen class names): rows another client wrote to a shared tavid are
 * never touched.
 */
export function diffLiveResultsRows(desired: LiveResultsRows, remote: LiveResultsRows): LiveResultsDiff {
  const wantedRunners = new Set(desired.runners.map(runnerKey));
  const remoteRunners = new Map(remote.runners.map((r) => [runnerKey(r), r]));
  const remoteResults = new Map(remote.results.map((r) => [resultKey(r), r]));
  const remoteSplits = new Map(remote.splitcontrols.map((r) => [splitKey(r), r]));

  const upsertRunners = desired.runners.filter((r) => {
    const cur = remoteRunners.get(runnerKey(r));
    return !cur || cur.name !== r.name || cur.club !== r.club || cur.class !== r.class || cur.bib !== r.bib;
  });
  const upsertResults = desired.results.filter((r) => {
    const cur = remoteResults.get(resultKey(r));
    return !cur || Number(cur.time) !== r.time || Number(cur.status) !== r.status;
  });
  const upsertSplits = desired.splitcontrols.filter((r) => {
    const cur = remoteSplits.get(splitKey(r));
    return !cur || cur.name !== r.name;
  });

  const deleteRunnerDbids = remote.runners
    .filter((r) => !wantedRunners.has(runnerKey(r)))
    .map((r) => Number(r.dbid));
  const gone = new Set(deleteRunnerDbids.map(String));
  const wantedResults = new Set(desired.results.map(resultKey));
  const deleteResults = remote.results
    .filter((r) => !wantedResults.has(resultKey(r)) && !gone.has(String(r.dbid)))
    .map((r) => ({ dbid: Number(r.dbid), control: Number(r.control) }));
  const wantedSplits = new Set(desired.splitcontrols.map(splitKey));
  const deleteSplits = remote.splitcontrols
    .filter((r) => !wantedSplits.has(splitKey(r)))
    .map((r) => ({ classname: r.classname, corder: Number(r.corder), code: Number(r.code) }));

  return { upsertRunners, upsertResults, upsertSplits, deleteRunnerDbids, deleteResults, deleteSplits };
}

/** Rows per multi-row statement. */
const CHUNK = 500;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Read what the remote holds in Oxygen's scope: runner rows Oxygen wants or
 * filed under exactly one of its class names, result rows of those runners
 * and of the wanted dbids, and split controls of Oxygen class names.
 */
async function readRemoteScope(
  conn: LiveResultsConn,
  tavid: number,
  ownedClassnames: string[],
  wantedDbids: number[],
): Promise<LiveResultsRows> {
  const remote: LiveResultsRows = { runners: [], results: [], splitcontrols: [] };
  // MySQL compares case- and accent-insensitively; ownership is the exact
  // name, so a MeOS class "h21" beside Oxygen's "H21" is not Oxygen's.
  const owned = new Set(ownedClassnames.filter((n) => n.length > 0));
  const wanted = new Set(wantedDbids);
  const seen = new Set<number>();
  const takeRunner = (r: mysql.RowDataPacket) => {
    const row: LiveResultsRunnerRow = {
      dbid: Number(r.dbid),
      name: String(r.name ?? ""),
      club: String(r.club ?? ""),
      class: String(r.class ?? ""),
      bib: String(r.bib ?? ""),
    };
    if (seen.has(row.dbid)) return;
    // A runner row is in scope when Oxygen wants that dbid, or when it is
    // filed under one of Oxygen's class names (then it is Oxygen's to clear).
    if (!wanted.has(row.dbid) && !owned.has(row.class)) return;
    seen.add(row.dbid);
    remote.runners.push(row);
  };
  for (const names of chunks([...owned])) {
    const ph = names.map(() => "?").join(",");
    const [runners] = await exec<mysql.RowDataPacket[]>(
      conn,
      `SELECT dbid, name, club, class, bib FROM runners WHERE tavid = ? AND class IN (${ph})`,
      [tavid, ...names],
    );
    runners.forEach(takeRunner);
    const [splits] = await exec<mysql.RowDataPacket[]>(
      conn,
      `SELECT classname, corder, code, name FROM splitcontrols WHERE tavid = ? AND classname IN (${ph})`,
      [tavid, ...names],
    );
    for (const r of splits) {
      if (!owned.has(String(r.classname))) continue;
      remote.splitcontrols.push({
        classname: String(r.classname),
        corder: Number(r.corder),
        code: Number(r.code),
        name: String(r.name ?? ""),
      });
    }
  }
  for (const ids of chunks(wantedDbids)) {
    const ph = ids.map(() => "?").join(",");
    const [runners] = await exec<mysql.RowDataPacket[]>(
      conn,
      `SELECT dbid, name, club, class, bib FROM runners WHERE tavid = ? AND dbid IN (${ph})`,
      [tavid, ...ids],
    );
    runners.forEach(takeRunner);
  }
  const dbids = [...new Set([...remote.runners.map((r) => r.dbid), ...wantedDbids])];
  for (const ids of chunks(dbids)) {
    const ph = ids.map(() => "?").join(",");
    const [results] = await exec<mysql.RowDataPacket[]>(
      conn,
      `SELECT dbid, control, time, status FROM results WHERE tavid = ? AND dbid IN (${ph})`,
      [tavid, ...ids],
    );
    for (const r of results) {
      remote.results.push({
        dbid: Number(r.dbid),
        control: Number(r.control),
        time: Number(r.time),
        status: Number(r.status),
      });
    }
  }
  return remote;
}

/** Write a diff: deletes, then chunked multi-row upserts. */
async function applyLiveResultsDiff(
  conn: LiveResultsConn,
  tavid: number,
  diff: LiveResultsDiff,
): Promise<void> {
  for (const ids of chunks(diff.deleteRunnerDbids)) {
    const ph = ids.map(() => "?").join(",");
    await exec(conn, `DELETE FROM results WHERE tavid = ? AND dbid IN (${ph})`, [tavid, ...ids]);
    await exec(conn, `DELETE FROM runners WHERE tavid = ? AND dbid IN (${ph})`, [tavid, ...ids]);
  }
  for (const rows of chunks(diff.deleteResults)) {
    const ph = rows.map(() => "(?, ?)").join(",");
    await exec(
      conn,
      `DELETE FROM results WHERE tavid = ? AND (dbid, control) IN (${ph})`,
      [tavid, ...rows.flatMap((r) => [r.dbid, r.control])],
    );
  }
  for (const rows of chunks(diff.deleteSplits)) {
    const ph = rows.map(() => "(?, ?, ?)").join(",");
    await exec(
      conn,
      `DELETE FROM splitcontrols WHERE tavid = ? AND (BINARY classname, corder, code) IN (${ph})`,
      [tavid, ...rows.flatMap((r) => [r.classname, r.corder, r.code])],
    );
  }
  for (const rows of chunks(diff.upsertSplits)) {
    await exec(
      conn,
      `INSERT INTO splitcontrols (tavid, classname, corder, code, name)
       VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(",")}
       ON DUPLICATE KEY UPDATE name = VALUES(name)`,
      rows.flatMap((r) => [tavid, r.classname, r.corder, r.code, r.name]),
    );
  }
  for (const rows of chunks(diff.upsertRunners)) {
    await exec(
      conn,
      `INSERT INTO runners (tavid, dbid, name, club, class, bib)
       VALUES ${rows.map(() => "(?, ?, ?, ?, ?, ?)").join(",")}
       ON DUPLICATE KEY UPDATE name = VALUES(name), club = VALUES(club),
         class = VALUES(class), bib = VALUES(bib)`,
      rows.flatMap((r) => [tavid, r.dbid, r.name, r.club, r.class, r.bib]),
    );
  }
  for (const rows of chunks(diff.upsertResults)) {
    await exec(
      conn,
      `INSERT INTO results (tavid, dbid, control, time, status, changed)
       VALUES ${rows.map(() => "(?, ?, ?, ?, ?, Now())").join(",")}
       ON DUPLICATE KEY UPDATE time = VALUES(time), status = VALUES(status),
         changed = VALUES(changed)`,
      rows.flatMap((r) => [tavid, r.dbid, r.control, r.time, r.status]),
    );
  }
}

export interface SyncStats {
  /** Rows the remote holds for this event after the cycle. */
  runners: number;
  results: number;
  splitcontrols: number;
  /** Rows written (inserted or changed) and deleted this cycle. */
  written?: number;
  deleted?: number;
}

/**
 * Bring the remote competition in line with one Oxygen event, in one
 * MySQL transaction: read Oxygen's scope, diff, write only the changes.
 * A reader of the public results sees the whole cycle or none of it.
 */
export async function pushLiveResultsRows(
  conn: LiveResultsConn,
  tavid: number,
  desired: LiveResultsRows,
  ownedClassnames: string[],
): Promise<SyncStats> {
  await conn.beginTransaction();
  try {
    const remote = await readRemoteScope(
      conn,
      tavid,
      ownedClassnames,
      desired.runners.map((r) => r.dbid),
    );
    const diff = diffLiveResultsRows(desired, remote);
    await applyLiveResultsDiff(conn, tavid, diff);
    await conn.commit();
    return {
      runners: desired.runners.length,
      results: desired.results.length,
      splitcontrols: desired.splitcontrols.length,
      written: diff.upsertRunners.length + diff.upsertResults.length + diff.upsertSplits.length,
      deleted: diff.deleteRunnerDbids.length + diff.deleteResults.length + diff.deleteSplits.length,
    };
  } catch (err) {
    // A timed-out statement is still at the head of the connection's queue
    // (mysql2 only rejects the caller), so a ROLLBACK would wait behind it
    // until TCP gives up. Destroy the connection instead: MySQL rolls back
    // an open transaction when its connection closes.
    if (isConnectionError(err)) conn.destroy();
    else await exec(conn, "ROLLBACK", []).catch(() => conn.destroy());
    throw err;
  }
}

/** Read one event's data from Postgres into the shape `buildLiveResultsRows` takes. */
async function loadLiveResultsSource(
  eventId: bigint,
): Promise<{ source: LiveResultsSource; ownedClassnames: string[] }> {
  const event = await prisma().event.findUnique({
    where: { id: eventId },
    select: { zeroTime: true, removed: true },
  });
  // A deleted event publishes nothing more (MC-28).
  if (!event || event.removed) throw new Error(`Event ${eventId} is deleted`);

  // Removed classes too: their names are still Oxygen's, so rows left under
  // them are found and cleared.
  const allClasses = await prisma().class.findMany({
    where: { eventId },
    select: { id: true, name: true, courseId: true, removed: true },
  });
  const classes = allClasses.filter((c) => !c.removed);

  const courses = await prisma().course.findMany({
    where: { eventId, removed: false },
    include: {
      courseControls: {
        orderBy: { position: "asc" },
        select: { control: { select: { id: true, codes: true, radioType: true, name: true } } },
      },
    },
  });
  const radioByCourse = new Map<string, EncodedRadioControl[]>();
  for (const c of courses) {
    radioByCourse.set(c.id, radioControlsFromCourse(c.courseControls.map((cc) => cc.control)));
  }

  const runners = await prisma().runner.findMany({
    // Cancel status acts as the "withdrawn" marker (legacy MeOS DnsCancel):
    // still pushed, `mapStatus` returns 1 (DNS). A removed runner is not
    // wanted, so its remote rows are deleted.
    where: { eventId, removed: false },
    select: {
      seq: true,
      name: true,
      clubName: true,
      classId: true,
      startNo: true,
      startTime: true,
      finishTime: true,
      status: true,
      cardNo: true,
      bib: true,
    },
  });

  // One punch query per event, grouped by card (not one per runner).
  const radioCodes = [...new Set([...radioByCourse.values()].flat().map((r) => r.punchCode))];
  const cardNos = [...new Set(runners.map((r) => r.cardNo).filter((c): c is number => c != null))];
  const punchesByCard = new Map<number, PunchForRadio[]>();
  if (radioCodes.length > 0 && cardNos.length > 0) {
    const punches = await prisma().punch.findMany({
      where: {
        eventId,
        cardNo: { in: cardNos },
        removed: false,
        // Backup-memory rows count only through their pushed mirror (RES-08).
        source: { not: "backup_memory" },
        controlCode: { in: radioCodes },
      },
      select: { cardNo: true, controlCode: true, time: true },
      orderBy: { time: "asc" },
    });
    for (const p of punches) {
      if (p.cardNo == null) continue;
      const list = punchesByCard.get(p.cardNo) ?? [];
      list.push({ controlCode: p.controlCode, time: p.time });
      punchesByCard.set(p.cardNo, list);
    }
  }

  const ownedClassnames = splitcontrolClassnamesToReplace(allClasses);
  return {
    source: {
      zeroTime: event.zeroTime,
      classes,
      radioByCourse,
      runners: runners.map((r) => ({ ...r, status: runnerStatusToValue(r.status) })),
      punchesByCard,
    },
    ownedClassnames,
  };
}

/** Longest a cycle may take before it is abandoned and its connection closed. */
const CYCLE_DEADLINE_MS = 120_000;

export async function syncAll(tavid: number, eventId: bigint): Promise<SyncStats> {
  const { source, ownedClassnames } = await loadLiveResultsSource(eventId);
  const desired = buildLiveResultsRows(source);
  return withConnection(async (conn) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          Object.assign(new Error(`LiveResults push took over ${CYCLE_DEADLINE_MS / 1000} s`), {
            code: "PROTOCOL_SEQUENCE_TIMEOUT",
          }),
        );
      }, CYCLE_DEADLINE_MS);
    });
    try {
      // The deadline makes sure the cycle settles (and the manager's
      // per-event guard clears, with `lastError` set) even on a black-holed
      // link; its connection-class code gets the connection destroyed.
      return await Promise.race([pushLiveResultsRows(conn, tavid, desired, ownedClassnames), deadline]);
    } finally {
      clearTimeout(timer);
    }
  });
}

// ─── Pusher manager (multi-tenant) ─────────────────────────

export interface PusherStatus {
  running: boolean;
  tavid: number | null;
  /** Cadence of the armed timer — null when nothing is running. */
  intervalSeconds: number | null;
  /** Start time of the last cycle that succeeded. */
  lastPush: string | null;
  lastError: string | null;
  pushCount: number;
}

export type SyncFn = (tavid: number, eventId: bigint) => Promise<SyncStats>;

interface TenantState {
  timer: ReturnType<typeof setInterval>;
  tavid: number;
  intervalSeconds: number;
  lastPush: string | null;
  lastError: string | null;
  pushCount: number;
}

class LiveResultsPusherManager {
  private tenants = new Map<string, TenantState>();
  /**
   * The cycle running for an event, timer or manual. A tick that finds one
   * is skipped; a manual push waits for it and then runs (SYNC-15).
   */
  private inFlight = new Map<string, Promise<unknown>>();

  getStatus(eventId: bigint): PusherStatus {
    const t = this.tenants.get(String(eventId));
    if (!t) {
      return {
        running: false,
        tavid: null,
        intervalSeconds: null,
        lastPush: null,
        lastError: null,
        pushCount: 0,
      };
    }
    return {
      running: true,
      tavid: t.tavid,
      intervalSeconds: t.intervalSeconds,
      lastPush: t.lastPush,
      lastError: t.lastError,
      pushCount: t.pushCount,
    };
  }

  isRunning(eventId: bigint): boolean {
    return this.tenants.has(String(eventId));
  }

  activeEventIds(): bigint[] {
    return [...this.tenants.keys()].map((s) => BigInt(s));
  }

  /** Whether a cycle is running for the event right now. */
  isBusy(eventId: bigint): boolean {
    return this.inFlight.has(String(eventId));
  }

  private track<T>(eventId: bigint, p: Promise<T>): Promise<T> {
    const key = String(eventId);
    this.inFlight.set(key, p);
    const clear = () => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key);
    };
    p.then(clear, clear);
    return p;
  }

  start(
    eventId: bigint,
    tavid: number,
    intervalSeconds: number,
    syncFn: SyncFn = syncAll,
  ): void {
    this.stop(eventId);
    const state: TenantState = {
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      tavid,
      intervalSeconds,
      lastPush: null,
      lastError: null,
      pushCount: 0,
    };
    const run = async () => {
      // The previous cycle is still writing: skip this tick rather than run
      // two cycles side by side. Status is left as the last cycle set it.
      if (this.isBusy(eventId)) return;
      const startedAt = new Date().toISOString();
      try {
        await this.track(eventId, syncFn(tavid, eventId));
        state.lastPush = startedAt;
        state.pushCount++;
        state.lastError = null;
      } catch (err) {
        state.lastError = err instanceof Error ? err.message : String(err);
        console.error(`[LiveResults] Sync error for event ${eventId}:`, err);
      }
    };
    state.timer = setInterval(run, intervalSeconds * 1000);
    this.tenants.set(String(eventId), state);
    void run();
  }

  stop(eventId: bigint): void {
    const t = this.tenants.get(String(eventId));
    if (!t) return;
    clearInterval(t.timer);
    this.tenants.delete(String(eventId));
  }

  stopAll(): void {
    for (const key of [...this.tenants.keys()]) {
      this.stop(BigInt(key));
    }
  }

  /**
   * One push on demand. Waits for a cycle already running for the event,
   * then runs its own, so the two never interleave.
   */
  async pushNow(
    tavid: number,
    eventId: bigint,
    // Recorded like a timer cycle, so a manual success shows in the status.
    syncFn: SyncFn = (t, e) => persistingSync(t, e),
  ): Promise<SyncStats> {
    for (;;) {
      const running = this.inFlight.get(String(eventId));
      if (!running) break;
      await running.catch(() => {});
    }
    return this.track(eventId, syncFn(tavid, eventId));
  }
}

export const liveResultsPusherManager = new LiveResultsPusherManager();

/**
 * Legacy export. The factory shape is kept for symmetry with the
 * online-input puller and to give `index.ts` a single startup hook.
 */
export function liveResultsPusher(): { start(): void; stop(): void } {
  return {
    start() {},
    stop() {
      liveResultsPusherManager.stopAll();
    },
  };
}

// ─── Persisted push status ─────────────────────────────────

/**
 * Push status lives in `settings`, not just in the pusher's memory,
 * because the timer runs on whichever instance holds the background-jobs
 * lease while the operator's status query can land on any of them. The
 * online-input puller already reports itself this way; this brings
 * LiveResults in line.
 */
export interface PersistedPushStatus {
  lastPush: string | null;
  pushCount: number;
  lastError: string | null;
}

const EMPTY_PUSH_STATUS: PersistedPushStatus = {
  lastPush: null,
  pushCount: 0,
  lastError: null,
};

function pushStatusKey(eventId: bigint): string {
  return `liveresults_${String(eventId)}_status`;
}

export async function loadPushStatus(
  eventId: bigint,
): Promise<PersistedPushStatus> {
  const raw = await getSetting(pushStatusKey(eventId));
  if (!raw) return { ...EMPTY_PUSH_STATUS };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedPushStatus>;
    return {
      lastPush: typeof parsed.lastPush === "string" ? parsed.lastPush : null,
      pushCount: typeof parsed.pushCount === "number" ? parsed.pushCount : 0,
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
    };
  } catch {
    return { ...EMPTY_PUSH_STATUS };
  }
}

/**
 * Record the outcome of one push cycle. Only the lease holder pushes, so
 * the read-modify-write on `pushCount` has a single writer.
 */
async function recordPush(
  eventId: bigint,
  error: string | null,
  startedAt: string,
): Promise<void> {
  const prev = await loadPushStatus(eventId);
  const next: PersistedPushStatus = error
    ? { ...prev, lastError: error }
    : {
        // When the cycle read the event: what the public results show is
        // as of then, not as of when the last statement returned.
        lastPush: startedAt,
        pushCount: prev.pushCount + 1,
        lastError: null,
      };
  await setSetting(pushStatusKey(eventId), JSON.stringify(next));
}

/**
 * `syncAll` wrapped so every cycle leaves a trace in the database. Used
 * by the reconciler; the manager itself stays storage-free so its unit
 * tests can drive it with plain stubs.
 */
const persistingSync: SyncFn = async (tavid, eventId) => {
  const startedAt = new Date().toISOString();
  try {
    const stats = await syncAll(tavid, eventId);
    await recordPush(eventId, null, startedAt).catch(() => {});
    return stats;
  } catch (err) {
    await recordPush(
      eventId,
      err instanceof Error ? err.message : String(err),
      startedAt,
    ).catch(() => {});
    throw err;
  }
};

// ─── Reconciler ────────────────────────────────────────────

export interface ReconcileResult {
  started: bigint[];
  skipped: bigint[];
  failed: Array<{ eventId: bigint; error: string }>;
}

/**
 * Bring this instance's push timers in line with what the database
 * says should be running: every event with a `liveresultsTavid` and
 * `liveresultsConfig.enabled`. Orphan rows cannot exist by construction
 * since the config lives on the event row itself.
 *
 * Run on gaining the background-jobs lease and periodically while
 * holding it, so an operator toggling the push on any instance takes
 * effect without that instance running the timer. Timers already armed
 * with the right tavid and cadence are left alone — restarting one
 * fires an immediate push, which would turn a reconcile every few
 * seconds into a push every few seconds.
 */
export async function reconcileEnabledPushers(): Promise<ReconcileResult> {
  const result: ReconcileResult = { started: [], skipped: [], failed: [] };

  let rows: Array<{
    id: bigint;
    liveresultsTavid: number | null;
    liveresultsConfig: unknown;
  }>;
  try {
    rows = await prisma().event.findMany({
      // A deleted event stops publishing (MC-28); restoring it resumes.
      where: { liveresultsTavid: { not: null }, removed: false },
      select: {
        id: true,
        liveresultsTavid: true,
        liveresultsConfig: true,
      },
    });
  } catch {
    return result;
  }

  const wanted = new Set<string>();

  for (const row of rows) {
    try {
      const cfg = (row.liveresultsConfig ?? {}) as Partial<{
        enabled: boolean;
        intervalSeconds: number;
      }>;
      if (!cfg.enabled) {
        result.skipped.push(row.id);
        continue;
      }
      if (row.liveresultsTavid === null) {
        result.failed.push({ eventId: row.id, error: "tavid not stored" });
        continue;
      }
      const interval =
        typeof cfg.intervalSeconds === "number" && cfg.intervalSeconds > 0
          ? cfg.intervalSeconds
          : 30;
      wanted.add(String(row.id));

      const current = liveResultsPusherManager.getStatus(row.id);
      if (
        current.running &&
        current.tavid === row.liveresultsTavid &&
        current.intervalSeconds === interval
      ) {
        continue;
      }
      liveResultsPusherManager.start(
        row.id,
        row.liveresultsTavid,
        interval,
        persistingSync,
      );
      result.started.push(row.id);
    } catch (err) {
      result.failed.push({
        eventId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Anything running here that the database no longer wants — disabled
  // on another instance, or the event was deleted.
  for (const eventId of liveResultsPusherManager.activeEventIds()) {
    if (!wanted.has(String(eventId))) liveResultsPusherManager.stop(eventId);
  }

  return result;
}
