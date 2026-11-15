import { describe, expect, it } from "vitest";
import { gpsTrack, mapGeo } from "@oxygen/shared";
import type { TrackMeta } from "../../../lib/editor/write-client";
import {
  MAX_CALL_POINTS, MAX_CALL_TRACKS, MAX_TRACK_POINTS, TRACK_COLOURS, chunkTracks, deletedTrackImport, disabledReason, locateBounds, parseVisibility,
  planImport, projectTrackRow, pruneVisibility, trackColour, trackErrorCode, trackRows, type TrackGeometry, defaultVisible, nextOverrides, pruneSelection,
  showConvertedKey, visibilityKey,
} from "../modes/map/tracks/model";

/** SWEREF99 TM, 1:10 000, 100 units per mm, origin at 500 000 / 6 500 000 (as project.test.ts). */
const frame: mapGeo.PaperFrame = {
  unitsPerMm: 100,
  mapScale: 10000,
  georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 500000, y: 6500000 }, gridRotationDeg: 0, gridScaleFactor: 1 },
};
const bounds = { minX: -5000, minY: -5000, maxX: 5000, maxY: 5000 }; // ±50 mm, native units

function pointsAt(mm: [number, number][], timed = false): gpsTrack.TrackPoints {
  const g = mm.map(([x, y]) => mapGeo.paperToWgs84(frame, x * 100, y * 100)!);
  return {
    lat: g.map((p) => gpsTrack.quantiseDeg(p.lat)),
    lng: g.map((p) => gpsTrack.quantiseDeg(p.lng)),
    time: timed ? mm.map((_, i) => 1_700_000_000_000 + i * 1000) : null,
    ele: null,
  };
}

function gpx(tracks: { name?: string; mm: [number, number][] }[], extra = ""): string {
  const trk = tracks.map((t) => {
    const p = pointsAt(t.mm);
    const pts = p.lat.map((lat, i) => `<trkpt lat="${lat / 1e7}" lon="${p.lng[i] / 1e7}"/>`).join("");
    return `<trk>${t.name ? `<name>${t.name}</name>` : ""}<trkseg>${pts}</trkseg></trk>`;
  }).join("");
  return `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">${extra}${trk}</gpx>`;
}

function meta(id: string, over: Partial<TrackMeta> = {}): TrackMeta {
  return {
    id, name: `T ${id}`, sourceName: `${id}.gpx`, pointCount: 3, recordedAt: null, trim: { start: 0, end: 3 }, derivedFrom: [], singlePass: null,
    convertedOp: null, createdBy: null, createdAt: "2026-11-15T10:00:00.000Z", version: "1", ...over,
  };
}

describe("disabledReason (docs/map-gps-tracks.md §5.1 'Where it is off')", () => {
  it("is venue, then permission, then georeference, else null", () => {
    expect(disabledReason({ nodeRole: "venue", canEdit: false, georeferenced: false })).toBe("venue");
    expect(disabledReason({ nodeRole: "cloud", canEdit: false, georeferenced: false })).toBe("no-permission");
    expect(disabledReason({ nodeRole: "cloud", canEdit: true, georeferenced: false })).toBe("not-georeferenced");
    expect(disabledReason({ nodeRole: "cloud", canEdit: true, georeferenced: true })).toBeNull();
    // The role not yet known is not a venue: the reads are refused there anyway (§1.3).
    expect(disabledReason({ nodeRole: undefined, canEdit: true, georeferenced: true })).toBeNull();
  });
});

describe("planImport (§5.1 'Import')", () => {
  it("one track per segment in file order, names cut to 200 and file names to 255, points verbatim", () => {
    const long = "x".repeat(300);
    const plan = planImport([
      { name: "a.gpx", text: gpx([{ name: "First", mm: [[0, 0], [1, 0]] }, { mm: [[0, 1], [1, 1], [2, 1]] }]) },
      { name: `${long}.gpx`, text: gpx([{ name: long, mm: [[0, 2], [1, 2]] }]) },
    ]);
    expect(plan.issues).toEqual([]);
    expect(plan.calls).toHaveLength(1);
    const items = plan.calls[0];
    expect(items.map((t) => t.name)).toEqual(["First", null, "x".repeat(200)]);
    expect(items.map((t) => t.sourceName)).toEqual(["a.gpx", "a.gpx", `${long}.gpx`.slice(0, 255)]);
    expect(items[1].points).toEqual(pointsAt([[0, 1], [1, 1], [2, 1]]));
    expect(plan.tracks).toBe(3);
  });

  it("a file that does not parse is reported by name and code; the others still go", () => {
    const plan = planImport([
      { name: "bad.gpx", text: "<kml></kml>" },
      { name: "cut.gpx", text: "<gpx><trk><trkseg><trkpt lat=" },
      { name: "wpt.gpx", text: '<gpx version="1.1"><wpt lat="1" lon="2"/></gpx>' },
      { name: "ok.gpx", text: gpx([{ mm: [[0, 0], [1, 0]] }]) },
    ]);
    expect(plan.issues).toEqual([
      { file: "bad.gpx", code: "not-gpx" },
      { file: "cut.gpx", code: "malformed" },
      { file: "wpt.gpx", code: "no-points" },
    ]);
    expect(plan.calls.flat().map((t) => t.sourceName)).toEqual(["ok.gpx"]);
  });

  it("counts what the files had that is not imported: skipped points, segments, waypoints", () => {
    const ok = gpx([{ mm: [[0, 0], [1, 0]] }], '<wpt lat="1" lon="2"/><wpt lat="1" lon="3"/>')
      .replace("</gpx>", '<trk><trkseg><trkpt lat="999" lon="1"/><trkpt lat="1" lon="1"/></trkseg></trk></gpx>');
    const plan = planImport([{ name: "a.gpx", text: ok }]);
    expect(plan.skipped).toEqual({ points: 1, segments: 1, waypoints: 2 });
  });

  it("a track over 200 000 points is refused by name; the rest go", () => {
    const n = MAX_TRACK_POINTS + 1;
    const pts = Array.from({ length: n }, (_, i) => `<trkpt lat="58.${String(i).padStart(7, "0")}" lon="15"/>`).join("");
    const big = `<gpx version="1.1"><trk><name>Big</name><trkseg>${pts}</trkseg></trk><trk><name>Small</name><trkseg><trkpt lat="1" lon="1"/><trkpt lat="1" lon="2"/></trkseg></trk></gpx>`;
    const plan = planImport([{ name: "big.gpx", text: big }]);
    expect(plan.issues).toEqual([{ file: "big.gpx", track: "Big", code: "too-many-points" }]);
    expect(plan.calls.flat().map((t) => t.name)).toEqual(["Small"]);
  }, 20_000);

  it("calls hold at most 500 000 points and 200 tracks, in file order", () => {
    // Synthetic parsed tracks (the GPX text of 600 000 points is needless here).
    const lat = (n: number) => Array.from({ length: n }, (_, i) => i);
    const track = (name: string, n: number) => ({ name, sourceName: "a.gpx", points: { lat: lat(n), lng: lat(n), time: null, ele: null } });
    const calls = chunkTracks([track("a", 200_000), track("b", 200_000), track("c", 200_000), ...Array.from({ length: 250 }, (_, i) => track(`s${i}`, 2))]);
    for (const call of calls) {
      expect(call.length).toBeLessThanOrEqual(MAX_CALL_TRACKS);
      expect(call.reduce((s, t) => s + t.points.lat.length, 0)).toBeLessThanOrEqual(MAX_CALL_POINTS);
    }
    expect(calls.flat().map((t) => t.name)).toEqual(["a", "b", "c", ...Array.from({ length: 250 }, (_, i) => `s${i}`)]);
    expect(calls.map((c) => c.length)).toEqual([2, 200, 51]);
    expect(chunkTracks([])).toEqual([]);
  });
});

describe("projectTrackRow (§5.1 'Projection', 'The list')", () => {
  const mm: [number, number][] = [[0, 0], [30, 0], [30, 40], [60, 40], [70, 40]];
  it("projects the trimmed range: length in ground metres, outside count, bounding box", () => {
    const g = projectTrackRow(frame, bounds, { start: 0, end: 5 }, pointsAt(mm)) as TrackGeometry;
    expect(g.line.x).toHaveLength(5);
    expect(g.lengthM).toBeCloseTo((30 + 40 + 30 + 10) * 10, 0); // 1:10 000 → 10 m per mm
    expect(g.outside).toBe(2); // 60 and 70 mm are past 50 mm
    expect(g.bbox.minX).toBeCloseTo(0, 2);
    expect(g.bbox.maxX).toBeCloseTo(70, 2);
    expect(g.bbox.maxY).toBeCloseTo(40, 2);
    const t = projectTrackRow(frame, bounds, { start: 1, end: 3 }, pointsAt(mm)) as TrackGeometry;
    expect(t.line.x).toHaveLength(2);
    expect(t.lengthM).toBeCloseTo(400, 0);
    expect(t.outside).toBe(0);
    expect(t.bbox.minX).toBeCloseTo(30, 2);
  });

  it("a point that does not project is the row's error, not a drawn line", () => {
    const p = pointsAt([[0, 0], [1, 0]]);
    p.lat[1] = Number.NaN;
    expect(projectTrackRow(frame, bounds, { start: 0, end: 2 }, p)).toEqual({ error: "not-projectable" });
  });
});

describe("trackRows (§5.1 'The list')", () => {
  it("keeps the list order; state, visibility override, colour, label, visible points", () => {
    const geom = new Map<string, TrackGeometry | { error: string }>([
      ["b", { line: { x: new Float64Array([0, 1]), y: new Float64Array([0, 0]), metresPerMm: 10 }, lengthM: 10, outside: 0, bbox: { minX: 0, minY: 0, maxX: 1, maxY: 0 } }],
      ["c", { error: "not-projectable" }],
    ]);
    const rows = trackRows([meta("a"), meta("b", { name: null, trim: { start: 1, end: 3 } }), meta("c")], geom, { b: false });
    expect(rows.map((r) => [r.meta.id, r.state, r.visible])).toEqual([["a", "loading", true], ["b", "ready", false], ["c", "error", true]]);
    expect(rows[1].label).toBe("b.gpx");
    expect(rows[0].label).toBe("T a");
    expect(rows[1].points).toBe(2);
    expect(rows[2].error).toBe("not-projectable");
    expect(rows[0].colour).toBe(trackColour("a"));
  });

  it("a converted track is hidden by default, shown with Show converted; the device's override wins either way (G26)", () => {
    const geom = new Map<string, TrackGeometry | { error: string }>();
    const conv = { convertedOp: "add:0190a000-0000-7000-8000-0000000000c1" };
    const metas = [meta("a"), meta("b", conv), meta("c", conv), meta("d", conv)];
    const overrides = { c: true, d: false };
    expect(trackRows(metas, geom, overrides).map((r) => r.visible)).toEqual([true, false, true, false]);
    expect(trackRows(metas, geom, overrides, true).map((r) => r.visible)).toEqual([true, true, true, false]);
    expect(defaultVisible(meta("a"), false)).toBe(true);
    expect(defaultVisible(meta("b", conv), false)).toBe(false);
    expect(defaultVisible(meta("b", conv), true)).toBe(true);
  });
});

describe("the eye's overrides and the conversion's selection (G26)", () => {
  const conv = meta("b", { convertedOp: "add:0190a000-0000-7000-8000-0000000000c1" });
  it("an override is kept only where it differs from the default", () => {
    // Hiding a plain track, showing it again.
    expect(nextOverrides({}, meta("a"), false, false)).toEqual({ a: false });
    expect(nextOverrides({ a: false }, meta("a"), true, false)).toEqual({});
    // A converted track: shown is the override, hidden again drops it; under Show converted the other way round.
    expect(nextOverrides({}, conv, true, false)).toEqual({ b: true });
    expect(nextOverrides({ b: true }, conv, false, false)).toEqual({});
    expect(nextOverrides({}, conv, false, true)).toEqual({ b: false });
    // Others untouched.
    expect(nextOverrides({ x: false }, meta("a"), false, false)).toEqual({ x: false, a: false });
  });

  it("Show converted has its own key per event, beside the overrides", () => {
    expect(showConvertedKey("itest")).toBe("oxygen:gps-tracks:itest:show-converted");
    expect(showConvertedKey("itest")).not.toBe(visibilityKey("itest"));
  });

  it("the selection keeps listed, ready rows in list order", () => {
    const rows = [
      { meta: meta("a"), state: "ready" as const },
      { meta: meta("b"), state: "loading" as const },
      { meta: meta("c"), state: "error" as const },
      { meta: meta("d"), state: "ready" as const },
    ];
    expect(pruneSelection(["d", "b", "c", "a", "gone"], rows)).toEqual(["a", "d"]);
    expect(pruneSelection([], rows)).toEqual([]);
  });
});

describe("trackColour, locateBounds, visibility (§5.1)", () => {
  it("a colour from the palette, stable for an id, spread over ids", () => {
    const ids = Array.from({ length: 64 }, (_, i) => `0190${String(i).padStart(4, "0")}-0000-7000-8000-00000000000${i % 10}`);
    for (const id of ids) {
      expect(TRACK_COLOURS).toContain(trackColour(id));
      expect(trackColour(id)).toBe(trackColour(id));
    }
    expect(new Set(ids.map(trackColour)).size).toBeGreaterThanOrEqual(6);
  });

  it("locate pads the box by 5 % and gives it a 10 mm minimum side", () => {
    expect(locateBounds({ minX: 0, minY: 0, maxX: 100, maxY: 40 })).toEqual({ minX: -5, minY: -2, maxX: 105, maxY: 42 });
    expect(locateBounds({ minX: 10, minY: 10, maxX: 12, maxY: 10 })).toEqual({ minX: 6, minY: 5, maxX: 16, maxY: 15 });
  });

  it("overrides parse defensively and drop ids no longer listed", () => {
    expect(parseVisibility(null)).toEqual({});
    expect(parseVisibility("not json")).toEqual({});
    expect(parseVisibility('{"a":false,"b":true,"c":3}')).toEqual({ a: false, b: true });
    expect(pruneVisibility({ a: false, b: true }, ["b", "c"])).toEqual({ b: true });
  });
});

describe("deletedTrackImport (§5.1 'Rename and delete': a delete's undo)", () => {
  it("re-imports under the id with name, file name and points; an average with its passes and ranges", () => {
    const points = pointsAt([[0, 0], [1, 0], [2, 0]]);
    expect(deletedTrackImport(meta("a"), points)).toEqual({ id: "a", name: "T a", sourceName: "a.gpx", points });
    const avg = meta("v", { derivedFrom: ["a", "b"], singlePass: [{ start: 0, end: 1 }], sourceName: "" });
    expect(deletedTrackImport(avg, points)).toEqual({ id: "v", name: "T v", sourceName: "", points, derivedFrom: ["a", "b"], singlePass: [{ start: 0, end: 1 }] });
  });
});

describe("trackErrorCode", () => {
  it("reads the TRACK_* prefix", () => {
    expect(trackErrorCode(new Error("TRACK_LIMIT: the event would hold more than 200 tracks"))).toBe("TRACK_LIMIT");
    expect(trackErrorCode(new Error("boom"))).toBeNull();
  });
});
