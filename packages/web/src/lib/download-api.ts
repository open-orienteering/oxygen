import { venueAwareFetch } from "./node-discovery";

/**
 * Same-origin `/api/...` downloads via fetch so identity headers travel
 * the same path as tRPC (plain `<a href>` navigations can omit them).
 */
export async function downloadSameOriginFile(url: string): Promise<void> {
  const res = await venueAwareFetch(url);
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
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(href);
}
