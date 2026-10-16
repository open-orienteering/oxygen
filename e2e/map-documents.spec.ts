import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { uploadEventMap } from "./helpers/map-upload";
import { API_BASE } from "./helpers/api-base";

/**
 * Content-addressed map documents (docs/map-storage.md): uploading an
 * event map additionally stores an immutable document the event pins,
 * `course.mapMetadata` exposes its hash, and `/api/map-documents/:hash`
 * serves it — gated by the event, cached as immutable, range-capable —
 * so the GL dev page can load it straight from the API.
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

    // The GL dev page loads the document from the route (no OCAD reader involved).
    await page.goto(`/dev/map-gl-doc?url=${encodeURIComponent(`/api/map-documents/${hash}?event=${EVENT}`)}`);
    await expect(page.getByTestId("map-gl-doc-canvas")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(page.getByTestId("map-gl-doc-error")).toHaveCount(0);
    await expect(page.getByTestId("map-gl-doc-document")).toContainText("native");
    const load = await page.evaluate(() => (window as unknown as { __mapGlDoc?: { load?: { document?: { hash: string }; objects: { matched: number } } } }).__mapGlDoc?.load);
    expect(load?.document?.hash).toBe(hash);
    expect(load?.objects.matched).toBeGreaterThan(0);
  });
});
