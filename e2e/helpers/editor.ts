/**
 * The new course editor in E2E (docs/course-editor.md §5): it has no SVG
 * hit targets — the viewer hit-tests the course layer's shapes — so tests
 * act on paper positions. The viewer mirrors every editor site as
 * `editor-site` (`data-x` / `data-y`, paper mm) and every drawn leg piece
 * as `course-leg` (`data-points`); `toPage` turns paper mm into a page
 * point through the viewer's paper view (`data-centre-x/y` in µm,
 * `data-px-per-um`, `data-rotation`), as `map-vector-layer.spec.ts` does.
 */
import { inflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { devices, expect, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { API_BASE as API } from "./api-base";
import { waitForTrpc } from "./trpc";

type Pt = { x: number; y: number };

export interface Site {
  id: string;
  code: string;
  type: string;
  mm: Pt;
}

async function paperView(page: Page) {
  const viewer = page.getByTestId("map-viewer");
  const n = async (name: string) => Number(await viewer.getAttribute(name));
  const box = await viewer.boundingBox();
  if (!box) throw new Error("map viewer has no box");
  return { centreX: await n("data-centre-x"), centreY: await n("data-centre-y"), pxPerUm: await n("data-px-per-um"), rotDeg: await n("data-rotation"), box };
}

/** Paper mm → page point. */
export async function toPage(page: Page, mm: Pt): Promise<Pt> {
  const v = await paperView(page);
  const rot = (v.rotDeg * Math.PI) / 180;
  const ix = (mm.x * 1000 - v.centreX) * v.pxPerUm, iy = -(mm.y * 1000 - v.centreY) * v.pxPerUm;
  return { x: v.box.x + v.box.width / 2 + ix * Math.cos(rot) - iy * Math.sin(rot), y: v.box.y + v.box.height / 2 + ix * Math.sin(rot) + iy * Math.cos(rot) };
}

/** Page point → paper mm (the inverse of `toPage`). */
export async function toPaper(page: Page, p: Pt): Promise<Pt> {
  const v = await paperView(page);
  const rot = (v.rotDeg * Math.PI) / 180;
  const dx = p.x - (v.box.x + v.box.width / 2), dy = p.y - (v.box.y + v.box.height / 2);
  const ix = dx * Math.cos(rot) + dy * Math.sin(rot), iy = -dx * Math.sin(rot) + dy * Math.cos(rot);
  return { x: (ix / v.pxPerUm + v.centreX) / 1000, y: (-iy / v.pxPerUm + v.centreY) / 1000 };
}

export async function sites(page: Page): Promise<Site[]> {
  return page.getByTestId("editor-site").evaluateAll((els) => els.map((el) => ({
    id: el.getAttribute("data-control-id") ?? "",
    code: el.getAttribute("data-control-code") ?? "",
    type: el.getAttribute("data-type") ?? "",
    mm: { x: Number(el.getAttribute("data-x")), y: Number(el.getAttribute("data-y")) },
  })));
}

export async function site(page: Page, code: string): Promise<Site> {
  const found = (await sites(page)).find((s) => s.code === code);
  if (!found) throw new Error(`no editor site ${code}`);
  return found;
}

/** Page point of a site by code. */
export async function sitePoint(page: Page, code: string): Promise<Pt> {
  return toPage(page, (await site(page, code)).mm);
}

/** The leg pieces drawn for a course, paper mm. */
export async function legPieces(page: Page, course?: string): Promise<{ course: string; leg: number; style: string; points: Pt[] }[]> {
  const all = await page.getByTestId("course-leg").evaluateAll((els) => els.map((el) => ({
    course: el.getAttribute("data-course") ?? "",
    leg: Number(el.getAttribute("data-leg")),
    style: el.getAttribute("data-style") ?? "",
    points: (el.getAttribute("data-points") ?? "").split(" ").filter(Boolean).map((p) => {
      const [x, y] = p.split(",").map(Number);
      return { x, y };
    }),
  })));
  return course ? all.filter((l) => l.course === course) : all;
}

async function boxes(page: Page, ids: string[]): Promise<{ x: number; y: number; width: number; height: number }[]> {
  const out = [];
  for (const id of ids) {
    const loc = page.getByTestId(id);
    for (let i = 0; i < (await loc.count()); i++) {
      const b = (await loc.nth(i).isVisible()) ? await loc.nth(i).boundingBox() : null;
      if (b) out.push(b);
    }
  }
  return out;
}

/** The drawn description sheets: their svg spans the viewer (pointer-events none), so the content's box, in page px. */
async function sheetBoxes(page: Page): Promise<{ x: number; y: number; width: number; height: number }[]> {
  return page.getByTestId("description-sheet").evaluateAll((els) => els.map((el) => {
    const svg = el as SVGSVGElement, at = svg.getBoundingClientRect(), b = svg.getBBox();
    return { x: at.x + b.x, y: at.y + b.y, width: b.width, height: b.height };
  }));
}

/**
 * A page point inside the viewer at least `clearPx` from every site and
 * every drawn leg, outside the editor's floating chrome, the description
 * sheet and the viewer's corner buttons. Scans a grid from the viewer's right half inwards.
 */
export async function emptyPoint(page: Page, clearPx = 40, avoid: Pt[] = []): Promise<Pt> {
  await viewSettled(page);
  const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
  const pts = [...(await Promise.all((await sites(page)).map((s) => toPage(page, s.mm)))), ...avoid];
  const legs = await Promise.all((await legPieces(page)).map(async (l) => Promise.all(l.points.map((p) => toPage(page, p)))));
  const chrome = [...(await boxes(page, CHROME)), ...(await sheetBoxes(page))];
  // The drawn numbers are hit targets too (`number`, §5): a click on one selects its control (D10: an "empty" point
  // 45 px from 78's circle was on its number).
  const labels = await Promise.all((await page.getByTestId("course-label").evaluateAll((els) => els.map((el) => ({
    x: Number(el.getAttribute("data-x")), y: Number(el.getAttribute("data-y")),
  })))).map((q) => toPage(page, q)));
  const segDist = (p: Pt, a: Pt, b: Pt) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  // The coarse grid of the middle band first (what callers were written against), then a dense grid over a wider
  // band, so a crowded view (many placed sites, long legs) still leaves a point (D10: "no empty map point" seen once
  // under sharded load with the coarse grid alone).
  const coarse = range(0.3, 0.75, 0.075).flatMap((gy) => range(0.35, 0.85, 0.05).reverse().map((gx) => [gx, gy] as const));
  const dense = range(0.2, 0.82, 0.025).flatMap((gy) => range(0.25, 0.88, 0.025).reverse().map((gx) => [gx, gy] as const));
  for (const [gx, gy] of [...coarse, ...dense]) {
    const p = { x: viewer.x + viewer.width * gx, y: viewer.y + viewer.height * gy };
    if (p.x > viewer.x + viewer.width - 80 && p.y > viewer.y + viewer.height - 200) continue;
    if (chrome.some((b) => p.x > b.x - 12 && p.x < b.x + b.width + 12 && p.y > b.y - 12 && p.y < b.y + b.height + 12)) continue;
    if (pts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < clearPx)) continue;
    if (labels.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < Math.min(40, Math.max(30, clearPx)))) continue;
    if (legs.some((poly) => poly.some((a, i) => i > 0 && segDist(p, poly[i - 1], a) < 20))) continue;
    return p;
  }
  throw new Error(`no empty map point found (clearance ${clearPx} px, ${pts.length} marks, ${chrome.length} chrome boxes)`);
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(v);
  return out;
}

const CHROME = ["editor-inspector", "editor-tool-rail", "editor-layout-rail", "editor-status", "editor-conflict", "editor-external-change", "editor-action-bar"];

/**
 * Click a page point on the map, failing fast when the editor's floating
 * chrome (the action bar of the current selection, the inspector…) covers
 * it — the click would land there, not on the canvas.
 */
export async function clickMap(page: Page, p: Pt): Promise<void> {
  const cover = await coveredBy(page, p);
  if (cover) throw new Error(`map point (${Math.round(p.x)}, ${Math.round(p.y)}) is covered by ${cover}`);
  await page.mouse.click(p.x, p.y);
}

/** The test id of the editor chrome over a page point (or the tag of whatever else is there), null when the map canvas is on top. */
export async function coveredBy(page: Page, p: Pt): Promise<string | null> {
  return page.evaluate(({ pt, chrome }) => {
    const el = document.elementFromPoint(pt.x, pt.y);
    const over = el?.closest(chrome.map((id) => `[data-testid="${id}"]`).join(","));
    if (over) return over.getAttribute("data-testid");
    return el?.closest('[data-testid="map-viewer"]') ? null : (el?.tagName ?? "nothing");
  }, { pt: p, chrome: CHROME });
}

/**
 * A paper point halfway along the drawn leg from site `from` to site `to`
 * of a course: the leg's pieces (auto slits cut it where it crosses other
 * circles) grouped by leg index, then the middle of its longest piece.
 */
export async function legMidpoint(page: Page, course: string, from: Pt, to: Pt): Promise<Pt> {
  const near = (q: Pt, s: Pt) => Math.hypot(q.x - s.x, q.y - s.y) < 8;
  // The mirror lags a structure write by one layer round trip (after an undo
  // the previous sequence's legs are still drawn), so wait for the leg itself,
  // not just for some pieces to exist.
  let leg: { points: Pt[] }[] | undefined;
  const deadline = Date.now() + 15000;
  for (;;) {
    const pieces = await legPieces(page, course);
    const legs = [...new Set(pieces.map((l) => l.leg))].map((idx) => pieces.filter((l) => l.leg === idx));
    leg = legs.find((ps) => near(ps[0].points[0], from) && near(ps[ps.length - 1].points.at(-1)!, to));
    if (leg || Date.now() > deadline) break;
    await page.waitForTimeout(250);
  }
  if (!leg) throw new Error("no drawn leg between the two sites");
  const length = (pts: Pt[]) => pts.reduce((sum, q, i) => (i === 0 ? 0 : sum + Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y)), 0);
  const piece = leg.map((l) => l.points).sort((x, y) => length(y) - length(x))[0];
  let rest = length(piece) / 2;
  for (let i = 1; i < piece.length; i++) {
    const a = piece[i - 1], b = piece[i], d = Math.hypot(b.x - a.x, b.y - a.y);
    if (rest <= d) return { x: a.x + ((b.x - a.x) * rest) / d, y: a.y + ((b.y - a.y) * rest) / d };
    rest -= d;
  }
  return piece[piece.length - 1];
}

/** Drag from one page point to another with intermediate moves (past the 3 px click threshold). */
export async function drag(page: Page, from: Pt, to: Pt): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

/** The editor is mounted, the course layer drawn and the sites mirrored. */
export async function editorReady(page: Page): Promise<Locator> {
  await expect(page.getByTestId("editor-page")).toBeVisible({ timeout: 15_000 });
  const viewer = page.getByTestId("map-viewer");
  await expect(viewer).toHaveAttribute("data-editor-hit", "shared", { timeout: 60_000 });
  await expect(page.getByTestId("editor-site").first()).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await viewSettled(page);
  return viewer;
}

/**
 * Wait until the viewer's paper view (centre, zoom, rotation) has not changed for `quietMs`. The editor fits the
 * view to the controls after it mounts and when a course is picked; a page point computed from the mirror before
 * the fit has settled lands elsewhere (D10 flake: an "empty" point that selected control 78, a "no empty map point"
 * under load). Returns after `timeoutMs` even if the view keeps moving (a pan the test is making itself).
 */
export async function viewSettled(page: Page, quietMs = 300, timeoutMs = 10_000): Promise<void> {
  const viewer = page.getByTestId("map-viewer");
  const read = () => viewer.evaluate((el) => ["data-centre-x", "data-centre-y", "data-px-per-um", "data-rotation"].map((a) => el.getAttribute(a)).join("|"));
  let last = await read();
  let since = Date.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(100);
    const now = await read();
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= quietMs) return;
  }
}

/** Points of the editor's UI-layer shapes (`editor-tool-layer`) by test id, paper mm. */
export async function toolShapes(page: Page, testId: string): Promise<{ x: number; y: number; data: Record<string, string> }[]> {
  return page.getByTestId("editor-tool-layer").getByTestId(testId).evaluateAll((els) => els.map((el) => ({
    x: Number(el.getAttribute("data-x")),
    y: Number(el.getAttribute("data-y")),
    data: Object.fromEntries([...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => [a.name.slice(5), a.value])),
  })));
}

/**
 * Pixels of the GL canvas inside a paper rectangle (mm), sampled every 0.1 mm, that are dark (the map's black
 * ink) or purple (the course overprint). The canvas alone is captured (the overlays hidden), as
 * `map-vector-layer.spec.ts` does.
 */
export async function inkIn(page: Page, rect: { minX: number; minY: number; maxX: number; maxY: number }, kind: InkKind = "dark"): Promise<number> {
  const points: Pt[] = [];
  for (let x = rect.minX; x <= rect.maxX; x += 0.1) for (let y = rect.minY; y <= rect.maxY; y += 0.1) points.push({ x, y });
  return inkAt(page, points, kind);
}

/**
 * `dark`: the map's black ink; `purple`: the course overprint; `map`: any map colour — not white and not
 * purple (a corridor's white band cuts the whole map away, docs/course-layer.md §10.2).
 */
export type InkKind = "dark" | "purple" | "map";

/** As `inkIn`, at a list of paper points (mm): how many distinct canvas pixels under them are of `kind`. */
export async function inkAt(page: Page, points: readonly Pt[], kind: InkKind = "dark"): Promise<number> {
  const { PNG } = await import("pngjs");
  const canvas = page.getByTestId("map-vector-layer");
  const style = "body * { visibility: hidden !important } [data-testid='map-vector-layer'] { visibility: visible !important }";
  const png = PNG.sync.read(await canvas.screenshot({ style }));
  const cb = (await canvas.boundingBox())!;
  const k = png.width / cb.width;
  // The view after the screenshot (taking it may scroll the canvas into view).
  const v = await paperView(page);
  const rot = (v.rotDeg * Math.PI) / 180;
  const seen = new Set<number>();
  let n = 0;
  for (const { x, y } of points) {
    const ix = (x * 1000 - v.centreX) * v.pxPerUm, iy = -(y * 1000 - v.centreY) * v.pxPerUm;
    const q = { x: v.box.x + v.box.width / 2 + ix * Math.cos(rot) - iy * Math.sin(rot), y: v.box.y + v.box.height / 2 + ix * Math.sin(rot) + iy * Math.cos(rot) };
    const px = Math.round((q.x - cb.x) * k), py = Math.round((q.y - cb.y) * k);
    if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
    const i = (py * png.width + px) * 4;
    if (seen.has(i)) continue;
    seen.add(i);
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const purple = r - g > 50 && b - g > 50;
    if (kind === "dark" ? Math.max(r, g, b) < 110 : kind === "purple" ? purple : !purple && Math.min(r, g, b) < 235) n++;
  }
  return n;
}

/**
 * The GL canvas inside the circle inscribed in a page box (CSS px), less `inset` px at the rim —
 * the editor's loupe (docs/course-editor.md §10 "Loupe"): its purple pixel count and the RGB of
 * every pixel in scan order (two captures of the same box compare pixel by pixel). The canvas
 * alone is captured, as in `inkIn`, so the loupe's DOM ring and crosshair do not count.
 */
export async function canvasInCircle(page: Page, box: { x: number; y: number; width: number; height: number }, inset = 4): Promise<{ purple: number; rgb: number[] }> {
  const { PNG } = await import("pngjs");
  const canvas = page.getByTestId("map-vector-layer");
  const style = "body * { visibility: hidden !important } [data-testid='map-vector-layer'] { visibility: visible !important }";
  const png = PNG.sync.read(await canvas.screenshot({ style }));
  const cb = (await canvas.boundingBox())!;
  const k = png.width / cb.width;
  const cx = (box.x + box.width / 2 - cb.x) * k, cy = (box.y + box.height / 2 - cb.y) * k, r = (box.width / 2 - inset) * k;
  let purple = 0;
  const rgb: number[] = [];
  for (let py = Math.max(0, Math.floor(cy - r)); py <= Math.min(png.height - 1, Math.ceil(cy + r)); py++) {
    for (let px = Math.max(0, Math.floor(cx - r)); px <= Math.min(png.width - 1, Math.ceil(cx + r)); px++) {
      if (Math.hypot(px - cx, py - cy) > r) continue;
      const i = (py * png.width + px) * 4;
      const red = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      rgb.push(red, g, b);
      if (red - g > 50 && b - g > 50) purple++;
    }
  }
  return { purple, rgb };
}

/** Two frames, so a React commit's GL redraw (one animation frame later) is on the canvas. */
export async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

// ─── The editor's fixture, navigation and selectors (D10: shared by every editor spec) ───────────────

/** The seeded event the editor specs use (`e2e/seed-builder`, "My example tävling"). */
export const EDITOR_EVENT = "itest";

/** The event's `nameId` from the current URL. */
export const nameIdOf = (page: Page): string => new URL(page.url()).pathname.split("/")[1];

export async function selectCompetition(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
}

export async function clickTab(page: Page, name: string): Promise<void> {
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name, exact: true }).click();
  }
}

/**
 * Courses and controls from `e2e/test.ocd` (append) and the same file as the event map — once per seed, a no-op
 * when the map is there (AGENTS §12: idempotent per test). The page must be on the event (`selectCompetition`).
 */
export async function ensureCoursesAndMap(page: Page): Promise<void> {
  await clickTab(page, "Courses");
  const uploadButton = page.getByRole("button", { name: "Upload map" });
  const viewer = page.getByTestId("map-viewer");
  await expect(uploadButton.or(viewer).first()).toBeVisible({ timeout: 60000 });
  if (!(await uploadButton.isVisible())) return;
  await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Import courses" }).click();
  const importChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await importChooser).setFiles("e2e/test.ocd");
  await expect(page.getByText("Courses and Class Assignments")).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Öppen 1" }).click();
  await page.getByRole("row", { name: /^E / }).getByRole("button", { name: "— Skip —", exact: true }).click();
  await page.getByTestId("course-import-replace-all").uncheck();
  await page.getByRole("button", { name: "Import 5 courses" }).click();
  await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Done" }).click();
  const mapChooser = page.waitForEvent("filechooser");
  await page.getByTestId("map-panel").getByRole("button", { name: "Upload map" }).click();
  await (await mapChooser).setFiles("e2e/test.ocd");
  await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
}

/** A desktop browser context of the running project (its base URL and headers), whatever the project's device. */
export async function desktopContext(browser: Browser, info: TestInfo): Promise<{ ctx: BrowserContext; page: Page }> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the browser type is the project's
  const { defaultBrowserType: _, ...desktop } = devices["Desktop Chrome"];
  const ctx = await browser.newContext({ ...desktop, baseURL: info.project.use.baseURL, extraHTTPHeaders: info.project.use.extraHTTPHeaders });
  return { ctx, page: await ctx.newPage() };
}

/** The fixture from a desktop context (the import dialog is a desktop flow); returns the event's `nameId`. */
export async function ensureFixtureFromDesktop(browser: Browser, info: TestInfo): Promise<string> {
  const { ctx, page } = await desktopContext(browser, info);
  try {
    await selectCompetition(page);
    const nameId = nameIdOf(page);
    await ensureCoursesAndMap(page);
    return nameId;
  } finally {
    await ctx.close();
  }
}

/** The event, the fixture, then the editor (`query` e.g. `?course=3`), ready. */
export async function openEditor(page: Page, query = ""): Promise<void> {
  await selectCompetition(page);
  await ensureCoursesAndMap(page);
  if (query) await page.goto(`/${nameIdOf(page)}/course-editor${query}`);
  else await clickTab(page, "Course Editor");
  await editorReady(page);
}

export const selectedCode = (page: Page): Locator => page.getByTestId("editor-selected-code");
export const selectedPosition = (page: Page): Locator => page.getByTestId("editor-selected-position");
export const controlRows = (page: Page): Locator => page.locator('[data-testid="editor-seq-row"][data-kind="control"]');
export const objectRow = (page: Page, id: string | number): Locator => page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`);

/** An object row's stored outline (`data-geometry`, paper mm). */
export async function geometryOf(row: Locator): Promise<Pt[]> {
  return ((await row.getAttribute("data-geometry")) ?? "").split(" ").filter(Boolean).map((q) => ({ x: Number(q.split(",")[0]), y: Number(q.split(",")[1]) }));
}

/** A new course from the inspector, selected, its structure loaded; returns its name (the next `reseed()` drops it). */
export async function newCourse(page: Page, prefix: string): Promise<string> {
  const name = `${prefix} ${Date.now() % 100000}`;
  await page.getByTestId("editor-new-course-name").fill(name);
  const created = waitForTrpc(page, "course.create");
  await page.getByTestId("editor-create-course").click();
  await created;
  await expect(page.getByTestId("editor-course-picker").locator("option:checked")).toHaveText(name, { timeout: 10000 });
  // A start row: an armed tool now appends to the course instead of only creating sites.
  await expect(page.locator('[data-testid="editor-seq-row"][data-kind="start"]')).toBeAttached({ timeout: 15000 });
  await viewSettled(page);
  return name;
}

/**
 * Regular (numeric-code) controls whose page points are inside the viewer, clear of the chrome and of every leg
 * drawn now: the selected course's legs are drawn over the other controls and win the hit-test (topmost first,
 * §5), so a click on a control under one is a leg click (D10 flake: the second append of a test clicked a control
 * the first append's leg ran over and got an Insert phantom), and clear of every other site's circle (E3 flake).
 * Call it again after a structure change.
 */
export async function regularCodes(page: Page, n: number, exclude: string[] = []): Promise<string[]> {
  await viewSettled(page);
  const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
  const inspector = await page.getByTestId("editor-inspector").boundingBox();
  const legs = await Promise.all((await legPieces(page)).map((l) => Promise.all(l.points.map((q) => toPage(page, q)))));
  const all = await sites(page);
  const points = await Promise.all(all.map((s) => toPage(page, s.mm)));
  const out: string[] = [];
  for (const [i, s] of all.entries()) {
    if (s.type !== "Control" || !/^\d+$/.test(s.code) || exclude.includes(s.code)) continue;
    const p = points[i];
    // Clear of every other site's circle too: an overlapping circle drawn later wins the click (E3 flake: a click
    // on 32 selected 72 after a reload redrew the sites in another order).
    if (points.some((q, j) => j !== i && Math.hypot(q.x - p.x, q.y - p.y) < 20)) continue;
    if (p.x < viewer.x + 30 || p.x > viewer.x + viewer.width - 90 || p.y < viewer.y + 30 || p.y > viewer.y + viewer.height - 30) continue;
    if (inspector && p.x < inspector.x + inspector.width + 40) continue;
    if (legs.some((poly) => poly.slice(1).some((b, i) => segDist(p, poly[i], b) < 18))) continue;
    out.push(s.code);
    if (out.length === n) break;
  }
  return out;
}

// ─── Gestures in paper terms (D10: place, select, arm, drag in mm) ────────────────────────────────────

/**
 * Select a site by a click on its circle on the canvas. An action bar left by an earlier selection (it may cover
 * the circle) is dropped first with one Escape — only then, since Escape with nothing selected drops the course (§3).
 */
export async function select(page: Page, code: string): Promise<void> {
  await expect(async () => {
    if ((await coveredBy(page, await sitePoint(page, code))) === "editor-action-bar") {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
    }
    await clickMap(page, await sitePoint(page, code));
    await expect(selectedCode(page)).toContainText(code, { timeout: 3000 });
  }).toPass({ timeout: 20000 });
}

/**
 * A value of the top bar's course-info popover (`editor-stats`, docs/course-editor.md §2; P2): opens it with the
 * button, reads `editor-stats-<row>[data-<attr>]` (null when the row is absent), closes it with the button again —
 * not Escape, which would step the editor's Escape cascade (§3) or disarm a tool.
 */
export async function statsRow(page: Page, row: string, attr: string): Promise<string | null> {
  const button = page.getByTestId("editor-stats");
  const popover = page.getByTestId("editor-stats-popover");
  if ((await popover.count()) === 0) await button.click();
  await expect(popover).toBeVisible();
  const el = popover.getByTestId(`editor-stats-${row}`);
  const value = (await el.count()) ? await el.getAttribute(`data-${attr}`) : null;
  await button.click();
  await expect(popover).toHaveCount(0);
  return value;
}

/** The map scale's denominator, from the map-info dialog's scale row (docs/course-editor.md §2, P6); Escape closes it. */
export async function mapScale(page: Page): Promise<number> {
  await page.getByTestId("editor-map-info").click();
  const dialog = page.getByTestId("editor-map-info-dialog");
  const row = dialog.getByTestId("editor-map-info-scale");
  await expect(row).toHaveAttribute("data-scale", /^\d+$/, { timeout: 15000 });
  const scale = Number(await row.getAttribute("data-scale"));
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(scale, "the map-info dialog's scale row").toBeGreaterThan(0);
  return scale;
}

/** Arm a tool by its key (`K`, `S`, `G` …): the rail shows it pressed. */
export async function arm(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key.toLowerCase());
  await expect(page.getByTestId(`editor-tool-${key.toUpperCase()}`)).toHaveAttribute("aria-pressed", "true");
}

/** With a placing tool armed: hover and click at the page point; returns the new site once the mirror has it. */
export async function place(page: Page, at: Pt): Promise<Site> {
  const before = new Set((await sites(page)).map((s) => s.id));
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  let added: Site | undefined;
  await expect.poll(async () => {
    added = (await sites(page)).find((s) => !before.has(s.id));
    return !!added;
  }, { timeout: 15000 }).toBe(true);
  return added!;
}

/** In `V`: a click on empty map, then *Add control* on the phantom; returns the new control's code (selected). */
export async function placeOneShot(page: Page, at?: Pt): Promise<string> {
  await clickMap(page, at ?? (await emptyPoint(page)));
  await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
  const created = waitForTrpc(page, "control.create");
  await page.getByTestId("editor-action-bar").getByTestId("editor-action-add").click();
  await created;
  await expect(selectedCode(page)).toBeVisible({ timeout: 15000 });
  const code = ((await selectedCode(page).textContent()) ?? "").match(/\d+/)![0];
  await expect.poll(async () => (await sites(page)).some((s) => s.code === code), { timeout: 15000 }).toBe(true);
  return code;
}

/** A drag between two paper points (mm), both turned into page points in the current view. */
export async function dragMm(page: Page, from: Pt, to: Pt): Promise<void> {
  await drag(page, await toPage(page, from), await toPage(page, to));
}

/** The viewer's paper centre (µm), what a pan moves. */
export async function viewCentre(page: Page): Promise<Pt> {
  const viewer = page.getByTestId("map-viewer");
  return { x: Number(await viewer.getAttribute("data-centre-x")), y: Number(await viewer.getAttribute("data-centre-y")) };
}

/**
 * The area-press rule (§5, §7; D12): a drag starting at the centroid of a closed outline (paper mm) pans the
 * view. Waits for the pan and returns the centre before and after; the caller asserts the object is untouched.
 */
export async function pressInside(page: Page, outline: Pt[], by?: Pt): Promise<{ before: Pt; after: Pt }> {
  const c = { x: outline.reduce((s, p) => s + p.x, 0) / outline.length, y: outline.reduce((s, p) => s + p.y, 0) / outline.length };
  const before = await viewCentre(page);
  const inside = await toPage(page, c);
  const cover = await coveredBy(page, inside);
  if (cover) throw new Error(`the area's inside (${Math.round(inside.x)}, ${Math.round(inside.y)}) is covered by ${cover}`);
  // By default 70 px towards the viewer's middle: repeated presses keep the area in view, clear of the edge chrome
  // (D10 flake: a second press from a fixed (-60, 40) started under the description sheet and panned nothing).
  const box = (await page.getByTestId("map-viewer").boundingBox())!;
  const dx = box.x + box.width / 2 - inside.x, dy = box.y + box.height / 2 - inside.y, d = Math.hypot(dx, dy) || 1;
  const step = by ?? { x: (dx / d) * 70, y: (dy / d) * 70 };
  await drag(page, inside, { x: inside.x + step.x, y: inside.y + step.y });
  await expect.poll(async () => { const now = await viewCentre(page); return Math.hypot(now.x - before.x, now.y - before.y); }, { timeout: 10000, message: "the press inside the area pans the view" }).toBeGreaterThan(0);
  return { before, after: await viewCentre(page) };
}

/**
 * A page point on a closed outline (paper mm) where a press is the outline's, not the course's: the edge midpoint
 * farthest from every site, every drawn number and every drawn leg piece.
 */
export async function pressOnEdge(page: Page, outline: Pt[]): Promise<Pt> {
  // Sites and their drawn numbers (a `number` hit selects the control, D10 flake: an edge under "32").
  const numbers = await page.getByTestId("course-label").evaluateAll((els) => els.map((el) => ({ x: Number(el.getAttribute("data-x")), y: Number(el.getAttribute("data-y")) })));
  const marks = await Promise.all([...(await sites(page)).map((s) => s.mm), ...numbers].map((mm) => toPage(page, mm)));
  const legs = await Promise.all((await legPieces(page)).map((l) => Promise.all(l.points.map((q) => toPage(page, q)))));
  const edges = await Promise.all(outline.map((v, i) => {
    const w = outline[(i + 1) % outline.length];
    return toPage(page, { x: (v.x + w.x) / 2, y: (v.y + w.y) / 2 });
  }));
  const clearance = (p: Pt) => Math.min(
    Infinity,
    ...marks.map((q) => Math.hypot(q.x - p.x, q.y - p.y)),
    ...legs.flatMap((poly) => poly.slice(1).map((b, i) => segDist(p, poly[i], b))),
  );
  return edges.sort((p, q) => clearance(q) - clearance(p))[0];
}

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** The drawn number of a site on the selected course (the `course-label` mirror), paper mm; null when not drawn. */
export async function labelOf(page: Page, siteId: string): Promise<(Pt & { text: string }) | null> {
  const label = page.locator(`[data-testid="course-label"][data-site-id="${siteId}"]`);
  if ((await label.count()) === 0) return null;
  return { x: Number(await label.getAttribute("data-x")), y: Number(await label.getAttribute("data-y")), text: (await label.getAttribute("data-text")) ?? "" };
}

/** The drawn circle cuts of a site (`course-site` `data-cuts`, compass degrees). */
export async function siteCuts(page: Page, siteId: string): Promise<{ start: number; end: number }[]> {
  const cuts = (await page.locator(`[data-testid="course-site"][data-site-id="${siteId}"]`).getAttribute("data-cuts")) ?? "";
  return cuts.split(" ").filter(Boolean).map((g) => {
    const [start, end] = g.split("-").map(Number);
    return { start, end };
  });
}

// ─── Server side: tRPC as the e2e admin, prints ───────────────────────────────────────────────────────

/** A tRPC call as the e2e admin on the editor's event, bypassing the browser. */
export async function trpcCall<T>(path: string, input: unknown, mutation = true, event = EDITOR_EVENT): Promise<T> {
  const headers = { "content-type": "application/json", "x-competition-id": event, "x-forwarded-email": "e2e-admin@oxygen.test" };
  const res = mutation
    ? await fetch(`${API}/trpc/${path}`, { method: "POST", headers, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) })
    : await fetch(`${API}/trpc/${path}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, { headers, signal: AbortSignal.timeout(20000) });
  const body = await res.text();
  expect(res.ok, body).toBe(true);
  return (JSON.parse(body) as { result: { data: T } }).result.data;
}

/** Best-effort cleanup in a `finally`: never fails or hangs the test it closes (the next `reseed()` drops the rows anyway). */
export async function cleanup(path: string, input: unknown): Promise<void> {
  try { await trpcCall(path, input); } catch { /* best effort */ }
}

// pdf-lib is the API's dependency; load it from there (as course-maps.spec.ts does).
type PdfDoc = { getPageCount(): number; getPages(): { getSize(): { width: number; height: number } }[] };
const loadPdf = (bytes: Uint8Array): Promise<PdfDoc> =>
  (createRequire(resolve(process.cwd(), "packages/api/package.json"))("pdf-lib") as { PDFDocument: { load(b: Uint8Array): Promise<PdfDoc> } }).PDFDocument.load(bytes);

/** A PDF's Flate content streams, inflated (latin1). */
export function inflatedStreams(bytes: Buffer): string[] {
  const text = bytes.toString("latin1");
  const out: string[] = [];
  for (let at = text.indexOf("stream"); at >= 0; at = text.indexOf("stream", at + 6)) {
    if (text.slice(at - 3, at) === "end") continue;
    const start = at + 6 + (text[at + 6] === "\r" ? 2 : 1);
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    try { out.push(inflateSync(bytes.subarray(start, end)).toString("latin1")); } catch { /* not Flate */ }
    at = end;
  }
  return out;
}

export interface PrintedPdf {
  pages: number;
  /** The first page's size, mm. */
  sizeMm: [number, number];
  /** Hatch passes: the PDF backend draws one (709) as a clip (`W* n`) and one stroke of separate `m … l` segments (`print/operators.ts`). */
  hatches: number;
  /** Fill paths (`m … h f*`) with a Bézier `c` among their segments (the base map has its own, so tests compare counts). */
  curvedFills: number;
  /** Every Bézier `c` operator. */
  curves: number;
}

/** A print of the event (`/api/maps/<nameId>/maps.pdf?<query>`, e.g. `allControls=1` or `maps=<seq>`), analysed. */
export async function printed(page: Page, nameId: string, query: string): Promise<PrintedPdf> {
  const res = await page.request.get(`/api/maps/${nameId}/maps.pdf?${query}`);
  expect(res.ok(), await res.text().catch(() => "")).toBe(true);
  return analysePdf(await res.body());
}

export async function analysePdf(bytes: Buffer): Promise<PrintedPdf> {
  const pdf = await loadPdf(bytes);
  const { width, height } = pdf.getPages()[0].getSize();
  let hatches = 0, curvedFills = 0, curves = 0;
  const run = /W\* n[^]*?(?:-?[\d.]+ -?[\d.]+ m -?[\d.]+ -?[\d.]+ l ){3,}-?[\d.]+ -?[\d.]+ m -?[\d.]+ -?[\d.]+ l S/g;
  for (const inflated of inflatedStreams(bytes)) {
    hatches += inflated.match(run)?.length ?? 0;
    let curved = false;
    for (const op of inflated.split(/\s+/)) {
      if (op === "c") { curved = true; curves++; }
      else if (op === "f*" || op === "f") {
        if (curved) curvedFills++;
        curved = false;
      } else if (op === "S" || op === "n" || op === "B" || op === "B*") curved = false;
    }
  }
  return { pages: pdf.getPageCount(), sizeMm: [Math.round((width * 25.4) / 72), Math.round((height * 25.4) / 72)], hatches, curvedFills, curves };
}

export type Frame = { x: number; y: number; width: number; height: number };

/** An A4 portrait template at 1:10 000 with the given map frame (page mm). */
export async function probeTemplate(name: string, frame: Frame = { x: 8, y: 8, width: 194, height: 281 }, printMarginMm = 3): Promise<{ seq: number }> {
  return trpcCall<{ seq: number }>("mapTemplate.create", {
    name: `${name} ${Date.now() % 100000}`, paper: "A4", orientation: "portrait", printScale: 10000, objects: [],
    settings: {
      printMarginMm, mapFrame: frame, description: { visible: false, x: 150, y: 12, cellSizeMm: 6 },
      appearance: { purple: "#a626ff", circleRadiusMm: 2.5, lineWidthMm: 0.35, numberHeightMm: 4 },
    },
  });
}

/** A template and an all-controls sheet on it (`maps.pdf?allControls=1`); `drop` removes both. */
export async function allControlsSheet(): Promise<{ drop: () => Promise<void> }> {
  const template = await probeTemplate("Print probe");
  const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "all_controls", templateId: template.seq });
  return {
    drop: async () => {
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
    },
  };
}

/** Layout mode's frame corners in paper mm (the UI layer's frame shape): page mm → paper mm by its affine map. */
export async function pageToPaperOf(page: Page, frame: Frame): Promise<(p: Pt) => Pt> {
  const pts = (await page.getByTestId("editor-tool-layer").getByTestId("editor-layout-frame").getAttribute("data-points"))!
    .split(" ").map((p) => { const [x, y] = p.split(",").map(Number); return { x, y }; });
  const [c0, c1, , c3] = pts;
  return (p: Pt) => {
    const u = (p.x - frame.x) / frame.width, v = (p.y - frame.y) / frame.height;
    return { x: c0.x + u * (c1.x - c0.x) + v * (c3.x - c0.x), y: c0.y + u * (c1.y - c0.y) + v * (c3.y - c0.y) };
  };
}

// ─── Two contexts (conflicts, presence) ───────────────────────────────────────────────────────────────

/**
 * Hold a page's view of other clients' writes still: `useExternalChanges` polls `competition.counterState` every
 * 5 s and, when a counter moved, invalidates the course / control queries — which re-seeds the editor's tokens
 * (D11). A conflict test needs the stale token to stay stale until its own write, so every later answer to that
 * call (alone or in a batch) carries the first one seen. The page's own writes still invalidate and re-seed.
 */
export async function freezeExternalPoll(page: Page): Promise<void> {
  let frozen: unknown;
  const procsOf = (url: URL) => decodeURIComponent(url.pathname.split("/trpc/")[1] ?? "").split(",");
  // The hold takes the first answer through the route; return only once there is one, so it predates whatever the
  // test writes next (D10 flake: B's write landed before A's next poll, which then froze the moved counters).
  const held = page.waitForResponse((r) => procsOf(new URL(r.url())).includes("competition.counterState"), { timeout: 15_000 });
  await page.route((url) => procsOf(url).includes("competition.counterState"), async (route) => {
    const res = await route.fetch();
    const at = procsOf(new URL(route.request().url())).indexOf("competition.counterState");
    const body = (await res.json().catch(() => null)) as unknown;
    if (!Array.isArray(body)) {
      if (frozen === undefined) frozen = body;
      await route.fulfill({ response: res, json: frozen });
      return;
    }
    if (frozen === undefined) frozen = body[at];
    else body[at] = frozen;
    await route.fulfill({ response: res, json: body });
  });
  await held;
}

/**
 * The drawn pieces of course `course`'s leg from `from` to `to` (paper mm, within 8 mm of the sites' centres —
 * the pieces start and end at the circles' rims), with its style; [] while the mirror does not show it.
 */
export async function legBetween(page: Page, course: string, from: Pt, to: Pt): Promise<{ leg: number; style: string; points: Pt[] }[]> {
  const near = (q: Pt | undefined, s: Pt) => !!q && Math.hypot(q.x - s.x, q.y - s.y) < 8;
  const pieces = await legPieces(page, course);
  for (const idx of new Set(pieces.map((l) => l.leg))) {
    const ps = pieces.filter((l) => l.leg === idx);
    if (near(ps[0].points[0], from) && near(ps[ps.length - 1].points.at(-1), to)) return ps;
  }
  return [];
}
