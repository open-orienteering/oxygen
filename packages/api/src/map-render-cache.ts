/**
 * Ensure a map_files / club_map_files row has file_hash + render_key.
 * Used by tile serving, print SVG load, and mapMetadata so the key is
 * filled lazily (same pattern as the north_detection backfill).
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

function parseProfile(raw: string | null | undefined): ColorProfile {
  const parsed = colorProfileSchema.safeParse(raw ?? "auto");
  return parsed.success ? parsed.data : "auto";
}

function parseOverrides(raw: unknown): ColorStackOverrides {
  const parsed = colorStackOverridesSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * Read the event's current map stack settings, computing and persisting
 * `file_hash` / `render_key` when missing. Returns null when the event
 * has no map file.
 */
export async function ensureEventMapRenderKey(
  db: MapFileDb,
  eventId: bigint,
): Promise<(MapStackSettings & { mapFileId: bigint; uploadedAtMs: number; bounds: unknown }) | null> {
  const row = await db.mapFile.findFirst({
    where: { eventId },
    orderBy: { id: "desc" },
    select: {
      id: true,
      uploadedAt: true,
      bounds: true,
      scale: true,
      rotationCorrection: true,
      colorProfile: true,
      colorOverrides: true,
      northLinesBelow: true,
      fileHash: true,
      renderKey: true,
      fileData: true,
    },
  });
  if (!row) return null;

  const colorProfile = parseProfile(row.colorProfile);
  const colorOverrides = parseOverrides(row.colorOverrides);
  const northLinesBelow = row.northLinesBelow;
  const rotationCorrection = row.rotationCorrection;

  let fileHash = row.fileHash;
  if (!fileHash) {
    fileHash = hashMapFileData(Buffer.from(row.fileData));
  }
  let renderKey = row.renderKey;
  const expected = computeRenderKey({
    fileHash,
    rotationCorrection,
    colorProfile,
    colorOverrides,
    northLinesBelow,
  });
  if (renderKey !== expected) {
    renderKey = expected;
  }

  if (row.fileHash !== fileHash || row.renderKey !== renderKey) {
    await db.mapFile.update({
      where: { id: row.id },
      data: { fileHash, renderKey },
    });
  }

  return {
    mapFileId: row.id,
    uploadedAtMs: row.uploadedAt.getTime(),
    bounds: row.bounds,
    scale: row.scale,
    colorProfile,
    colorOverrides,
    northLinesBelow,
    rotationCorrection,
    fileHash,
    renderKey,
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
    select: {
      id: true,
      scale: true,
      rotationCorrection: true,
      colorProfile: true,
      colorOverrides: true,
      northLinesBelow: true,
      fileHash: true,
      renderKey: true,
      fileData: true,
    },
  });
  if (!row) return null;

  const colorProfile = parseProfile(row.colorProfile);
  const colorOverrides = parseOverrides(row.colorOverrides);
  const northLinesBelow = row.northLinesBelow;
  const rotationCorrection = row.rotationCorrection;

  let fileHash = row.fileHash;
  if (!fileHash) {
    fileHash = hashMapFileData(Buffer.from(row.fileData));
  }
  const renderKey = computeRenderKey({
    fileHash,
    rotationCorrection,
    colorProfile,
    colorOverrides,
    northLinesBelow,
  });

  if (row.fileHash !== fileHash || row.renderKey !== renderKey) {
    await db.clubMapFile.update({
      where: { id: row.id },
      data: { fileHash, renderKey },
    });
  }

  return {
    scale: row.scale,
    colorProfile,
    colorOverrides,
    northLinesBelow,
    rotationCorrection,
    fileHash,
    renderKey,
  };
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
    select: {
      rotationCorrection: true,
      colorProfile: true,
      colorOverrides: true,
      northLinesBelow: true,
      fileHash: true,
      fileData: true,
    },
  });
  const fileHash = row.fileHash ?? hashMapFileData(Buffer.from(row.fileData));
  const renderKey = computeRenderKey({
    fileHash,
    rotationCorrection: row.rotationCorrection,
    colorProfile: parseProfile(row.colorProfile),
    colorOverrides: parseOverrides(row.colorOverrides),
    northLinesBelow: row.northLinesBelow,
  });
  await db.mapFile.update({
    where: { id: mapFileId },
    data: { fileHash, renderKey },
  });
  return renderKey;
}

export async function refreshClubMapRenderKey(
  db: ClubMapDb,
  clubMapId: bigint,
): Promise<string> {
  const row = await db.clubMapFile.findUniqueOrThrow({
    where: { id: clubMapId },
    select: {
      rotationCorrection: true,
      colorProfile: true,
      colorOverrides: true,
      northLinesBelow: true,
      fileHash: true,
      fileData: true,
    },
  });
  const fileHash = row.fileHash ?? hashMapFileData(Buffer.from(row.fileData));
  const renderKey = computeRenderKey({
    fileHash,
    rotationCorrection: row.rotationCorrection,
    colorProfile: parseProfile(row.colorProfile),
    colorOverrides: parseOverrides(row.colorOverrides),
    northLinesBelow: row.northLinesBelow,
  });
  await db.clubMapFile.update({
    where: { id: clubMapId },
    data: { fileHash, renderKey },
  });
  return renderKey;
}
