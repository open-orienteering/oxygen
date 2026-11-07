/**
 * The map-info dialog's rows (docs/course-editor.md §2, P6): what the editor
 * knows about the event's map, from data it already has — `course.mapFileInfo`
 * (file name, upload time, size), `course.mapMetadata` (scale, north lines,
 * document hash) and the loaded document's header (`useMapDocument`). The
 * dialog is `pages/editor/MapInfoDialog.tsx`; the north lines are its
 * `NorthLinesBadge`, between the scale and the file.
 */

import type { mapDocument } from "@oxygen/shared";

/** The header fields the dialog reads (`MapDocumentHeader`, docs/map-document.md). */
export type MapInfoHeader = Pick<mapDocument.MapDocumentHeader,"source" | "format" | "library" | "georeferencing" | "colours" | "symbols" | "objects">;

export interface MapInfoInput {
  /** The uploaded file's name; null without a map. */
  fileName: string | null;
  /** When the file was uploaded (ISO 8601). */
  uploadedAt: string | null;
  /** The file's size in bytes; 0 or null when unknown. */
  sizeBytes: number | null;
  /** The map scale's denominator. */
  scale: number | null;
  /** How far the drawn north lines are off today's magnetic north (`NorthLinesBadge`). */
  meridianStalenessDeg: number | null;
  /** The event's map document (null while the import runs): the review link's target. */
  documentHash: string | null;
  /** The loaded document's header; null while it loads or the import runs. */
  header: MapInfoHeader | null;
}

export type MapInfoRowId = "name" | "scale" | "file" | "source" | "content" | "library" | "crs" | "importer";

export interface MapInfoRow {
  id: MapInfoRowId;
  /** The row's label key in the `editor` namespace. */
  label: MapInfoLabel;
  text: string;
  /** Machine-readable values for the row's `data-*` attributes. */
  data: Record<string, string>;
}

type MapInfoLabel =
  | "mapInfoName" | "mapInfoScale" | "mapInfoFile" | "mapInfoSource" | "mapInfoContent"
  | "mapInfoLibrary" | "mapInfoCrs" | "mapInfoImporter";
type MapInfoKey = "mapInfoScaleValue" | "mapInfoFileValue" | "mapInfoObjects" | "mapInfoSymbols" | "mapInfoColours";
/** The editor namespace's `t`, narrowed to the keys the values use. */
type T = (key: MapInfoKey, opts?: { count?: number; scale?: string; size?: string; date?: string }) => string;

export interface MapInfo {
  /** The map itself: name, scale, file. Empty without a map. */
  map: MapInfoRow[];
  /** The document's details; empty while no header is loaded. */
  document: MapInfoRow[];
  /** The document section's `data-*` values (`editor-map-info-document`). */
  documentData: Record<string, string> | null;
}

/** `1 234 567` bytes as `1.2 MB`, the club-map picker's rule: KB below a MiB, MB from it, one decimal. */
export function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SOURCE_KIND: Record<MapInfoHeader["source"]["kind"], string> = { ocad: "OCAD", omap: "OpenOrienteering Mapper" };

/**
 * The dialog's rows, each only when it has a value: the map's name, scale and file, then the document's source,
 * content (objects · symbols · colours), symbol library, coordinate system and importer.
 */
export function mapInfoRows(input: MapInfoInput, t: T, formatDate: (iso: string) => string): MapInfo {
  const map: MapInfoRow[] = [];
  if (input.fileName) map.push({ id: "name", label: "mapInfoName", text: input.fileName, data: { name: input.fileName } });
  if (input.scale) {
    map.push({ id: "scale", label: "mapInfoScale", text: t("mapInfoScaleValue", { scale: input.scale.toLocaleString("sv-SE") }), data: { scale: String(input.scale) } });
  }
  if (input.fileName && (input.sizeBytes || input.uploadedAt)) {
    const size = input.sizeBytes ? formatBytes(input.sizeBytes) : null;
    const date = input.uploadedAt ? formatDate(input.uploadedAt) : null;
    const text = size && date ? t("mapInfoFileValue", { size, date }) : (size ?? date!);
    map.push({ id: "file", label: "mapInfoFile", text, data: { bytes: String(input.sizeBytes ?? 0), uploaded: input.uploadedAt ?? "" } });
  }

  const h = input.header;
  if (!input.fileName || !h) return { map, document: [], documentData: null };
  const document: MapInfoRow[] = [];
  const kind = SOURCE_KIND[h.source.kind];
  document.push({ id: "source", label: "mapInfoSource", text: h.source.version ? `${kind} ${h.source.version}` : kind, data: { kind: h.source.kind, version: h.source.version } });
  const content = [
    t("mapInfoObjects", { count: h.objects.count }),
    t("mapInfoSymbols", { count: h.symbols.length }),
    t("mapInfoColours", { count: h.colours.length }),
  ].join(" · ");
  document.push({ id: "content", label: "mapInfoContent", text: content, data: {} });
  if (h.library) document.push({ id: "library", label: "mapInfoLibrary", text: `${h.library.id} · ${h.library.version}`, data: { id: h.library.id, version: h.library.version } });
  const crs = h.georeferencing.crs;
  if (crs) document.push({ id: "crs", label: "mapInfoCrs", text: `${crs.authority}:${crs.code} · ${crs.name}`, data: { crs: `${crs.authority}:${crs.code}` } });
  document.push({ id: "importer", label: "mapInfoImporter", text: h.format.importer, data: { importer: h.format.importer } });
  return {
    map,
    document,
    documentData: {
      source: h.source.kind,
      objects: String(h.objects.count),
      symbols: String(h.symbols.length),
      colours: String(h.colours.length),
    },
  };
}
