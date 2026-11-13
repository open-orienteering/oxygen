/**
 * `projectTrack` / `unprojectTrack` (docs/map-gps-tracks.md §3.1–3.2),
 * against the frame the importer reads from the E2E fixture map
 * `e2e/test.xmap` (UTM 33N, 1:10 000, grid scale 0.9996, grivation 2.5°,
 * 1000 units per mm) and an OCAD-unit SWEREF99 TM frame.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { paperToWgs84, type PaperFrame } from "../../geo/projection.js";
import { inputBounds } from "../../map-document/codec.js";
import { readOmap } from "../../import/omap-reader.js";
import { omapToDocumentInput } from "../../import/omap-source.js";
import { metresPerMm, projectTrack, TrackProjectionError, unprojectTrack, isGeoreferenced } from "../project.js";
import { quantiseDeg, type Track } from "../track.js";

const FIXTURE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../e2e/test.xmap");
const { header, objects } = omapToDocumentInput(readOmap(readFileSync(FIXTURE, "utf8")), { fileName: "test.xmap", fileHash: "ab".repeat(32), fileBytes: 1 }).input;
const xmap: PaperFrame = { unitsPerMm: header.unitsPerMm, mapScale: header.mapScale, georeferencing: header.georeferencing };
const xmapBounds = inputBounds(objects);

const sweref: PaperFrame = {
  unitsPerMm: 100,
  mapScale: 10000,
  georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 500000, y: 6500000 }, gridRotationDeg: 0, gridScaleFactor: 1 },
};

/** A track of the given paper-mm points on a frame, through `paperToWgs84`. */
function trackAt(frame: PaperFrame, mm: [number, number][]): Track {
  const pts = mm.map(([x, y]) => paperToWgs84(frame, x * frame.unitsPerMm, y * frame.unitsPerMm)!);
  return { name: null, points: { lat: pts.map((p) => quantiseDeg(p.lat)), lng: pts.map((p) => quantiseDeg(p.lng)), time: null, ele: null } };
}

function codeOf(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof TrackProjectionError) return e.code;
    throw e;
  }
  return undefined;
}

describe("the fixture frame", () => {
  it("is the importer's: UTM 33N, 1:10 000, 0.001 mm units", () => {
    expect(xmap.georeferencing.crs).toMatchObject({ authority: "EPSG", code: 32633 });
    expect(xmap.mapScale).toBe(10000);
    expect(xmap.unitsPerMm).toBe(1000);
    expect(isGeoreferenced(xmap)).toBe(true);
    expect(metresPerMm(xmap.mapScale)).toBe(10);
  });
});

describe("projectTrack", () => {
  it("places Mapper's reference point (50, 40) mm — 500 000 / 6 600 000 in UTM 33N — at (50, −40) mm, y up", () => {
    // Mapper's paper y runs down; the document's runs up (docs/map-import.md §4.2).
    const t: Track = { name: null, points: { lat: [], lng: [], time: null, ele: null } };
    const ref = paperToWgs84(xmap, 50 * 1000, -40 * 1000)!;
    t.points.lat.push(quantiseDeg(ref.lat));
    t.points.lng.push(quantiseDeg(ref.lng));
    const { track } = projectTrack(xmap, t);
    // 1e-7° ≈ 1 cm on the ground = 0.001 mm on paper at 1:10 000.
    expect(track.x[0]).toBeCloseTo(50, 2);
    expect(track.y[0]).toBeCloseTo(-40, 2);
    expect(track.metresPerMm).toBe(10);
  });

  it.each([
    ["test.xmap", xmap],
    ["SWEREF99 TM, OCAD units", sweref],
  ] as const)("round trip on %s: paper → WGS 84 → paper within 0.002 mm, index-aligned", (_, frame) => {
    const mm: [number, number][] = [[0, 0], [12.5, -3.25], [80, 60], [-40, 120.125], [55.5, 55.5]];
    const { track } = projectTrack(frame, trackAt(frame, mm));
    expect(track.x).toHaveLength(mm.length);
    mm.forEach(([x, y], i) => {
      expect(Math.abs(track.x[i] - x)).toBeLessThan(0.002);
      expect(Math.abs(track.y[i] - y)).toBeLessThan(0.002);
    });
  });

  it("round trip WGS 84 → paper → WGS 84 is exact in stored units", () => {
    const t = trackAt(xmap, [[10, -10], [20, -30], [70, -75]]);
    const back = unprojectTrack(xmap, projectTrack(xmap, t).track, "back");
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(back.points.lat[i] - t.points.lat[i])).toBeLessThanOrEqual(1);
      expect(Math.abs(back.points.lng[i] - t.points.lng[i])).toBeLessThanOrEqual(1);
    }
    expect(back.name).toBe("back");
    expect(back.points.time).toBeNull();
    expect(back.points.ele).toBeNull();
  });

  it("keeps points outside the map's bounds and counts them", () => {
    const b = xmapBounds; // native units
    const inside: [number, number] = [(b.minX + b.maxX) / 2000, (b.minY + b.maxY) / 2000];
    const t = trackAt(xmap, [inside, [b.maxX / 1000 + 5, inside[1]], [inside[0], b.minY / 1000 - 5], inside]);
    const r = projectTrack(xmap, t, b);
    expect(r.outside).toBe(2);
    expect(r.track.x).toHaveLength(4);
    expect(projectTrack(xmap, t).outside).toBe(0);
  });

  it("follows the operator's rotation correction", () => {
    const t = trackAt(xmap, [[30, -20]]);
    const turned = projectTrack({ ...xmap, correctionDeg: 90 }, t).track;
    // The same ground point turned 90° counter-clockwise about the paper origin (`projectedToPaper` rotates by grid rotation + correction).
    const plain = projectTrack(xmap, t).track;
    expect(turned.x[0]).toBeCloseTo(-plain.y[0], 6);
    expect(turned.y[0]).toBeCloseTo(plain.x[0], 6);
  });

  it("works in mm whatever the native unit", () => {
    const t = trackAt(sweref, [[10, 20]]);
    const { track } = projectTrack(sweref, t);
    expect(track.x[0]).toBeCloseTo(10, 2);
    expect(track.y[0]).toBeCloseTo(20, 2);
  });
});

describe("errors", () => {
  const t = trackAt(xmap, [[0, 0], [1, 1]]);
  const g = xmap.georeferencing;

  it("not-georeferenced without a CRS, without a paper origin, or with a code proj4 does not know", () => {
    expect(codeOf(() => projectTrack({ ...xmap, georeferencing: { ...g, crs: null } }, t))).toBe("not-georeferenced");
    expect(codeOf(() => projectTrack({ ...xmap, georeferencing: { ...g, paperOrigin: null } }, t))).toBe("not-georeferenced");
    expect(codeOf(() => projectTrack({ ...xmap, georeferencing: { ...g, crs: { authority: "EPSG", code: 999999, name: "" } } }, t))).toBe("not-georeferenced");
    expect(codeOf(() => unprojectTrack({ ...xmap, georeferencing: { ...g, crs: null } }, projectTrack(xmap, t).track))).toBe("not-georeferenced");
    expect(isGeoreferenced({ ...xmap, georeferencing: { ...g, crs: null } })).toBe(false);
  });

  it("not-projectable names the point instead of dropping it", () => {
    const bad: Track = { name: null, points: { lat: [...t.points.lat, Number.NaN], lng: [...t.points.lng, 0], time: null, ele: null } };
    try {
      projectTrack(xmap, bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TrackProjectionError);
      expect((e as TrackProjectionError).code).toBe("not-projectable");
      expect((e as TrackProjectionError).index).toBe(2);
    }
  });
});
