/**
 * The server reads of the pinned map document (docs/map-storage.md §4.6):
 * which row is the pin, the honest "no map" answers, the frame with the
 * row's rotation correction, the one `map_sources.bytes` fallback (a
 * `CRS_UNRESOLVED` header), and the content-addressed caches. Runs the
 * readers over a stub database holding an in-memory import of the E2E
 * fixture.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { course, mapDocument, mapGeo } from "@oxygen/shared";
import { loadEventCrs } from "../event-crs.js";
import { loadEventCheckDocument, loadEventCutFeatures, loadEventMapObjects } from "../event-map-objects.js";
import { frameFromOcadCrs, mapMmToWgs84, type OcadCrs } from "../map-projection.js";
import { clearEventDocumentCaches, documentMapFileColumns, documentPaperFrame, reportNorth, sourceFrameFallback } from "../map-store/event-document.js";
import { documentDbStub, importForStub, type StubDocument } from "./helpers/document-db-stub.js";

const FIXTURE = resolve(__dirname, "../../../../e2e/test.ocd");
const EVENT = 1n;

let bytes: Buffer;
let doc: StubDocument;
let legacyCrs: OcadCrs;

beforeAll(async () => {
  bytes = readFileSync(FIXTURE);
  doc = await importForStub(bytes, "test.ocd");
  const ocadMod = await import("ocad2geojson");
  const readOcad = (ocadMod as unknown as { readOcad(b: Buffer, o?: object): Promise<{ getCrs(): OcadCrs }> }).readOcad;
  legacyCrs = (await readOcad(bytes, { quietWarnings: true })).getCrs();
}, 60_000);

beforeEach(() => clearEventDocumentCaches());

/** The same document with its header's CRS removed, as the importer stores a `CRS_UNRESOLVED` map. */
function unresolved(d: StubDocument): StubDocument {
  const header = d.header as { georeferencing: Record<string, unknown> };
  return { ...d, hash: "u".repeat(64), header: { ...header, georeferencing: { ...header.georeferencing, crs: null, paperOrigin: null } } };
}

describe("loadEventCrs", () => {
  it("answers null when the event has no map", async () => {
    const { db } = documentDbStub([doc], {}, null);
    expect(await loadEventCrs(db, EVENT)).toBeNull();
  });

  it("answers null while the import has not pinned a document — never an OCAD parse", async () => {
    const { db, reads } = documentDbStub([doc], { [doc.sourceHash]: bytes }, { documentHash: null, sourceHash: doc.sourceHash });
    expect(await loadEventCrs(db, EVENT)).toBeNull();
    expect(reads.blobs).toBe(0);
  });

  it("builds the frame from the document header with the row's correction", async () => {
    const { db } = documentDbStub([doc], {}, { documentHash: doc.hash, sourceHash: doc.sourceHash, rotationCorrection: 11 });
    const frame = await loadEventCrs(db, EVENT);
    expect(frame).toMatchObject({ unitsPerMm: 100, mapScale: legacyCrs.scale, correctionDeg: 11 });
    expect(mapGeo.epsgOf(frame!)).toBe(`EPSG:${legacyCrs.code}`);
  });

  it("converts control positions like the legacy OCAD CRS did", async () => {
    const { db } = documentDbStub([doc], {}, { documentHash: doc.hash, sourceHash: doc.sourceHash });
    const frame = (await loadEventCrs(db, EVENT))!;
    const legacy = frameFromOcadCrs(legacyCrs)!;
    for (const [x, y] of [[0, 0], [-76.4, -48.4], [76.4, 46.4], [12.5, -30]]) {
      const now = mapMmToWgs84(x, y, frame)!;
      const before = mapGeo.paperToWgs84(legacy, x * 100, y * 100)!;
      expect(Math.abs(now.lat - before.lat)).toBeLessThan(1e-8);
      expect(Math.abs(now.lng - before.lng)).toBeLessThan(1e-8);
    }
  });

  it("reads the header once per document hash", async () => {
    const { db, reads } = documentDbStub([doc], {}, { documentHash: doc.hash, sourceHash: doc.sourceHash });
    await loadEventCrs(db, EVENT);
    await loadEventCrs(db, EVENT);
    expect(reads.mapDocument).toBe(1);
    expect(reads.mapFile).toBe(2);
  });
});

describe("the CRS_UNRESOLVED fallback", () => {
  it("reads the source's ScalePar when the header has no CRS", async () => {
    const u = unresolved(doc);
    const { db, reads } = documentDbStub([u], { [u.sourceHash]: bytes }, { documentHash: u.hash, sourceHash: u.sourceHash, rotationCorrection: 2 });
    const frame = await documentPaperFrame(db, u.hash, 2);
    expect(frame).toEqual({ ...frameFromOcadCrs(legacyCrs), correctionDeg: 2 });
    // Cached per source hash: no second blob read.
    clearEventDocumentCaches();
    const before = reads.blobs;
    await loadEventCrs(db, EVENT);
    await loadEventCrs(db, EVENT);
    expect(reads.blobs - before).toBe(1);
  });

  it("keeps the scale and no CRS when the source finds none either", async () => {
    const u = unresolved(doc);
    const { db } = documentDbStub([u], {}, { documentHash: u.hash, sourceHash: u.sourceHash });
    const frame = await loadEventCrs(db, EVENT);
    expect(frame?.mapScale).toBe(legacyCrs.scale);
    expect(mapGeo.epsgOf(frame!)).toBeNull();
    expect(mapMmToWgs84(1, 1, frame!)).toBeNull();
  });

  it("finds no CRS in a source that is not OCAD, and remembers that", async () => {
    const u = unresolved(doc);
    const omap = Buffer.from('<?xml version="1.0"?><map xmlns="http://openorienteering.org/apps/mapper/xml/v2"/>');
    const { db, reads } = documentDbStub([u], { [u.sourceHash]: omap }, { documentHash: u.hash, sourceHash: u.sourceHash });
    const frame = await loadEventCrs(db, EVENT);
    expect(frame?.mapScale).toBe(legacyCrs.scale);
    expect(mapGeo.epsgOf(frame!)).toBeNull();
    clearEventDocumentCaches();
    const before = reads.blobs;
    await sourceFrameFallback(db, u.sourceHash);
    await sourceFrameFallback(db, u.sourceHash);
    expect(reads.blobs - before).toBe(1);
  });

  it("is not read for a header with a CRS", async () => {
    const { db, reads } = documentDbStub([doc], { [doc.sourceHash]: bytes }, { documentHash: doc.hash, sourceHash: doc.sourceHash });
    await loadEventCrs(db, EVENT);
    expect(reads.blobs).toBe(0);
  });
});

describe("document derivations", () => {
  it("answer null without a pin", async () => {
    const { db } = documentDbStub([doc], {}, { documentHash: null, sourceHash: doc.sourceHash });
    expect(await loadEventMapObjects(db, EVENT)).toBeNull();
    expect(await loadEventCutFeatures(db, EVENT)).toBeNull();
    expect(await loadEventCheckDocument(db, EVENT)).toBeNull();
  });

  it("answer null when the pinned document's blob is missing", async () => {
    const { db } = documentDbStub([], {}, { documentHash: "x".repeat(64), sourceHash: doc.sourceHash });
    expect(await loadEventMapObjects(db, EVENT)).toBeNull();
  });

  it("read the pinned document", async () => {
    const { db } = documentDbStub([doc], {}, { documentHash: doc.hash, sourceHash: doc.sourceHash });
    const objects = await loadEventMapObjects(db, EVENT);
    expect(objects?.length).toBeGreaterThan(0);
    expect(await loadEventCutFeatures(db, EVENT)).not.toBeNull();
    expect((await loadEventCheckDocument(db, EVENT))?.libraryId).toBeTruthy();
  });

  it("read the effective document: a hide, then an add, then a disabled patch, each answered fresh (G14; map-patches §2.4)", async () => {
    const stub = documentDbStub([doc], {}, { documentHash: doc.hash, sourceHash: doc.sourceHash });
    const decoded = mapDocument.decodeMapDocument(doc.bytes);
    const plainCuts = (await loadEventCutFeatures(stub.db, EVENT))!;
    const plainObjects = (await loadEventMapObjects(stub.db, EVENT))!;
    expect(plainCuts.length).toBeGreaterThan(0);
    // A cut feature of the fixture, hidden by the patch.
    const cuts = course.cutFeaturesOfDocument(decoded);
    const perMm = decoded.header.unitsPerMm;
    const i = [...decoded.attrs.sourceIndex.keys()].find((k) => {
      const at = decoded.coordStart[k] * 2;
      return decoded.attrs.type[k] === mapDocument.OBJECT_TYPE.point && cuts.some((f) => f.x === decoded.coords[at] / perMm && f.y === decoded.coords[at + 1] / perMm);
    })!;
    const src = decoded.attrs.sourceIndex[i];
    const row = (version: bigint, ops: Record<string, unknown>, enabled = true) => ({ documentHash: doc.hash, enabled, ops, symbols: {}, version });
    stub.setPatch(row(5n, { [`hide:${src}`]: { op: "hide", sourceIndex: src } }));
    expect((await loadEventCutFeatures(stub.db, EVENT))!.length).toBe(plainCuts.length - 1);
    expect((await loadEventMapObjects(stub.db, EVENT))!.length).toBe(plainObjects.length - 1);

    const id = "00000000-0000-4000-8000-0000000000b2";
    stub.setPatch(row(6n, {
      [`hide:${src}`]: { op: "hide", sourceIndex: src },
      [`add:${id}`]: { op: "add", id, type: mapDocument.OBJECT_TYPE.point, symbol: { doc: decoded.attrs.symbolIdx[i] }, coords: [[0, 0]] },
    }));
    const withAdd = (await loadEventCutFeatures(stub.db, EVENT))!;
    expect(withAdd.length).toBe(plainCuts.length);
    expect(withAdd.some((f) => f.x === 0 && f.y === 0)).toBe(true);

    stub.setPatch(row(7n, { [`hide:${src}`]: { op: "hide", sourceIndex: src } }, false));
    expect(await loadEventCutFeatures(stub.db, EVENT)).toEqual(plainCuts);
    // A dormant row (keyed onto another document) is not applied.
    stub.setPatch({ ...row(8n, { [`hide:${src}`]: { op: "hide", sourceIndex: src } }), documentHash: "d".repeat(64) });
    expect(await loadEventCutFeatures(stub.db, EVENT)).toEqual(plainCuts);
  });

  it("derive once for a row keyed to the pin that does not parse (the unpatched answer, memoised)", async () => {
    const stub = documentDbStub([doc], {}, { documentHash: doc.hash, sourceHash: doc.sourceHash });
    const plain = await loadEventCutFeatures(stub.db, EVENT);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      stub.setPatch({ documentHash: doc.hash, enabled: true, ops: [], symbols: {}, version: 11n });
      expect(await loadEventCutFeatures(stub.db, EVENT)).toEqual(plain);
      const reads = stub.reads.mapPatch;
      expect(await loadEventCutFeatures(stub.db, EVENT)).toEqual(plain);
      // The second call is a hit: only the version column was read.
      expect(stub.reads.mapPatch).toBe(reads + 1);
    } finally {
      warn.mockRestore();
    }
  });

  it("decode a document once per hash", async () => {
    const { db, reads } = documentDbStub([doc], {}, { documentHash: doc.hash, sourceHash: doc.sourceHash });
    await loadEventMapObjects(db, EVENT);
    const after = reads.blobs;
    await loadEventMapObjects(db, EVENT);
    await loadEventCutFeatures(db, EVENT);
    expect(reads.blobs).toBe(after);
  });
});

describe("documentMapFileColumns", () => {
  it("is the pin's columns under the given correction", async () => {
    const { db } = documentDbStub([doc], {}, null);
    const columns = await documentMapFileColumns(db, doc.hash, 3);
    const header = doc.header as { unitsPerMm: number; mapScale: number; georeferencing: mapGeo.FrameGeoreferencing; bounds: mapGeo.PaperBounds };
    const tilt = reportNorth(doc.report)?.meridian?.medianTiltDeg ?? null;
    expect(columns).toEqual(mapGeo.mapFileMetadata({ ...header, correctionDeg: 3 }, header.bounds, tilt));
  });

  it("falls back to the source's CRS for an unresolved header", async () => {
    const u = unresolved(doc);
    const { db } = documentDbStub([u], { [u.sourceHash]: bytes }, null);
    const columns = await documentMapFileColumns(db, u.hash, 0);
    expect(columns?.bounds).not.toBeNull();
    expect(columns?.calibration).toHaveLength(4);
  });

  it("is scale only when nothing projects", async () => {
    const u = unresolved(doc);
    const { db } = documentDbStub([u], {}, null);
    expect(await documentMapFileColumns(db, u.hash, 0)).toEqual({ scale: legacyCrs.scale, bounds: null, northOffset: null, calibration: null });
  });
});

describe("reportNorth", () => {
  it("reads the north section even when the rest of the report does not parse", () => {
    const north = reportNorth(doc.report);
    expect(north).not.toBeNull();
    expect(reportNorth({ north, timings: "broken" })).toEqual(north);
  });

  it("answers null without one", () => {
    expect(reportNorth(null)).toBeNull();
    expect(reportNorth({})).toBeNull();
    expect(reportNorth({ north: { meridian: "x" } })).toBeNull();
  });
});
