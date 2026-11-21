/**
 * The demo map's invented detail (docs/ops/demo-map.md): the seeded
 * enrichment of the o-kartan map in `scripts/demo-map/`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readOcad } from "ocad2geojson";
import type { HeightField } from "@oxygen/shared/src/terrain/field/read.js";
// @ts-expect-error -- plain ES module script, no types
import { DEMO_SEED, PLAN, enrichOcad } from "../../scripts/demo-map/enrich-ocad.mjs";

const ORIGINAL = fileURLToPath(new URL("../../../../fixtures/okartan/okartan-original.ocd", import.meta.url));

type Report = { placed: Record<string, number>; cliffLines: { sym: number; steep: boolean; pts: [number, number][] }[]; features: { sym: number; x: number; y: number }[] };

/**
 * Ground falling east at 0.3 m per m (15 m per paper mm at 1:15 000), and
 * at 1.0 m per m on a band 5 mm wide: the band is steep enough for new
 * cliffs, the rest is not.
 */
function eastFallingField(): HeightField {
  const cellMm = 0.2, x0 = -90, y0 = -110, width = 875, height = 1090;
  const zScaleM = 0.1;
  const bandFrom = 40, bandMm = 5; // paper mm from x0
  const z = new Int16Array(width * height);
  for (let cx = 0; cx < width; cx++) {
    const x = (cx + 0.5) * cellMm;
    const h = 2000 - 15 * (0.3 * x + 0.7 * Math.min(Math.max(x - bandFrom, 0), bandMm));
    for (let cy = 0; cy < height; cy++) z[cy * width + cx] = Math.round(h / zScaleM);
  }
  return {
    header: { version: 1, source: "test", cellMm, x0, y0, width, height, groundMPerMm: 15, intervalM: 5, zScaleM, zOffsetM: 0, datum: "absolute", zMin: -32767, zMax: 32767 },
    z,
    confident: new Uint8Array((width * height + 7) >> 3).fill(255),
  } as HeightField;
}

/** An area object's rings: OCAD flags a hole's first point with yFlags bit 2. */
function rings(coords: { 0: number; 1: number; yFlags?: number }[]): number[][][] {
  const out: number[][][] = [];
  let cur: number[][] = [];
  for (const c of coords) {
    if ((c.yFlags ?? 0) & 2 && cur.length) (out.push(cur), (cur = []));
    cur.push([c[0], c[1]]);
  }
  if (cur.length) out.push(cur);
  return out;
}

function inside(px: number, py: number, ring: number[][]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[j];
    if (y1 > py !== y2 > py && px < x1 + ((py - y1) * (x2 - x1)) / (y2 - y1)) c = !c;
  }
  return c;
}

describe("demo map enrichment", () => {
  const original = readFileSync(ORIGINAL);

  it("is seeded: the same seed gives the same bytes, another seed other bytes", async () => {
    const a = await enrichOcad(original);
    const b = await enrichOcad(original, { seed: DEMO_SEED });
    const c = await enrichOcad(original, { seed: DEMO_SEED + 7 });
    expect(Buffer.compare(a.bytes, b.bytes)).toBe(0);
    expect(Buffer.compare(a.bytes, c.bytes)).not.toBe(0);
  });

  it("without a height field, appends only the planned points and leaves the original bytes as they are", async () => {
    const { bytes, report } = (await enrichOcad(original)) as { bytes: Buffer; report: Report };
    // The original's bytes, but the last index block's next-block pointer.
    let last = original.readInt32LE(12);
    while (original.readInt32LE(last) !== 0) last = original.readInt32LE(last);
    const patched = Buffer.from(bytes.subarray(0, original.length));
    patched.writeInt32LE(0, last);
    expect(Buffer.compare(patched, original)).toBe(0);
    expect(report.cliffLines).toEqual([]);
    for (const { sym, count } of PLAN as { sym: number; count: number }[]) expect(report.placed[String(sym / 1000)]).toBe(count);

    const before = await readOcad(original);
    const after = await readOcad(bytes);
    expect(after.objects.length).toBe(before.objects.length + report.features.length);
  });

  it("keeps invented points out of water and buildings", async () => {
    const { report } = (await enrichOcad(original)) as { report: Report };
    const ocad = await readOcad(original);
    const forbidden = ocad.objects
      .filter((o: { sym: number; otp: number }) => o.otp === 3 && [301, 521].includes(Math.floor(o.sym / 1000)))
      .map((o: { coordinates: { 0: number; 1: number; yFlags?: number }[] }) => rings(o.coordinates));
    for (const f of report.features) {
      for (const rs of forbidden) expect(rs.filter((r: number[][]) => inside(f.x, f.y, r)).length % 2, `feature ${f.sym} at ${f.x},${f.y}`).toBe(0);
    }
  });

  it("with a height field, points every cliff's tags downhill (right of the line's direction)", async () => {
    // Ground falling east: tags must point east, so each cliff runs north.
    const { bytes, report } = (await enrichOcad(original, { field: eastFallingField() })) as { bytes: Buffer; report: Report };
    expect(report.cliffLines.length).toBeGreaterThan(0);
    expect(report.cliffLines.some((l) => l.steep)).toBe(true);
    expect(report.cliffLines.some((l) => !l.steep)).toBe(true);
    for (const l of report.cliffLines) {
      const dy = l.pts.at(-1)![1] - l.pts[0][1];
      const dx = l.pts.at(-1)![0] - l.pts[0][0];
      // a line across the slope must run north; one along it carries no direction
      if (Math.abs(dy) > Math.abs(dx)) expect(dy, JSON.stringify(l.pts)).toBeGreaterThan(0);
    }
    // The tagged symbols replace the joined segments: those are deleted, the file still reads.
    const after = await readOcad(bytes);
    const tagged = after.objects.filter((o: { sym: number }) => o.sym === 201000 || o.sym === 202002);
    expect(tagged.length).toBe(report.cliffLines.length);
  });
});
