/**
 * The render-key helpers run on the map-tile hot path — once per tile
 * request, including cache hits — so they must never pull the OCAD blob
 * (`file_data`, often 5–40 MB) unless the hash genuinely has to be
 * computed. The September 2026 Cloud Run incident
 * (docs/bugfix-map-tile-cold-render-cloud-timeouts.md) came from exactly
 * that: every tile request dragged the whole map through Cloud SQL.
 */

import { describe, expect, it } from "vitest";
import {
  ensureClubMapRenderKey,
  ensureEventMapRenderKey,
  refreshClubMapRenderKey,
  refreshMapFileRenderKey,
} from "../map-render-cache.js";
import { computeRenderKey, hashMapFileData } from "../map-render-key.js";

const FILE = Buffer.from("fake ocad bytes");
const FILE_HASH = hashMapFileData(FILE);

type Row = {
  id: bigint;
  uploadedAt: Date;
  bounds: unknown;
  scale: number | null;
  rotationCorrection: number;
  colorProfile: string | null;
  colorOverrides: unknown;
  northLinesBelow: boolean;
  fileHash: string | null;
  renderKey: string | null;
  fileData: Uint8Array;
};

function baseRow(over: Partial<Row> = {}): Row {
  return {
    id: 7n,
    uploadedAt: new Date("2026-09-01T00:00:00Z"),
    bounds: { north: 1, south: 0, east: 1, west: 0 },
    scale: 15000,
    rotationCorrection: 0,
    colorProfile: "auto",
    colorOverrides: {},
    northLinesBelow: true,
    fileHash: FILE_HASH,
    renderKey: computeRenderKey({
      fileHash: FILE_HASH,
      rotationCorrection: 0,
      colorProfile: "auto",
      colorOverrides: {},
      northLinesBelow: true,
    }),
    fileData: FILE,
    ...over,
  };
}

/**
 * A stand-in for the Prisma delegate that records which columns every
 * query asked for and applies updates to its single row.
 */
function fakeDelegate(row: Row) {
  const selects: Array<Record<string, boolean>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const pick = (select: Record<string, boolean>) => {
    selects.push(select);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(select)) {
      if (v) out[k] = (row as unknown as Record<string, unknown>)[k];
    }
    return out;
  };
  const delegate = {
    findFirst: async (args: { select: Record<string, boolean> }) =>
      pick(args.select),
    findUnique: async (args: { select: Record<string, boolean> }) =>
      pick(args.select),
    findUniqueOrThrow: async (args: { select: Record<string, boolean> }) =>
      pick(args.select),
    update: async (args: { data: Record<string, unknown> }) => {
      updates.push(args.data);
      Object.assign(row, args.data);
      return row;
    },
  };
  const askedForBlob = () => selects.filter((s) => s.fileData === true).length;
  return { delegate, selects, updates, askedForBlob };
}

describe("ensureEventMapRenderKey", () => {
  it("does not read file_data when the hash is already stored", async () => {
    const row = baseRow();
    const fake = fakeDelegate(row);
    const meta = await ensureEventMapRenderKey(
      { mapFile: fake.delegate } as never,
      1n,
    );
    expect(meta?.renderKey).toBe(row.renderKey);
    expect(fake.askedForBlob()).toBe(0);
    expect(fake.updates).toHaveLength(0);
  });

  it("reads file_data exactly once to backfill a missing hash, then persists it", async () => {
    const row = baseRow({ fileHash: null, renderKey: null });
    const fake = fakeDelegate(row);
    const meta = await ensureEventMapRenderKey(
      { mapFile: fake.delegate } as never,
      1n,
    );
    expect(meta?.fileHash).toBe(FILE_HASH);
    expect(fake.askedForBlob()).toBe(1);
    expect(fake.updates).toEqual([
      { fileHash: FILE_HASH, renderKey: meta!.renderKey },
    ]);

    // Second call: hash is stored now, so no blob read at all.
    const again = fakeDelegate(row);
    await ensureEventMapRenderKey({ mapFile: again.delegate } as never, 1n);
    expect(again.askedForBlob()).toBe(0);
  });

  it("recomputes a stale render_key from the stored hash without touching the blob", async () => {
    const row = baseRow({ renderKey: "stale" });
    const fake = fakeDelegate(row);
    const meta = await ensureEventMapRenderKey(
      { mapFile: fake.delegate } as never,
      1n,
    );
    expect(meta?.renderKey).not.toBe("stale");
    expect(fake.askedForBlob()).toBe(0);
    expect(fake.updates).toHaveLength(1);
  });
});

describe("ensureClubMapRenderKey", () => {
  it("does not read file_data when the hash is already stored", async () => {
    const fake = fakeDelegate(baseRow());
    await ensureClubMapRenderKey({ clubMapFile: fake.delegate } as never, 7n);
    expect(fake.askedForBlob()).toBe(0);
  });

  it("backfills a missing hash with a single blob read", async () => {
    const fake = fakeDelegate(baseRow({ fileHash: null, renderKey: null }));
    const meta = await ensureClubMapRenderKey(
      { clubMapFile: fake.delegate } as never,
      7n,
    );
    expect(meta?.fileHash).toBe(FILE_HASH);
    expect(fake.askedForBlob()).toBe(1);
  });
});

describe("refresh*RenderKey", () => {
  it("reuses the stored hash instead of re-reading the blob", async () => {
    const ev = fakeDelegate(baseRow({ colorProfile: "issprom" }));
    await refreshMapFileRenderKey({ mapFile: ev.delegate } as never, 7n);
    expect(ev.askedForBlob()).toBe(0);

    const club = fakeDelegate(baseRow({ colorProfile: "issprom" }));
    await refreshClubMapRenderKey({ clubMapFile: club.delegate } as never, 7n);
    expect(club.askedForBlob()).toBe(0);
  });

  it("hashes the blob when no hash is stored yet (fresh upload)", async () => {
    const ev = fakeDelegate(baseRow({ fileHash: null, renderKey: null }));
    const key = await refreshMapFileRenderKey(
      { mapFile: ev.delegate } as never,
      7n,
    );
    expect(ev.askedForBlob()).toBe(1);
    expect(ev.updates[0]).toEqual({ fileHash: FILE_HASH, renderKey: key });
  });
});
