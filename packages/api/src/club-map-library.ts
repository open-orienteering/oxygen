/**
 * The club library read from the series (docs/map-storage.md §6.5): one
 * listed row per `club_maps` series, built from its latest
 * `club_map_versions` row, that version's `map_sources` / `map_documents`
 * rows and — for the raster-path metadata the document does not carry
 * yet — the linked legacy `club_map_files` row. Pure, so the precedence
 * rules are unit-tested without a database.
 */
import { TRPCError } from "@trpc/server";
import { currentMeridianStaleness } from "./event-map.js";
import { canDownloadClubLibraryMap } from "./ocad-export.js";
import type { WGS84Bounds } from "./map-projection.js";
import type { NorthDetection } from "./map-north.js";

export interface Person {
  email: string;
  displayName: string | null;
}

export interface ClubMapRowInput {
  series: {
    id: string;
    name: string;
    colourProfile: string;
    colourOverrides: unknown;
    northLinesBelow: boolean;
    rotationCorrection: number;
    createdBy: string | null;
    createdAt: Date;
    creator: Person | null;
  };
  /** Latest `seq`, or null while the first import has not produced one. */
  version: {
    id: string;
    seq: number;
    label: string;
    sourceHash: string;
    documentHash: string;
    uploadedAt: Date;
    uploadedBy: string | null;
    uploader: Person | null;
    source: { fileName: string; sizeBytes: number };
    document: { header: unknown };
  } | null;
  versionCount: number;
  /** Newest import job of the series. */
  job: {
    id: string;
    state: string;
    error: string | null;
    source: { fileName: string; sizeBytes: number };
  } | null;
  /** The linked `club_map_files` row (write-through, §6.5). */
  legacy: {
    id: bigint;
    scale: number | null;
    bounds: unknown;
    northOffset: number | null;
    northDetection: unknown;
  } | null;
}

function headerScale(header: unknown): number | null {
  if (header && typeof header === "object" && "mapScale" in header) {
    const scale = (header as { mapScale: unknown }).mapScale;
    if (typeof scale === "number" && Number.isFinite(scale) && scale > 0) return scale;
  }
  return null;
}

export function projectClubMapRow({ series, version, versionCount, job, legacy }: ClubMapRowInput) {
  const file = version?.source ?? job?.source ?? null;
  return {
    id: series.id,
    name: series.name,
    colorProfile: series.colourProfile,
    colorOverrides: (series.colourOverrides ?? {}) as { above?: number[]; below?: number[] },
    northLinesBelow: series.northLinesBelow,
    rotationCorrection: series.rotationCorrection,
    createdBy: series.createdBy,
    createdAt: series.createdAt.toISOString(),
    version: version
      ? {
          id: version.id,
          seq: version.seq,
          label: version.label,
          sourceHash: version.sourceHash,
          documentHash: version.documentHash,
          uploadedAt: version.uploadedAt.toISOString(),
          uploadedBy: version.uploadedBy,
        }
      : null,
    versionCount,
    importJob: !version && job ? { id: job.id, state: job.state, error: job.error } : null,
    fileName: version?.label || file?.fileName || null,
    sizeBytes: file?.sizeBytes ?? null,
    scale: (version ? headerScale(version.document.header) : null) ?? legacy?.scale ?? null,
    uploadedAt: (version?.uploadedAt ?? series.createdAt).toISOString(),
    uploadedBy: version ? version.uploadedBy : series.createdBy,
    uploader: version ? version.uploader : series.creator,
    previewUrl: version
      ? `/api/map-documents/${version.documentHash}/thumbnail.png`
      : legacy
        ? `/api/club-map-preview/${legacy.id}`
        : null,
    bounds: (legacy?.bounds as WGS84Bounds | null | undefined) ?? null,
    northOffset: legacy?.northOffset ?? null,
    northDetection: (legacy?.northDetection as NorthDetection | null | undefined) ?? null,
    // Evaluated for today, not import time, so a library map starts
    // to flag its north lines as the declination drifts away from them.
    meridianStalenessDeg: currentMeridianStaleness(legacy?.northDetection ?? null),
  };
}

export type ClubMapRow = ReturnType<typeof projectClubMapRow>;

interface Caller {
  authEnabled: boolean;
  user: { id: string; isAdmin: boolean } | null;
}

/** Delete a series: its creator or an instance admin. */
export function canRemoveClubMap(args: Caller & { createdBy: string | null }): boolean {
  if (!args.authEnabled) return true;
  return Boolean(args.user && (args.user.isAdmin || args.createdBy === args.user.id));
}

/** Download a version's source: the club clause of `GET /api/map-sources/:hash` (§4.4). */
export function canDownloadClubMapVersion(args: Caller & { uploadedBy: string | null }): boolean {
  return canDownloadClubLibraryMap({
    authEnabled: args.authEnabled,
    isAdmin: Boolean(args.user?.isAdmin),
    isUploader: Boolean(args.user && args.uploadedBy === args.user.id),
  });
}

/**
 * An event pins a version (06 §6): a series whose import failed or is
 * still running cannot be downloaded or adopted yet.
 */
export function latestVersionOrRefuse<V>(name: string, version: V | null | undefined): V {
  if (!version) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Club map "${name}" has not been imported yet`,
    });
  }
  return version;
}
