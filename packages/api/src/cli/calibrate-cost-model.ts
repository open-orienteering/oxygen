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
 * arguments, 1 when a map cannot take tracks or no leg survives.
 */

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mapDocument } from "@oxygen/shared";
import { deriveTerrain } from "@oxygen/shared/src/terrain/index.js";
import { fieldSampler } from "@oxygen/shared/src/terrain/profile/index.js";
import { DEFAULT_COST_MODEL_DATA } from "@oxygen/shared/src/route/index.js";
import {
  buildReport, calibrationMapOf, crossValidate, finderRatios, fitCostModel, modelDataOf, observeRecord, trackRecordSchema,
  type CalibrationReport, type FitOptions, type MapObservations,
} from "@oxygen/shared/src/route/calibration/index.js";
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

export async function runCalibration(args: CalibrationArgs, fit: FitOptions = {}): Promise<CalibrationRun> {
  const lines: string[] = [];
  const sets: MapObservations[] = [];
  const finder: number[] = [];
  const perMap: { map: ReturnType<typeof calibrationMapOf>; sets: MapObservations[] }[] = [];
  let runnerBase = 0;
  for (const [m, entry] of args.maps.entries()) {
    const file = await readFile(entry.map);
    const kind = sniffMapKind(file.subarray(0, 1024));
    if (!kind) { lines.push(`map ${m + 1}: not an OCAD or Mapper file`); return { code: 1, report: null, lines }; }
    const imported = await importMapToDocument(file, `map-${m + 1}`, kind);
    const doc = mapDocument.decodeMapDocument(imported.bytes);
    const derived = args.heights ? deriveTerrain(doc) : null;
    const map = calibrationMapOf(doc, derived ? fieldSampler(derived.field).heightAt : null);
    lines.push(`map ${m + 1}: 1:${doc.header.mapScale}, ${doc.header.objects.count} objects, heights ${derived ? "from contours" : "none"}`);
    const merged: MapObservations = { observations: [], pairs: new Map(), tracks: 0, tracksUsed: 0, courses: 0, rejected: {}, medianMissM: Number.NaN, blockedShare: 0, outside: 0, warnings: [] };
    const misses: number[] = [];
    let blockedM = 0, totalM = 0;
    const own: MapObservations[] = [];
    for (const path of (await Promise.all(entry.tracks.map(recordFiles))).flat()) {
      const parsed = trackRecordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (!parsed.success) { lines.push(`map ${m + 1}: a track record does not parse (${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message})`); return { code: 1, report: null, lines }; }
      let set: MapObservations;
      try {
        set = observeRecord(map, parsed.data, runnerBase, `${m}:`);
      } catch (err) {
        lines.push(`map ${m + 1}: ${err instanceof Error ? err.message : String(err)}`);
        return { code: 1, report: null, lines };
      }
      runnerBase += set.tracks;
      own.push(set);
      const base = merged.observations.length;
      merged.observations.push(...set.observations);
      for (const [k, p] of set.pairs) {
        const known = merged.pairs.get(k);
        if (known) known.observations.push(...p.observations.map((i) => i + base));
        else merged.pairs.set(k, { ...p, observations: p.observations.map((i) => i + base) });
      }
      merged.tracks += set.tracks; merged.tracksUsed += set.tracksUsed; merged.courses += set.courses; merged.outside += set.outside;
      for (const [k, n] of Object.entries(set.rejected)) merged.rejected[k as keyof MapObservations["rejected"]] = (merged.rejected[k as keyof MapObservations["rejected"]] ?? 0) + (n ?? 0);
      if (Number.isFinite(set.medianMissM)) misses.push(set.medianMissM);
      const metres = set.observations.reduce((s, o) => s + o.f.totalM, 0);
      blockedM += set.blockedShare * metres; totalM += metres;
      merged.warnings = [...new Set([...merged.warnings, ...set.warnings])];
    }
    misses.sort((a, b) => a - b);
    merged.medianMissM = misses.length > 0 ? misses[misses.length >> 1] : Number.NaN;
    merged.blockedShare = totalM > 0 ? blockedM / totalM : 0;
    sets.push(merged);
    perMap.push({ map, sets: [merged] });
    lines.push(`map ${m + 1}: ${merged.tracksUsed} of ${merged.tracks} tracks, ${merged.observations.length} legs, control miss ${Number.isFinite(merged.medianMissM) ? merged.medianMissM.toFixed(1) : "–"} m, ${(merged.blockedShare * 100).toFixed(1)} % on uncrossable`);
  }
  const all = sets.flatMap((s) => s.observations);
  if (all.length === 0) { lines.push("no leg survived the cleaning"); return { code: 1, report: null, lines }; }
  const result = fitCostModel(all, DEFAULT_COST_MODEL_DATA, fit);
  const model = modelDataOf(result, DEFAULT_COST_MODEL_DATA, args.id, `${result.runners} runs, ${all.length} legs on ${sets.length} map${sets.length === 1 ? "" : "s"}`);
  for (const { map, sets: own } of perMap) for (const set of own) finder.push(...finderRatios(map, set, model));
  const report = buildReport({ model, base: DEFAULT_COST_MODEL_DATA, fit: result, sets, alongTrack: result.supported.some(Boolean) ? crossValidate(all, DEFAULT_COST_MODEL_DATA, fit) : null, finder });
  await writeFile(args.out, JSON.stringify(report, null, 2) + "\n");
  for (const c of report.classes) {
    if (c.metres === 0) continue;
    lines.push(`${c.class.padEnd(14)} ${String(c.metres).padStart(7)} m ${String(c.runners).padStart(4)} runs ${String(c.legs).padStart(5)} legs  ${c.baseFactor.toFixed(2)} → ${c.factor.toFixed(2)}${c.interval ? ` [${c.interval[0].toFixed(2)}, ${c.interval[1].toFixed(2)}]` : ""}  ${c.calibrated ? (c.anchor ? "reference" : "measured") : c.kept ?? ""}`);
  }
  lines.push(`slope: up ${report.model.slope.up}${report.slope.upFitted ? "" : " (kept)"}, down ${report.model.slope.down}${report.slope.downFitted ? "" : " (kept)"}, heights under ${(report.slope.heightShare * 100).toFixed(0)} % of the track`);
  if (report.alongTrack) lines.push(`held-out legs: median error ${((report.alongTrack.fitted.medianAbs ?? 0) * 100).toFixed(1)} % fitted, ${((report.alongTrack.base.medianAbs ?? 0) * 100).toFixed(1)} % rule of thumb (${report.alongTrack.fitted.legs} legs)`);
  if (report.againstFinder?.median != null) lines.push(`actual ÷ the finder's fastest route: median ${report.againstFinder.median.toFixed(2)} over ${report.againstFinder.legs} legs`);
  return { code: 0, report, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = parseCalibrationArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(2);
  }
  const run = await runCalibration(parsed.value);
  for (const l of run.lines) console.log(l);
  process.exit(run.code);
}
