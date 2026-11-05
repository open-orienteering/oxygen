/**
 * The club library read from the series (docs/map-storage.md §6.5): one
 * listed row per `club_maps` series, built from its latest
 * `club_map_versions` row and that version's `map_sources` /
 * `map_documents` rows — extent and north from the document's header and
 * import report, under the series' `rotation_correction`. The linked
 * legacy `club_map_files` row only names the PNG preview of a series that
 * has no version yet. Pure, so the precedence rules are unit-tested
 * without a database.
 */
import { TRPCError } from "@trpc/server";
import { canDownloadClubLibraryMap } from "./ocad-export.js";
import { meridianStalenessFromDetection } from "./map-north.js";
import { documentFrameSchema, mapFileMetadataFor } from "./map-store/map-file-metadata.js";
import { reportNorth } from "./map-store/event-document.js";

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
    /** `report` is the import report (`matching.symbols` counts); optional for callers that do not load it. */
    document: { header: unknown; report?: unknown };
  } | null;
  versionCount: number;
  /** Newest import job of the series. */
  job: {
    id: string;
    state: string;
    error: string | null;
    source: { fileName: string; sizeBytes: number };
  } | null;
  /** The linked `club_map_files` row (write-through, §6.5): its preview route only. */
  legacy: { id: bigint } | null;
}

function headerScale(header: unknown): number | null {
  if (header && typeof header === "object" && "mapScale" in header) {
    const scale = (header as { mapScale: unknown }).mapScale;
    if (typeof scale === "number" && Number.isFinite(scale) && scale > 0) return scale;
  }
  return null;
}

/**
 * Symbols of a version's document still awaiting review and those with a
 * club decision, from the import report's matching summary (06 §5.1:
 * review is expected for club maps). Null before the matcher ran.
 */
function reviewCounts(report: unknown): { suggested: number; reviewed: number } | null {
  const symbols = (report as { matching?: { symbols?: { suggested?: unknown; reviewed?: unknown } } } | null)?.matching?.symbols;
  if (typeof symbols?.suggested !== "number" || typeof symbols.reviewed !== "number") return null;
  return { suggested: symbols.suggested, reviewed: symbols.reviewed };
}

export function projectClubMapRow({ series, version, versionCount, job, legacy }: ClubMapRowInput) {
  const file = version?.source ?? job?.source ?? null;
  const north = version ? reportNorth(version.document.report) : null;
  const frame = version ? documentFrameSchema.safeParse(version.document.header) : null;
  const columns = frame?.success
    ? mapFileMetadataFor(frame.data, north?.meridian?.medianTiltDeg ?? null, series.rotationCorrection)
    : null;
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
    review: version ? reviewCounts(version.document.report) : null,
    importJob: !version && job ? { id: job.id, state: job.state, error: job.error } : null,
    fileName: version?.label || file?.fileName || null,
    sizeBytes: file?.sizeBytes ?? null,
    scale: version ? headerScale(version.document.header) : null,
    uploadedAt: (version?.uploadedAt ?? series.createdAt).toISOString(),
    uploadedBy: version ? version.uploadedBy : series.createdBy,
    uploader: version ? version.uploader : series.creator,
    previewUrl: version
      ? `/api/map-documents/${version.documentHash}/thumbnail.png`
      : legacy
        ? `/api/club-map-preview/${legacy.id}`
        : null,
    bounds: columns?.bounds ?? null,
    northOffset: columns?.northOffset ?? null,
    northDetection: north,
    // Evaluated for today, not import time, so a library map starts
    // to flag its north lines as the declination drifts away from them.
    meridianStalenessDeg: meridianStalenessFromDetection(north),
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
