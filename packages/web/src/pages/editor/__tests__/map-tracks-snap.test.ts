/**
 * A converted track's ends snapped to the track network (docs/map-gps-tracks.md §6.7; docs/course-editor.md §13 "GPS
 * tracks: junctions"; row G28): short, overshoot, end to end, nothing in reach, and the track-symbol filter.
 */

import { describe, expect, it } from "vitest";
import { mapDocument, render, symbolLibrary } from "@oxygen/shared";
import { nearestOnLines, nearestOnPath } from "../../../lib/editor/snap";
import {
  SNAP_ENDS_MM, TRACK_ENTRY_IDS, isTrackSymbolRef, libraryTrackLineIds, snapLineEnds, trackSymbolFilter, type FindLine,
} from "../modes/map/tracks/snap-ends";

type C = mapDocument.PatchCoord;
const T = mapDocument.OBJECT_TYPE;
const F = render.COORD_FLAG;
const U = 100;

/** The target: a track line along y = 0 from x = 0 to 100 mm (100 units per mm). */
const TARGET: C[] = [[0, 0], [10000, 0]];
const findOn = (...targets: C[][]): FindLine => (pt) => {
  let best = null;
  for (const t of targets) {
    const h = nearestOnPath(t, U, pt, SNAP_ENDS_MM);
    if (h && (!best || h.distanceMm < best.distanceMm)) best = h;
  }
  return best;
};
const find = findOn(TARGET);

describe("snapLineEnds: the rules (§6.7)", () => {
  it("short: an end 1 mm before the line is moved onto its nearest point (extended straight)", () => {
    const r = snapLineEnds([[5000, 2000], [5000, 100]], find, U);
    expect(r.coords).toEqual([[5000, 2000], [5000, 0]]);
    expect(r.snapped).toBe(1);
    expect(r.how).toEqual([null, "moved"]);
  });

  it("overshoot: an end 1 mm past the line is cut at the crossing", () => {
    const r = snapLineEnds([[5000, 2000], [5000, -100]], find, U);
    expect(r.coords).toEqual([[5000, 2000], [5000, 0]]);
    expect(r.how).toEqual([null, "cut"]);
    // Over several nodes, every one after the crossing within reach: cut on the segment that crosses.
    const r2 = snapLineEnds([[5000, 2000], [5000, 50], [5100, -100]], find, U);
    expect(r2.coords).toEqual([[5000, 2000], [5000, 50], [5033, 0]]);
  });

  it("an overshoot whose tail leaves reach is not cut: the end is moved instead", () => {
    const r = snapLineEnds([[5000, 2000], [5000, -300], [5100, -100]], find, U);
    expect(r.coords).toEqual([[5000, 2000], [5000, -300], [5100, 0]]);
    expect(r.how).toEqual([null, "moved"]);
  });

  it("end to end: the line's end node within reach is taken, before a crossing or a nearest point", () => {
    expect(snapLineEnds([[-2000, 2000], [-100, 100]], find, U).coords).toEqual([[-2000, 2000], [0, 0]]);
    // Crosses at (1, 0), but the end node (0, 0) is within 1.5 mm of the end (1.41 mm): end to end wins.
    const r = snapLineEnds([[100, 2000], [100, -100]], find, U);
    expect(r.coords).toEqual([[100, 2000], [0, 0]]);
    expect(r.how).toEqual([null, "end"]);
  });

  it("nothing in reach: the coordinates come back unchanged", () => {
    const coords: C[] = [[5000, 2000], [5000, 200]];
    const r = snapLineEnds(coords, find, U);
    expect(r.coords).toEqual(coords);
    expect(r.snapped).toBe(0);
    expect(snapLineEnds(coords, () => null, U).coords).toEqual(coords);
  });

  it("the reach is 1.5 mm, inclusive", () => {
    expect(snapLineEnds([[5000, 2000], [5000, 150]], find, U).coords).toEqual([[5000, 2000], [5000, 0]]);
    expect(snapLineEnds([[5000, 2000], [5000, 151]], find, U).snapped).toBe(0);
  });

  it("both ends, start first; each to its own line", () => {
    const other: C[] = [[0, 5000], [10000, 5000]];
    const r = snapLineEnds([[3000, 100], [3000, 4900]], findOn(TARGET, other), U);
    expect(r.coords).toEqual([[3000, 0], [3000, 5000]]);
    expect(r.snapped).toBe(2);
    expect(r.how).toEqual(["moved", "moved"]);
    // An overshooting start is cut too.
    expect(snapLineEnds([[3000, -100], [3000, 4000]], find, U).coords).toEqual([[3000, 0], [3000, 4000]]);
  });

  it("a snap that would leave fewer than two distinct coordinates is not made", () => {
    // A 0.5 mm stub across the line: cutting or moving the end would collapse it onto the moved start.
    const r = snapLineEnds([[5000, 20], [5000, -20]], find, U);
    expect(new Set(r.coords.map((c) => `${c[0]},${c[1]}`)).size).toBeGreaterThanOrEqual(2);
  });

  it("is deterministic and does not mutate its input", () => {
    const coords: C[] = [[5000, 2000], [5000, 50], [5100, -100]];
    const copy = structuredClone(coords);
    expect(snapLineEnds(coords, find, U)).toEqual(snapLineEnds(coords, find, U));
    expect(coords).toEqual(copy);
  });

  it("flags: the new end keeps the old end's (border bits cleared), a new start the border bits of its segment", () => {
    const r = snapLineEnds([[5000, -100, F.noLeft | F.corner], [5000, 1000, F.noRight], [5000, 4000], [5000, 4100, F.dash | F.noLeft]], findOn(TARGET, [[0, 4000], [10000, 4000]]), U);
    expect(r.coords).toEqual([[5000, 0, F.corner | F.noLeft], [5000, 1000, F.noRight], [5000, 4000, F.dash]]);
  });

  it("a curved end segment is not snapped", () => {
    const coords: C[] = [[5000, 2000], [5000, 1000, F.bezierFirst], [5000, 500, F.bezierSecond], [5000, 100]];
    expect(snapLineEnds(coords, find, U).snapped).toBe(0);
  });
});

// ─── The filter ──

const colours = [{ id: "src:0", name: "Black", cmyk: [0, 0, 0, 1] as [number, number, number, number] }];
const match = (canonicalId: string | null, state: "auto" | "suggested" | "unmatched" = "auto") => ({
  canonicalId, method: "explicit" as const, state, confidence: 1, reasons: [], reviewed: false, libraryVersion: symbolLibrary.SYMBOL_LIBRARY_VERSION,
});
const sym = (code: string, kind: "line" | "area" | "point", m?: ReturnType<typeof match>) => ({
  code, name: code, kind, render: null, ...(m ? { match: m } : {}),
});

/**
 * Symbols: 0 `801.0` unmatched line (in); 1 `505.0` unmatched line (out); 2 `801.1` matched to ISSkiOM 801.1 (in);
 * 3 `820.0` matched to ISOM 505 (out); 4 `850.0` with an unreviewed suggestion of ISOM 505 (in: not applied);
 * 5 `808.0` unmatched area (out); 6 `801.5` unmatched point (out); 7 `505` matched to ISSkiOM 805 (in).
 */
function filterDoc() {
  return mapDocument.decodeMapDocument(mapDocument.encodeMapDocument({
    header: {
      format: { version: 1, importer: "test-1" },
      source: { kind: "ocad", version: "2018.8.3", hash: "00".repeat(32), bytes: 1 },
      unitsPerMm: U, mapScale: 15000, georeferencing: { crs: null, paperOrigin: null }, colours,
      symbols: [
        sym("801.0", "line"), sym("505.0", "line"), sym("801.1", "line", match("ISSkiOM2019:801.1")), sym("820.0", "line", match("ISOM2017-2:505")),
        sym("850.0", "line", match("ISOM2017-2:505", "suggested")), sym("808.0", "area"), sym("801.5", "point"), sym("505", "line", match("ISSkiOM2019:805")),
      ] as mapDocument.DocumentSymbolInput[],
    },
    objects: [
      { symbolIdx: 1, type: T.line, sourceIndex: 1, coords: [0, 0, 10000, 0], flags: [0, 0] },
      { symbolIdx: 0, type: T.line, sourceIndex: 2, coords: [0, 120, 10000, 120], flags: [0, 0] },
    ],
  }));
}

describe("the track-symbol filter (§6 answer 4)", () => {
  it("the track group is the ISSkiOM library's track-group line entries (808 is an area)", () => {
    expect([...TRACK_ENTRY_IDS].sort()).toEqual(libraryTrackLineIds().sort());
    expect(TRACK_ENTRY_IDS.has("ISSkiOM2019:808")).toBe(false);
  });

  it("document symbols: matched to a track entry, or unmatched with an 8xx code; lines only", () => {
    const f = trackSymbolFilter(filterDoc());
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(f)).toEqual([true, false, true, false, true, false, false, true]);
  });

  it("patch symbols by their key: each of the twelve in, a path out", () => {
    const base = filterDoc();
    const symbols: Record<string, mapDocument.PatchSymbol> = {};
    for (const id of [...TRACK_ENTRY_IDS, "ISOM2017-2:505"]) {
      const code = id.split(":")[1];
      symbols[id] = { code, name: id, kind: "line", origin: "source", hidden: false, render: { type: "line", id, code, name: id, main: { colour: 0, widthUm: 300 } } } as mapDocument.PatchSymbol;
    }
    const eff = mapDocument.applyPatch(base, mapDocument.mapPatchSchema.parse({
      documentHash: "ab".repeat(32), enabled: true, symbols,
      ops: { "hide:1": { op: "hide", sourceIndex: 1 } },
    })).document;
    const f = trackSymbolFilter(eff);
    const keys = eff.patch!.symbols;
    keys.forEach((k, i) => expect(f(eff.patch!.baseSymbols + i)).toBe(k !== "ISOM2017-2:505"));
    for (const id of TRACK_ENTRY_IDS) expect(isTrackSymbolRef(eff, { patch: id })).toBe(true);
    expect(isTrackSymbolRef(eff, { patch: "ISOM2017-2:505" })).toBe(false);
    expect(isTrackSymbolRef(eff, { doc: 0 })).toBe(true);
    expect(isTrackSymbolRef(eff, { doc: 1 })).toBe(false);
  });

  it("with nearestOnLines: a path nearer than a track is passed over", () => {
    const doc = filterDoc();
    // The 505 path at y = 0 is nearer the end than the 801 track at y = 1.2 mm; the end goes to the track.
    const r = snapLineEnds([[5000, 2000], [5000, 100]], (pt) => nearestOnLines(doc, pt, SNAP_ENDS_MM, trackSymbolFilter(doc)), U);
    expect(r.coords).toEqual([[5000, 2000], [5000, 120]]);
  });
});
