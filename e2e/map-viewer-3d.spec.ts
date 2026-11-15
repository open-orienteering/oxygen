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
 * Choosing the surface (H11): no DEM provider runs in the E2E stack, so the
 * descriptor's `dem` is rewritten to `ready` and the DEM fields are answered
 * from the real `contours` field (`helpers/dem-field.ts`): the anchored
 * field as the map's terrain, the switch to ground and back, the provider's
 * attribution, ground below the contour gate, ground that cannot be had,
 * and ground as the default with a GPS track shown.
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
import { insertGpsRoute } from "./helpers/gps-route";
import { DEM_PROVIDER, GLO30_PROVIDER, demFieldBytes, pendingDem, readyDem, type DemProvider } from "./helpers/dem-field";

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

/**
 * Rewrites `course.mapMetadata`'s terrain descriptor in the batched tRPC responses (the n-th answer,
 * from 0, goes through `patch`; `null` leaves it), so the gate's other rows run on the demo map.
 */
async function patchTerrainDescriptor(page: Page, patch: (terrain: Record<string, unknown>, n: number) => Record<string, unknown> | null): Promise<() => number> {
  let n = 0;
  await page.route(/\/trpc\/[^?]*course\.mapMetadata/, async (route) => {
    const res = await route.fetch();
    const procs = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/trpc\//, "")).split(",");
    const body = (await res.json()) as unknown;
    const arr = (Array.isArray(body) ? body : [body]) as { result?: { data?: { terrain?: Record<string, unknown> | null } } }[];
    const data = arr[procs.indexOf("course.mapMetadata")]?.result?.data;
    if (data?.terrain) data.terrain = patch(data.terrain, n++) ?? data.terrain;
    await route.fulfill({ response: res, json: Array.isArray(body) ? arr : arr[0] });
  });
  return () => n;
}

/**
 * Answers the DEM sources of `height.bin` (`?…&source=ground.…`, `contours.…`) with fields made from
 * the document's real `contours` field; `abortGround` fails ground's. Returns the requests seen.
 */
async function serveDemFields(page: Page, opts: { abortGround?: boolean; provider?: DemProvider } = {}): Promise<{ source: string; eventId: string | undefined }[]> {
  const asked: { source: string; eventId: string | undefined }[] = [];
  await page.route(/\/height\.bin\?.*source=/, async (route) => {
    const url = new URL(route.request().url());
    const source = url.searchParams.get("source")!;
    asked.push({ source, eventId: route.request().headers()["x-event-id"] });
    if (opts.abortGround && source.startsWith("ground.")) return route.abort();
    url.searchParams.delete("source");
    const res = await route.fetch({ url: url.toString() });
    expect(res.status()).toBe(200);
    await route.fulfill({ status: 200, contentType: "application/octet-stream", body: demFieldBytes(new Uint8Array(await res.body()), source, opts.provider) });
  });
  return asked;
}

/** Records every `data-view-mode` the viewer takes from now on (a switch must never pass through 2D). */
async function watchViewMode(viewer: Locator): Promise<() => Promise<string[]>> {
  await viewer.evaluate((el) => {
    const w = window as unknown as { __viewModes: string[] };
    w.__viewModes = [];
    new MutationObserver(() => w.__viewModes.push(el.getAttribute("data-view-mode") ?? "")).observe(el, { attributes: true, attributeFilter: ["data-view-mode"] });
  });
  return () => viewer.evaluate(() => (window as unknown as { __viewModes: string[] }).__viewModes);
}

const GROUND = `ground.${DEM_PROVIDER.id}`, ANCHORED = `contours.${DEM_PROVIDER.id}`;

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
    let { viewer, canvas } = await viewerWithMap(page);
    await expect(canvas).toHaveAttribute("data-document-hash", hash);
    // A control at the map's centre, so the UI layer has a ring to start a gesture on.
    const centre = { x: Number(await viewer.getAttribute("data-centre-x")) / 1000, y: Number(await viewer.getAttribute("data-centre-y")) / 1000 };
    await trpc("control.create", { codes: "247", xpos: centre.x + 3, ypos: centre.y + 3 });
    await page.reload();
    ({ viewer, canvas } = await viewerWithMap(page));
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
      // No 2D-only tool.
      await expect(viewer.getByRole("button", { name: "Measure distance" })).toHaveCount(0);
      // No DEM (the E2E stack enables none): the contour field, no surface choice, no attribution (H11).
      await expect(viewer).toHaveAttribute("data-surface", "map");
      await expect(viewer).toHaveAttribute("data-surface-source", "contours");
      await expect(viewer.getByTestId("map-3d-surface-choice")).toHaveCount(0);
      await expect(viewer.getByTestId("map-dem-attribution")).toHaveCount(0);
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

    await test.step("a gesture that starts on a ring of the UI layer is the 3D view's, and a click still reaches the ring", async () => {
      // The control made at the map's centre before the page opened: its transparent click target.
      const ring = viewer.locator("[data-testid='map-course-overlay-upper'] circle[fill='transparent']").first();
      await expect(ring).toBeAttached();
      const box = (await ring.boundingBox())!;
      const pitch0 = Number(await viewer.getAttribute("data-pitch"));
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down({ button: "right" });
      await page.mouse.move(cx + 60, cy - 40, { steps: 4 });
      await page.mouse.up({ button: "right" });
      // the 2D handlers would have panned; the 3D view orbits
      await expect.poll(async () => Number(await viewer.getAttribute("data-pitch"))).toBeGreaterThan(pitch0);
      expect(Number(await viewer.getAttribute("data-user-bearing"))).not.toBe(0);
      const zoom = Number(await viewer.getAttribute("data-px-per-um"));
      const r2 = (await ring.boundingBox())!;
      await page.mouse.move(r2.x + r2.width / 2, r2.y + r2.height / 2);
      await page.mouse.wheel(0, -200);
      await expect.poll(async () => Number(await viewer.getAttribute("data-px-per-um"))).toBeCloseTo(zoom * Math.pow(2, 0.15), 8);
      await expect(viewer).toHaveAttribute("data-view-mode", "3d");
      await page.mouse.wheel(0, 200);
      await viewer.getByTestId("map-compass").click();
      await expect(viewer).toHaveAttribute("data-user-bearing", "0");
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

  test("below the gate the toggle says why and stays in 2D", async ({ page }) => {
    test.setTimeout(120_000);
    await patchTerrainDescriptor(page, (t) => ({ ...t, decided: 0.796 }));
    await openEvent(page);
    const { viewer, canvas } = await viewerWithMap(page);
    const toggle = viewer.getByTestId("map-3d-toggle");
    await expect(toggle).toHaveAttribute("data-state", "unavailable");
    await expect(toggle).toHaveAttribute("aria-disabled", "true");
    await expect(toggle).toHaveAttribute("title", /80 %.*79 %/);
    await expect(viewer).toHaveAttribute("data-terrain-reason", "low-confidence");
    // aria-disabled, not disabled: a click still says why (Playwright waits on aria-disabled, so force it)
    await toggle.click({ force: true });
    await expect(viewer.getByTestId("map-3d-notice")).toHaveAttribute("data-reason", "low-confidence");
    await expect(viewer).toHaveAttribute("data-view-mode", "2d");
    await expect(canvas).toHaveAttribute("data-mode", "2d");
  });

  test("a pending descriptor: the switch fetches the field, the descriptor is read again and the gate lets 3D in", async ({ page }) => {
    test.setTimeout(120_000);
    // The first answer says the field is not derived yet; every later one is the server's.
    const answers = await patchTerrainDescriptor(page, (t, n) => (n === 0 ? { ...t, state: "pending", decided: null } : null));
    await openEvent(page);
    const { viewer, canvas } = await viewerWithMap(page);
    const toggle = viewer.getByTestId("map-3d-toggle");
    await expect(toggle).toHaveAttribute("data-state", "off");
    const before = answers();
    await toggle.click();
    await settled3d(viewer, canvas);
    expect(answers()).toBeGreaterThan(before);
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
  test("choosing the surface: the anchored map terrain, ground and back, with the provider's attribution (H11)", async ({ page }) => {
    test.setTimeout(180_000);
    await patchTerrainDescriptor(page, (t) => ({ ...t, dem: readyDem(t.url as string, 0.9) }));
    const asked = await serveDemFields(page);
    await openEvent(page);
    const { viewer, canvas } = await viewerWithMap(page);
    const toggle = viewer.getByTestId("map-3d-toggle");
    const attribution = viewer.getByTestId("map-dem-attribution");
    await expect(attribution).toHaveCount(0);

    await test.step("3D opens on the map's terrain: the DEM-anchored field, with the attribution (decision 4)", async () => {
      await toggle.click();
      await settled3d(viewer, canvas);
      await expect(viewer).toHaveAttribute("data-surface", "map");
      await expect(viewer).toHaveAttribute("data-surface-source", ANCHORED);
      await expect(viewer.getByTestId("map-3d-source-map")).toHaveAttribute("aria-pressed", "true");
      await expect(viewer.getByTestId("map-3d-source-ground")).toHaveAttribute("aria-pressed", "false");
      await expect(attribution).toBeVisible();
      await expect(attribution).toContainText("© Lantmäteriet");
      await expect(attribution).toContainText("CC BY 4.0");
      expect(asked.map((a) => a.source)).toEqual([ANCHORED]);
    });

    await test.step("ground: one request, the relief changes, the view and 3D are kept", async () => {
      const before = await canvasPixels(canvas);
      const keep = ["data-centre-x", "data-centre-y", "data-px-per-um", "data-pitch", "data-user-bearing", "data-exaggeration"];
      const view = await Promise.all(keep.map((a) => viewer.getAttribute(a)));
      const modes = await watchViewMode(viewer);
      await viewer.getByTestId("map-3d-source-ground").click();
      await expect(viewer).toHaveAttribute("data-surface-source", GROUND, { timeout: 60_000 });
      await expect(viewer).toHaveAttribute("data-surface", "ground");
      await expect(canvas).toHaveAttribute("data-terrain-ready", "true", { timeout: 60_000 });
      expect(await modes()).not.toContain("2d");
      await expect(viewer).toHaveAttribute("data-view-mode", "3d");
      expect(await Promise.all(keep.map((a) => viewer.getAttribute(a)))).toEqual(view);
      expect(differing(before, await canvasPixels(canvas))).toBeGreaterThan(0.02);
      expect(asked.map((a) => a.source)).toEqual([ANCHORED, GROUND]);
      expect(asked[1].eventId).toBe("itest");
      await expect(viewer.getByTestId("map-3d-source-ground")).toHaveAttribute("aria-pressed", "true");
      await expect(attribution).toContainText("© Lantmäteriet");
    });

    await test.step("back to the map's terrain: no request", async () => {
      await viewer.getByTestId("map-3d-source-map").click();
      await expect(viewer).toHaveAttribute("data-surface-source", ANCHORED, { timeout: 60_000 });
      await expect(viewer).toHaveAttribute("data-view-mode", "3d");
      expect(asked).toHaveLength(2);
    });

    await test.step("2D: no attribution; re-entering keeps the choice and asks nothing", async () => {
      await viewer.getByTestId("map-3d-source-ground").click();
      await expect(viewer).toHaveAttribute("data-surface-source", GROUND, { timeout: 60_000 });
      await toggle.click();
      await expect(viewer).toHaveAttribute("data-view-mode", "2d");
      await expect(attribution).toHaveCount(0);
      await expect(viewer).not.toHaveAttribute("data-surface", /.*/);
      await toggle.click();
      await settled3d(viewer, canvas);
      await expect(viewer).toHaveAttribute("data-surface-source", GROUND);
      await expect(attribution).toContainText("© Lantmäteriet");
      expect(asked).toHaveLength(2);
    });
  });

  test("ground below the contour gate opens 3D on its own; the map's terrain says why (H11 decision 6)", async ({ page }) => {
    test.setTimeout(120_000);
    // The coarse provider (answer 13): its label carries the resolution.
    await patchTerrainDescriptor(page, (t) => ({ ...t, decided: 0.5, dem: readyDem(t.url as string, 0.6, GLO30_PROVIDER) }));
    const asked = await serveDemFields(page, { provider: GLO30_PROVIDER });
    await openEvent(page);
    const { viewer, canvas } = await viewerWithMap(page);
    const toggle = viewer.getByTestId("map-3d-toggle");
    await expect(toggle).toHaveAttribute("data-state", "off");
    await toggle.click();
    await settled3d(viewer, canvas);
    const glo = `ground.${GLO30_PROVIDER.id}`;
    await expect(viewer).toHaveAttribute("data-surface-source", glo);
    await expect(viewer.getByTestId("map-3d-source-ground")).toHaveText("Ground (30 m)");
    const map = viewer.getByTestId("map-3d-source-map");
    await expect(map).toHaveAttribute("aria-disabled", "true");
    await expect(map).toHaveAttribute("title", /80 %.*50 %/);
    await map.click({ force: true });
    await expect(viewer).toHaveAttribute("data-surface-source", glo);
    await expect(viewer.getByTestId("map-dem-attribution")).toContainText("COPERNICUS");
    expect(asked.map((a) => a.source)).toEqual([glo]);
  });

  test("ground as the only surface that cannot be had: back to 2D with the reason (H11)", async ({ page }) => {
    test.setTimeout(120_000);
    await patchTerrainDescriptor(page, (t) => ({ ...t, decided: 0.5, dem: readyDem(t.url as string, 0.6) }));
    await serveDemFields(page, { abortGround: true });
    await openEvent(page);
    const { viewer, canvas } = await viewerWithMap(page);
    await viewer.getByTestId("map-3d-toggle").click();
    await expect(viewer.getByTestId("map-3d-notice")).toHaveAttribute("data-reason", "unavailable");
    await expect(viewer).toHaveAttribute("data-view-mode", "2d");
    await expect(canvas).toHaveAttribute("data-mode", "2d");
  });

  test("a pending DEM: no ground offered; entering 3D asks for it once, which queues its job (H11)", async ({ page }) => {
    test.setTimeout(120_000);
    await patchTerrainDescriptor(page, (t) => ({ ...t, dem: pendingDem(t.url as string) }));
    const asked = await serveDemFields(page);
    await openEvent(page);
    const { viewer, canvas } = await viewerWithMap(page);
    const toggle = viewer.getByTestId("map-3d-toggle");
    expect(asked).toHaveLength(0);
    await toggle.click();
    await settled3d(viewer, canvas);
    await expect(viewer).toHaveAttribute("data-surface-source", "contours");
    await expect(viewer.getByTestId("map-3d-surface-choice")).toHaveCount(0);
    await expect.poll(() => asked.map((a) => a.source)).toEqual([GROUND]);
    expect(asked[0].eventId).toBe("itest");
    await toggle.click();
    await expect(viewer).toHaveAttribute("data-view-mode", "2d");
    await toggle.click();
    await settled3d(viewer, canvas);
    expect(asked).toHaveLength(1);
  });

  test("ground that cannot be had: 3D stays on the map's terrain and says why; the plain field carries no attribution (H11)", async ({ page }) => {
    test.setTimeout(120_000);
    // No decided share for the anchored field: the map's terrain is the plain `contours` field.
    await patchTerrainDescriptor(page, (t) => ({ ...t, dem: readyDem(t.url as string, null) }));
    await serveDemFields(page, { abortGround: true });
    await openEvent(page);
    const { viewer, canvas } = await viewerWithMap(page);
    await viewer.getByTestId("map-3d-toggle").click();
    await settled3d(viewer, canvas);
    await expect(viewer).toHaveAttribute("data-surface-source", "contours");
    await expect(viewer.getByTestId("map-dem-attribution")).toHaveCount(0);
    const modes = await watchViewMode(viewer);
    await viewer.getByTestId("map-3d-source-ground").click();
    await expect(viewer.getByTestId("map-3d-notice")).toHaveAttribute("data-reason", "ground-unavailable");
    await expect(canvas).toHaveAttribute("data-terrain-ready", "true", { timeout: 60_000 });
    expect(await modes()).not.toContain("2d");
    await expect(viewer).toHaveAttribute("data-view-mode", "3d");
    await expect(viewer).toHaveAttribute("data-surface-source", "contours");
    await expect(viewer.getByTestId("map-3d-source-map")).toHaveAttribute("aria-pressed", "true");
    await expect(viewer.getByTestId("map-dem-attribution")).toHaveCount(0);
  });

  test("a GPS track on the Tracks page is drawn on the terrain (H8)", async ({ page }) => {
    test.setTimeout(240_000);
    // The demo map (a re-import when the earlier test pinned it already: the same document).
    const hash = await importDemoMap();
    // The wide screen's map pane: the Tracks page drives it through MapSlot (no inline map).
    await page.setViewportSize({ width: 2400, height: 1200 });
    await page.goto("/itest/tracks");
    const pane = page.getByTestId("map-pane");
    await expect(pane).toHaveAttribute("data-visible", "true", { timeout: 15_000 });
    const viewer = pane.getByTestId("map-viewer");
    const canvas = viewer.getByTestId("map-vector-layer");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-document-hash", hash);
    // A zig-zag of ten fixes through the map's centre (≈ 200 m across), then the page again to list it.
    const lat = Number(await viewer.getAttribute("data-center-lat")), lng = Number(await viewer.getAttribute("data-center-lng"));
    const fixes = Array.from({ length: 10 }, (_, i) => ({ lat: lat - 0.0009 + i * 0.0002, lng: lng + (i % 2 ? 0.0006 : -0.0006) }));
    const routeId = await insertGpsRoute("itest", fixes);
    await page.reload();
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    const row = page.locator(`[data-testid="track-row"][data-route-id="${routeId}"]`);

    /**
     * Route-red (#e6194b at 0.8 over the map): red well above green, and blue not below green — the
     * map's brown contours and orange fields have blue well below green.
     */
    const isRoute = (png: PNG, i: number) => png.data[i] > 150 && png.data[i] - png.data[i + 1] > 100 && png.data[i + 2] >= png.data[i + 1] - 5;
    const routePixels = (png: PNG) => {
      let n = 0;
      for (let i = 0; i < png.data.length; i += 4) if (isRoute(png, i)) n++;
      return n;
    };

    await test.step("2D: the SVG path", async () => {
      await row.click();
      await expect(viewer.getByTestId("gps-route")).toHaveCount(1);
      await expect(viewer.getByTestId("gps-route-3d")).toHaveCount(0);
      await expect(canvas).not.toHaveAttribute("data-terrain-lines", /.*/);
    });

    await test.step("3D: drawn by the GL frame on the terrain, no SVG path", async () => {
      await viewer.getByTestId("map-3d-toggle").click();
      await settled3d(viewer, canvas);
      await expect(canvas).toHaveAttribute("data-terrain-lines", "1");
      await expect(viewer.getByTestId("gps-route")).toHaveCount(0);
      const mirror = viewer.getByTestId("gps-route-3d");
      await expect(mirror).toHaveCount(1);
      const png = await canvasPixels(canvas);
      // At the route's projected points (the mirror, CSS px = canvas px at DPR 1) the canvas is
      // route-red, on or just above the point: the line is raised by its half width (§5.6 "Lines").
      const pts = (await mirror.getAttribute("data-points"))!.split(" ").map((p) => p.split(",").map(Number));
      expect(pts.length).toBeGreaterThanOrEqual(10);
      const onLine = pts.filter(([x, y]) => {
        for (let dy = -10; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const px = Math.round(x) + dx, py = Math.round(y) + dy;
            if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
            if (isRoute(png, (py * png.width + px) * 4)) return true;
          }
        return false;
      });
      expect(onLine.length / pts.length).toBeGreaterThan(0.7);
      const withRoute = routePixels(png);
      expect(withRoute).toBeGreaterThan(300);

      // Collapsing the row takes the route away: the same 3D view without it has (almost) no route-red.
      await row.click();
      await expect(canvas).toHaveAttribute("data-terrain-lines", "0");
      await expect(canvas).toHaveAttribute("data-terrain-ready", "true", { timeout: 60_000 });
      expect(routePixels(await canvasPixels(canvas))).toBeLessThan(withRoute / 10);
      await row.click();
      await expect(canvas).toHaveAttribute("data-terrain-lines", "1");
      if (process.env.MAP_3D_SHOT === "1") await viewer.screenshot({ path: "docs/screenshots/map-3d-track.png" });
    });

    await test.step("back to 2D: the SVG path again", async () => {
      await viewer.getByTestId("map-3d-toggle").click();
      await expect(viewer).toHaveAttribute("data-view-mode", "2d");
      await expect(viewer.getByTestId("gps-route")).toHaveCount(1);
      await expect(viewer.getByTestId("gps-route-3d")).toHaveCount(0);
      await expect(canvas).not.toHaveAttribute("data-terrain-lines", /.*/);
    });
  });

  test("with a GPS track shown, 3D opens on ground and the track lies on it (H11 decision 5)", async ({ page }) => {
    test.setTimeout(180_000);
    await patchTerrainDescriptor(page, (t) => ({ ...t, dem: readyDem(t.url as string, 0.9) }));
    const asked = await serveDemFields(page);
    await page.setViewportSize({ width: 2400, height: 1200 });
    await page.goto("/itest/tracks");
    const pane = page.getByTestId("map-pane");
    await expect(pane).toHaveAttribute("data-visible", "true", { timeout: 15_000 });
    const viewer = pane.getByTestId("map-viewer");
    const canvas = viewer.getByTestId("map-vector-layer");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    // Two runners' tracks through the map's centre (the event's routes go with the reseed after the file).
    const lat = Number(await viewer.getAttribute("data-center-lat")), lng = Number(await viewer.getAttribute("data-center-lng"));
    const zigzag = (dx: number) => Array.from({ length: 10 }, (_, i) => ({ lat: lat - 0.0009 + i * 0.0002, lng: lng + dx + (i % 2 ? 0.0006 : -0.0006) }));
    const ids = [await insertGpsRoute("itest", zigzag(0)), await insertGpsRoute("itest", zigzag(0.0004))];
    await page.reload();
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    const row = (id: number) => page.locator(`[data-testid="track-row"][data-route-id="${id}"]`);
    await row(ids[0]).click();
    await expect(viewer.getByTestId("gps-route")).toHaveCount(1);
    await viewer.getByTestId("map-3d-toggle").click();
    await settled3d(viewer, canvas);
    await expect(viewer).toHaveAttribute("data-surface-source", GROUND);
    await expect(canvas).toHaveAttribute("data-terrain-lines", "1");
    await expect(viewer.getByTestId("map-dem-attribution")).toContainText("© Lantmäteriet");
    expect(asked.map((a) => a.source)).toEqual([GROUND]);
    // The map's terrain on request: the track re-lifted onto it, still in 3D.
    await viewer.getByTestId("map-3d-source-map").click();
    await expect(viewer).toHaveAttribute("data-surface-source", ANCHORED, { timeout: 60_000 });
    await expect(canvas).toHaveAttribute("data-terrain-lines", "1");
    await expect(viewer).toHaveAttribute("data-view-mode", "3d");
    // The next runner: the previous track stays until the next is in, so the choice and 3D hold.
    const mirror = viewer.getByTestId("gps-route-3d");
    const firstPoints = await mirror.getAttribute("data-points");
    const modes = await watchViewMode(viewer);
    const surfaces: string[] = [];
    await viewer.evaluate((el) => {
      const w = window as unknown as { __surfaces: string[] };
      w.__surfaces = [];
      new MutationObserver(() => w.__surfaces.push(el.getAttribute("data-surface-source") ?? "")).observe(el, { attributes: true, attributeFilter: ["data-surface-source"] });
    });
    await row(ids[1]).click();
    await expect(page.locator(`[data-testid="track-row"][data-route-id="${ids[1]}"] + tr`)).toBeVisible();
    await expect(canvas).toHaveAttribute("data-terrain-lines", "1");
    await expect(canvas).toHaveAttribute("data-terrain-ready", "true", { timeout: 60_000 });
    surfaces.push(...(await viewer.evaluate(() => (window as unknown as { __surfaces: string[] }).__surfaces)));
    expect(surfaces.filter((x) => x !== ANCHORED)).toEqual([]);
    expect(await modes()).not.toContain("2d");
    await expect(viewer).toHaveAttribute("data-surface-source", ANCHORED);
    expect(asked.map((a) => a.source)).toEqual([GROUND, ANCHORED]);
    // The second runner's track replaced the first (the mirror's projected points moved with it).
    await expect(mirror).toHaveCount(1);
    await expect(mirror).not.toHaveAttribute("data-points", firstPoints!);
  });
});
