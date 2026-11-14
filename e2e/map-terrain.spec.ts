/**
 * The terrain mesh, camera and shading on the dev page
 * (docs/map-rendering.md §5.6, `/dev/map-terrain`): a synthetic field drawn
 * by `TerrainRenderer` in headless Chromium, read back through
 * `canvas.toDataURL` and probed at points projected by the page's own
 * camera (`window.__mapTerrain.project`). The expected values are
 * analytic — §5.6's shading on the dev cone — not a golden image: no
 * reference raster exists for 3D.
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
