/**
 * The terrain mesh, camera and shading on the dev page
 * (docs/map-rendering.md §5.6, `/dev/map-terrain`): a synthetic field drawn
 * by `TerrainRenderer` in headless Chromium, read back through
 * `canvas.toDataURL` and probed at points projected by the page's own
 * camera (`window.__mapTerrain.project`). The expected values are
 * analytic — §5.6's shading on the dev cone — not a golden image: no
 * reference raster exists for 3D.
 *
 * The last block (H6, §5.6 "Drape layers" … "Settling") drapes the course fixture document — a map
 * line and a four-control course — through a real `MapGlEngine` (`?doc=course`): the map and the
 * course are rendered into the drape layers over the camera's footprint, then the mesh.
 */

import { test, expect, type Page } from "@playwright/test";
import { PNG } from "pngjs";

/** The dev cone (`map-gl/terrain/synthetic.ts`): apex at paper (26.1, 36.1) mm, radius 12 mm, ground slope 1 : 4. */
const CONE = { x: 10 + 80.5 * 0.2, y: 20 + 80.5 * 0.2, radiusMm: 12, slope: 0.25 };
/** §5.6 shading at a slope tan θ: sin θ + cos θ facing the north-west light, cos θ − sin θ away from it, 1 flat. */
const TH = Math.atan(CONE.slope);
const GREY = 128;
const FACING = GREY * (Math.sin(TH) + Math.cos(TH)); // 155.2
const AWAY = GREY * (Math.cos(TH) - Math.sin(TH)); // 93.1
const TOLERANCE = 10;
/** §5.6 shading of a slope facing south at tan θ = g (the light's direction (−½, ½, √½)). */
const southShade = (g: number) => Math.min(Math.max((-g * 0.5 + Math.SQRT1_2) / Math.hypot(g, 1) / Math.SQRT1_2, 0.4), 1.25);
/** The checker's colours (`map-gl/terrain/synthetic.ts` `CHECKER`), 2 mm squares, a where ⌊x/2⌋ + ⌊y/2⌋ is even. */
const CHECKER_A = [0xe8, 0xd8, 0xa0], CHECKER_B = [0x3a, 0x6e, 0xa5];

type Api = {
  stats: { chunks: number; culled: number; triangles: number; draws: number; perLevel: number[] } | null;
  project: (x: number, y: number) => [number, number] | null;
  lastPick: { x: number; y: number; data: boolean } | null;
};

async function open(page: Page, query: string) {
  await page.goto(`/dev/map-terrain?${query}`);
  const canvas = page.getByTestId("map-terrain-canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  return canvas;
}

async function pixels(page: Page): Promise<PNG> {
  const url = await page.getByTestId("map-terrain-canvas").evaluate((c) => (c as HTMLCanvasElement).toDataURL("image/png"));
  return PNG.sync.read(Buffer.from(url.split(",")[1], "base64"));
}

/** Mean RGB over a 5 × 5 block round canvas px (x, y). */
function probe(png: PNG, x: number, y: number): number[] {
  const s = [0, 0, 0];
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const i = ((Math.round(y) + dy) * png.width + Math.round(x) + dx) * 4;
      for (let c = 0; c < 3; c++) s[c] += png.data[i + c] / 25;
    }
  return s;
}

const project = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => (window as unknown as { __mapTerrain: Api }).__mapTerrain.project(px, py), [x, y] as const);
const stats = (page: Page) => page.evaluate(() => (window as unknown as { __mapTerrain: Api }).__mapTerrain.stats);

const expectGrey = (rgb: number[], value: number) => {
  for (const c of rgb) expect(Math.abs(c - value), `channel ${c.toFixed(1)} vs ${value.toFixed(1)}`).toBeLessThanOrEqual(TOLERANCE);
};

test.describe("terrain dev page (map-rendering.md §5.6)", () => {
  test("a lit cone: the flank facing the light brighter than flat ground, the far flank darker, by §5.6's shading", async ({ page }) => {
    await open(page, "field=cone&texture=grey&pitch=0&e=1");
    const png = await pixels(page);
    const d = 6 / Math.SQRT2; // half the radius, along the diagonals
    const facing = probe(png, ...(await project(page, CONE.x - d, CONE.y + d))!);
    const away = probe(png, ...(await project(page, CONE.x + d, CONE.y - d))!);
    const flat = probe(png, ...(await project(page, CONE.x + 10, CONE.y + 10))!);
    expectGrey(facing, FACING);
    expectGrey(away, AWAY);
    expectGrey(flat, GREY);
    expect(facing[0]).toBeGreaterThan(flat[0]);
    expect(flat[0]).toBeGreaterThan(away[0]);
    const s = (await stats(page))!;
    expect(s.draws).toBeGreaterThan(0);
    expect(s.draws).toBeLessThanOrEqual(7);
  });

  test("the checker drape at pitch 60: adjacent squares on flat ground show both colours unshaded", async ({ page }) => {
    await open(page, "field=cone&texture=checker&pitch=60&e=2");
    const png = await pixels(page);
    // squares (24–26, 22–24) → b and (26–28, 22–24) → a, south of the cone, facing the camera
    const b = probe(png, ...(await project(page, 25, 23))!);
    const a = probe(png, ...(await project(page, 27, 23))!);
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(b[c] - CHECKER_B[c])).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(a[c] - CHECKER_A[c])).toBeLessThanOrEqual(TOLERANCE);
    }
    // the apex stands above its own foot: projected higher on screen than the ground point under it would be at z = 0
    const apex = (await project(page, CONE.x, CONE.y))!;
    const south = (await project(page, CONE.x, CONE.y - CONE.radiusMm))!;
    expect(apex[1]).toBeLessThan(south[1]);
  });

  test("the mesh is lifted and the exaggeration reaches the shader: a south-flank point shows its own slope at e = 2 and e = 1", async ({ page }) => {
    // 3 mm south of the apex, at pitch 60 looking north. A flat mesh would put the north flank (≈ 146–155) under
    // this point's projection; a shader ignoring e would show the e = 1 value at e = 2.
    const at = { x: CONE.x, y: CONE.y - 3 };
    for (const e of [2, 1]) {
      await open(page, `field=cone&texture=grey&pitch=60&e=${e}`);
      const png = await pixels(page);
      expectGrey(probe(png, ...(await project(page, at.x, at.y))!), GREY * southShade(CONE.slope * e)); // 74.0, 102.2
    }
  });

  test("outside the drape the background colour stands in for it, shaded like it", async ({ page }) => {
    // drape=half: the grey drape covers the field's west half (x < 26.1 mm); magenta beyond
    await open(page, "field=cone&texture=grey&drape=half&bg=ff00ff&pitch=0&e=1");
    const png = await pixels(page);
    expectGrey(probe(png, ...(await project(page, 12, 24))!), GREY);
    const flat = probe(png, ...(await project(page, 40, 24))!);
    const d = 6 / Math.SQRT2;
    const away = probe(png, ...(await project(page, CONE.x + d, CONE.y - d))!);
    const awayShade = Math.cos(TH) - Math.sin(TH);
    for (const [rgb, k] of [[flat, 1], [away, awayShade]] as const) {
      expect(Math.abs(rgb[0] - 255 * k)).toBeLessThanOrEqual(TOLERANCE);
      expect(rgb[1]).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(rgb[2] - 255 * k)).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  test("no cracks between levels: no background inside the field's outline, and auto LOD close to full detail", async ({ page }) => {
    const query = "field=noise&texture=grey&pitch=60&e=4&bg=ff00ff&w=800&h=600";
    await open(page, `${query}&lod=auto`);
    const s = (await stats(page))!;
    expect(s.perLevel.filter((n) => n > 0).length, `levels ${s.perLevel.join("/")}`).toBeGreaterThan(1);
    const auto = await pixels(page);
    // the noise field's outer cell centres, 300 × 200 cells of 0.2 mm from (0, 0); its border lies at z = 0
    const corners = await Promise.all([[0.1, 0.1], [59.9, 0.1], [59.9, 39.9], [0.1, 39.9]].map(([x, y]) => project(page, x, y)));
    const poly = corners.map((c) => c!);
    const inside = (x: number, y: number) => {
      // ≥ 3 px inside every edge of the (convex) projected outline
      for (let i = 0; i < 4; i++) {
        const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % 4];
        const cross = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / Math.hypot(bx - ax, by - ay);
        if (cross > -3) return false; // the outline runs clockwise on screen (y down)
      }
      return true;
    };
    let tested = 0, magenta = 0;
    for (let y = 0; y < auto.height; y++)
      for (let x = 0; x < auto.width; x++) {
        if (!inside(x, y)) continue;
        tested++;
        const i = (y * auto.width + x) * 4;
        if (auto.data[i] > 200 && auto.data[i + 1] < 80 && auto.data[i + 2] > 200) magenta++;
      }
    expect(tested).toBeGreaterThan(50_000);
    expect(magenta).toBe(0);

    await open(page, `${query}&lod=0`);
    const full = await pixels(page);
    let differ = 0;
    for (let i = 0; i < full.data.length; i += 4)
      if (Math.max(Math.abs(full.data[i] - auto.data[i]), Math.abs(full.data[i + 1] - auto.data[i + 1]), Math.abs(full.data[i + 2] - auto.data[i + 2])) > 16) differ++;
    expect(differ / (full.width * full.height)).toBeLessThanOrEqual(0.02);
  });

  test("a click picks the terrain point under the cursor", async ({ page }) => {
    const canvas = await open(page, "field=cone&texture=checker&pitch=45&bearing=20&e=2");
    const target = { x: CONE.x - 2, y: CONE.y - 5 };
    const [px, py] = (await project(page, target.x, target.y))!;
    await canvas.click({ position: { x: px, y: py } });
    await expect(canvas).toHaveAttribute("data-pick", /,/);
    const hit = await page.evaluate(() => (window as unknown as { __mapTerrain: Api }).__mapTerrain.lastPick);
    expect(hit!.data).toBe(true);
    expect(Math.hypot(hit!.x - target.x, hit!.y - target.y)).toBeLessThan(0.2);
  });
});

/** The course fixture (`map-gl/fixtures/course-document.ts`) and its field (`synthetic.ts` `docField`): paper mm. */
const DOC = { cone: { x: 35, y: 25, radiusMm: 22, heightM: 45, groundMPerMm: 15 }, blackLine: { x: 25, y: 5 }, leg3132: { x: 50, y: 25 }, control32: { x: 60, y: 40 } };

type DocApi = {
  frame: { mesh: { draws: number; matrix: Float32Array } | null } | null;
  engineStats: () => { terrain?: { drapeRenders: number; drapeBytes: number; fieldBytes: number; layers: { role: string; widthPx: number; heightPx: number; pxPerUm: number; ratio: number }[] } };
  project: (x: number, y: number) => [number, number] | null;
  setCamera: (c: { xMm?: number; yMm?: number; pitch?: number; bearing?: number; zoom?: number }) => void;
  compare2d: () => { maxDiff: number; over: number; pixels: number };
  courseRgb: [number, number, number];
};
const docProject = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => (window as unknown as { __mapTerrainDoc: DocApi }).__mapTerrainDoc.project(px, py), [x, y] as const);
const terrainStats = (page: Page) => page.evaluate(() => (window as unknown as { __mapTerrainDoc: DocApi }).__mapTerrainDoc.engineStats().terrain!);
/** The course's purple, shaded or not: blue and red well above green. */
const isPurple = (r: number, g: number, b: number) => b > g + 60 && r > g + 40;

/** Purple pixels in a (2k+1)² window round (x, y), or over the whole canvas. */
function purpleIn(png: PNG, at?: [number, number], k = 4): number {
  let n = 0;
  const [x0, x1, y0, y1] = at ? [Math.round(at[0]) - k, Math.round(at[0]) + k, Math.round(at[1]) - k, Math.round(at[1]) + k] : [0, png.width - 1, 0, png.height - 1];
  for (let y = Math.max(0, y0); y <= Math.min(png.height - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(png.width - 1, x1); x++) {
      const i = (y * png.width + x) * 4;
      if (isPurple(png.data[i], png.data[i + 1], png.data[i + 2])) n++;
    }
  return n;
}

test.describe("the map as the drape (map-rendering.md §5.6, H6)", () => {
  test("at pitch 0 over flat ground the 3D frame is the 2D frame (the hand-over)", async ({ page }) => {
    const compare = () => page.evaluate(() => (window as unknown as { __mapTerrainDoc: DocApi }).__mapTerrainDoc.compare2d());
    await open(page, "doc=course&field=flat&pitch=0&bearing=0&e=1");
    let c = await compare();
    expect(c.pixels).toBe(800 * 600);
    // North up, the drape's texels lie on the pixels: the same picture. On a GPU it is exact (max 1
    // level); SwiftShader resolves the canvas's and a framebuffer's 4× MSAA a little differently, so
    // antialiased edge pixels may differ by a few levels — half a texel off would cost 100+ on every edge.
    expect(c.maxDiff).toBeLessThanOrEqual(10);
    expect(c.over / c.pixels).toBeLessThan(0.005);
    const t = await terrainStats(page);
    expect(t.layers).toHaveLength(1);
    expect(t.layers[0].ratio).toBeCloseTo(1, 6);
    // turned, the texel grid is turned against the pixels: a bilinear resample, edges only
    await open(page, "doc=course&field=flat&pitch=0&bearing=25&e=1");
    c = await compare();
    expect(c.over / c.pixels).toBeLessThan(0.01);
  });

  test("tilted over a cone: the course and the map draped, the paper shaded by the slope", async ({ page }) => {
    await open(page, "doc=course&field=cone&pitch=60&bearing=0&e=2&zoom=1.2");
    const png = await pixels(page);
    // the leg from 31 to 32 runs over the cone's east flank
    expect(purpleIn(png, (await docProject(page, DOC.leg3132.x, DOC.leg3132.y))!)).toBeGreaterThan(0);
    // the map's black line on flat ground
    const [bx, by] = (await docProject(page, DOC.blackLine.x, DOC.blackLine.y))!;
    let darkest = 255;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const i = ((Math.round(by) + dy) * png.width + Math.round(bx) + dx) * 4;
        darkest = Math.min(darkest, Math.max(png.data[i], png.data[i + 1], png.data[i + 2]));
      }
    expect(darkest).toBeLessThan(60);
    // paper white 10 mm south of the apex: a slope of 45 m in 22 mm at 1:15 000, × 2, facing south
    const g = (DOC.cone.heightM / (DOC.cone.radiusMm * DOC.cone.groundMPerMm)) * 2;
    expectGrey(probe(png, ...(await docProject(page, DOC.cone.x, DOC.cone.y - 10))!), 255 * southShade(g));
    const t = await terrainStats(page);
    expect(t.drapeRenders).toBeGreaterThan(0);
    expect(t.fieldBytes).toBe(500 * 400 * 5);
    const draws = await page.evaluate(() => (window as unknown as { __mapTerrainDoc: DocApi }).__mapTerrainDoc.frame!.mesh!.draws);
    expect(draws).toBeGreaterThan(0);
    expect(draws).toBeLessThanOrEqual(7);
  });

  test("the drape follows the camera once it has settled, not while it moves", async ({ page }) => {
    await open(page, `doc=course&field=cone&pitch=0&e=1&zoom=4&x=10&y=10`);
    const before = (await terrainStats(page)).drapeRenders;
    // to control 32, outside the drape rendered round the start; the frame read in the same task, so
    // the settle timer (DRAPE_SETTLE_MS, 150 ms) cannot re-render the drape before it is read — a
    // second round trip took longer than that on a busy CI runner
    const moved = await page.evaluate(({ x, y }) => {
      const api = (window as unknown as { __mapTerrainDoc: DocApi }).__mapTerrainDoc;
      api.setCamera({ xMm: x, yMm: y });
      const url = (document.querySelector('[data-testid="map-terrain-canvas"]') as HTMLCanvasElement).toDataURL("image/png");
      return { renders: api.engineStats().terrain!.drapeRenders, url };
    }, DOC.control32);
    expect(moved.renders).toBe(before);
    // the old drape does not reach: shaded background only
    expect(purpleIn(PNG.sync.read(Buffer.from(moved.url.split(",")[1], "base64")))).toBe(0);
    await expect.poll(async () => (await terrainStats(page)).drapeRenders, { timeout: 5_000 }).toBeGreaterThan(before);
    await expect.poll(async () => purpleIn(await pixels(page)), { timeout: 5_000 }).toBeGreaterThan(200);
  });

  test("split by need: a near layer over the near ground, a coarser far one, and the budget's third never exceeded", async ({ page }) => {
    // close to the cone and tilted: the screen's bottom edge needs far more texels than its top
    const query = "doc=course&field=cone&pitch=60&bearing=0&e=2&zoom=6&x=46&y=19";
    await open(page, query);
    let t = await terrainStats(page);
    expect(t.layers.map((l) => l.role)).toEqual(["near", "far"]);
    expect(t.layers[0].pxPerUm).toBeGreaterThan(t.layers[1].pxPerUm * 1.5);
    // the club budget's third is room enough here: each at what its ground needs
    for (const l of t.layers) expect(l.ratio).toBeCloseTo(1, 6);
    const texels = (layers: { widthPx: number; heightPx: number }[]) => layers.reduce((n, l) => n + l.widthPx * l.heightPx, 0);
    expect(texels(t.layers)).toBeLessThanOrEqual((150 * 1024 * 1024) / 3 / (16 / 3));
    // the leg from 31 to 32 at the camera's target, drawn from the near layer
    expect(purpleIn(await pixels(page), (await docProject(page, 46, 19))!)).toBeGreaterThan(20);
    // a 2 MB budget: the drape shrinks to its third and is still drawn
    await open(page, `${query}&budget=2`);
    t = await terrainStats(page);
    expect(t.layers.length).toBeGreaterThan(0);
    expect(texels(t.layers)).toBeLessThanOrEqual((2 * 1024 * 1024) / 3 / (16 / 3));
    expect(t.drapeBytes).toBeLessThanOrEqual((2 * 1024 * 1024) / 3);
  });
});

test.describe("lines on the terrain (map-rendering.md §5.6 \"Lines\", H8)", () => {
  type LineApi = DocApi & {
    frame: { mesh: { draws: number; lines?: { lines: number; draws: number; segments: number } } | null } | null;
    pick: (px: number, py: number) => { x: number; y: number } | null;
    lineRgb: [number, number, number];
  };
  const api = (page: Page) => page.evaluate(() => {
    const a = (window as unknown as { __mapTerrainDoc: LineApi }).__mapTerrainDoc;
    return { mesh: a.frame?.mesh ?? null, lineRgb: a.lineRgb };
  });
  const pickAt = (page: Page, p: [number, number]) => page.evaluate(([x, y]) => (window as unknown as { __mapTerrainDoc: LineApi }).__mapTerrainDoc.pick(x, y), p);
  /**
   * Line-coloured pixels in a window 5 px wide from 2 px below the ground point (x, y) to 14 px above
   * it: a line is drawn raised by its half width and the lift (§5.6 "Lines"), its lower edge on the ground.
   */
  const lineIn = (png: PNG, [x, y]: [number, number], rgb: number[]) => {
    let n = 0;
    for (let dy = -14; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const i = ((Math.round(y) + dy) * png.width + Math.round(x) + dx) * 4;
        if (Math.max(Math.abs(png.data[i] - rgb[0]), Math.abs(png.data[i + 1] - rgb[1]), Math.abs(png.data[i + 2] - rgb[2])) <= 12) n++;
      }
    return n;
  };
  // Two lines across the doc cone (apex (35, 25), radius 22 mm, 45 m at 1:15 000): one 8 mm south of
  // the apex (the flank facing a camera that looks north), one 8 mm north (the far flank).
  const C = DOC.cone;
  const NEAR = { x: C.x, y: C.y - 8 }, FAR = { x: C.x, y: C.y + 8 };
  const line = (y: number) => `${C.x - 6},${y};${C.x},${y};${C.x + 6},${y}`;
  const query = (pitch: number, e: number) => `doc=course&field=cone&pitch=${pitch}&bearing=0&e=${e}&line=${encodeURIComponent(`${line(NEAR.y)}|${line(FAR.y)}`)}`;

  test("drawn on the surface and hidden behind the cone, as the exaggeration makes it", async ({ page }) => {
    // From above both lines are seen.
    await open(page, query(0, 5));
    let png = await pixels(page);
    const { lineRgb } = await api(page);
    expect(lineIn(png, (await docProject(page, NEAR.x, NEAR.y))!, lineRgb)).toBeGreaterThan(15);
    expect(lineIn(png, (await docProject(page, FAR.x, FAR.y))!, lineRgb)).toBeGreaterThan(15);
    let { mesh } = await api(page);
    expect(mesh!.draws).toBeLessThanOrEqual(7);
    expect(mesh!.lines).toMatchObject({ lines: 2, draws: 4 });
    expect(mesh!.lines!.segments).toBeGreaterThan(2 * 12 / 0.2 - 4);

    // Low over the ground (20° above the horizon) at 5×, the far flank (34°) is behind the apex: the
    // near line is drawn on its flank, the far one is hidden — the pixel where it would be shows the
    // cone in front of it, as the pick confirms.
    await open(page, query(70, 5));
    png = await pixels(page);
    const near = (await docProject(page, NEAR.x, NEAR.y))!, far = (await docProject(page, FAR.x, FAR.y))!;
    // the two windows do not overlap: the far point projects well above the near line
    expect(near[1] - far[1]).toBeGreaterThan(20);
    expect(lineIn(png, near, lineRgb)).toBeGreaterThan(15);
    expect(lineIn(png, far, lineRgb)).toBe(0);
    const hit = (await pickAt(page, far))!;
    expect(hit.y).toBeLessThan(FAR.y - 2);
    ({ mesh } = await api(page));
    expect(mesh!.draws).toBeLessThanOrEqual(7);
    expect(mesh!.lines).toMatchObject({ lines: 2, draws: 4 });

    // At 1× the far flank (8°) faces the camera again: the same line is drawn there (heights in units,
    // the exaggeration applied to the lines as to the mesh).
    await open(page, query(70, 1));
    png = await pixels(page);
    const farFlat = (await docProject(page, FAR.x, FAR.y))!;
    expect(lineIn(png, farFlat, lineRgb)).toBeGreaterThan(15);
    // Its whole width: the column through it has ≥ 6 line-coloured rows of the 8 px line. Centred on
    // the ground line, the terrain under the capsule's lower half would be nearer and swallow it (about
    // 4 rows) — the vertex shader raises the line by its half width (§5.6 "Lift and depth").
    let rows = 0;
    for (let dy = -16; dy <= 4; dy++) {
      const i = ((Math.round(farFlat[1]) + dy) * png.width + Math.round(farFlat[0])) * 4;
      if (Math.max(Math.abs(png.data[i] - lineRgb[0]), Math.abs(png.data[i + 1] - lineRgb[1]), Math.abs(png.data[i + 2] - lineRgb[2])) <= 12) rows++;
    }
    expect(rows).toBeGreaterThanOrEqual(6);
    expect(lineIn(png, (await docProject(page, NEAR.x, NEAR.y))!, lineRgb)).toBeGreaterThan(15);
  });
  test("a line's opacity is applied once, where it crosses itself and at its joins", async ({ page }) => {
    // An X through the camera's target on flat ground, one line at half opacity, looked at from above.
    const base = "doc=course&field=flat&pitch=0&bearing=0&e=1";
    const meanAt = (png: PNG, [x, y]: [number, number]) => {
      const m = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const i = ((Math.round(y) + dy) * png.width + Math.round(x) + dx) * 4;
          for (let c = 0; c < 3; c++) m[c] += png.data[i + c] / 9;
        }
      return m;
    };
    await open(page, base);
    const crossing = (await docProject(page, 40, 30))!, single = (await docProject(page, 35, 25))!;
    let png = await pixels(page);
    const under = [meanAt(png, crossing), meanAt(png, single)];
    await open(page, `${base}&lineOpacity=0.5&line=${encodeURIComponent("30,20;50,40;50,20;30,40")}`);
    png = await pixels(page);
    const { lineRgb } = await api(page);
    for (const [k, at] of [crossing, single].entries()) {
      const got = meanAt(png, at);
      // once: half the line over the map; twice would be three quarters (green 255 → 140 once, 83 twice on white)
      for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - (lineRgb[c] + under[k][c]) / 2), `channel ${c} at ${k ? "a join" : "the crossing"}`).toBeLessThanOrEqual(8);
    }
  });
});
