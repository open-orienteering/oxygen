import { venueAwareFetch } from "./node-discovery";

/**
 * A same-origin `/api/...` file fetched as a blob, its name from
 * `Content-Disposition`. A non-2xx throws the body's text (the route's
 * message) or `Download failed (<status>)`.
 */
export async function fetchDownload(url: string, fetchImpl: (url: string) => Promise<Response> = venueAwareFetch): Promise<{ blob: Blob; filename: string }> {
  const res = await fetchImpl(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
  const filename = match
    ? decodeURIComponent(match[1].replace(/"/g, "").trim())
    : url.split("/").pop() ?? "download";
  return { blob, filename };
}

/** Hands a blob to the browser as a download named `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}

/**
 * Same-origin `/api/...` downloads via fetch so identity headers travel
 * the same path as tRPC (plain `<a href>` navigations can omit them).
 */
export async function downloadSameOriginFile(url: string): Promise<void> {
  const { blob, filename } = await fetchDownload(url);
  saveBlob(blob, filename);
}

/**
 * `maps.pdf<query>` of event `nameId`, composed on this device when it can
 * and by the server otherwise (docs/course-print.md §8.6, G16). The client
 * and, through it, the print worker load on first use.
 */
export async function downloadMapsPdf(nameId: string, query: string): Promise<void> {
  const { printMapsPdf } = await import("../print/client");
  const { blob, filename } = await printMapsPdf(nameId, query);
  saveBlob(blob, filename);
}

/** `/api/maps/<nameId>/maps.pdf[?query]`: the routes `downloadExport` composes on the device. */
const MAPS_PDF_RE = /^\/api\/maps\/([^/?]+)\/maps\.pdf(\?.*)?$/;

/** `[nameId, query]` of a `maps.pdf` URL; null for any other file. */
export function mapsPdfTarget(url: string): [nameId: string, query: string] | null {
  const m = MAPS_PDF_RE.exec(url);
  return m ? [decodeURIComponent(m[1]), m[2] ?? ""] : null;
}

/** An export's download (Export ▾, `course-layout.md` §7): `maps.pdf` through `downloadMapsPdf`, any other file as it is. */
export function downloadExport(url: string): Promise<void> {
  const target = mapsPdfTarget(url);
  return target ? downloadMapsPdf(...target) : downloadSameOriginFile(url);
}
