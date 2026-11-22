/**
 * Calibrates the route cost model from GPS tracks
 * (docs/course-elevation.md §7.9, docs/dev/route-calibration.md):
 *
 *   pnpm --filter @oxygen/api route:calibrate --map <map.ocd|.omap> --tracks <record.json|dir> [--tracks …]
 *        [--map … --tracks …] --out <report.json> [--id <model-id>] [--no-heights]
 *
 * Each `--tracks` (a track record, or a directory of them) belongs to
 * the `--map` before it. Runs locally: no database, no server, nothing
 * sent anywhere. The report holds aggregates only — no coordinate, no
 * name, no file name — and the same summary is printed. Exits 2 on bad
 * arguments, 1 when a file is unreadable, a map cannot take tracks, no
 * leg survives or fewer than five runs have a usable leg.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mapDocument } from "@oxygen/shared";
import { deriveTerrain } from "@oxygen/shared/src/terrain/index.js";
import { fieldSampler } from "@oxygen/shared/src/terrain/profile/index.js";
import { DEFAULT_COST_MODEL_DATA } from "@oxygen/shared/src/route/index.js";
import {
  MIN_REPORT_RUNS, buildReport, calibrationMapOf, crossValidate, finderRatios, fitCostModel, modelDataOf, observeRecords, trackRecordSchema,
  type CalibrationReport, type FitOptions, type MapObservations, type TrackRecord,
} from "@oxygen/shared/src/route/calibration/index.js";
import { TrackProjectionError } from "@oxygen/shared/src/gps-track/project.js";
import { importMapToDocument } from "../import/ocad.js";
import { sniffMapKind } from "../map-store/uploads.js";

export interface CalibrationArgs {
  maps: { map: string; tracks: string[] }[];
  out: string;
  id: string;
  heights: boolean;
}

export const USAGE = "usage: route:calibrate --map <map file> --tracks <record.json|dir> [--tracks …] [--map … --tracks …] --out <report.json> [--id <model-id>] [--no-heights]";

export function parseCalibrationArgs(argv: readonly string[]): { ok: true; value: CalibrationArgs } | { ok: false; error: string } {
  const value: CalibrationArgs = { maps: [], out: "", id: "fitted-1", heights: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => (i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : null);
    if (a === "--no-heights") value.heights = false;
    else if (a === "--map" || a === "--tracks" || a === "--out" || a === "--id") {
      const v = next();
      if (v === null) return { ok: false, error: `${a} needs a value` };
      if (a === "--map") value.maps.push({ map: v, tracks: [] });
      else if (a === "--tracks") {
        if (value.maps.length === 0) return { ok: false, error: "--tracks comes after the --map it belongs to" };
        value.maps[value.maps.length - 1].tracks.push(v);
      } else if (a === "--out") value.out = v;
      else value.id = v;
    } else return { ok: false, error: `unknown option ${a}` };
  }
  if (value.maps.length === 0) return { ok: false, error: "no --map given" };
  const bare = value.maps.find((m) => m.tracks.length === 0);
  if (bare) return { ok: false, error: "a --map without --tracks" };
  if (!value.out) return { ok: false, error: "no --out given" };
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id)) return { ok: false, error: "--id is lower-case letters, digits and hyphens" };
  return { ok: true, value };
}

async function recordFiles(path: string): Promise<string[]> {
  if (!(await stat(path)).isDirectory()) return [path];
  return (await readdir(path)).filter((f) => f.endsWith(".json")).sort().map((f) => join(path, f));
}

export interface CalibrationRun { code: 0 | 1; report: CalibrationReport | null; lines: string[] }

/**
 * `log` gets each line as it is known (a forest map takes minutes); the
 * same lines are returned. A line never holds a path, a name or what an
 * unreadable file's error said: maps and records are named by position.
 */
export async function runCalibration(args: CalibrationArgs, fit: FitOptions = {}, log: (line: string) => void = () => {}): Promise<CalibrationRun> {
  const lines: string[] = [];
  const say = (line: string) => { lines.push(line); log(line); };
  const fail = (line: string): CalibrationRun => { say(line); return { code: 1, report: null, lines }; };
  const sets: MapObservations[] = [];
  const maps: ReturnType<typeof calibrationMapOf>[] = [];
  let runnerBase = 0;
  for (const [m, entry] of args.maps.entries()) {
    let map: ReturnType<typeof calibrationMapOf>;
    let heights = false;
    try {
      const file = await readFile(entry.map);
      const kind = sniffMapKind(file.subarray(0, 1024));
      if (!kind) return fail(`map ${m + 1}: not an OCAD or Mapper file`);
      const imported = await importMapToDocument(file, `map-${m + 1}`, kind);
      const doc = mapDocument.decodeMapDocument(imported.bytes);
      const derived = args.heights ? deriveTerrain(doc) : null;
      heights = derived !== null;
      map = calibrationMapOf(doc, derived ? fieldSampler(derived.field).heightAt : null);
    } catch {
      return fail(`map ${m + 1}: unreadable`);
    }
    say(`map ${m + 1}: read, heights ${heights ? "from contours" : "none"}`);
    let files: string[];
    try {
      files = (await Promise.all(entry.tracks.map(recordFiles))).flat();
    } catch {
      return fail(`map ${m + 1}: a --tracks path is unreadable`);
    }
    const records: TrackRecord[] = [];
    for (const [k, path] of files.entries()) {
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(path, "utf8"));
      } catch {
        return fail(`map ${m + 1}, record ${k + 1}: unreadable`);
      }
      const parsed = trackRecordSchema.safeParse(raw);
      if (!parsed.success) return fail(`map ${m + 1}, record ${k + 1}: not a track record (${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.code})`);
      records.push(parsed.data);
    }
    say(`map ${m + 1}: ${records.length} record${records.length === 1 ? "" : "s"}, reading the tracks…`);
    // All of a map's records together: classes sharing a control pair share its grid and count it once.
    let set: MapObservations;
    try {
      set = observeRecords(map, records, runnerBase, `${m}:`);
    } catch (err) {
      return fail(`map ${m + 1}: ${err instanceof TrackProjectionError ? err.message : "its tracks cannot be read"}`);
    }
    runnerBase += set.tracks;
    sets.push(set);
    maps.push(map);
    say(`map ${m + 1}: ${set.tracksUsed} of ${set.tracks} tracks, ${set.observations.length} legs, control miss ${Number.isFinite(set.medianMissM) ? set.medianMissM.toFixed(1) : "–"} m, ${(set.blockedShare * 100).toFixed(1)} % on uncrossable`);
  }
  const all = sets.flatMap((s) => s.observations);
  if (all.length === 0) return fail("no leg survived the cleaning");
  const runs = new Set(all.map((o) => o.runner)).size;
  if (runs < MIN_REPORT_RUNS) return fail(`${runs} run${runs === 1 ? "" : "s"} with a usable leg: under ${MIN_REPORT_RUNS} no report is written, its numbers would describe a few people`);
  say(`fitting ${all.length} legs of ${runs} runs…`);
  const result = fitCostModel(all, DEFAULT_COST_MODEL_DATA, fit);
  const model = modelDataOf(result, DEFAULT_COST_MODEL_DATA, args.id, `${result.runners} runs, ${all.length} legs on ${sets.length} map${sets.length === 1 ? "" : "s"}`);
  say("checking held-out legs and the finder…");
  const finder = sets.flatMap((set, i) => finderRatios(maps[i], set, model));
  const report = buildReport({ model, base: DEFAULT_COST_MODEL_DATA, fit: result, sets, alongTrack: result.supported.some(Boolean) ? crossValidate(all, DEFAULT_COST_MODEL_DATA, fit) : null, finder });
  await writeFile(args.out, JSON.stringify(report, null, 2) + "\n");
  for (const c of report.classes) {
    if (c.metres === 0) continue;
    say(`${c.class.padEnd(14)} ${String(c.metres).padStart(7)} m ${String(c.runners).padStart(4)} runs ${String(c.legs).padStart(5)} legs ${String(c.pairs).padStart(4)} pairs  ${c.baseFactor.toFixed(2)} → ${c.factor.toFixed(2)}${c.interval ? ` [${c.interval[0].toFixed(2)}, ${c.interval[1].toFixed(2)}]` : ""}  ${c.calibrated ? (c.anchor ? "reference" : "measured") : c.kept ?? ""}`);
  }
  say(`slope: up ${report.model.slope.up}${report.slope.upFitted ? "" : " (kept)"}, down ${report.model.slope.down}${report.slope.downFitted ? "" : " (kept)"}, heights under ${(report.slope.heightShare * 100).toFixed(0)} % of the track`);
  if (report.counts.outliers > 0) say(`${report.counts.outliers} of ${report.counts.legs} legs took over twice or under half the fitted model's time: they weigh little`);
  if (report.alongTrack) say(`held-out legs: median error ${((report.alongTrack.fitted.medianAbs ?? 0) * 100).toFixed(1)} % fitted, ${((report.alongTrack.base.medianAbs ?? 0) * 100).toFixed(1)} % rule of thumb (${report.alongTrack.fitted.legs} legs)`);
  if (report.againstFinder?.median != null) say(`actual ÷ the finder's fastest route: median ${report.againstFinder.median.toFixed(2)} over ${report.againstFinder.legs} legs`);
  return { code: 0, report, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseCalibrationArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(2);
  }
  const run = await runCalibration(parsed.value, {}, (line) => console.log(line));
  process.exit(run.code);
}
