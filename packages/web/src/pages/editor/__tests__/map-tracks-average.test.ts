import { describe, expect, it } from "vitest";
import { gpsTrack, mapGeo } from "@oxygen/shared";
import { AverageCancelled, averageImport, averagePasses, averageResponse, createAverager, type AverageRequest, type AverageResponse, type AverageWorkerLike } from "../modes/map/tracks/average";

/** SWEREF99 TM, 1:10 000, 100 units per mm (as map-tracks-model.test.ts). */
const frame: mapGeo.PaperFrame = {
  unitsPerMm: 100,
  mapScale: 10000,
  georeferencing: { crs: { authority: "EPSG", code: 3006, name: "SWEREF99 TM" }, paperOrigin: { x: 500000, y: 6500000 }, gridRotationDeg: 0, gridScaleFactor: 1 },
};
const line = (pts: [number, number][], metresPerMm = 10): gpsTrack.ProjectedTrack => ({
  x: Float64Array.from(pts, (p) => p[0]), y: Float64Array.from(pts, (p) => p[1]), metresPerMm,
});
/** Two passes 0.3 mm (3 m) apart along x, 40 mm long; the second one covering the first half only, reversed. */
const a = line(Array.from({ length: 41 }, (_, i) => [i, 0] as [number, number]));
const b = line(Array.from({ length: 21 }, (_, i) => [20 - i, 0.3] as [number, number]));

/** A worker in the same thread: the entry's handler, answered on a microtask. */
function inline(): AverageWorkerLike & { posted: AverageRequest[]; terminated: boolean } {
  const w = {
    posted: [] as AverageRequest[],
    terminated: false,
    onmessage: null as ((e: MessageEvent<AverageResponse>) => void) | null,
    onerror: null as ((e: Event) => void) | null,
    postMessage(msg: AverageRequest) {
      w.posted.push(msg);
      queueMicrotask(() => w.onmessage?.({ data: averageResponse(msg) } as MessageEvent<AverageResponse>));
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

describe("averaging in Map mode (docs/map-gps-tracks.md §5.2, G27)", () => {
  it("the worker's handler is averageTracks with the defaults (15 m, 2 iterations); a RangeError is its error", () => {
    const r = averageResponse({ id: 3, passes: [a, b] });
    const want = gpsTrack.averageTracks([a, b], { maxDistanceM: gpsTrack.DEFAULT_MATCH_DISTANCE_M, iterations: gpsTrack.DEFAULT_ITERATIONS });
    expect(r).toEqual({ id: 3, ok: true, line: want.line, singlePass: want.singlePass });
    // The covered half on the centre line, the rest on the one pass; one single-pass range.
    if (!r.ok) throw new Error("expected ok");
    expect(r.singlePass).toHaveLength(1);
    const mid = r.line.x.findIndex((x) => x > 5);
    expect(r.line.y[mid]).toBeCloseTo(0.15, 6);
    expect(r.line.y[r.line.x.length - 3]).toBeCloseTo(0, 6);
    expect(averageResponse({ id: 4, passes: [a] })).toMatchObject({ id: 4, ok: false });
  });

  it("the passes go as copies: the rows' lines are never detached", () => {
    const sub = { x: a.x.subarray(2, 10), y: a.y.subarray(2, 10), metresPerMm: 10 };
    const [c] = averagePasses([sub]);
    expect(c.x).not.toBe(sub.x);
    expect(c.x.buffer).not.toBe(a.x.buffer);
    expect(c.x.buffer.byteLength).toBe(8 * 8);
    expect(Array.from(c.x)).toEqual(Array.from(sub.x));
  });

  it("the client: one worker, the answer by id, dispose terminates it and rejects what is in flight", async () => {
    let made = 0;
    const w = inline();
    const avg = createAverager(() => { made++; return w; });
    const r1 = await avg.run([a, b]);
    const r2 = await avg.run([b, a]);
    expect(made).toBe(1);
    expect(r1).toEqual(r2); // §4.2: any order, the same bytes
    expect(w.posted.map((p) => p.id)).toEqual([1, 2]);
    // The posted passes are copies.
    expect(w.posted[0].passes[0].x).not.toBe(a.x);
    await expect(avg.run([a])).rejects.toThrow();
    const hung = createAverager(() => ({ ...inline(), postMessage() { /* never answers */ } }));
    const p = hung.run([a, b]);
    hung.dispose();
    await expect(p).rejects.toBeInstanceOf(AverageCancelled);
    avg.dispose();
    expect(w.terminated).toBe(true);
  });

  it("the result stored like an imported track: client id, no file name, derivedFrom, singlePass, index-aligned WGS 84", () => {
    const r = averageResponse({ id: 1, passes: [a, b] });
    if (!r.ok) throw new Error("expected ok");
    const out = averageImport(frame, r, "0190a000-0000-7000-8000-0000000000a1", "Average of 2 tracks", ["p", "q"]);
    if (!out.ok) throw new Error("expected ok");
    expect(out.item).toMatchObject({ id: "0190a000-0000-7000-8000-0000000000a1", name: "Average of 2 tracks", sourceName: "", derivedFrom: ["p", "q"], singlePass: r.singlePass });
    expect(out.item.points.lat).toHaveLength(r.line.x.length);
    expect(out.item.points.time).toBeNull();
    // Back on the paper within a hair of the averaged samples (§3.2: 1e-7°).
    const back = gpsTrack.projectTrack(frame, { name: null, points: out.item.points }).track;
    for (const i of [0, 7, r.line.x.length - 1]) {
      expect(Math.abs(back.x[i] - r.line.x[i])).toBeLessThan(0.002);
      expect(Math.abs(back.y[i] - r.line.y[i])).toBeLessThan(0.002);
    }
  });

  it("over 200 000 points, or without a georeference: refused on the device", () => {
    const big = { line: { x: new Float64Array(200_001), y: new Float64Array(200_001), metresPerMm: 10 }, singlePass: [] };
    expect(averageImport(frame, big, "x", "n", ["p", "q"])).toEqual({ ok: false, code: "too-many-points" });
    const bare = { ...frame, georeferencing: null } as unknown as mapGeo.PaperFrame;
    expect(averageImport(bare, { line: a, singlePass: [] }, "x", "n", ["p", "q"])).toEqual({ ok: false, code: "not-projectable" });
  });
});
