/**
 * The render-key writes kept for the v0.5.0 rollback (E4a; E5 drops the
 * column) must not pull the OCAD blob (`file_data`, often 5–40 MB) unless
 * the hash genuinely has to be computed
 * (docs/bugfix-map-tile-cold-render-cloud-timeouts.md).
 */

import { describe, expect, it } from "vitest";
import { refreshClubMapRenderKey, refreshMapFileRenderKey } from "../map-render-cache.js";
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
