/**
 * The new course editor in E2E (docs/course-editor.md §5): it has no SVG
 * hit targets — the viewer hit-tests the course layer's shapes — so tests
 * act on paper positions. The viewer mirrors every editor site as
 * `editor-site` (`data-x` / `data-y`, paper mm) and every drawn leg piece
 * as `course-leg` (`data-points`); `toPage` turns paper mm into a page
 * point through the viewer's paper view (`data-centre-x/y` in µm,
 * `data-px-per-um`, `data-rotation`), as `map-vector-layer.spec.ts` does.
 */
import { expect, type Locator, type Page } from "@playwright/test";

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
export async function legPieces(page: Page, course?: string): Promise<{ course: string; leg: number; points: Pt[] }[]> {
  const all = await page.getByTestId("course-leg").evaluateAll((els) => els.map((el) => ({
    course: el.getAttribute("data-course") ?? "",
    leg: Number(el.getAttribute("data-leg")),
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
  const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
  const pts = [...(await Promise.all((await sites(page)).map((s) => toPage(page, s.mm)))), ...avoid];
  const legs = await Promise.all((await legPieces(page)).map(async (l) => Promise.all(l.points.map((p) => toPage(page, p)))));
  const chrome = [...(await boxes(page, CHROME)), ...(await sheetBoxes(page))];
  const segDist = (p: Pt, a: Pt, b: Pt) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  for (let gy = 0.3; gy <= 0.75; gy += 0.075) {
    for (let gx = 0.85; gx >= 0.35; gx -= 0.05) {
      const p = { x: viewer.x + viewer.width * gx, y: viewer.y + viewer.height * gy };
      if (p.x > viewer.x + viewer.width - 80 && p.y > viewer.y + viewer.height - 200) continue;
      if (chrome.some((b) => p.x > b.x - 12 && p.x < b.x + b.width + 12 && p.y > b.y - 12 && p.y < b.y + b.height + 12)) continue;
      if (pts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < clearPx)) continue;
      if (legs.some((poly) => poly.some((a, i) => i > 0 && segDist(p, poly[i - 1], a) < 20))) continue;
      return p;
    }
  }
  throw new Error("no empty map point found");
}

const CHROME = ["editor-inspector", "editor-tool-rail", "editor-status", "editor-conflict", "editor-action-bar"];

/**
 * Click a page point on the map, failing fast when the editor's floating
 * chrome (the action bar of the current selection, the inspector…) covers
 * it — the click would land there, not on the canvas.
 */
export async function clickMap(page: Page, p: Pt): Promise<void> {
  const cover = await page.evaluate(({ pt, chrome }) => {
    const el = document.elementFromPoint(pt.x, pt.y);
    const over = el?.closest(chrome.map((id) => `[data-testid="${id}"]`).join(","));
    if (over) return over.getAttribute("data-testid");
    return el?.closest('[data-testid="map-viewer"]') ? null : (el?.tagName ?? "nothing");
  }, { pt: p, chrome: CHROME });
  if (cover) throw new Error(`map point (${Math.round(p.x)}, ${Math.round(p.y)}) is covered by ${cover}`);
  await page.mouse.click(p.x, p.y);
}

/**
 * A paper point halfway along the drawn leg from site `from` to site `to`
 * of a course: the leg's pieces (auto slits cut it where it crosses other
 * circles) grouped by leg index, then the middle of its longest piece.
 */
export async function legMidpoint(page: Page, course: string, from: Pt, to: Pt): Promise<Pt> {
  const pieces = await legPieces(page, course);
  const near = (q: Pt, s: Pt) => Math.hypot(q.x - s.x, q.y - s.y) < 8;
  const legs = [...new Set(pieces.map((l) => l.leg))].map((leg) => pieces.filter((l) => l.leg === leg));
  const leg = legs.find((ps) => near(ps[0].points[0], from) && near(ps[ps.length - 1].points.at(-1)!, to));
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
  return viewer;
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
 * Dark pixels of the GL canvas inside a paper rectangle (mm), sampled every 0.1 mm: the map's black ink there.
 * The canvas alone is captured (the overlays hidden), as `map-vector-layer.spec.ts` does.
 */
export async function inkIn(page: Page, rect: { minX: number; minY: number; maxX: number; maxY: number }): Promise<number> {
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
  for (let x = rect.minX; x <= rect.maxX; x += 0.1) {
    for (let y = rect.minY; y <= rect.maxY; y += 0.1) {
      const ix = (x * 1000 - v.centreX) * v.pxPerUm, iy = -(y * 1000 - v.centreY) * v.pxPerUm;
      const q = { x: v.box.x + v.box.width / 2 + ix * Math.cos(rot) - iy * Math.sin(rot), y: v.box.y + v.box.height / 2 + ix * Math.sin(rot) + iy * Math.cos(rot) };
      const px = Math.round((q.x - cb.x) * k), py = Math.round((q.y - cb.y) * k);
      if (px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
      const i = (py * png.width + px) * 4;
      if (seen.has(i)) continue;
      seen.add(i);
      if (Math.max(png.data[i], png.data[i + 1], png.data[i + 2]) < 110) n++;
    }
  }
  return n;
}
