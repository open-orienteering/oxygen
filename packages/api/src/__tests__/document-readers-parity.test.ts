/**
 * Parity of the document readers with the OCAD readers they replace
 * (slice E1, docs/map-storage.md §4.6 "Parity"). For each map: import it
 * in memory as the import job would, then compare every reader's answer
 * from the document with the legacy answer from `readOcad` over the same
 * bytes:
 *
 * - CRS (`loadEventCrs`): WGS 84 of the extent's corners and centre within
 *   1e-8°, with and without an 11° rotation correction; scale exact;
 * - autodetect objects (`slimObjectsOfDocument`): the multiset of
 *   (sym, type, coordinates to 1e-6 units) equals the OCAD slimming's
 *   minus objects of hidden symbols, exactly;
 * - north (`report.north` vs `detectMapNorth`): meridian count exact;
 *   angles within 1e-6°; centre within 1e-8°;
 * - cut features (`cutFeaturesOfDocument` vs the legacy adapter): equal
 *   within 1e-6 mm in x, y and r.
 *
 * Objects and cuts are compared on source codes (symbol matches cleared):
 * an applied match changing a symbol's code is the document rule, not a
 * difference of the reader, and is covered by `event-map-objects.test.ts`
 * and `packages/shared/src/course/__tests__/cuts.test.ts`.
 *
 * The E2E fixture always runs. The local corpus (`.local/corpus`, never
 * committed; `OXYGEN_CORPUS_DIR` overrides) runs when present.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mapDocument, mapGeo, course } from "@oxygen/shared";
import { loadEventCrs } from "../event-crs.js";
import { slimObjectsOfDocument, type SlimMapObject } from "../event-map-objects.js";
import { detectMapNorth, type OcadNorthSource } from "../map-north.js";
import { frameFromOcadCrs, withGrivationCorrection, type OcadCrs } from "../map-projection.js";
import { clearEventDocumentCaches, reportNorth } from "../map-store/event-document.js";
import { cutFeaturesOfOcad, slimObjectsOfOcad, type RawOcadFile } from "./helpers/ocad-oracle.js";
import { documentDbStub, importForStub } from "./helpers/document-db-stub.js";

const REPO = resolve(__dirname, "../../../..");
const CORPUS_DIR = process.env.OXYGEN_CORPUS_DIR ?? resolve(REPO, ".local/corpus");
const CORPUS = ["club-2026.ocd", "club-full.ocd", "crop-a.ocd", "crop-b.ocd", "sprint.ocd"];
const AS_OF = new Date("2026-11-05T00:00:00Z");

const MAPS: Array<{ name: string; path: string }> = [
  { name: "e2e/test.ocd", path: resolve(REPO, "e2e/test.ocd") },
  ...CORPUS.map((f) => ({ name: `corpus/${f}`, path: resolve(CORPUS_DIR, f) })),
];

type OcadFile = RawOcadFile & OcadNorthSource & {
  getBounds(): number[];
  symbols?: ArrayLike<{ symNum: number; status?: number }>;
};

async function readOcad(bytes: Buffer): Promise<OcadFile> {
  const mod = (await import("ocad2geojson")) as unknown as { readOcad(b: Buffer, o?: object): Promise<OcadFile> };
  return mod.readOcad(bytes, { quietWarnings: true });
}

const key = (o: SlimMapObject) => `${o.sym}|${o.objType}|${o.coordinates.map(([x, y]) => `${x.toFixed(6)},${y.toFixed(6)}`).join(" ")}`;

function multisetDiff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const count = new Map<string, number>();
  for (const k of a) count.set(k, (count.get(k) ?? 0) + 1);
  for (const k of b) count.set(k, (count.get(k) ?? 0) - 1);
  const onlyA: string[] = [], onlyB: string[] = [];
  for (const [k, n] of count) {
    for (let i = 0; i < n; i++) onlyA.push(k);
    for (let i = 0; i < -n; i++) onlyB.push(k);
  }
  return { onlyA, onlyB };
}

/** The document with every symbol match cleared: the source-code rule. */
function unmatched(doc: mapDocument.MapDocument): mapDocument.MapDocument {
  return { ...doc, header: { ...doc.header, symbols: doc.header.symbols.map((s) => ({ ...s, match: undefined })) } };
}

for (const map of MAPS) {
  describe.skipIf(!existsSync(map.path))(`document readers ≡ OCAD readers: ${map.name}`, () => {
    let state: Promise<{
      ocad: OcadFile;
      doc: mapDocument.MapDocument;
      stub: Awaited<ReturnType<typeof importForStub>>;
      bytes: Buffer;
    }> | null = null;
    const load = () =>
      (state ??= (async () => {
        const bytes = readFileSync(map.path);
        const stub = await importForStub(bytes, map.name, "ocad", AS_OF);
        return { ocad: await readOcad(bytes), doc: mapDocument.decodeMapDocument(stub.bytes), stub, bytes };
      })());

    it("CRS: the same WGS 84 positions and scale", async () => {
      const { ocad, stub, bytes } = await load();
      const legacyCrs = ocad.getCrs();
      for (const correction of [0, 11]) {
        clearEventDocumentCaches();
        const { db } = documentDbStub([stub], { [stub.sourceHash]: bytes }, { documentHash: stub.hash, sourceHash: stub.sourceHash, rotationCorrection: correction });
        const frame = await loadEventCrs(db, 1n);
        expect(frame?.mapScale).toBe(legacyCrs.scale);
        const legacy = frameFromOcadCrs(withGrivationCorrection(legacyCrs, correction));
        if (!legacy) {
          // Neither side can project: the document must not invent a CRS.
          expect(mapGeo.epsgOf(frame!)).toBeNull();
          continue;
        }
        const [minX, minY, maxX, maxY] = ocad.getBounds();
        const points = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY], [(minX + maxX) / 2, (minY + maxY) / 2]];
        for (const [x, y] of points) {
          const before = mapGeo.paperToWgs84(legacy, x, y)!;
          const now = mapGeo.paperToWgs84(frame!, (x / 100) * frame!.unitsPerMm, (y / 100) * frame!.unitsPerMm)!;
          expect(Math.abs(now.lat - before.lat), `lat at ${x},${y} (correction ${correction})`).toBeLessThan(1e-8);
          expect(Math.abs(now.lng - before.lng), `lng at ${x},${y} (correction ${correction})`).toBeLessThan(1e-8);
        }
      }
    }, 300_000);

    it("autodetect objects: the OCAD slimming minus hidden symbols", async () => {
      const { ocad, doc } = await load();
      const hidden = new Set<number>();
      for (const s of Array.from(ocad.symbols ?? [])) if (((s.status ?? 0) & 2) === 2) hidden.add(s.symNum);
      const before = slimObjectsOfOcad(ocad).filter((o) => !hidden.has(o.sym)).map(key);
      const now = slimObjectsOfDocument(unmatched(doc)).map(key);
      const { onlyA, onlyB } = multisetDiff(now, before);
      expect({ documentOnly: onlyA.slice(0, 5), ocadOnly: onlyB.slice(0, 5), counts: [onlyA.length, onlyB.length] }).toEqual({ documentOnly: [], ocadOnly: [], counts: [0, 0] });
      expect(now.length).toBeGreaterThan(0);
    }, 300_000);

    it("north: the report's analysis equals detectMapNorth", async () => {
      const { ocad, stub } = await load();
      const before = detectMapNorth(ocad, AS_OF);
      const now = reportNorth(stub.report)!;
      expect(now).not.toBeNull();
      expect(now.meridian?.count ?? null).toBe(before.meridian?.count ?? null);
      const close = (a: number | null | undefined, b: number | null | undefined, tol: number, what: string) => {
        if (a == null || b == null) return expect(a ?? null, what).toBe(b ?? null);
        expect(Math.abs(a - b), what).toBeLessThan(tol);
      };
      close(now.meridian?.medianTiltDeg, before.meridian?.medianTiltDeg, 1e-6, "medianTiltDeg");
      close(now.meridian?.stddevDeg, before.meridian?.stddevDeg, 1e-6, "stddevDeg");
      close(now.declaredGrivationDeg, before.declaredGrivationDeg, 1e-6, "declaredGrivationDeg");
      close(now.trueNorthFromGridDeg, before.trueNorthFromGridDeg, 1e-6, "trueNorthFromGridDeg");
      close(now.declinationDeg, before.declinationDeg, 1e-6, "declinationDeg");
      close(now.meridianStalenessDeg, before.meridianStalenessDeg, 1e-6, "meridianStalenessDeg");
      close(now.centerLat, before.centerLat, 1e-8, "centerLat");
      close(now.centerLng, before.centerLng, 1e-8, "centerLng");
    }, 300_000);

    it("cut features: the legacy adapter's", async () => {
      const { ocad, doc } = await load();
      const before = cutFeaturesOfOcad(ocad, ocad.getCrs().scale);
      const now = course.cutFeaturesOfDocument(unmatched(doc));
      const order = (a: course.CutFeature, b: course.CutFeature) => a.x - b.x || a.y - b.y;
      before.sort(order);
      now.sort(order);
      expect(now.length).toBe(before.length);
      now.forEach((f, i) => {
        const b = before[i]!;
        expect(Math.abs(f.x - b.x)).toBeLessThan(1e-6);
        expect(Math.abs(f.y - b.y)).toBeLessThan(1e-6);
        expect(Math.abs((f.r ?? 0) - (b.r ?? 0))).toBeLessThan(1e-6);
      });
    }, 300_000);
  });
}
