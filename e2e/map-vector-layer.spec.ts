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
 * black line art, over the yellow area). Under `legacy` the viewer is today's tile viewer.
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

type Rgb = [number, number, number];
type Pt = { x: number; y: number };
const isDark = ([r, g, b]: Rgb) => Math.max(r, g, b) < 120;
// At the fitted view a 0.25 mm line is about a pixel wide: anti-aliased grey.
const isInk = ([r, g, b]: Rgb) => Math.max(r, g, b) < 180 && Math.max(r, g, b) - Math.min(r, g, b) < 40;
const isWhite = ([r, g, b]: Rgb) => Math.min(r, g, b) > 230;
const isPurple = ([r, g, b]: Rgb) => r - g > 50 && b - g > 50;
const isYellow = ([r, g, b]: Rgb) => r > 220 && g > 150 && g < 230 && b < 140;

/** The canvas as pixels plus paper mm ↔ pixel through the viewer's paper view (CSS rotation included). */
async function snapshot(viewer: Locator, canvas: Locator) {
  // The canvas alone: an element screenshot is a page clip, and the scale bar, buttons and SVG sit on top.
  const style = "body * { visibility: hidden !important } [data-testid='map-vector-layer'] { visibility: visible !important }";
  const png = PNG.sync.read(await canvas.screenshot({ style }));
  // Read the view after the screenshot: taking it scrolls the canvas into view, which moves every page coordinate.
  const v = await paperView(viewer);
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
}

/** The canvas pixel nearest the centre (in rings outward) whose colour passes `first` and paper point passes `test`, as paper mm. */
function findSpot(shot: Awaited<ReturnType<typeof snapshot>>, first: (c: Rgb) => boolean, test: (p: Pt) => boolean, firstMatch = false): Pt | undefined {
  const { width, height, data } = shot.png;
  const candidates: [number, number][] = [];
  for (let py = 4; py < height - 4; py += 2) for (let px = 4; px < width - 4; px += 2) candidates.push([px, py]);
  if (!firstMatch) candidates.sort((a, b) => Math.hypot(a[0] - width / 2, a[1] - height / 2) - Math.hypot(b[0] - width / 2, b[1] - height / 2));
  for (const [px, py] of candidates) {
    const i = (py * width + px) * 4;
    if (!first([data[i], data[i + 1], data[i + 2]])) continue;
    const p = shot.toPaper(px, py);
    if (test(p)) return p;
  }
  return undefined;
}

/** A course through two new controls, created through the API and shown alone in the viewer. */
async function showCourse(page: Page, viewer: Locator, canvas: Locator, name: string, controls: [string, Pt][]) {
  const api = async <T,>(path: string, data: unknown): Promise<T> => {
    const res = await page.request.post(`${API}/trpc/${path}`, { headers: { "content-type": "application/json", "x-event-id": "itest" }, data });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { result: { data: T } }).result.data;
  };
  const ids: number[] = [];
  for (const [code, p] of controls) ids.push((await api<{ id: number }>("control.create", { codes: code, xpos: p.x, ypos: p.y })).id);
  await api("course.create", { name, controlIds: ids });
  await page.reload();
  await waitForStableMapPanel(page);
  await page.getByRole("row").filter({ has: page.getByRole("cell", { name, exact: true }) }).getByRole("checkbox").check();
  await waitForStableMapPanel(page);
  await expect(viewer).toHaveAttribute("data-course-layer", "gl", { timeout: 30_000 });
  await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(viewer.locator(`[data-testid="course-leg"][data-course="${name}"]`).first()).toBeAttached({ timeout: 30_000 });
  // No course symbol is drawn by the SVG under the GL layer.
  await expect(viewer.locator('[data-testid="control-label"]')).toHaveCount(0);
}

/** Zoom in on a paper point with the wheel (which keeps it under the cursor) until about 20 px per mm. */
async function zoomOn(page: Page, viewer: Locator, canvas: Locator, spot: Pt) {
  for (let n = 0; n < 15 && Number(await viewer.getAttribute("data-px-per-um")) < 0.02; n++) {
    const q = (await snapshot(viewer, canvas)).toPage(spot);
    await page.mouse.move(q.x, q.y);
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(150);
  }
  await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
}

async function openCourses(page: Page) {
  await page.locator("nav[aria-label='Tabs']").getByRole("link", { name: "Courses", exact: true }).click();
  // The courses page remounts the map panel once its data arrives; a locator taken before that detaches.
  await waitForStableMapPanel(page);
  const viewer = page.getByTestId("map-panel").first().getByTestId("map-viewer");
  const canvas = viewer.getByTestId("map-vector-layer");
  await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await viewer.scrollIntoViewIfNeeded();
  return { viewer, canvas };
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
    // line art is drawn after lower purple) and the leg is purple on either side of it. The crossing is
    // made on white paper so the colour tests stay simple: two controls straddling a black path where
    // there is no yellow (lower purple is drawn over the yellow too — docs/bugfix-lower-purple-under-areas.md).
    test.setTimeout(180_000);
    await setMapPipeline("vector");
    await openEvent(page);
    await viewerWithMap(page);
    const { viewer, canvas } = await openCourses(page);

    // 1. A black line with white paper 2–3 mm above and below it and line pixels 1.5 mm to either side.
    const fit = await snapshot(viewer, canvas);
    const spot = findSpot(fit, isInk, (p) => {
      const at = (dx: number, dy: number) => fit.rgb({ x: p.x + dx, y: p.y + dy });
      const white = [-3, -2, 2, 3].every((dy) => { const c = at(0, dy); return c && isWhite(c); });
      const sides = [-1.5, 1.5].every((dx) => [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1].some((dy) => { const c = at(dx, dy); return c && isInk(c); }));
      return !!(white && sides);
    }, true);
    expect(spot, "a black line on white paper").toBeDefined();

    // 2. Course P: two controls 15 mm below and above it (beyond the circles' clearance), through the API.
    await showCourse(page, viewer, canvas, "P", [["191", { x: spot!.x, y: spot!.y - 15 }], ["192", { x: spot!.x, y: spot!.y + 15 }]]);

    // 3. Zoomed in on the crossing: black there, purple 2 mm above and below.
    await zoomOn(page, viewer, canvas, spot!);
    const near = await snapshot(viewer, canvas);
    const crossing = [-0.1, 0, 0.1].map((dy) => near.rgb({ x: spot!.x, y: spot!.y + dy }));
    expect(crossing.some((c) => c && isDark(c)), `black at the crossing: ${JSON.stringify(crossing)}`).toBe(true);
    for (const dy of [-2, 2]) {
      const c = near.rgb({ x: spot!.x, y: spot!.y + dy });
      expect(c && isPurple(c), `lower purple ${dy} mm from the crossing: ${JSON.stringify(c)}`).toBe(true);
    }
  });

  // docs/bugfix-lower-purple-under-areas.md: the fixture has no lower purple of its own; the inserted one must go
  // above its yellow, not under it (the yellow is an area colour, 03 §2.4 / Appendix B).
  test("the course layer draws lower purple over the map's yellow area", async ({ page }) => {
    test.setTimeout(180_000);
    await setMapPipeline("vector");
    await openEvent(page);
    await viewerWithMap(page);
    const { viewer, canvas } = await openCourses(page);

    // 1. A yellow spot with only yellow within 8 mm along the x axis and 2 mm across it.
    const fit = await snapshot(viewer, canvas);
    const spot = findSpot(fit, isYellow, (p) =>
      [-8, -6, -4, -2, 2, 4, 6, 8].every((dx) => [-2, 0, 2].every((dy) => { const c = fit.rgb({ x: p.x + dx, y: p.y + dy }); return !!c && isYellow(c); })));
    expect(spot, "open yellow ground").toBeDefined();

    // 2. Course Y: a 12 mm leg across it.
    await showCourse(page, viewer, canvas, "Y", [["193", { x: spot!.x - 6, y: spot!.y }], ["194", { x: spot!.x + 6, y: spot!.y }]]);

    // 3. Zoomed in: the leg is purple over the yellow, the yellow 2 mm beside it unchanged.
    await zoomOn(page, viewer, canvas, spot!);
    const near = await snapshot(viewer, canvas);
    const leg = [-0.1, 0, 0.1].map((dy) => near.rgb({ x: spot!.x, y: spot!.y + dy }));
    expect(leg.some((c) => c && isPurple(c)), `purple leg over yellow: ${JSON.stringify(leg)}`).toBe(true);
    const beside = near.rgb({ x: spot!.x, y: spot!.y + 2 });
    expect(beside && isYellow(beside), `yellow beside the leg: ${JSON.stringify(beside)}`).toBe(true);
  });

  // docs/course-layer.md §8.3: a stored, `all`-scoped course object reaches the viewer through
  // MapPanel's `courseObject.list` and is drawn by the GL course layer even with no course shown.
  test("a stored white-out course object paints the map white", async ({ page }) => {
    test.setTimeout(180_000);
    await setMapPipeline("vector");
    await openEvent(page);
    await viewerWithMap(page);
    let { viewer, canvas } = await openCourses(page);

    // 1. Open yellow ground: yellow 3 mm around a spot.
    const fit = await snapshot(viewer, canvas);
    const spot = findSpot(fit, isYellow, (p) =>
      [-3, 0, 3].every((dx) => [-3, 0, 3].every((dy) => { const c = fit.rgb({ x: p.x + dx, y: p.y + dy }); return !!c && isYellow(c); })));
    expect(spot, "open yellow ground").toBeDefined();

    // 2. A 2 mm white-out square on it, through the API.
    const sq = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([dx, dy]) => ({ x: spot!.x + dx, y: spot!.y + dy }));
    const res = await page.request.post(`${API}/trpc/courseObject.create`, {
      headers: { "content-type": "application/json", "x-event-id": "itest" },
      data: { kind: "whiteout", geometry: sq, props: {}, scope: { all: true } },
    });
    expect(res.ok(), await res.text()).toBe(true);
    const id = ((await res.json()) as { result: { data: { id: number } } }).result.data.id;
    try {
      await page.reload();
      ({ viewer, canvas } = await openCourses(page));
      await expect(viewer).toHaveAttribute("data-course-layer", "gl", { timeout: 30_000 });

      // 3. White inside the square, yellow 3 mm beside it.
      await zoomOn(page, viewer, canvas, spot!);
      await expect.poll(async () => {
        const c = (await snapshot(viewer, canvas)).rgb(spot!);
        return !!c && isWhite(c);
      }, { timeout: 30_000 }).toBe(true);
      const near = await snapshot(viewer, canvas);
      const beside = near.rgb({ x: spot!.x + 3, y: spot!.y });
      expect(beside && isYellow(beside), `yellow beside the white-out: ${JSON.stringify(beside)}`).toBe(true);
    } finally {
      await page.request.post(`${API}/trpc/courseObject.delete`, { headers: { "content-type": "application/json", "x-event-id": "itest" }, data: { id } });
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
