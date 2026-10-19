import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { reseed } from "./helpers/reseed";
import { uploadEventMap } from "./helpers/map-upload";
import { API_BASE } from "./helpers/api-base";

/**
 * Content-addressed map documents (docs/map-storage.md): uploading an
 * event map additionally stores an immutable document the event pins,
 * `course.mapMetadata` exposes its hash, and `/api/map-documents/:hash`
 * serves it — gated by the event, cached as immutable, range-capable —
 * so the GL dev page can load it straight from the API; the original file
 * streams back from `/api/map-sources/:hash` to an event manager. The
 * second test drives the chunked upload route and the import job status
 * end to end.
 */

const EVENT = "itest";
const HEADERS = { "x-event-id": EVENT };

test.beforeAll(reseed);
test.afterAll(reseed);

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10_000 });
}

async function clickTab(page: Page, name: string) {
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) await mainTab.click();
  else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name, exact: true }).click();
  }
}

test.describe("Map documents", () => {
  test("an uploaded event map is stored as a document and served by hash", async ({ page, request }) => {
    test.setTimeout(120_000);
    await selectCompetition(page);
    await clickTab(page, "Courses");
    await uploadEventMap(page);
    await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60_000 });

    // The upload pinned a document; the hash comes back through mapMetadata.
    const meta = await request.get(`${API_BASE}/trpc/course.mapMetadata`, { headers: HEADERS });
    expect(meta.ok()).toBe(true);
    const hash = (await meta.json())?.result?.data?.documentHash as string | null | undefined;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Served to the event's course viewer, immutable, with an ETag equal to the hash.
    const full = await request.get(`${API_BASE}/api/map-documents/${hash}`, { headers: HEADERS });
    expect(full.status()).toBe(200);
    expect(full.headers()["content-type"]).toBe("application/vnd.oxygen.map");
    expect(full.headers()["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(full.headers()["etag"]).toBe(`"${hash}"`);
    const body = await full.body();
    expect(body.subarray(0, 4).toString()).toBe("OXVM");

    // Revalidation is free, ranges are honoured, the event gate holds.
    const notModified = await request.get(`${API_BASE}/api/map-documents/${hash}`, { headers: { ...HEADERS, "if-none-match": `"${hash}"` } });
    expect(notModified.status()).toBe(304);
    const range = await request.get(`${API_BASE}/api/map-documents/${hash}`, { headers: { ...HEADERS, range: "bytes=0-3" } });
    expect(range.status()).toBe(206);
    expect(range.headers()["content-range"]).toBe(`bytes 0-3/${body.byteLength}`);
    expect((await range.body()).toString()).toBe("OXVM");
    const noEvent = await request.get(`${API_BASE}/api/map-documents/${hash}`, { headers: { "x-event-id": "meos_20251222_001121_2BC" } });
    expect(noEvent.status()).toBe(403);

    // The original upload streams back to an event manager as an uncached attachment (docs/map-storage.md §4.4).
    const file = readFileSync("e2e/test.ocd");
    const sourceHash = createHash("sha256").update(file).digest("hex");
    const source = await request.get(`${API_BASE}/api/map-sources/${sourceHash}`, { headers: HEADERS });
    expect(source.status()).toBe(200);
    expect(source.headers()["content-type"]).toBe("application/octet-stream");
    expect(source.headers()["cache-control"]).toBe("private, no-store");
    expect(source.headers()["content-disposition"]).toContain('filename="test.ocd"');
    expect((await source.body()).equals(file)).toBe(true);
    // Anonymous (no proxy identity) never gets it.
    const anonymous = await request.get(`${API_BASE}/api/map-sources/${sourceHash}`, { headers: { ...HEADERS, "x-forwarded-email": "" } });
    expect(anonymous.status()).toBe(401);

    // The GL dev page loads the document from the route (no OCAD reader involved).
    await page.goto(`/dev/map-gl-doc?url=${encodeURIComponent(`/api/map-documents/${hash}?event=${EVENT}`)}`);
    await expect(page.getByTestId("map-gl-doc-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(page.getByTestId("map-gl-doc-error")).toHaveCount(0);
    await expect(page.getByTestId("map-gl-doc-document")).toContainText("native");
    const load = await page.evaluate(() => (window as unknown as { __mapGlDoc?: { load?: { document?: { hash: string }; objects: { matched: number } } } }).__mapGlDoc?.load);
    expect(load?.document?.hash).toBe(hash);
    expect(load?.objects.matched).toBeGreaterThan(0);

    // The upload ran as an import job; the latest one for the event is done
    // and carries the report (docs/map-storage.md §6).
    const latest = await request.get(`${API_BASE}/trpc/mapImport.latestForEvent`, { headers: HEADERS });
    expect(latest.ok()).toBe(true);
    const job = (await latest.json())?.result?.data as { state: string; documentHash: string; report: { source: { fileName: string } } };
    expect(job).toMatchObject({ state: "done", documentHash: hash });
    expect(job.report.source.fileName).toBe("test.ocd");
  });

  test("the chunked upload route feeds applyUploadedMap, and a club upload imports as a job", async ({ request }) => {
    const file = readFileSync("e2e/test.ocd");
    const chunkBytes = 8192;

    // Init → chunks (last one first, chunk 1 twice) → finalise.
    const init = await request.post(`${API_BASE}/api/map-uploads`, { headers: HEADERS, data: { fileName: "chunked.ocd", bytes: file.byteLength, chunkBytes } });
    expect(init.status()).toBe(201);
    const { uploadId, chunkCount } = (await init.json()) as { uploadId: string; chunkCount: number };
    expect(chunkCount).toBe(Math.ceil(file.byteLength / chunkBytes));
    const order = [chunkCount - 1, ...Array.from({ length: chunkCount - 1 }, (_, i) => i), 1];
    for (const n of order) {
      const put = await request.put(`${API_BASE}/api/map-uploads/${uploadId}/chunks/${n}`, {
        headers: { ...HEADERS, "content-type": "application/octet-stream" },
        data: file.subarray(n * chunkBytes, (n + 1) * chunkBytes),
      });
      expect(put.status(), `chunk ${n}`).toBe(204);
    }
    const fin = await request.post(`${API_BASE}/api/map-uploads/${uploadId}/finalise`, { headers: HEADERS });
    expect(fin.status()).toBe(200);
    const { fileHash, bytes } = (await fin.json()) as { fileHash: string; bytes: number };
    expect(bytes).toBe(file.byteLength);
    expect(fileHash).toBe(createHash("sha256").update(file).digest("hex"));

    // Apply by hash: the event map is now the chunked upload, under its own name.
    const applied = await request.post(`${API_BASE}/trpc/course.applyUploadedMap`, { headers: HEADERS, data: { fileHash, fileName: "chunked.ocd" } });
    expect(applied.ok()).toBe(true);
    const result = (await applied.json())?.result?.data as { fileName: string; documentHash: string | null; importJob: { id: string; state: string } };
    expect(result.fileName).toBe("chunked.ocd");
    expect(result.importJob.state).toBe("done");
    expect(result.documentHash).toMatch(/^[0-9a-f]{64}$/);
    const meta = await request.get(`${API_BASE}/trpc/course.mapMetadata`, { headers: HEADERS });
    expect((await meta.json())?.result?.data?.documentHash).toBe(result.documentHash);

    // Same bytes as a club-library map: its own series, imported by a job
    // that dedups against the document already stored.
    const club = await request.post(`${API_BASE}/trpc/clubMap.upload`, { data: { name: "E2E chunked club map", fileName: "club.ocd", fileDataBase64: file.toString("base64") } });
    expect(club.ok()).toBe(true);
    const created = (await club.json())?.result?.data as { id: number; clubMapId: string; importJob: { id: string; state: string } };
    expect(created.importJob.state).toBe("done");
    const status = await request.get(`${API_BASE}/trpc/mapImport.status?input=${encodeURIComponent(JSON.stringify({ jobId: created.importJob.id }))}`);
    expect(status.ok()).toBe(true);
    expect((await status.json())?.result?.data).toMatchObject({ state: "done", documentHash: result.documentHash, clubMapId: created.clubMapId });
    const removed = await request.post(`${API_BASE}/trpc/clubMap.remove`, { data: { id: created.id } });
    expect(removed.ok()).toBe(true);
  });
});
