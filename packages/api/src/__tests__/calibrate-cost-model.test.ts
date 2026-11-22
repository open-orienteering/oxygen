/**
 * The calibration command (docs/course-elevation.md §7.9,
 * docs/dev/route-calibration.md) on the synthetic fixture map
 * `e2e/test.ocd` with made-up runners: no database, no server.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapDocument } from "@oxygen/shared";
import { paperToWgs84, type PaperFrame } from "@oxygen/shared/src/geo/projection.js";
import { calibrationReportSchema } from "@oxygen/shared/src/route/calibration/index.js";
import { parseCalibrationArgs, runCalibration } from "../cli/calibrate-cost-model.js";
import { importMapToDocument } from "../import/ocad.js";

const MAP = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../e2e/test.ocd");
let dir: string;
let tracks: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "calibrate-"));
  const doc = mapDocument.decodeMapDocument((await importMapToDocument(await readFile(MAP), "test.ocd", "ocad")).bytes);
  const h = doc.header;
  const frame: PaperFrame = { unitsPerMm: h.unitsPerMm, mapScale: h.mapScale, georeferencing: h.georeferencing };
  const u = h.unitsPerMm;
  const cx = (h.bounds.minX + h.bounds.maxX) / 2 / u, cy = (h.bounds.minY + h.bounds.maxY) / 2 / u;
  const span = Math.min(h.bounds.maxX - h.bounds.minX, h.bounds.maxY - h.bounds.minY) / u / 4;
  const g = h.mapScale / 1000;
  // A square of four legs round the map's middle, run by eight made-up runners at their own even pace.
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([dx, dy]) => ({ x: cx + dx * span, y: cy + dy * span }));
  const latLng = (p: { x: number; y: number }) => { const q = paperToWgs84(frame, p.x * u, p.y * u)!; return { lat: q.lat, lng: q.lng }; };
  const start = 1_700_000_000_000;
  const record = {
    courses: [{ id: 1, controls: corners.map((p, i) => ({ code: i === 0 ? "S" : i === 4 ? "F" : String(30 + i), type: i === 0 ? "start" : i === 4 ? "finish" : "control", ...latLng(p) })) }],
    kept: Array.from({ length: 8 }, (_, r) => {
      const speed = 3 + r * 0.2;
      const legS = (2 * span * g) / speed;
      const waypoints: { timeMs: number; lat: number; lng: number }[] = [];
      for (let t = 0; t <= 4 * legS + 1e-6; t += 2) {
        const leg = Math.min(3, Math.floor(t / legS)), k = t / legS - leg;
        const a = corners[leg], b = corners[leg + 1];
        waypoints.push({ timeMs: start + t * 1000, ...latLng({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }) });
      }
      waypoints.push({ timeMs: start + 4 * legS * 1000, ...latLng(corners[4]) });
      return { participantId: 1000 + r, courseId: 1, raceStartMs: start, waypoints, result: { status: "ok", timeMs: 4 * legS * 1000, splitTimes: [1, 2, 3].map((i) => ({ controlCode: String(30 + i), timeMs: i * legS * 1000 })) } };
    }),
  };
  tracks = join(dir, "class-1.json");
  await writeFile(tracks, JSON.stringify(record));
}, 120_000);

afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("route:calibrate", () => {
  it("reads its arguments: tracks belong to the map before them", () => {
    expect(parseCalibrationArgs(["--map", "a.ocd", "--tracks", "x", "--tracks", "y", "--map", "b.omap", "--tracks", "z", "--out", "r.json", "--no-heights"]))
      .toEqual({ ok: true, value: { maps: [{ map: "a.ocd", tracks: ["x", "y"] }, { map: "b.omap", tracks: ["z"] }], out: "r.json", id: "fitted-1", heights: false } });
    for (const bad of [[], ["--tracks", "x"], ["--map", "a"], ["--map", "a", "--tracks", "x"], ["--map", "a", "--tracks", "x", "--out", "r", "--fast"], ["--map", "a", "--tracks", "x", "--out", "r", "--id", "Bad Id"], ["--map"]])
      expect(parseCalibrationArgs(bad).ok, bad.join(" ")).toBe(false);
  });

  it("imports the map, reads a directory of records and writes a report of aggregates", async () => {
    const out = join(dir, "report.json");
    const said: string[] = [];
    const run = await runCalibration({ maps: [{ map: MAP, tracks: [dir] }], out, id: "test-1", heights: true }, { minMetres: 200, minRunners: 4, minLegs: 8, minPairs: 2, resamples: 10 }, (line) => said.push(line));
    expect(run.code).toBe(0);
    // Each line as it is known, the same lines returned; nothing of the map but that it was read.
    expect(said).toEqual(run.lines);
    expect(said[0]).toMatch(/^map 1: read, heights (from contours|none)$/);
    const report = calibrationReportSchema.parse(JSON.parse(await readFile(out, "utf8")));
    expect(report).toEqual(run.report);
    expect(report.counts).toMatchObject({ maps: 1, courses: 1, tracks: 8, tracksUsed: 8, runners: 8 });
    expect(report.counts.legs).toBeGreaterThanOrEqual(24);
    expect(report.maps[0].medianMissM).toBeLessThan(5);
    expect(report.model.id).toBe("test-1");
    expect(report.classes.reduce((m, c) => m + c.metres, 0)).toBeGreaterThan(1000);
    const text = await readFile(out, "utf8");
    expect(text).not.toMatch(/test\.ocd|class-1|participantId|"lat"|1000|1007/);
    expect(run.lines.join("\n")).not.toContain(dir);
  }, 120_000);

  it("fails plainly: a file that is no map, a record that does not parse", async () => {
    const out = join(dir, "none.json");
    expect((await runCalibration({ maps: [{ map: tracks, tracks: [tracks] }], out, id: "x", heights: false })).code).toBe(1);
    const bad = join(dir, "bad");
    await writeFile(bad, JSON.stringify({ courses: [{ id: 1, controls: [] }] }));
    const run = await runCalibration({ maps: [{ map: MAP, tracks: [bad] }], out, id: "x", heights: false });
    expect(run.code).toBe(1);
    expect(run.lines.join(" ")).toMatch(/map 1, record 1: not a track record/);
  }, 120_000);

  it("a missing map, a missing record and a record that is not JSON are named by position, never by path or content", async () => {
    const out = join(dir, "none.json");
    const secret = join(dir, "anna-andersson.json");
    await writeFile(secret, "{ not json: Anna Andersson");
    for (const [maps, line] of [
      [[{ map: join(dir, "no-such-map.ocd"), tracks: [tracks] }], "map 1: unreadable"],
      [[{ map: MAP, tracks: [join(dir, "no-such-dir")] }], "map 1: a --tracks path is unreadable"],
      [[{ map: MAP, tracks: [tracks, secret] }], "map 1, record 2: unreadable"],
    ] as const) {
      const run = await runCalibration({ maps: maps.map((m) => ({ map: m.map, tracks: [...m.tracks] })), out, id: "x", heights: false });
      expect(run.code).toBe(1);
      expect(run.lines[run.lines.length - 1]).toBe(line);
      expect(run.lines.join(" ")).not.toMatch(/anna|Anna|no-such|calibrate-/);
    }
  }, 120_000);

  it("under five runs no report is written", async () => {
    const few = join(dir, "few");
    const record = JSON.parse(await readFile(tracks, "utf8"));
    await writeFile(few, JSON.stringify({ ...record, kept: record.kept.slice(0, 4) }));
    const out = join(dir, "few-report.json");
    const run = await runCalibration({ maps: [{ map: MAP, tracks: [few] }], out, id: "x", heights: false });
    expect(run.code).toBe(1);
    expect(run.report).toBeNull();
    expect(run.lines[run.lines.length - 1]).toMatch(/^4 runs with a usable leg: under 5 no report is written/);
    await expect(readFile(out)).rejects.toThrow();
  }, 120_000);
});
