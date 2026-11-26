/**
 * SYNC-15 / DB-09 / RES-14 / MC-31: the LiveResults push is a plan (pure
 * `buildLiveResultsRows`) and a diff applied in one MySQL transaction.
 *
 * The apply runs against a small in-memory stand-in for the remote MySQL
 * that understands exactly the statements the pusher sends, so these tests
 * pin what the public results see across cycles: an in-forest runner is
 * never deleted, unchanged rows are not rewritten, a removed runner goes,
 * and rows another client wrote to a shared tavid stay.
 */

import { describe, it, expect } from "vitest";
import { RunnerStatus } from "@oxygen/shared";
import {
  buildLiveResultsRows,
  diffLiveResultsRows,
  parseConnectionString,
  pushLiveResultsRows,
  type LiveResultsConn,
  type LiveResultsRows,
  type LiveResultsSource,
  type LiveResultsSourceRunner,
} from "../liveresults.js";

// ─── Fake remote ─────────────────────────────────────────────

interface Db {
  runners: Array<{ tavid: number; dbid: number; name: string; club: string; class: string; bib: string }>;
  results: Array<{ tavid: number; dbid: number; control: number; time: number; status: number; changed: number }>;
  splitcontrols: Array<{ tavid: number; classname: string; corder: number; code: number; name: string }>;
}

function fakeRemote(db: Db) {
  const log: string[] = [];
  let tick = 0;
  let snapshot: string | null = null;
  const conn: LiveResultsConn = {
    async beginTransaction() {
      log.push("BEGIN");
      snapshot = JSON.stringify(db);
    },
    async commit() {
      log.push("COMMIT");
      snapshot = null;
    },
    async rollback() {
      log.push("ROLLBACK");
      if (snapshot) Object.assign(db, JSON.parse(snapshot));
    },
    destroy() {
      log.push("DESTROY");
      // MySQL rolls back an open transaction when the connection closes.
      if (snapshot) Object.assign(db, JSON.parse(snapshot));
    },
    async query(options, values = []) {
      const sql = options.sql.replace(/\s+/g, " ").trim();
      log.push(sql.split(" ").slice(0, 3).join(" "));
      if (fail && sql.startsWith(fail.prefix)) throw Object.assign(new Error("boom"), { code: fail.code });
      if (sql === "ROLLBACK") {
        if (snapshot) Object.assign(db, JSON.parse(snapshot));
        return [{}, []] as never;
      }
      const v = values as Array<string | number>;
      // MySQL's default collation compares case-insensitively.
      const inCi = (list: unknown[], x: string) => list.some((y) => String(y).toLowerCase() === x.toLowerCase());
      const tavid = Number(v[0]);
      const rest = v.slice(1);
      const ret = (rows: unknown) => [rows, []] as never;
      if (sql.startsWith("SELECT dbid, name, club, class, bib FROM runners")) {
        if (sql.includes("AND dbid IN")) {
          return ret(db.runners.filter((r) => r.tavid === tavid && rest.includes(r.dbid)));
        }
        return ret(db.runners.filter((r) => r.tavid === tavid && inCi(rest, r.class)));
      }
      if (sql.startsWith("SELECT classname, corder, code, name FROM splitcontrols")) {
        return ret(db.splitcontrols.filter((r) => r.tavid === tavid && inCi(rest, r.classname)));
      }
      if (sql.startsWith("SELECT dbid, control, time, status FROM results")) {
        return ret(db.results.filter((r) => r.tavid === tavid && rest.includes(r.dbid)));
      }
      if (sql.startsWith("DELETE FROM results WHERE tavid = ? AND dbid IN")) {
        db.results = db.results.filter((r) => !(r.tavid === tavid && rest.includes(r.dbid)));
        return ret({});
      }
      if (sql.startsWith("DELETE FROM runners WHERE tavid = ? AND dbid IN")) {
        db.runners = db.runners.filter((r) => !(r.tavid === tavid && rest.includes(r.dbid)));
        return ret({});
      }
      if (sql.startsWith("DELETE FROM results WHERE tavid = ? AND (dbid, control)")) {
        const keys = new Set<string>();
        for (let i = 0; i < rest.length; i += 2) keys.add(`${rest[i]}:${rest[i + 1]}`);
        db.results = db.results.filter((r) => !(r.tavid === tavid && keys.has(`${r.dbid}:${r.control}`)));
        return ret({});
      }
      if (sql.startsWith("DELETE FROM splitcontrols")) {
        const keys = new Set<string>();
        for (let i = 0; i < rest.length; i += 3) keys.add(`${rest[i]}|${rest[i + 1]}|${rest[i + 2]}`);
        db.splitcontrols = db.splitcontrols.filter(
          (r) => !(r.tavid === tavid && keys.has(`${r.classname}|${r.corder}|${r.code}`)),
        );
        return ret({});
      }
      if (sql.startsWith("INSERT INTO splitcontrols")) {
        for (let i = 0; i < v.length; i += 5) {
          const [t, classname, corder, code, name] = v.slice(i, i + 5);
          const cur = db.splitcontrols.find(
            (r) => r.tavid === t && r.classname === classname && r.corder === corder && r.code === code,
          );
          if (cur) cur.name = String(name);
          else db.splitcontrols.push({ tavid: Number(t), classname: String(classname), corder: Number(corder), code: Number(code), name: String(name) });
        }
        return ret({});
      }
      if (sql.startsWith("INSERT INTO runners")) {
        for (let i = 0; i < v.length; i += 6) {
          const [t, dbid, name, club, cls, bib] = v.slice(i, i + 6);
          const cur = db.runners.find((r) => r.tavid === t && r.dbid === dbid);
          const row = { tavid: Number(t), dbid: Number(dbid), name: String(name), club: String(club), class: String(cls), bib: String(bib) };
          if (cur) Object.assign(cur, row);
          else db.runners.push(row);
        }
        return ret({});
      }
      if (sql.startsWith("INSERT INTO results")) {
        tick++;
        for (let i = 0; i < v.length; i += 5) {
          const [t, dbid, control, time, status] = v.slice(i, i + 5).map(Number);
          const cur = db.results.find((r) => r.tavid === t && r.dbid === dbid && r.control === control);
          if (cur) Object.assign(cur, { time, status, changed: tick });
          else db.results.push({ tavid: t, dbid, control, time, status, changed: tick });
        }
        return ret({});
      }
      throw new Error(`fake remote: unexpected statement ${sql}`);
    },
  };
  let fail: { prefix: string; code: string } | null = null;
  return {
    conn,
    log,
    failOn(prefix: string | null, code = "ER_PARSE_ERROR") {
      fail = prefix ? { prefix, code } : null;
    },
  };
}

const emptyDb = (): Db => ({ runners: [], results: [], splitcontrols: [] });

// ─── Source helpers ──────────────────────────────────────────

const ZERO = 324000; // 09:00:00 in deciseconds

function runner(seq: number, over: Partial<LiveResultsSourceRunner> = {}): LiveResultsSourceRunner {
  return {
    seq,
    name: `Runner ${seq}`,
    clubName: "OK Test",
    classId: "c1",
    startNo: seq,
    startTime: 0,
    finishTime: 0,
    status: RunnerStatus.Unknown,
    cardNo: 1000 + seq,
    bib: "",
    ...over,
  };
}

function source(runners: LiveResultsSourceRunner[], over: Partial<LiveResultsSource> = {}): LiveResultsSource {
  return {
    zeroTime: ZERO,
    classes: [{ id: "c1", name: "H21", courseId: "k1" }],
    radioByCourse: new Map([["k1", [{ punchCode: 82, encoded: 1082, name: "Radio 82" }]]]),
    runners,
    punchesByCard: new Map(),
    ...over,
  };
}

const TAVID = 4242;
const OWNED = ["H21"];

async function cycle(remote: ReturnType<typeof fakeRemote>, src: LiveResultsSource) {
  return pushLiveResultsRows(remote.conn, TAVID, buildLiveResultsRows(src), OWNED);
}

// ─── buildLiveResultsRows ────────────────────────────────────

describe("buildLiveResultsRows", () => {
  it("an Unknown runner with a start gives a runner row and a start row, no finish row", () => {
    const rows = buildLiveResultsRows(source([runner(1, { startTime: 6000 })]));
    expect(rows.runners.map((r) => r.dbid)).toEqual([1]);
    expect(rows.results).toEqual([{ dbid: 1, control: 100, time: (ZERO + 6000) * 10, status: 0 }]);
  });

  it("an undrawn entry with no status is not published", () => {
    const rows = buildLiveResultsRows(source([runner(1)]));
    expect(rows.runners).toEqual([]);
    expect(rows.results).toEqual([]);
  });

  it("a finished runner gets a finish row with the elapsed time and status", () => {
    const rows = buildLiveResultsRows(
      source([runner(1, { startTime: 6000, finishTime: 6000 + 36000, status: RunnerStatus.OK })]),
    );
    expect(rows.results).toContainEqual({ dbid: 1, control: 1000, time: 360000, status: 0 });
  });

  it("radio splits come from the event-wide punch map, grouped by card", () => {
    const rows = buildLiveResultsRows(
      source([runner(1, { startTime: 6000 }), runner(2, { startTime: 6000 })], {
        punchesByCard: new Map([
          [1001, [{ controlCode: 82, time: 6000 + 3000 }]],
          [1002, [{ controlCode: 82, time: 6000 + 4500 }]],
        ]),
      }),
    );
    expect(rows.results.filter((r) => r.control === 1082)).toEqual([
      { dbid: 1, control: 1082, time: 30000, status: 0 },
      { dbid: 2, control: 1082, time: 45000, status: 0 },
    ]);
    expect(rows.splitcontrols).toEqual([{ classname: "H21", corder: 1, code: 1082, name: "Radio 82" }]);
  });
});

// ─── diff ────────────────────────────────────────────────────

describe("diffLiveResultsRows", () => {
  it("an unchanged row produces no statement", () => {
    const desired = buildLiveResultsRows(source([runner(1, { startTime: 6000 })]));
    const diff = diffLiveResultsRows(desired, structuredClone(desired));
    expect(diff).toEqual({
      upsertRunners: [],
      upsertResults: [],
      upsertSplits: [],
      deleteRunnerDbids: [],
      deleteResults: [],
      deleteSplits: [],
    });
  });

  it("a remote runner that is no longer wanted is deleted with its results; its results are not listed twice", () => {
    const remote: LiveResultsRows = {
      runners: [{ dbid: 9, name: "Gone", club: "", class: "H21", bib: "" }],
      results: [{ dbid: 9, control: 100, time: 1, status: 0 }],
      splitcontrols: [],
    };
    const diff = diffLiveResultsRows({ runners: [], results: [], splitcontrols: [] }, remote);
    expect(diff.deleteRunnerDbids).toEqual([9]);
    expect(diff.deleteResults).toEqual([]);
  });
});

// ─── apply across cycles ─────────────────────────────────────

describe("pushLiveResultsRows across cycles (SYNC-15)", () => {
  it("writes everything in one transaction, then nothing while nothing changes", async () => {
    const db = emptyDb();
    const remote = fakeRemote(db);
    const src = source([runner(1, { startTime: 6000 }), runner(2, { startTime: 6600 })]);

    const first = await cycle(remote, src);
    expect(remote.log[0]).toBe("BEGIN");
    expect(remote.log.at(-1)).toBe("COMMIT");
    expect(first).toMatchObject({ runners: 2, results: 2, splitcontrols: 1, written: 5, deleted: 0 });
    // One multi-row INSERT per table, not one per runner.
    expect(remote.log.filter((s) => s === "INSERT INTO runners")).toHaveLength(1);

    remote.log.length = 0;
    const second = await cycle(remote, src);
    expect(second).toMatchObject({ written: 0, deleted: 0 });
    expect(remote.log.some((s) => s.startsWith("INSERT") || s.startsWith("DELETE"))).toBe(false);
  });

  it("never deletes an in-forest (Unknown, started) runner between cycles", async () => {
    const db = emptyDb();
    const remote = fakeRemote(db);
    const src = source([runner(1, { startTime: 6000 })]);
    await cycle(remote, src);
    const changedBefore = db.results[0].changed;
    await cycle(remote, src);
    await cycle(remote, src);
    expect(remote.log.filter((s) => s.startsWith("DELETE"))).toEqual([]);
    expect(db.runners.map((r) => r.dbid)).toEqual([1]);
    expect(db.results[0].changed).toBe(changedBefore);
  });

  it("a finish moves only that runner's rows", async () => {
    const db = emptyDb();
    const remote = fakeRemote(db);
    await cycle(remote, source([runner(1, { startTime: 6000 }), runner(2, { startTime: 6000 })]));
    const s = await cycle(
      remote,
      source([
        runner(1, { startTime: 6000, finishTime: 42000, status: RunnerStatus.OK }),
        runner(2, { startTime: 6000 }),
      ]),
    );
    expect(s).toMatchObject({ written: 1, deleted: 0 });
    expect(db.results.find((r) => r.dbid === 1 && r.control === 1000)?.status).toBe(0);
  });

  it("a removed runner is deleted remotely, a status reset drops the finish row", async () => {
    const db = emptyDb();
    const remote = fakeRemote(db);
    await cycle(
      remote,
      source([
        runner(1, { startTime: 6000, finishTime: 42000, status: RunnerStatus.OK }),
        runner(2, { startTime: 6000 }),
      ]),
    );
    // Runner 2 was deleted in Oxygen; runner 1's readout was undone.
    await cycle(remote, source([runner(1, { startTime: 6000 })]));
    expect(db.runners.map((r) => r.dbid)).toEqual([1]);
    expect(db.results.map((r) => `${r.dbid}:${r.control}`)).toEqual(["1:100"]);
  });

  it("leaves rows another client wrote to a shared tavid alone", async () => {
    const db = emptyDb();
    db.runners.push({ tavid: TAVID, dbid: 77, name: "MeOS runner", club: "", class: "H21 5 km", bib: "" });
    db.results.push({ tavid: TAVID, dbid: 77, control: 1000, time: 1, status: 0, changed: 0 });
    db.splitcontrols.push({ tavid: TAVID, classname: "H21 5 km", corder: 1, code: 1050, name: "MeOS radio" });
    const remote = fakeRemote(db);
    await cycle(remote, source([runner(1, { startTime: 6000 })]));
    expect(db.runners.map((r) => r.dbid).sort()).toEqual([1, 77]);
    expect(db.results.some((r) => r.dbid === 77)).toBe(true);
    expect(db.splitcontrols.map((r) => r.classname).sort()).toEqual(["H21", "H21 5 km"]);
  });

  it("a radio control removed from the course drops its split control and split rows", async () => {
    const db = emptyDb();
    const remote = fakeRemote(db);
    const punches = new Map([[1001, [{ controlCode: 82, time: 9000 }]]]);
    await cycle(remote, source([runner(1, { startTime: 6000 })], { punchesByCard: punches }));
    expect(db.results.some((r) => r.control === 1082)).toBe(true);
    await cycle(
      remote,
      source([runner(1, { startTime: 6000 })], { punchesByCard: punches, radioByCourse: new Map() }),
    );
    expect(db.splitcontrols).toEqual([]);
    expect(db.results.some((r) => r.control === 1082)).toBe(false);
  });

  it("a failed statement rolls the whole cycle back", async () => {
    const db = emptyDb();
    const remote = fakeRemote(db);
    remote.failOn("INSERT INTO results");
    await expect(cycle(remote, source([runner(1, { startTime: 6000 })]))).rejects.toThrow("boom");
    expect(remote.log.at(-1)).toBe("ROLLBACK");
    expect(db).toEqual(emptyDb());
  });

  it("a timed-out or lost connection is destroyed, not rolled back behind the stalled statement", async () => {
    const db = emptyDb();
    const remote = fakeRemote(db);
    remote.failOn("INSERT INTO results", "PROTOCOL_SEQUENCE_TIMEOUT");
    await expect(cycle(remote, source([runner(1, { startTime: 6000 })]))).rejects.toThrow("boom");
    expect(remote.log.at(-1)).toBe("DESTROY");
    expect(remote.log).not.toContain("ROLLBACK");
    expect(db).toEqual(emptyDb());
  });

  it("a runner under another client's class name that differs only in case is not Oxygen's", async () => {
    const db = emptyDb();
    db.runners.push({ tavid: TAVID, dbid: 78, name: "MeOS lower", club: "", class: "h21", bib: "" });
    db.splitcontrols.push({ tavid: TAVID, classname: "h21", corder: 1, code: 1050, name: "MeOS radio" });
    const remote = fakeRemote(db);
    await cycle(remote, source([runner(1, { startTime: 6000 })]));
    expect(db.runners.map((r) => r.dbid).sort()).toEqual([1, 78]);
    expect(db.splitcontrols.some((r) => r.classname === "h21")).toBe(true);
  });

  it("a wanted runner filed under a foreign class name is updated, not duplicated", async () => {
    const db = emptyDb();
    db.runners.push({ tavid: TAVID, dbid: 1, name: "Old", club: "", class: "Renamed", bib: "" });
    const remote = fakeRemote(db);
    await cycle(remote, source([runner(1, { startTime: 6000 })]));
    expect(db.runners).toHaveLength(1);
    expect(db.runners[0].class).toBe("H21");
  });
});

// ─── connection string ───────────────────────────────────────

describe("parseConnectionString (EVT-16)", () => {
  it("accepts host;user;password;database", () => {
    expect(parseConnectionString("h.example;u;p;d\n")).toEqual({
      host: "h.example",
      user: "u",
      password: "p",
      database: "d",
    });
  });

  it.each(["<html>502 Bad Gateway</html>", "a;b;c", "a;b;;d", "a;b;c;d;e", ""])(
    "refuses %j",
    (text) => {
      expect(() => parseConnectionString(text)).toThrow();
    },
  );
});
