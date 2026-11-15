/**
 * The viewer's 3D mode (docs/map-rendering.md §5.4 "3D mode", H7).
 *
 * The seed's map (`e2e/test.ocd`) has no contours: no 3D toggle. The CC0
 * demo map (`docs/screenshots/fixtures/puit-de-laven-demo.omap`, > 80 %
 * decided) is imported through the API and pinned: the toggle fetches its
 * height field once, the canvas draws the map draped over the terrain, a
 * right-drag orbits and tilts, the compass turns north up again, the
 * exaggeration control changes the relief, two fingers tilt, a GPS fix is
 * projected through the camera, and leaving 3D draws the 2D view again.
 * A field that cannot be had leaves 2D drawn and says why.
 *
 * Headless Chromium draws WebGL2 with SwiftShader: pixels are compared with
 * one another, never with golden images. `MAP_3D_SHOT=1` writes the
 * showcase screenshot `docs/screenshots/map-3d.png`.
 */

import { test, expect, type Locator, type Page, type Request } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { reseed } from "./helpers/reseed";
import { uploadEventMap, waitForStableMapPanel } from "./helpers/map-upload";
import { API_BASE } from "./helpers/api-base";
import { E2E_HEADERS, trpc } from "./helpers/print-pdf";

const DEMO = "docs/screenshots/fixtures/puit-de-laven-demo.omap";

async function openEvent(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 15_000 });
}

async function viewerWithMap(page: Page): Promise<{ viewer: Locator; canvas: Locator }> {
  const viewer = page.getByTestId("map-viewer").first();
  const upload = page.getByTestId("map-panel").first().getByRole("button", { name: "Upload map" });
  await expect(viewer.or(upload)).toBeVisible({ timeout: 60_000 });
  if (!(await viewer.isVisible())) await uploadEventMap(page);
  await waitForStableMapPanel(page);
  const v = page.getByTestId("map-viewer").first();
  const canvas = v.getByTestId("map-vector-layer");
  await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await v.scrollIntoViewIfNeeded();
  return { viewer: v, canvas };
}

/** Imports the demo map through the chunked upload and pins it to `itest`, as the map panel does. */
async function importDemoMap(): Promise<string> {
  const bytes = await readFile(DEMO);
  const init = await fetch(`${API_BASE}/api/map-uploads`, {
    method: "POST",
    headers: { ...E2E_HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ fileName: "demo.omap", bytes: bytes.byteLength, chunkBytes: bytes.byteLength }),
  });
  expect(init.status, await init.clone().text()).toBe(201);
  const { uploadId } = (await init.json()) as { uploadId: string };
  const chunk = await fetch(`${API_BASE}/api/map-uploads/${uploadId}/chunks/0`, { method: "PUT", headers: { ...E2E_HEADERS, "content-type": "application/octet-stream" }, body: bytes });
  expect(chunk.status, await chunk.clone().text()).toBe(204);
  const fin = await fetch(`${API_BASE}/api/map-uploads/${uploadId}/finalise`, { method: "POST", headers: E2E_HEADERS });
  expect(fin.status, await fin.clone().text()).toBe(200);
  const { fileHash } = (await fin.json()) as { fileHash: string };
  const applied = await trpc<{ documentHash: string | null; importJob: { state: string } }>("course.applyUploadedMap", { fileHash, fileName: "demo.omap" });
  expect(applied.importJob.state).toBe("done");
  return applied.documentHash!;
}

/** The canvas alone as pixels (buttons, SVG and scale bar hidden). */
async function canvasPixels(canvas: Locator): Promise<PNG> {
  const style = "body * { visibility: hidden !important } [data-testid='map-vector-layer'] { visibility: visible !important }";
  return PNG.sync.read(await canvas.screenshot({ style }));
}

/** Share of pixels that differ by more than `levels` in a channel. */
function differing(a: PNG, b: PNG, levels = 2): number {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > levels) n++;
  }
  return n / (a.width * a.height);
}

/** Share of non-white pixels (the map drawn, not the paper). */
function inked(p: PNG): number {
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) if (Math.min(p.data[i], p.data[i + 1], p.data[i + 2]) < 230) n++;
  return n / (p.width * p.height);
}

async function settled3d(viewer: Locator, canvas: Locator) {
  await expect(viewer).toHaveAttribute("data-view-mode", "3d", { timeout: 60_000 });
  await expect(canvas).toHaveAttribute("data-mode", "3d");
  await expect(canvas).toHaveAttribute("data-terrain-ready", "true", { timeout: 60_000 });
}

test.describe("the viewer's 3D mode", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(reseed);
  test.afterAll(reseed);

  test("a map without contours offers no 3D", async ({ page }) => {
    test.setTimeout(120_000);
    await openEvent(page);
    const { viewer } = await viewerWithMap(page);
    const meta = await page.request.get(`${API_BASE}/trpc/course.mapMetadata`, { headers: { "x-event-id": "itest" } });
    expect((await meta.json())?.result?.data?.terrain?.state).toBe("none");
    await expect(viewer.getByTestId("map-3d-toggle")).toHaveCount(0);
    await expect(viewer).toHaveAttribute("data-terrain-reason", "no-contours");
    await expect(viewer).toHaveAttribute("data-view-mode", "2d");
  });

  test("switches the demo map to 3D: orbit, north up, exaggeration, two-finger tilt, GPS, back to 2D", async ({ page }) => {
    test.setTimeout(300_000);
    const hash = await importDemoMap();
    const fieldRequests: Request[] = [], documentRequests: string[] = [];
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path === `/api/map-documents/${hash}/height.bin`) fieldRequests.push(req);
      if (path === `/api/map-documents/${hash}`) documentRequests.push(path);
    });
    await openEvent(page);
    const { viewer, canvas } = await viewerWithMap(page);
    await expect(canvas).toHaveAttribute("data-document-hash", hash);
    const toggle = viewer.getByTestId("map-3d-toggle");
    await expect(toggle).toHaveAttribute("data-state", "off");
    await expect(viewer).toHaveAttribute("data-user-bearing", "0");
    const flat = await canvasPixels(canvas);

    await test.step("enter 3D: one field request, the map draped and tilted", async () => {
      await toggle.click();
      await settled3d(viewer, canvas);
      await expect(toggle).toHaveAttribute("data-state", "on");
      await expect(viewer).toHaveAttribute("data-pitch", "45");
      await expect(viewer).toHaveAttribute("data-exaggeration", "2");
      expect(fieldRequests).toHaveLength(1);
      expect(new URL(fieldRequests[0].url()).search).toMatch(/^\?v=\d+$/);
      expect(fieldRequests[0].headers()["x-event-id"]).toBe("itest");
      const tilted = await canvasPixels(canvas);
      expect(differing(flat, tilted)).toBeGreaterThan(0.2);
      // The drape is the map: about as much ink as the 2D view, not a blank or a background.
      expect(inked(tilted)).toBeGreaterThan(inked(flat) * 0.3);
      // No 2D-only tool, no scale bar on a tilted view.
      await expect(viewer.getByRole("button", { name: "Measure distance" })).toHaveCount(0);
      if (process.env.MAP_3D_SHOT === "1") await viewer.screenshot({ path: "docs/screenshots/map-3d.png" });
    });

    await test.step("a right-drag orbits and tilts; the compass turns north up again", async () => {
      const box = (await viewer.boundingBox())!;
      const before = await canvasPixels(canvas);
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(cx + box.width / 8, cy - box.height / 10, { steps: 5 });
      await page.mouse.up({ button: "right" });
      await expect.poll(async () => Number(await viewer.getAttribute("data-pitch"))).toBeGreaterThan(45);
      expect(Number(await viewer.getAttribute("data-user-bearing"))).not.toBe(0);
      await expect(canvas).toHaveAttribute("data-terrain-ready", "true", { timeout: 60_000 });
      expect(differing(before, await canvasPixels(canvas))).toBeGreaterThan(0.05);
      await viewer.getByTestId("map-compass").click();
      await expect(viewer).toHaveAttribute("data-user-bearing", "0");
      await expect(viewer).toHaveAttribute("data-view-mode", "3d");
    });

    await test.step("the exaggeration control changes the relief", async () => {
      await expect(canvas).toHaveAttribute("data-terrain-ready", "true", { timeout: 60_000 });
      const before = await canvasPixels(canvas);
      await viewer.getByTestId("map-3d-exaggeration").fill("5");
      await expect(viewer).toHaveAttribute("data-exaggeration", "5");
      await expect(canvas).toHaveAttribute("data-terrain-ready", "true", { timeout: 60_000 });
      expect(differing(before, await canvasPixels(canvas))).toBeGreaterThan(0.01);
      await viewer.getByTestId("map-3d-exaggeration").fill("2");
      await expect(viewer).toHaveAttribute("data-exaggeration", "2");
    });

    await test.step("two fingers moving up together tilt further", async () => {
      const box = (await viewer.boundingBox())!;
      const pitch0 = Number(await viewer.getAttribute("data-pitch"));
      // Real touches (CDP), so the browser makes pointer events of them as a phone would.
      const cdp = await page.context().newCDPSession(page);
      const y0 = box.y + box.height * 0.7, xa = box.x + box.width * 0.4, xb = box.x + box.width * 0.6;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: xa, y: y0, id: 1 }, { x: xb, y: y0, id: 2 }] });
      for (let k = 1; k <= 8; k++) {
        const y = y0 - k * 6;
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: xa, y, id: 1 }, { x: xb, y, id: 2 }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await cdp.detach();
      await expect.poll(async () => Number(await viewer.getAttribute("data-pitch"))).toBeGreaterThan(pitch0);
    });

    await test.step("back to 2D: the 2D view drawn again; re-entering asks for nothing", async () => {
      // pitch and bearing do not survive; centre and zoom were not moved
      await toggle.click();
      await expect(viewer).toHaveAttribute("data-view-mode", "2d");
      await expect(canvas).toHaveAttribute("data-mode", "2d");
      await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
      await expect.poll(async () => differing(flat, await canvasPixels(canvas)), { timeout: 30_000 }).toBeLessThan(0.005);
      const docs = documentRequests.length;
      await toggle.click();
      await settled3d(viewer, canvas);
      expect(fieldRequests).toHaveLength(1);
      expect(documentRequests).toHaveLength(docs);
    });

    await test.step("a GPS fix is projected through the camera", async () => {
      const lat = Number(await viewer.getAttribute("data-center-lat"));
      const lng = Number(await viewer.getAttribute("data-center-lng"));
      await page.context().grantPermissions(["geolocation"]);
      await page.context().setGeolocation({ latitude: lat + 0.0003, longitude: lng + 0.0003, accuracy: 10 });
      await viewer.getByTestId("locate-button").click();
      const marker = viewer.getByTestId("my-location-marker");
      await expect(marker).toBeVisible({ timeout: 10_000 });
      await expect.poll(async () => Number(await viewer.getAttribute("data-center-lat")), { timeout: 10_000 }).toBeCloseTo(lat + 0.0003, 5);
      // Followed, north up: the fix lies on the camera's vertical plane through the target — on the
      // screen's vertical centre line; its height above or below the target moves it only up or down.
      const vb = (await viewer.boundingBox())!;
      const dot = (await marker.locator("circle[r='7']").boundingBox())!;
      expect(Math.abs(dot.x + dot.width / 2 - (vb.x + vb.width / 2))).toBeLessThan(1.5);
      expect(dot.y).toBeGreaterThan(vb.y);
      expect(dot.y + dot.height).toBeLessThan(vb.y + vb.height);
    });
  });

  test("a field that cannot be had leaves 2D drawn and says why", async ({ page }) => {
    test.setTimeout(120_000);
    await page.route("**/height.bin*", (route) => route.abort());
    await openEvent(page);
    const { viewer, canvas } = await viewerWithMap(page);
    const toggle = viewer.getByTestId("map-3d-toggle");
    await toggle.click();
    await expect(viewer.getByTestId("map-3d-notice")).toHaveAttribute("data-reason", "unavailable");
    await expect(viewer).toHaveAttribute("data-terrain-reason", "unavailable");
    await expect(viewer).toHaveAttribute("data-view-mode", "2d");
    await expect(canvas).toHaveAttribute("data-mode", "2d");
    await expect(toggle).toHaveAttribute("data-state", "off");
  });
});
