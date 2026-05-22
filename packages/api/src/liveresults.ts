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
 *
 * The push pipeline is intentionally a fire-and-forget background task:
 * any sync error is captured into `state.lastError` and surfaced via the
 * `liveresults.getStatus` query — the timer keeps running on a best-
 * effort basis.
 */

import mysql from "mysql2/promise";
import { prisma } from "./db.js";
import { toAbsolute } from "./timeConvert.js";
import { runnerStatusToValue } from "./statusConvert.js";
import { RunnerStatus } from "@oxygen/shared";

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
  if (finishTime > 0) return 0;
  return 9;
}

// ─── Connection pool (process-wide, credentials cached) ─────

let pool: mysql.Pool | null = null;
let poolCredentials: string | null = null;

async function fetchConnectionString(): Promise<string> {
  const resp = await fetch(CONFIG_ENDPOINT, {
    method: "POST",
    body: new URLSearchParams({ key: CONFIG_KEY }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const text = (await resp.text()).trim();
  if (!text || text === "Wrong key") {
    throw new Error("Failed to fetch LiveResults connection settings");
  }
  return text;
}

export async function getLiveResultsPool(): Promise<mysql.Pool> {
  const connStr = await fetchConnectionString();
  if (pool && poolCredentials === connStr) return pool;
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
  const [host, user, password, database] = connStr.split(";");
  pool = mysql.createPool({
    host,
    user,
    password,
    database,
    port: 3306,
    connectionLimit: 5,
    connectTimeout: 10000,
    charset: "utf8mb4",
  });
  poolCredentials = connStr;
  return pool;
}

// ─── Competition row management ────────────────────────────

/**
 * Ensure a `login` row exists for this event. Returns the LiveResults
 * `tavid` (allocated by us, persisted on `events.liveresultsTavid`).
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

  const conn = await (await getLiveResultsPool()).getConnection();
  try {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      "SELECT COALESCE(MAX(tavid), 0) + 1 AS next FROM login",
    );
    const tavid = rows[0].next as number;
    const compDate = event.date.toISOString().slice(0, 10);
    await conn.execute(
      `INSERT INTO login (tavid, compName, compDate, organizer, user, pass, public, timediff, country)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'SE')`,
      [
        tavid,
        event.name.slice(0, 50),
        compDate,
        (event.organizerName ?? "").slice(0, 50),
        "oxygen",
        `oxygen_${eventId}`,
      ],
    );
    await prisma().event.update({
      where: { id: eventId },
      data: { liveresultsTavid: tavid },
    });
    return tavid;
  } finally {
    conn.release();
  }
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
  const conn = await (await getLiveResultsPool()).getConnection();
  try {
    const parts: string[] = [];
    const vals: unknown[] = [];
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
    await conn.execute(
      `UPDATE login SET ${parts.join(", ")} WHERE tavid = ?`,
      vals,
    );
  } finally {
    conn.release();
  }
}

// ─── Main sync ─────────────────────────────────────────────

export interface SyncStats {
  runners: number;
  results: number;
  splitcontrols: number;
}

export async function syncAll(
  tavid: number,
  eventId: bigint,
): Promise<SyncStats> {
  const stats: SyncStats = { runners: 0, results: 0, splitcontrols: 0 };
  const conn = await (await getLiveResultsPool()).getConnection();
  try {
    const event = await prisma().event.findUnique({
      where: { id: eventId },
      select: { zeroTime: true },
    });
    const zeroTime = event?.zeroTime ?? 324000;

    const classes = await prisma().class.findMany({
      where: { eventId, removed: false },
      select: { id: true, name: true, courseId: true },
    });

    const courses = await prisma().course.findMany({
      where: { eventId, removed: false },
      include: {
        courseControls: {
          orderBy: { position: "asc" },
          select: { control: { select: { id: true, codes: true, radioType: true, name: true } } },
        },
      },
    });

    // courseId → ordered list of radio controls (first code only).
    const radioByCourse = new Map<
      string,
      Array<{ code: number; name: string }>
    >();
    for (const c of courses) {
      const radios = c.courseControls
        .map((cc) => cc.control)
        .filter((ctrl) => ctrl.radioType && ctrl.radioType !== "normal")
        .map((ctrl) => {
          const firstCode = parseInt((ctrl.codes ?? "").split(";")[0], 10);
          return Number.isFinite(firstCode)
            ? { code: firstCode, name: ctrl.name || String(firstCode) }
            : null;
        })
        .filter((x): x is { code: number; name: string } => x !== null);
      radioByCourse.set(c.id, radios);
    }

    // ── 1. splitcontrols: classname × radio ordering ──────
    await conn.execute("DELETE FROM splitcontrols WHERE tavid = ?", [tavid]);
    for (const cls of classes) {
      if (!cls.courseId) continue;
      const radios = radioByCourse.get(cls.courseId) ?? [];
      let order = 1;
      for (const r of radios) {
        await conn.execute(
          `INSERT INTO splitcontrols (tavid, classname, corder, code, name)
           VALUES (?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE name = VALUES(name)`,
          [
            tavid,
            cls.name.slice(0, 50),
            order++,
            r.code,
            r.name.slice(0, 50),
          ],
        );
        stats.splitcontrols++;
      }
    }

    // Lookup map for class name + course's radio set per runner.
    const classById = new Map(classes.map((c) => [c.id, c]));

    const runners = await prisma().runner.findMany({
      // Cancel status acts as the "withdrawn" marker (legacy MeOS DnsCancel).
      // We still push those rows but `mapStatus` returns 1 (DNS).
      where: { eventId, removed: false },
      select: {
        id: true,
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

    // ── 2. delete results for runners that no longer have a status ──
    const noResultIds = runners
      .filter((r) => runnerStatusToValue(r.status) === RunnerStatus.Unknown)
      .map((r) => r.seq);
    if (noResultIds.length > 0) {
      const placeholders = noResultIds.map(() => "?").join(",");
      await conn.execute(
        `DELETE FROM results WHERE tavid = ? AND dbid IN (${placeholders})`,
        [tavid, ...noResultIds],
      );
      await conn.execute(
        `DELETE FROM runners WHERE tavid = ? AND dbid IN (${placeholders})`,
        [tavid, ...noResultIds],
      );
    }

    for (const r of runners) {
      const oxygenStatus = runnerStatusToValue(r.status);
      // Only push runners that have a status or a start row. Unknown +
      // no start time = entry without a draw → skip.
      if (oxygenStatus === RunnerStatus.Unknown && r.startTime <= 0) continue;

      const cls = r.classId ? classById.get(r.classId) : null;
      const className = cls?.name ?? "";
      const bib = r.bib && r.bib.length > 0 ? r.bib : String(r.startNo ?? "");

      await conn.execute(
        `INSERT INTO runners (tavid, dbid, name, club, class, bib)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), club = VALUES(club),
           class = VALUES(class), bib = VALUES(bib)`,
        [
          tavid,
          r.seq,
          r.name.slice(0, 100),
          (r.clubName ?? "").slice(0, 255),
          className.slice(0, 50),
          bib.slice(0, 10),
        ],
      );
      stats.runners++;

      const lrStatus = mapStatus(oxygenStatus, r.finishTime);

      if (r.startTime > 0) {
        const startAbsoluteCenti = toAbsolute(r.startTime, zeroTime) * 10;
        await conn.execute(
          `INSERT INTO results (tavid, dbid, control, time, status, changed)
           VALUES (?, ?, 100, ?, 0, Now())
           ON DUPLICATE KEY UPDATE time = VALUES(time)`,
          [tavid, r.seq, startAbsoluteCenti],
        );
        stats.results++;
      }

      if (r.finishTime > 0 || oxygenStatus !== RunnerStatus.Unknown) {
        const elapsed =
          r.finishTime > 0 && r.startTime > 0
            ? (r.finishTime - r.startTime) * 10
            : 0;
        await conn.execute(
          `INSERT INTO results (tavid, dbid, control, time, status, changed)
           VALUES (?, ?, ?, ?, ?, Now())
           ON DUPLICATE KEY UPDATE time = VALUES(time), status = VALUES(status)`,
          [tavid, r.seq, FINISH_CONTROL, elapsed, lrStatus],
        );
        stats.results++;
      }

      // ── 3. radio splits per runner ──────────────────────────
      if (r.startTime > 0 && cls?.courseId) {
        const radios = radioByCourse.get(cls.courseId) ?? [];
        if (radios.length > 0) {
          const radioCodes = new Set(radios.map((rad) => rad.code));
          const punches = await prisma().punch.findMany({
            where: {
              eventId,
              cardNo: r.cardNo,
              removed: false,
              controlCode: { in: [...radioCodes] },
            },
            select: { controlCode: true, time: true },
            orderBy: { time: "asc" },
          });
          // De-dupe: take the *first* punch per code (radios at a given
          // location can punch multiple times for redundancy units).
          const seen = new Set<number>();
          for (const p of punches) {
            if (seen.has(p.controlCode)) continue;
            seen.add(p.controlCode);
            const splitCenti = (p.time - r.startTime) * 10;
            if (splitCenti < 0) continue;
            await conn.execute(
              `INSERT INTO results (tavid, dbid, control, time, status, changed)
               VALUES (?, ?, ?, ?, 0, Now())
               ON DUPLICATE KEY UPDATE time = VALUES(time)`,
              [tavid, r.seq, p.controlCode, splitCenti],
            );
            stats.results++;
          }
        }
      }
    }

    return stats;
  } finally {
    conn.release();
  }
}

// ─── Pusher manager (multi-tenant) ─────────────────────────

export interface PusherStatus {
  running: boolean;
  tavid: number | null;
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

  getStatus(eventId: bigint): PusherStatus {
    const t = this.tenants.get(String(eventId));
    if (!t) {
      return {
        running: false,
        tavid: null,
        lastPush: null,
        lastError: null,
        pushCount: 0,
      };
    }
    return {
      running: true,
      tavid: t.tavid,
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
      try {
        await syncFn(tavid, eventId);
        state.lastPush = new Date().toISOString();
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

  async pushNow(tavid: number, eventId: bigint): Promise<SyncStats> {
    return syncAll(tavid, eventId);
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

// ─── Boot reconciler ───────────────────────────────────────

export interface ReconcileResult {
  started: bigint[];
  skipped: bigint[];
  failed: Array<{ eventId: bigint; error: string }>;
}

/**
 * Re-arm push timers on API startup. Reads every event that has both
 * `liveresultsTavid` and an enabled `liveresultsConfig.enabled` flag.
 * Orphan rows (no event) cannot exist by construction since the config
 * lives on the event row itself.
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
      where: { liveresultsTavid: { not: null } },
      select: {
        id: true,
        liveresultsTavid: true,
        liveresultsConfig: true,
      },
    });
  } catch {
    return result;
  }

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
      liveResultsPusherManager.start(row.id, row.liveresultsTavid, interval);
      result.started.push(row.id);
    } catch (err) {
      result.failed.push({
        eventId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
