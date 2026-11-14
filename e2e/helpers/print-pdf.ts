/**
 * Print helpers for the preview stack's offline-print smoke
 * (`e2e/offline-print.preview.spec.ts`, G29): seeding a pinned base map,
 * comparing a downloaded PDF with `maps.pdf` object for object, and the
 * Courses page's navigation. Copies of `e2e/course-maps.spec.ts`'s, which
 * keeps its own: that spec is other rows' area (decisions/slice-g.md G29).
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, type Download, type Page } from "@playwright/test";
import { API_BASE } from "./api-base";
import { reseed } from "./reseed";

// pdf-lib is the API's dependency; load it from there.
type PdfObject = { toString(): string; dict?: { lookup(key: unknown): unknown; toString(): string }; contents?: Uint8Array };
type LoadedPdf = {
  getPageCount(): number;
  getPages(): { getSize(): { width: number; height: number } }[];
  context: { trailerInfo: { Info?: { toString(): string } }; enumerateIndirectObjects(): [{ toString(): string }, PdfObject][] };
};
const { PDFDocument, PDFName, PDFRawStream } = createRequire(resolve(process.cwd(), "packages/api/package.json"))("pdf-lib") as {
  PDFDocument: { load(bytes: Uint8Array): Promise<LoadedPdf> };
  PDFName: { of(name: string): unknown };
  PDFRawStream: new (...args: never[]) => PdfObject;
};

export const E2E_HEADERS = { "x-competition-id": "itest", "x-forwarded-email": "e2e-admin@oxygen.test" };

/**
 * Every indirect object of a PDF as text (a stream: its dictionary and its
 * raw bytes in hex), but the `Info` dictionary and the cross-reference and
 * object streams — what two prints of one job may differ in without
 * `deterministic` (`CreationDate`, `/ID`; course-print.md §3.2, §8.5).
 */
async function pdfObjects(bytes: Uint8Array): Promise<{ pages: number; objects: Map<string, string> }> {
  const pdf = await PDFDocument.load(bytes);
  const info = pdf.context.trailerInfo.Info?.toString();
  const objects = new Map<string, string>();
  for (const [ref, obj] of pdf.context.enumerateIndirectObjects()) {
    if (ref.toString() === info) continue;
    if (obj instanceof PDFRawStream) {
      const type = obj.dict!.lookup(PDFName.of("Type"));
      if (type === PDFName.of("XRef") || type === PDFName.of("ObjStm")) continue;
      objects.set(ref.toString(), `${obj.dict!.toString()}\n${Buffer.from(obj.contents!).toString("hex")}`);
    } else objects.set(ref.toString(), obj.toString());
  }
  return { pages: pdf.getPageCount(), objects };
}

/** The device's PDF is the server's, object for object, but the creation date and `/ID` (course-print.md §8.6). */
export async function expectSamePdf(device: Download, server: Uint8Array) {
  const a = await pdfObjects(await readFile((await device.path())!));
  const b = await pdfObjects(server);
  expect(a.pages).toBe(b.pages);
  expect([...a.objects.keys()]).toEqual([...b.objects.keys()]);
  for (const [ref, text] of b.objects) expect(a.objects.get(ref), `object ${ref}`).toBe(text);
}

/** A downloaded PDF: its page count, every page A4 (05 §7). */
export async function expectA4Pages(download: Download, pages: number) {
  const pdf = await PDFDocument.load(await readFile((await download.path())!));
  expect(pdf.getPageCount()).toBe(pages);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const mm = [width, height].map((pt) => Math.round((pt * 25.4) / 72)).sort((a, b) => a - b);
    expect(mm).toEqual([210, 297]);
  }
}

/**
 * Reseed and pin the event map through the chunked upload and
 * `course.applyUploadedMap`, as the map panel does: every print goes
 * through the composer (course-print.md §8.1).
 */
export async function seedBaseMap() {
  await reseed();
  const bytes = await readFile("e2e/test.ocd");
  const init = await fetch(`${API_BASE}/api/map-uploads`, {
    method: "POST",
    headers: { ...E2E_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ fileName: "test.ocd", bytes: bytes.byteLength, chunkBytes: bytes.byteLength }),
  });
  expect(init.status, await init.clone().text()).toBe(201);
  const { uploadId } = (await init.json()) as { uploadId: string };
  const chunk = await fetch(`${API_BASE}/api/map-uploads/${uploadId}/chunks/0`, {
    method: "PUT",
    headers: { ...E2E_HEADERS, "content-type": "application/octet-stream" },
    body: bytes,
  });
  expect(chunk.status, await chunk.clone().text()).toBe(204);
  const fin = await fetch(`${API_BASE}/api/map-uploads/${uploadId}/finalise`, { method: "POST", headers: E2E_HEADERS });
  expect(fin.status, await fin.clone().text()).toBe(200);
  const { fileHash } = (await fin.json()) as { fileHash: string };
  await trpc("course.applyUploadedMap", { fileHash, fileName: "test.ocd" });
}

/** A tRPC mutation straight to the API, as the e2e admin on `itest`. */
export async function trpc<T>(path: string, input: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/trpc/${path}`, {
    method: "POST",
    headers: { ...E2E_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(res.ok, await res.clone().text()).toBe(true);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

/** Open the seed event from the event list. */
export async function selectEvent(page: Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10_000 });
}

export async function openTab(page: Page, name: string) {
  const primary = page.locator("nav[aria-label='Tabs']").getByRole("link", { name, exact: true });
  if (await primary.isVisible()) {
    await primary.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name, exact: true }).click();
  }
}

/** The Courses page's template pickers, one per course row. */
export const pickers = (page: Page) => page.locator("select[data-testid^='course-template-']");

/** The course ids of the Courses page's rows, in table order. */
export async function courseIds(page: Page): Promise<number[]> {
  await expect(pickers(page).first()).toBeVisible();
  return pickers(page).evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-testid")!.replace("course-template-", ""))));
}

export async function download(page: Page, click: () => Promise<void>): Promise<Download> {
  const [file] = await Promise.all([page.waitForEvent("download"), click()]);
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  return file;
}

/** The paths Cache Storage `name` holds on the page (none when it does not exist). */
export async function cachedPaths(page: Page, name: string | RegExp): Promise<string[]> {
  return page.evaluate(
    async ({ source, flags }) => {
      const re = flags === null ? null : new RegExp(source, flags);
      const names = (await caches.keys()).filter((n) => (re ? re.test(n) : n === source));
      const paths: string[] = [];
      for (const n of names) {
        for (const r of await (await caches.open(n)).keys()) {
          const u = new URL(r.url);
          paths.push(u.pathname + u.search);
        }
      }
      return paths;
    },
    typeof name === "string" ? { source: name, flags: null } : { source: name.source, flags: name.flags },
  );
}
