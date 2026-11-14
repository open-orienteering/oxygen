/**
 * Height-field helpers (docs/map-storage.md §4.7): the `?v=` parse, the
 * cell estimate and cap, the worker against the in-process derive, and
 * the derive's sharing, queue and failure memo over a stub database.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHeightField, TERRAIN_VERSION } from "@oxygen/shared/src/terrain/field/index.js";
import {
  deriveHeightfieldInWorker,
  estimateGraphCells,
  getOrDeriveHeightfield,
  heightfieldEtag,
  heightfieldMaxCells,
  heightfieldUrl,
  HEIGHTFIELD_GRAPH_BUDGET_CELLS,
  isOverCap,
  parseTerrainVersion,
  resetHeightfieldState,
  type DerivedHeightfield,
} from "../map-store/heightfield.js";
import { deriveHeightfieldBytes } from "../map-store/heightfield-worker.js";
import { FLAT, HILL, encodeTerrainDoc } from "./helpers/terrain-doc.js";

const HASH = "a".repeat(64);

describe("height.bin helpers", () => {
  it("parses ?v= as a positive integer without sign or leading zeros", () => {
    expect(parseTerrainVersion("1")).toBe(1);
    expect(parseTerrainVersion("12")).toBe(12);
    for (const bad of [undefined, "", "0", "01", "-1", "+1", "1.0", "x", ["1"], "99999999999999999999"]) expect(parseTerrainVersion(bad)).toBeNull();
  });

  it("names the version in the URL and the ETag", () => {
    expect(heightfieldUrl(HASH)).toBe(`/api/map-documents/${HASH}/height.bin?v=${TERRAIN_VERSION}`);
    expect(heightfieldEtag(HASH, 3)).toBe(`"${HASH}/height/contours/3"`);
  });

  it("estimates the graph raster from the header summary: bounds + 2 mm pad at 0.1 mm, clamped to the budget", () => {
    // 100 × 50 mm in 0.01 mm units → (104 · 54) / 0.01 = 561 600 cells.
    expect(estimateGraphCells({ unitsPerMm: 100, bounds: { minX: 0, minY: 0, maxX: 10_000, maxY: 5_000 } })).toBe(561_600);
    // units per mm are honoured
    expect(estimateGraphCells({ unitsPerMm: 1000, bounds: { minX: 0, minY: 0, maxX: 100_000, maxY: 50_000 } })).toBe(561_600);
    // a huge sheet is clamped to the budget the raster coarsens to
    expect(estimateGraphCells({ unitsPerMm: 100, bounds: { minX: 0, minY: 0, maxX: 2_000_000, maxY: 2_000_000 } })).toBe(HEIGHTFIELD_GRAPH_BUDGET_CELLS);
    for (const bad of [null, {}, { unitsPerMm: 100 }, { unitsPerMm: 0, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } }, { unitsPerMm: 100, bounds: { minX: 5, minY: 0, maxX: 1, maxY: 1 } }])
      expect(estimateGraphCells(bad)).toBeNull();
  });

  it("refuses only above the cap; the default cap is the budget, so it never refuses", () => {
    const huge = { unitsPerMm: 100, bounds: { minX: 0, minY: 0, maxX: 2_000_000, maxY: 2_000_000 } };
    expect(heightfieldMaxCells(undefined)).toBe(HEIGHTFIELD_GRAPH_BUDGET_CELLS);
    expect(isOverCap(huge, heightfieldMaxCells(undefined))).toBe(false);
    expect(isOverCap(huge, 1_000_000)).toBe(true);
    expect(isOverCap({ unitsPerMm: 100, bounds: { minX: 0, minY: 0, maxX: 10_000, maxY: 5_000 } }, 1_000_000)).toBe(false);
    expect(isOverCap({}, 1)).toBe(false);
  });

  it("reads MAP_HEIGHTFIELD_MAX_CELLS when it is a positive integer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(heightfieldMaxCells("8000000")).toBe(8_000_000);
    expect(heightfieldMaxCells("")).toBe(HEIGHTFIELD_GRAPH_BUDGET_CELLS);
    expect(heightfieldMaxCells("lots")).toBe(HEIGHTFIELD_GRAPH_BUDGET_CELLS);
    expect(heightfieldMaxCells("-5")).toBe(HEIGHTFIELD_GRAPH_BUDGET_CELLS);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("the derive worker", () => {
  it("gives the in-process derive's bytes, header and report", async () => {
    const doc = encodeTerrainDoc(HILL, "worker");
    const inline = deriveHeightfieldBytes(doc);
    if (inline.type !== "done") throw new Error("the hill has contours");
    const out = await deriveHeightfieldInWorker(doc);
    if (out.kind !== "field") throw new Error(`expected a field, got ${out.kind}`);
    expect(Buffer.from(out.bytes).equals(Buffer.from(inline.bytes))).toBe(true);
    expect(out.header).toEqual(inline.header);
    expect(out.report).toEqual(inline.report);
    expect(decodeHeightField(out.bytes).header.version).toBe(TERRAIN_VERSION);
    expect(out.report.share.decided).toBeGreaterThan(0.99);
  }, 60_000);

  it("answers none for a document without contours", async () => {
    expect(await deriveHeightfieldInWorker(encodeTerrainDoc(FLAT, "flat"))).toEqual({ kind: "none" });
  }, 60_000);

  it("rejects bytes that are not a document", async () => {
    await expect(deriveHeightfieldInWorker(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).rejects.toThrow();
  }, 60_000);

  it("is terminated at the timeout", async () => {
    await expect(deriveHeightfieldInWorker(encodeTerrainDoc(HILL, "slow"), { timeoutMs: 1 })).rejects.toThrow(/exceeded 1 ms/);
  }, 60_000);
});

// ---- derive on a miss, over a stub database -------------------------------------

interface StubRow { documentHash: string; source: string; version: number; bytes?: Uint8Array; sizeBytes?: number; header?: unknown; report?: unknown }

function stubDb(opts: { docHeader?: unknown; docBytes?: Buffer | null } = {}) {
  const rows: StubRow[] = [];
  const find = (w: { documentHash: string; source: string; version: number }) => rows.find((r) => r.documentHash === w.documentHash && r.source === w.source && r.version === w.version);
  const db = {
    rows,
    mapHeightfield: {
      findUnique: async ({ where }: { where: { documentHash_source_version: { documentHash: string; source: string; version: number } } }) => {
        const r = find(where.documentHash_source_version);
        return r ? { bytes: r.bytes ?? null, header: r.header ?? null, report: r.report ?? null, sizeBytes: r.sizeBytes ?? null } : null;
      },
      createMany: async ({ data }: { data: StubRow[] }) => {
        for (const d of data) if (!find(d)) rows.push(d);
        return { count: data.length };
      },
    },
    mapDocument: {
      findUnique: async () => (opts.docBytes === null ? null : { header: opts.docHeader ?? { unitsPerMm: 100, bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } } }),
    },
    $queryRawUnsafe: async () => (opts.docBytes === null ? [] : [{ chunk: opts.docBytes ?? Buffer.from("doc") }]),
  };
  return db;
}

const FIELD: DerivedHeightfield = {
  kind: "field",
  bytes: new Uint8Array([1, 2, 3]),
  header: { width: 1, height: 1, cellMm: 0.2 } as never,
  report: { share: { decided: 0.9 } } as never,
};

describe("getOrDeriveHeightfield", () => {
  afterEach(() => resetHeightfieldState());
  const quiet = () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  };
  afterEach(() => vi.restoreAllMocks());

  it("derives once on a miss, writes the row, and serves the row afterwards", async () => {
    quiet();
    const db = stubDb();
    const derive = vi.fn(async () => FIELD);
    const first = await getOrDeriveHeightfield(db as never, HASH, { derive });
    expect(first.state).toBe("ready");
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ documentHash: HASH, source: "contours", version: TERRAIN_VERSION, sizeBytes: 3 });
    const second = await getOrDeriveHeightfield(db as never, HASH, { derive });
    expect(second.state).toBe("ready");
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("shares one derive between concurrent callers", async () => {
    quiet();
    const db = stubDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const derive = vi.fn(async () => { await gate; return FIELD; });
    const a = getOrDeriveHeightfield(db as never, HASH, { derive });
    const b = getOrDeriveHeightfield(db as never, HASH, { derive });
    expect(a).toBe(b);
    release();
    expect((await a).state).toBe("ready");
    expect(derive).toHaveBeenCalledTimes(1);
  });

  it("runs derives of different documents one at a time", async () => {
    quiet();
    const db = stubDb();
    let running = 0, peak = 0;
    const derive = vi.fn(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return FIELD;
    });
    await Promise.all(["b", "c", "d"].map((c) => getOrDeriveHeightfield(db as never, c.repeat(64), { derive })));
    expect(derive).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  it("records a document without contours as a row without bytes", async () => {
    quiet();
    const db = stubDb();
    expect((await getOrDeriveHeightfield(db as never, HASH, { derive: async () => ({ kind: "none" }) })).state).toBe("none");
    expect(db.rows).toEqual([{ documentHash: HASH, source: "contours", version: TERRAIN_VERSION }]);
    expect((await getOrDeriveHeightfield(db as never, HASH, { derive: async () => FIELD })).state).toBe("none");
  });

  it("writes nothing on a failure and does not retry it for a while", async () => {
    quiet();
    const db = stubDb();
    const derive = vi.fn(async (): Promise<DerivedHeightfield> => { throw new Error("boom"); });
    expect((await getOrDeriveHeightfield(db as never, HASH, { derive })).state).toBe("failed");
    expect((await getOrDeriveHeightfield(db as never, HASH, { derive })).state).toBe("failed");
    expect(derive).toHaveBeenCalledTimes(1);
    expect(db.rows).toHaveLength(0);
    resetHeightfieldState();
    expect((await getOrDeriveHeightfield(db as never, HASH, { derive: async () => FIELD })).state).toBe("ready");
  });

  it("refuses over the cap without reading the document", async () => {
    quiet();
    const db = stubDb({ docHeader: { unitsPerMm: 100, bounds: { minX: 0, minY: 0, maxX: 100_000, maxY: 100_000 } } });
    const read = vi.spyOn(db, "$queryRawUnsafe");
    const derive = vi.fn(async () => FIELD);
    expect((await getOrDeriveHeightfield(db as never, HASH, { derive, maxCells: 1_000_000 })).state).toBe("over-cap");
    expect(derive).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(db.rows).toHaveLength(0);
  });

  it("answers missing when there is no such document", async () => {
    quiet();
    const db = stubDb({ docBytes: null });
    expect((await getOrDeriveHeightfield(db as never, HASH, { derive: async () => FIELD })).state).toBe("missing");
  });
});
