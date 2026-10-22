/**
 * The vector base layer inside `MapViewer` (docs/map-rendering.md §5.4).
 *
 * The layer is chosen by the event's switch, `events.map_pipeline`
 * (docs/map-pipeline-switch.md), set here straight in the database. Under
 * `vector` the event's pinned document is fetched once from
 * `/api/map-documents/:hash` and drawn by the WebGL2 arena path on an
 * unrotated canvas; no tile is requested; gestures move a paper-space
 * view; a GPS fix reaches the overlay through `mapGeo`. Under `legacy`
 * the viewer is today's tile viewer.
 *
 * Headless Chromium draws WebGL2 with SwiftShader, so only presence and
 * geometry are asserted, never timings.
 */

import { test, expect, type Locator, type Page, type Request } from "@playwright/test";
import { PNG } from "pngjs";
import { reseed } from "./helpers/reseed";
import { uploadEventMap } from "./helpers/map-upload";
import { setMapPipeline } from "./helpers/map-pipeline";

async function openEvent(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 15_000 });
}

async function viewerWithMap(page: Page): Promise<Locator> {
  const viewer = page.getByTestId("map-viewer").first();
  // The seed event may already carry a map; upload one only when the panel offers to.
  const upload = page.getByTestId("map-panel").first().getByRole("button", { name: "Upload map" });
  await expect(viewer.or(upload)).toBeVisible({ timeout: 60_000 });
  if (!(await viewer.isVisible())) await uploadEventMap(page);
  await expect(viewer).toBeVisible({ timeout: 60_000 });
  return viewer;
}

/** Paper view of the viewer, from its data attributes. */
async function paperView(viewer: Locator) {
  const n = async (name: string) => Number(await viewer.getAttribute(name));
  const box = await viewer.boundingBox();
  if (!box) throw new Error("map viewer has no box");
  return {
    centreX: await n("data-centre-x"),
    centreY: await n("data-centre-y"),
    pxPerUm: await n("data-px-per-um"),
    rotDeg: await n("data-rotation"),
    box,
  };
}

/** Paper µm under a page point: undo the CSS rotation about the container centre, then the paper view. */
function pageToPaper(v: Awaited<ReturnType<typeof paperView>>, x: number, y: number) {
  const r = (-v.rotDeg * Math.PI) / 180;
  const dx = x - (v.box.x + v.box.width / 2), dy = y - (v.box.y + v.box.height / 2);
  const ix = dx * Math.cos(r) - dy * Math.sin(r), iy = dx * Math.sin(r) + dy * Math.cos(r);
  return { x: v.centreX + ix / v.pxPerUm, y: v.centreY - iy / v.pxPerUm };
}

test.describe("vector map layer", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await reseed();
  });

  test.afterAll(async () => {
    await setMapPipeline("legacy");
  });

  test("draws the pinned document and requests no tiles", async ({ page }) => {
    test.setTimeout(120_000);
    await setMapPipeline("vector");
    const tileRequests: string[] = [];
    const documentRequests: Request[] = [];
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith("/api/map-tile")) tileRequests.push(path);
      if (/^\/api\/map-documents\/[0-9a-f]{64}$/.test(path)) documentRequests.push(req);
    });

    await openEvent(page);
    const viewer = await viewerWithMap(page);
    await expect(viewer).toHaveAttribute("data-map-pipeline", "vector", { timeout: 30_000 });
    const canvas = viewer.getByTestId("map-vector-layer");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-document-hash", /^[0-9a-f]{64}$/);

    // The document travels by hash with the event as a header, never in the query.
    expect(documentRequests.length).toBeGreaterThan(0);
    const req = documentRequests[0];
    expect(new URL(req.url()).search).toBe("");
    expect(req.headers()["x-event-id"]).toBeTruthy();
    expect(new URL(req.url()).pathname).toBe(`/api/map-documents/${await canvas.getAttribute("data-document-hash")}`);

    // No tile layer and no tile traffic.
    await expect(viewer.getByTestId("map-tiles-composite")).toHaveCount(0);
    await expect(viewer.getByTestId("map-tiles-ink")).toHaveCount(0);
    expect(tileRequests).toEqual([]);

    // The canvas fills the viewer's content box, unrotated, and has drawn map ink.
    const inner = await viewer.evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }));
    const cb = (await canvas.boundingBox())!;
    expect(Math.abs(cb.width - inner.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(cb.height - inner.h)).toBeLessThanOrEqual(1);
    const png = PNG.sync.read(await canvas.screenshot());
    let dark = 0;
    for (let i = 0; i < png.data.length; i += 4) {
      if (png.data[i] + png.data[i + 1] + png.data[i + 2] < 600) dark++;
    }
    expect(dark).toBeGreaterThan(200);

    // The paper view is exposed; the legacy attributes keep their meaning.
    const v = await paperView(viewer);
    expect(v.pxPerUm).toBeGreaterThan(0);
    expect(Number(await viewer.getAttribute("data-center-lat"))).toBeGreaterThan(50);
    expect(Number(await viewer.getAttribute("data-zoom"))).toBeGreaterThan(5);
  });

  test("wheel zoom keeps the paper point under the cursor", async ({ page }) => {
    test.setTimeout(120_000);
    await setMapPipeline("vector");
    await openEvent(page);
    const viewer = await viewerWithMap(page);
    await expect(viewer.getByTestId("map-vector-layer")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });

    // The dashboard map sits below the fold: bring it in, then aim inside the visible part.
    await viewer.scrollIntoViewIfNeeded();
    const before = await paperView(viewer);
    const vh = page.viewportSize()!.height;
    const x = before.box.x + before.box.width * 0.3;
    const y = Math.max(before.box.y, 0) + Math.min(before.box.height, vh - Math.max(before.box.y, 0)) * 0.4;
    const anchor = pageToPaper(before, x, y);
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -100);
    await expect.poll(async () => Number(await viewer.getAttribute("data-px-per-um"))).toBeGreaterThan(before.pxPerUm * 1.05);
    const after = await paperView(viewer);
    const moved = pageToPaper(after, x, y);
    // Within half a CSS pixel at the new scale.
    expect(Math.hypot(moved.x - anchor.x, moved.y - anchor.y) * after.pxPerUm).toBeLessThan(0.5);
  });

  test("a GPS fix lands where mapGeo puts it", async ({ page }) => {
    test.setTimeout(120_000);
    await setMapPipeline("vector");
    await openEvent(page);
    const viewer = await viewerWithMap(page);
    await expect(viewer.getByTestId("map-vector-layer")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });

    // The fitted view's centre in WGS 84 (paper → WGS 84 through mapGeo).
    const lat = Number(await viewer.getAttribute("data-center-lat"));
    const lng = Number(await viewer.getAttribute("data-center-lng"));
    await page.context().grantPermissions(["geolocation"]);
    await page.context().setGeolocation({ latitude: lat + 0.0005, longitude: lng + 0.0005, accuracy: 10 });

    await viewer.getByTestId("locate-button").click();
    const marker = viewer.getByTestId("my-location-marker");
    await expect(marker).toBeVisible({ timeout: 10_000 });
    // Following re-centres the view on the fix (WGS 84 → paper through mapGeo) …
    await expect.poll(async () => Number(await viewer.getAttribute("data-center-lat")), { timeout: 10_000 }).toBeCloseTo(lat + 0.0005, 5);
    await expect.poll(async () => Number(await viewer.getAttribute("data-center-lng"))).toBeCloseTo(lng + 0.0005, 5);
    // … and the marker is drawn at the centre of the viewer.
    const vb = (await viewer.boundingBox())!;
    const dot = (await marker.locator("circle[r='7']").boundingBox())!;
    expect(Math.abs(dot.x + dot.width / 2 - (vb.x + vb.width / 2))).toBeLessThan(1.5);
    expect(Math.abs(dot.y + dot.height / 2 - (vb.y + vb.height / 2))).toBeLessThan(1.5);
  });

  test("a legacy event stays on tiles", async ({ page }) => {
    test.setTimeout(120_000);
    await setMapPipeline("legacy");
    await openEvent(page);
    const viewer = await viewerWithMap(page);
    await expect(viewer).toHaveAttribute("data-map-pipeline", "legacy");
    await expect(viewer.getByTestId("map-tiles-composite")).toHaveCount(1);
    await expect(viewer.getByTestId("map-vector-layer")).toHaveCount(0);
  });
});
