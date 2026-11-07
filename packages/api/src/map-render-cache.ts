/**
 * `file_hash` + `render_key` of a map_files / club_map_files row, written
 * after an upload or a rotation change, and the orphan-tile collection.
 * Writes only: nothing in this version reads the key (the tile renderer
 * went in E4a); a rollback to v0.5.0 does, so it stays current until E5
 * drops the column and `map_tiles` (docs/map-storage.md §4.6).
 *
 * The OCAD blob (`file_data`, routinely 5–40 MB) is fetched with a
 * second query and only when `file_hash` is still null — selecting it
 * unconditionally is what saturated Cloud SQL in the September 2026
 * incident (docs/bugfix-map-tile-cold-render-cloud-timeouts.md).
 */

import type { ColorProfile, ColorStackOverrides } from "@oxygen/shared";
import { colorProfileSchema, colorStackOverridesSchema } from "@oxygen/shared";
import type { PrismaClient } from "./generated/prisma/client.js";
import { computeRenderKey, hashMapFileData } from "./map-render-key.js";

type MapFileDb = {
  mapFile: PrismaClient["mapFile"];
};

type ClubMapDb = {
  clubMapFile: PrismaClient["clubMapFile"];
};

type GcDb = {
  $executeRawUnsafe: PrismaClient["$executeRawUnsafe"];
};


/** Metadata-only projection shared by every read in this module. */
const STACK_COLUMNS = {
  id: true,
  rotationCorrection: true,
  colorProfile: true,
  colorOverrides: true,
  northLinesBelow: true,
  fileHash: true,
  renderKey: true,
} as const;

type StackRow = {
  id: bigint;
  rotationCorrection: number;
  colorProfile: string | null;
  colorOverrides: unknown;
  northLinesBelow: boolean;
  fileHash: string | null;
  renderKey: string | null;
};

/** Either delegate, narrowed to the two calls this module makes. */
type BlobDelegate = {
  findUnique(args: {
    where: { id: bigint };
    select: { fileData: true };
  }): Promise<{ fileData: Uint8Array } | null>;
  update(args: {
    where: { id: bigint };
    data: { fileHash: string; renderKey: string };
  }): Promise<unknown>;
};

function parseProfile(raw: string | null | undefined): ColorProfile {
  const parsed = colorProfileSchema.safeParse(raw ?? "auto");
  return parsed.success ? parsed.data : "auto";
}

function parseOverrides(raw: unknown): ColorStackOverrides {
  const parsed = colorStackOverridesSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Resolve (and persist when changed) file_hash + render_key for one row.
 * The blob is read only when no hash is stored yet.
 */
async function settleRow(
  delegate: BlobDelegate,
  row: StackRow,
): Promise<string> {
  const colorProfile = parseProfile(row.colorProfile);
  const colorOverrides = parseOverrides(row.colorOverrides);

  let fileHash = row.fileHash;
  if (!fileHash) {
    const blob = await delegate.findUnique({
      where: { id: row.id },
      select: { fileData: true },
    });
    if (!blob) throw new Error("Map file row vanished during hash backfill");
    fileHash = hashMapFileData(Buffer.from(blob.fileData));
  }

  const renderKey = computeRenderKey({
    fileHash,
    rotationCorrection: row.rotationCorrection,
    colorProfile,
    colorOverrides,
    northLinesBelow: row.northLinesBelow,
  });

  if (row.fileHash !== fileHash || row.renderKey !== renderKey) {
    await delegate.update({
      where: { id: row.id },
      data: { fileHash, renderKey },
    });
  }

  return renderKey;
}

/**
 * Drop tile rows whose render_key is no longer referenced by any
 * map_files or club_map_files row. Called after upload, rotation change,
 * club map removal and event purge; E5 drops `map_tiles`.
 */
export async function gcOrphanTiles(db: GcDb): Promise<number> {
  // Prisma can't express NOT IN (UNION …) cleanly; raw SQL is fine —
  // map_tiles is a pure cache.
  const result = await db.$executeRawUnsafe(`
    DELETE FROM oxygen.map_tiles
    WHERE render_key IS NOT NULL
      AND render_key NOT IN (
        SELECT render_key FROM oxygen.map_files WHERE render_key IS NOT NULL
        UNION
        SELECT render_key FROM oxygen.club_map_files WHERE render_key IS NOT NULL
      )
  `);
  return typeof result === "number" ? result : 0;
}

/** Recompute and store render_key after a settings change on map_files. */
export async function refreshMapFileRenderKey(
  db: MapFileDb,
  mapFileId: bigint,
): Promise<string> {
  const row = await db.mapFile.findUniqueOrThrow({
    where: { id: mapFileId },
    select: STACK_COLUMNS,
  });
  return settleRow(db.mapFile as unknown as BlobDelegate, row);
}

export async function refreshClubMapRenderKey(
  db: ClubMapDb,
  clubMapId: bigint,
): Promise<string> {
  const row = await db.clubMapFile.findUniqueOrThrow({
    where: { id: clubMapId },
    select: STACK_COLUMNS,
  });
  return settleRow(db.clubMapFile as unknown as BlobDelegate, row);
}
