/**
 * The vector base layer inside `MapViewer` (docs/map-rendering.md §5.4).
 *
 * The layer is chosen by the event's switch, `events.map_pipeline`
 * (docs/map-pipeline-switch.md), set here straight in the database. Under
 * `vector` the event's pinned document is fetched once from
 * `/api/map-documents/:hash` and drawn by the WebGL2 arena path on an
 * unrotated canvas; no tile is requested; gestures move a paper-space
 * view; a GPS fix reaches the overlay through `mapGeo`; the course is
 * drawn by the GL layer in colour order with the map (lower purple under
 * black line art). Under `legacy` the viewer is today's tile viewer.
 *
 * Headless Chromium draws WebGL2 with SwiftShader, so only presence and
 * geometry are asserted, never timings.
 */

import { test, expect, type Locator, type Page, type Request } from "@playwright/test";
import { PNG } from "pngjs";
import { reseed } from "./helpers/reseed";
import { uploadEventMap, waitForStableMapPanel } from "./helpers/map-upload";
import { setMapPipeline } from "./helpers/map-pipeline";
import { API_BASE as API } from "./helpers/api-base";

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
    const atlasRequests: string[] = [];
    page.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith("/api/map-tile")) tileRequests.push(path);
      // Fetches only: under Vite dev the `?url` imports of both pages load as tiny script modules.
      if (path.includes("text-atlas.") && req.resourceType() === "fetch") atlasRequests.push(path);
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

    // MSDF text (map-rendering.md §5.2 "Text atlas"): the Latin page, not the Cyrillic one the
    // fixture's strings do not need.
    expect(atlasRequests.some((p) => p.includes("text-atlas.latin"))).toBe(true);
    expect(atlasRequests.filter((p) => p.includes("text-atlas.cyrillic"))).toEqual([]);

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

  test("the course layer draws lower purple under the map's black line art", async ({ page }) => {
    // map-rendering.md §5.4 "Overlay": where a leg crosses a black line, the crossing is black (the
    // line art is drawn after lower purple) and the leg is purple on either side of it. The fixture's
    // yellow area sits above lower purple in its own colour order, so the crossing is made on white
    // paper: two controls straddling a black path where there is no yellow.
    test.setTimeout(180_000);
    await setMapPipeline("vector");
    await openEvent(page);
    await viewerWithMap(page);
    await page.locator("nav[aria-label='Tabs']").getByRole("link", { name: "Courses", exact: true }).click();
    const viewer = page.getByTestId("map-panel").first().getByTestId("map-viewer");
    const canvas = viewer.getByTestId("map-vector-layer");
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await viewer.scrollIntoViewIfNeeded();

    type Rgb = [number, number, number];
    type Pt = { x: number; y: number };
    const isDark = ([r, g, b]: Rgb) => Math.max(r, g, b) < 120;
    // At the fitted view a 0.25 mm line is about a pixel wide: anti-aliased grey.
    const isInk = ([r, g, b]: Rgb) => Math.max(r, g, b) < 180 && Math.max(r, g, b) - Math.min(r, g, b) < 40;
    const isWhite = ([r, g, b]: Rgb) => Math.min(r, g, b) > 230;
    const isPurple = ([r, g, b]: Rgb) => r - g > 50 && b - g > 50;
    /** The canvas as pixels plus paper mm ↔ pixel through the viewer's paper view (CSS rotation included). */
    const snapshot = async () => {
      const v = await paperView(viewer);
      // The canvas alone: an element screenshot is a page clip, and the scale bar, buttons and SVG sit on top.
      const style = "body * { visibility: hidden !important } [data-testid='map-vector-layer'] { visibility: visible !important }";
      const png = PNG.sync.read(await canvas.screenshot({ style }));
      const cb = (await canvas.boundingBox())!;
      const k = png.width / cb.width;
      const rot = (v.rotDeg * Math.PI) / 180;
      const toPage = (p: Pt) => {
        const ix = (p.x * 1000 - v.centreX) * v.pxPerUm, iy = -(p.y * 1000 - v.centreY) * v.pxPerUm;
        return { x: v.box.x + v.box.width / 2 + ix * Math.cos(rot) - iy * Math.sin(rot), y: v.box.y + v.box.height / 2 + ix * Math.sin(rot) + iy * Math.cos(rot) };
      };
      const rgb = (p: Pt): Rgb | null => {
        const q = toPage(p);
        const px = Math.round((q.x - cb.x) * k), py = Math.round((q.y - cb.y) * k);
        if (px < 0 || py < 0 || px >= png.width || py >= png.height) return null;
        const i = (py * png.width + px) * 4;
        return [png.data[i], png.data[i + 1], png.data[i + 2]];
      };
      const toPaper = (px: number, py: number): Pt => {
        const q = pageToPaper(v, cb.x + px / k, cb.y + py / k);
        return { x: q.x / 1000, y: q.y / 1000 };
      };
      return { png, rgb, toPage, toPaper };
    };

    // 1. A black line with white paper 2–3 mm above and below it and line pixels 1.5 mm to either side.
    const fit = await snapshot();
    let spot: Pt | undefined;
    for (let py = 4; py < fit.png.height - 4 && !spot; py += 2) {
      for (let px = 4; px < fit.png.width - 4 && !spot; px += 2) {
        const i = (py * fit.png.width + px) * 4;
        if (!isInk([fit.png.data[i], fit.png.data[i + 1], fit.png.data[i + 2]])) continue;
        const p = fit.toPaper(px, py);
        const at = (dx: number, dy: number) => fit.rgb({ x: p.x + dx, y: p.y + dy });
        const white = [-3, -2, 2, 3].every((dy) => { const c = at(0, dy); return c && isWhite(c); });
        const sides = [-1.5, 1.5].every((dx) => [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1].some((dy) => { const c = at(dx, dy); return c && isInk(c); }));
        if (white && sides) spot = p;
      }
    }
    expect(spot, "a black line on white paper").toBeDefined();

    // 2. Course P: two controls 15 mm below and above it (beyond the circles' clearance), through the API.
    const api = async <T,>(path: string, data: unknown): Promise<T> => {
      const res = await page.request.post(`${API}/trpc/${path}`, { headers: { "content-type": "application/json", "x-event-id": "itest" }, data });
      expect(res.ok(), await res.text()).toBe(true);
      return ((await res.json()) as { result: { data: T } }).result.data;
    };
    const ids: number[] = [];
    for (const [code, dy] of [["191", -15], ["192", 15]] as const) {
      const c = await api<{ id: number }>("control.create", { codes: code, xpos: spot!.x, ypos: spot!.y + dy });
      ids.push(c.id);
    }
    await api("course.create", { name: "P", controlIds: ids });
    await page.reload();
    await waitForStableMapPanel(page);
    await page.getByRole("row").filter({ has: page.getByRole("cell", { name: "P", exact: true }) }).getByRole("checkbox").check();
    await waitForStableMapPanel(page);
    await expect(viewer).toHaveAttribute("data-course-layer", "gl", { timeout: 30_000 });
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
    await expect(viewer.locator('[data-testid="course-leg"][data-course="P"]').first()).toBeAttached({ timeout: 30_000 });
    // No course symbol is drawn by the SVG under the GL layer.
    await expect(viewer.locator('[data-testid="control-label"]')).toHaveCount(0);

    // 3. Zoomed in on the crossing (the wheel keeps it under the cursor): black there, purple 2 mm above and below.
    for (let n = 0; n < 15 && Number(await viewer.getAttribute("data-px-per-um")) < 0.02; n++) {
      const q = (await snapshot()).toPage(spot!);
      await page.mouse.move(q.x, q.y);
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(150);
    }
    await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    const near = await snapshot();
    const crossing = [-0.1, 0, 0.1].map((dy) => near.rgb({ x: spot!.x, y: spot!.y + dy }));
    expect(crossing.some((c) => c && isDark(c)), `black at the crossing: ${JSON.stringify(crossing)}`).toBe(true);
    for (const dy of [-2, 2]) {
      const c = near.rgb({ x: spot!.x, y: spot!.y + dy });
      expect(c && isPurple(c), `lower purple ${dy} mm from the crossing: ${JSON.stringify(c)}`).toBe(true);
    }
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
