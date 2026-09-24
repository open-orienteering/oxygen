/**
 * Ensure a map_files / club_map_files row has file_hash + render_key.
 * Used by tile serving, print SVG load, and mapMetadata so the key is
 * filled lazily (same pattern as the north_detection backfill).
 *
 * These run on the tile hot path — once per tile request, cache hits
 * included — so they read metadata columns only. The OCAD blob
 * (`file_data`, routinely 5–40 MB) is fetched with a second query and
 * only when `file_hash` is still null, i.e. once per row for the life of
 * the upload. Selecting it unconditionally is what saturated Cloud SQL
 * in the September 2026 incident
 * (docs/bugfix-map-tile-cold-render-cloud-timeouts.md).
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

export interface MapStackSettings {
  colorProfile: ColorProfile;
  colorOverrides: ColorStackOverrides;
  northLinesBelow: boolean;
  rotationCorrection: number;
  fileHash: string;
  renderKey: string;
  scale: number | null;
}

/** Metadata-only projection shared by every read in this module. */
const STACK_COLUMNS = {
  id: true,
  scale: true,
  rotationCorrection: true,
  colorProfile: true,
  colorOverrides: true,
  northLinesBelow: true,
  fileHash: true,
  renderKey: true,
} as const;

type StackRow = {
  id: bigint;
  scale: number | null;
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
): Promise<MapStackSettings> {
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

  return {
    scale: row.scale,
    colorProfile,
    colorOverrides,
    northLinesBelow: row.northLinesBelow,
    rotationCorrection: row.rotationCorrection,
    fileHash,
    renderKey,
  };
}

/**
 * Read the event's current map stack settings, computing and persisting
 * `file_hash` / `render_key` when missing. Returns null when the event
 * has no map file.
 */
export async function ensureEventMapRenderKey(
  db: MapFileDb,
  eventId: bigint,
): Promise<
  (MapStackSettings & { mapFileId: bigint; uploadedAtMs: number; bounds: unknown }) | null
> {
  const row = await db.mapFile.findFirst({
    where: { eventId },
    orderBy: { id: "desc" },
    select: { ...STACK_COLUMNS, uploadedAt: true, bounds: true },
  });
  if (!row) return null;

  const settings = await settleRow(db.mapFile as unknown as BlobDelegate, row);
  return {
    ...settings,
    mapFileId: row.id,
    uploadedAtMs: row.uploadedAt.getTime(),
    bounds: row.bounds,
  };
}

/**
 * Same as `ensureEventMapRenderKey` for a club-library row.
 */
export async function ensureClubMapRenderKey(
  db: ClubMapDb,
  clubMapId: bigint,
): Promise<MapStackSettings | null> {
  const row = await db.clubMapFile.findUnique({
    where: { id: clubMapId },
    select: STACK_COLUMNS,
  });
  if (!row) return null;
  return settleRow(db.clubMapFile as unknown as BlobDelegate, row);
}

/**
 * Drop tile rows whose render_key is no longer referenced by any
 * map_files or club_map_files row. Safe to call after upload, profile
 * change, rotation change, or event delete.
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
  const settings = await settleRow(db.mapFile as unknown as BlobDelegate, row);
  return settings.renderKey;
}

export async function refreshClubMapRenderKey(
  db: ClubMapDb,
  clubMapId: bigint,
): Promise<string> {
  const row = await db.clubMapFile.findUniqueOrThrow({
    where: { id: clubMapId },
    select: STACK_COLUMNS,
  });
  const settings = await settleRow(
    db.clubMapFile as unknown as BlobDelegate,
    row,
  );
  return settings.renderKey;
}
