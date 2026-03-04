/**
 * LiveResults integration — direct MySQL approach.
 *
 * Writes results directly to the LiveResults MySQL database at
 * liveresultat.orientering.se. The connection credentials are fetched
 * dynamically via the official endpoint so they stay current.
 *
 * Key design decisions:
 * - Connection credentials fetched at runtime (not hardcoded)
 * - Competition created automatically on first enable
 * - tavid stored in oos_settings per competition
 * - Radio controls identified by case-insensitive "radio" in name
 * - Times stored in centiseconds (MeOS uses 1/10s → divide by 10)
 */

import mysql from "mysql2/promise";
import { getSetting, setSetting, getCompetitionClient } from "./db.js";

// ─── Constants ────────────────────────────────────────────────

const CONFIG_ENDPOINT =
    "https://liveresultat.orientering.se/configs/getConnectionSettings.php";
const CONFIG_KEY = "liveemmaclient";
const FINISH_CONTROL = 1000;

// ─── Status code mapping ──────────────────────────────────────

// MeOS RunnerStatus → LiveResults status
// MeOS: 0=Unknown, 1=OK, 2=NoTiming, 3=MP, 4=DNF, 5=DQ,
//       15=OutOfCompetition, 20=DNS, 21=Cancel, 99=NotCompetiting
// LiveResults: 0=OK, 1=DNS, 2=DNF, 3=MP, 4=DSQ, 5=OT, 9=not started, 10=not started yet
function mapStatus(meosStatus: number, finishTime: number): number {
    if (meosStatus === 1) return 0;  // OK
    if (meosStatus === 2) return 0;  // NoTiming → OK
    if (meosStatus === 3) return 3;  // MP
    if (meosStatus === 4) return 2;  // DNF
    if (meosStatus === 5) return 4;  // DQ → DSQ
    if (meosStatus === 15) return 5; // OutOfCompetition → OT
    if (meosStatus === 20) return 1; // DNS
    if (meosStatus === 21) return 1; // Cancel → DNS
    if (meosStatus === 99) return 9; // NotCompetiting → not started
    if (finishTime > 0) return 0;    // Unknown but has finish time → OK
    return 9;                         // not yet finished
}

// ─── Connection pool (cached per process) ────────────────────

let liveResultsPool: mysql.Pool | null = null;
let poolCredentials: string | null = null;

/**
 * Fetch current LiveResults connection string from the official endpoint.
 * Returns "host;user;pw;db" format.
 */
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

/**
 * Get (or create) the mysql2 connection pool to the LiveResults server.
 * Re-fetches credentials if they have changed.
 */
export async function getLiveResultsPool(): Promise<mysql.Pool> {
    const connStr = await fetchConnectionString();

    // If we already have a pool with the same credentials, reuse it
    if (liveResultsPool && poolCredentials === connStr) {
        return liveResultsPool;
    }

    // Destroy old pool if credentials changed
    if (liveResultsPool) {
        await liveResultsPool.end().catch(() => { });
        liveResultsPool = null;
    }

    const [host, user, password, database] = connStr.split(";");
    liveResultsPool = mysql.createPool({
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
    return liveResultsPool;
}

// ─── Competition management ───────────────────────────────────

/**
 * Ensure a LiveResults competition exists for this OOS event.
 * Creates one if needed and stores the tavid in oos_settings.
 * Returns the tavid.
 */
export async function ensureCompetition(nameId: string): Promise<number> {
    const settingKey = `liveresults_tavid_${nameId}`;
    const existing = await getSetting(settingKey);
    if (existing) return parseInt(existing, 10);

    // Get event info from OOS
    const client = await getCompetitionClient();
    const event = await client.oEvent.findFirst({ where: { Removed: false } });
    if (!event) throw new Error("No event found in OOS database");

    const organizer = await client.oClub.findFirst({
        where: { Removed: false },
        select: { Name: true },
    });

    const pool = await getLiveResultsPool();
    const conn = await pool.getConnection();
    try {
        // Allocate next tavid (same logic as the LiveResults web UI)
        const [rows] = await conn.execute<mysql.RowDataPacket[]>(
            "SELECT COALESCE(MAX(tavid), 0) + 1 AS next FROM login",
        );
        const tavid = rows[0].next as number;

        const compDate = event.Date
            ? new Date(event.Date).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10);

        await conn.execute(
            `INSERT INTO login (tavid, compName, compDate, organizer, user, pass, public, timediff, country)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'SE')`,
            [
                tavid,
                event.Name.slice(0, 50),
                compDate,
                (organizer?.Name ?? "").slice(0, 50),
                "oos",
                `oos_${nameId}`,
            ],
        );

        await setSetting(settingKey, String(tavid));
        return tavid;
    } finally {
        conn.release();
    }
}

/**
 * Update competition metadata in LiveResults (name, organizer, public flag).
 */
export async function updateCompetitionMeta(
    tavid: number,
    opts: { compName?: string; organizer?: string; isPublic?: boolean; country?: string },
): Promise<void> {
    const pool = await getLiveResultsPool();
    const conn = await pool.getConnection();
    try {
        const parts: string[] = [];
        const vals: unknown[] = [];
        if (opts.compName !== undefined) { parts.push("compName = ?"); vals.push(opts.compName.slice(0, 50)); }
        if (opts.organizer !== undefined) { parts.push("organizer = ?"); vals.push(opts.organizer.slice(0, 50)); }
        if (opts.isPublic !== undefined) { parts.push("public = ?"); vals.push(opts.isPublic ? 1 : 0); }
        if (opts.country !== undefined) { parts.push("country = ?"); vals.push(opts.country.slice(0, 2)); }
        if (parts.length === 0) return;
        vals.push(tavid);
        await conn.execute(`UPDATE login SET ${parts.join(", ")} WHERE tavid = ?`, vals);
    } finally {
        conn.release();
    }
}

// ─── Main sync ───────────────────────────────────────────────

/**
 * Sync all data (splitcontrols, runners, results) from OOS to LiveResults.
 * This is the core function called by the interval timer.
 */
export async function syncAll(tavid: number): Promise<SyncStats> {
    const client = await getCompetitionClient();
    const pool = await getLiveResultsPool();
    const conn = await pool.getConnection();

    const stats: SyncStats = { runners: 0, results: 0, splitcontrols: 0 };

    try {
        // ── 1. Fetch OOS data ─────────────────────────────────────

        const event = await client.oEvent.findFirst({ where: { Removed: false } });
        const zeroTime = event?.ZeroTime ?? 0;

        const classes = await client.oClass.findMany({
            where: { Removed: false },
            select: { Id: true, Name: true, Course: true },
        });
        const classById = new Map(classes.map((c) => [c.Id, c]));

        const courses = await client.oCourse.findMany({
            where: { Removed: false },
            select: { Id: true, Controls: true },
        });
        const courseById = new Map(courses.map((c) => [c.Id, c]));

        // Controls: identify radio controls by name containing "radio" (case-insensitive)
        const controls = await client.oControl.findMany({
            where: { Removed: false },
            select: { Id: true, Name: true, Numbers: true },
        });

        // Map controlId → numeric code (from Numbers field, e.g. "42")
        const controlCodeById = new Map<number, number>();
        const radioControlIds = new Set<number>();
        for (const ctrl of controls) {
            const code = parseInt(ctrl.Numbers.split(";")[0], 10);
            if (!isNaN(code)) controlCodeById.set(ctrl.Id, code);
            if (ctrl.Name.toLowerCase().includes("radio")) {
                radioControlIds.add(ctrl.Id);
            }
        }

        // ── 2. Upsert splitcontrols ──────────────────────────────

        // Build per-class radio control list with ordering
        // Each class → ordered list of radio control codes from its course
        const classRadioControls: Array<{
            className: string;
            code: number;
            corder: number;
            name: string;
        }> = [];

        for (const cls of classes) {
            if (!cls.Course || cls.Course <= 0) continue;
            const course = courseById.get(cls.Course);
            if (!course) continue;

            const courseControlIds = course.Controls.split(";")
                .filter(Boolean)
                .map((s) => parseInt(s, 10))
                .filter((id) => !isNaN(id));

            let radioOrder = 1;
            for (const ctrlId of courseControlIds) {
                if (!radioControlIds.has(ctrlId)) continue;
                const code = controlCodeById.get(ctrlId);
                if (!code) continue;
                const ctrl = controls.find((c) => c.Id === ctrlId);
                classRadioControls.push({
                    className: cls.Name,
                    code,
                    corder: radioOrder++,
                    name: ctrl?.Name ?? String(code),
                });
            }
        }

        // Delete existing splitcontrols and re-insert (simple full-refresh)
        await conn.execute("DELETE FROM splitcontrols WHERE tavid = ?", [tavid]);
        for (const sc of classRadioControls) {
            await conn.execute(
                `INSERT INTO splitcontrols (tavid, classname, corder, code, name) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
                [tavid, sc.className.slice(0, 50), sc.corder, sc.code, sc.name.slice(0, 50)],
            );
            stats.splitcontrols++;
        }

        // ── 3. Upsert runners ────────────────────────────────────

        const runners = await client.oRunner.findMany({
            where: { Removed: false },
            select: {
                Id: true,
                Name: true,
                Club: true,
                Class: true,
                StartNo: true,
                StartTime: true,
                FinishTime: true,
                Status: true,
                CardNo: true,
                Bib: true,
            },
        });

        const clubs = await client.oClub.findMany({
            where: { Removed: false },
            select: { Id: true, Name: true },
        });
        const clubNameById = new Map(clubs.map((c) => [c.Id, c.Name]));

        for (const r of runners) {
            const className = classById.get(r.Class)?.Name ?? "";
            const clubName = clubNameById.get(r.Club) ?? "";
            const bib = r.Bib ?? r.StartNo.toString();

            await conn.execute(
                `INSERT INTO runners (tavid, dbid, name, club, class, bib)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), club = VALUES(club),
           class = VALUES(class), bib = VALUES(bib)`,
                [tavid, r.Id, r.Name.slice(0, 100), clubName.slice(0, 255), className.slice(0, 50), bib.slice(0, 10)],
            );
            stats.runners++;

            // ── 4. Upsert results ──────────────────────────────────

            const meosStatus = r.Status as number;
            const lrStatus = mapStatus(meosStatus, r.FinishTime);

            // Start time as time-of-day in centiseconds (control 100)
            // MeOS stores times in deciseconds (1/10s), LiveResults uses centiseconds (1/100s)
            if (r.StartTime > 0) {
                const startCentiseconds = r.StartTime * 10;
                await conn.execute(
                    `INSERT INTO results (tavid, dbid, control, time, status, changed)
           VALUES (?, ?, 100, ?, 0, Now())
           ON DUPLICATE KEY UPDATE time = VALUES(time)`,
                    [tavid, r.Id, startCentiseconds],
                );
                stats.results++;
            }

            // Finish result
            if (r.FinishTime > 0 || meosStatus > 0) {
                const elapsed = r.FinishTime > 0 && r.StartTime > 0
                    ? (r.FinishTime - r.StartTime) * 10
                    : 0;

                await conn.execute(
                    `INSERT INTO results (tavid, dbid, control, time, status, changed)
           VALUES (?, ?, ?, ?, ?, Now())
           ON DUPLICATE KEY UPDATE time = VALUES(time), status = VALUES(status)`,
                    [tavid, r.Id, FINISH_CONTROL, elapsed, lrStatus],
                );
                stats.results++;
            }

            // Radio split results from oPunch
            if (radioControlIds.size > 0 && r.StartTime > 0) {
                const punches = await client.oPunch.findMany({
                    where: {
                        CardNo: r.CardNo,
                        Removed: false,
                    },
                    select: { Type: true, Time: true },
                });

                for (const punch of punches) {
                    if (!radioControlIds.has(punch.Type)) continue;
                    const code = controlCodeById.get(punch.Type);
                    if (!code) continue;
                    const splitCentiseconds = (punch.Time - r.StartTime) * 10;
                    if (splitCentiseconds < 0) continue;

                    await conn.execute(
                        `INSERT INTO results (tavid, dbid, control, time, status, changed)
             VALUES (?, ?, ?, ?, 0, Now())
             ON DUPLICATE KEY UPDATE time = VALUES(time)`,
                        [tavid, r.Id, code, splitCentiseconds],
                    );
                    stats.results++;
                }
            }
        }

        return stats;
    } finally {
        conn.release();
    }
}

export interface SyncStats {
    runners: number;
    results: number;
    splitcontrols: number;
}

// ─── Pusher class (interval timer) ───────────────────────────

export interface PusherStatus {
    running: boolean;
    tavid: number | null;
    lastPush: string | null;
    lastError: string | null;
    pushCount: number;
}

/**
 * Singleton pusher instance per process.
 * Manages the setInterval timer and tracks status.
 */
class LiveResultsPusherManager {
    private timer: ReturnType<typeof setInterval> | null = null;
    private _tavid: number | null = null;
    private _lastPush: string | null = null;
    private _lastError: string | null = null;
    private _pushCount = 0;

    get status(): PusherStatus {
        return {
            running: this.timer !== null,
            tavid: this._tavid,
            lastPush: this._lastPush,
            lastError: this._lastError,
            pushCount: this._pushCount,
        };
    }

    start(tavid: number, intervalSeconds: number): void {
        this.stop();
        this._tavid = tavid;
        this._lastError = null;

        const run = async () => {
            try {
                await syncAll(tavid);
                this._lastPush = new Date().toISOString();
                this._pushCount++;
                this._lastError = null;
            } catch (err) {
                this._lastError = err instanceof Error ? err.message : String(err);
                console.error("[LiveResults] Sync error:", err);
            }
        };

        // Run immediately, then on interval
        run();
        this.timer = setInterval(run, intervalSeconds * 1000);
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async pushNow(tavid: number): Promise<SyncStats> {
        return syncAll(tavid);
    }
}

export const liveResultsPusher = new LiveResultsPusherManager();
