/**
 * The E2E GPS-track fixture (docs/map-gps-tracks.md §5; e2e/map-gps-tracks.spec.ts): a synthetic GPX
 * placed on the frame of `e2e/test.ocd`, the map the editor's E2E event pins. Nothing here comes from a
 * real recording.
 *
 *   pnpm --filter @oxygen/api exec tsx scripts/generate-test-gpx.ts
 *
 * Writes `e2e/fixtures/gps-tracks.gpx` (two tracks) and `e2e/fixtures/gps-tracks.json` (what the editor
 * must show for them: the paper mm of every point as `projectTrack` places the stored 1e-7° values, the
 * ground length, the points outside the map). The spec hard-codes those numbers, so a projection
 * regression moves the drawn track and fails it; regenerate only when the fixture map itself changes.
 *
 * - "E2E inside": an L of five timed points (with elevation) around the map's centre, 20 mm up and 30 mm
 *   across.
 * - "E2E outside": four untimed points from inside the map to 50 mm past its east edge; two lie outside.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gpsTrack, mapDocument, mapGeo } from "@oxygen/shared";
import { importMapToDocument } from "../src/import/ocad.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const file = await readFile(resolve(root, "e2e/test.ocd"));
const { bytes } = await importMapToDocument(file, "test.ocd", "ocad");
const { header } = mapDocument.readMapDocumentHeader(bytes);
const u = header.unitsPerMm;
const frame: mapGeo.PaperFrame = { unitsPerMm: u, mapScale: header.mapScale, georeferencing: header.georeferencing, correctionDeg: 0 };
const b = header.bounds;
const cx = Math.round((b.minX + b.maxX) / 2 / u), cy = Math.round((b.minY + b.maxY) / 2 / u);
const east = b.maxX / u;

type Mm = [number, number];
const tracks: { name: string; mm: Mm[]; timed: boolean }[] = [
  { name: "E2E inside", timed: true, mm: [[cx - 15, cy + 10], [cx - 15, cy], [cx - 15, cy - 10], [cx, cy - 10], [cx + 15, cy - 10]] },
  { name: "E2E outside", timed: false, mm: [[east - 40, cy + 20], [east - 10, cy + 20], [east + 20, cy + 20], [east + 50, cy + 20]] },
];

const START = Date.UTC(2026, 0, 17, 9, 30, 0);
const gpx: string[] = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<gpx version="1.1" creator="oxygen generate-test-gpx" xmlns="http://www.topografix.com/GPX/1/1">',
];
const expected: { name: string; points: number; lengthM: number; outside: number; mm: Mm[]; recordedAt: number | null }[] = [];
for (const t of tracks) {
  const lat: number[] = [], lng: number[] = [];
  gpx.push(`  <trk><name>${t.name}</name><trkseg>`);
  t.mm.forEach(([x, y], i) => {
    const g = mapGeo.paperToWgs84(frame, x * u, y * u);
    if (!g) throw new Error("test.ocd has no georeference");
    lat.push(gpsTrack.quantiseDeg(g.lat));
    lng.push(gpsTrack.quantiseDeg(g.lng));
    const extra = t.timed ? `<ele>${(120 + i).toFixed(1)}</ele><time>${new Date(START + i * 60_000).toISOString()}</time>` : "";
    gpx.push(`    <trkpt lat="${(lat[i] / 1e7).toFixed(7)}" lon="${(lng[i] / 1e7).toFixed(7)}">${extra}</trkpt>`);
  });
  gpx.push("  </trkseg></trk>");
  // What the editor computes: the stored points projected back (docs/map-gps-tracks.md §3.2).
  const { track, outside } = gpsTrack.projectTrack(frame, { name: t.name, points: { lat, lng, time: null, ele: null } }, header.bounds);
  let mm = 0;
  for (let i = 1; i < track.x.length; i++) mm += Math.sqrt((track.x[i] - track.x[i - 1]) ** 2 + (track.y[i] - track.y[i - 1]) ** 2);
  expected.push({
    name: t.name,
    points: t.mm.length,
    lengthM: Math.round(mm * track.metresPerMm * 10) / 10,
    outside,
    mm: Array.from(track.x, (x, i) => [Math.round(x * 1000) / 1000, Math.round(track.y[i] * 1000) / 1000] as Mm),
    recordedAt: t.timed ? START : null,
  });
}
gpx.push("</gpx>", "");

await writeFile(resolve(root, "e2e/fixtures/gps-tracks.gpx"), gpx.join("\n"));
await writeFile(resolve(root, "e2e/fixtures/gps-tracks.json"), JSON.stringify({ source: "e2e/test.ocd", mapScale: header.mapScale, tracks: expected }, null, 2) + "\n");
console.log(`wrote e2e/fixtures/gps-tracks.{gpx,json}: centre ${cx}, ${cy} mm, scale 1:${header.mapScale}`);
