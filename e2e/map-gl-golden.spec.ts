/**
 * Golden-image tests of the WebGL2 map backend (docs/map-rendering.md §6.2).
 *
 * Each golden scene is drawn by `/dev/map-gl?fixture=<name>` into a canvas
 * sized exactly like the reference raster, read back as PNG, and compared
 * with `e2e/__golden__/map-gl/<name>.png` using the contract's metric:
 * pixels whose largest channel difference exceeds 16 must be at most
 * 0.5 % of the image. The goldens are written by the reference raster
 * (`pnpm --filter @oxygen/api golden:render`), never by this test.
 *
 * On failure the actual image and a diff (differing pixels in red) are
 * attached to the report.
 *
 * MSDF text tier (§6.2): the text scenes are also drawn through the arena
 * path (`&path=arena`: inline worker, text from the MSDF atlas, MSAA
 * only) against the same goldens, at the wider `TEXT_TIER_MAX_RATIO`.
 *
 * Filter regions (D3, §4.11): the `filter-*` scenes are also drawn through
 * the arena path — the static buckets with the stream's masks as the
 * visible set's per-(colour, mask) draws under the stencil region bit.
 * That path has MSAA only (no 2× supersample), so its hairline edges
 * (0.14 mm contours, 0.12 mm hatch lines) step in quarter coverage and the
 * whole-image budget is `ARENA_FILTER_MAX_RATIO`; pixel probes on either
 * side of each region then check what the masks decide.
 */

import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "node:fs";
import { PNG } from "pngjs";

/** Playwright runs with the repo root as cwd (see other specs' `e2e/test.ocd`). */
const GOLDEN_DIR = "e2e/__golden__/map-gl/";
const CHANNEL_TOLERANCE = 16;
const MAX_DIFF_RATIO = 0.005;
/**
 * MSDF text tier budget (map-rendering.md §6.2): pixels beyond the channel tolerance, arena path vs
 * golden. Measured at introduction (B3): text-with-halo 0.364 %, lib-text 0.688 %, lib-halos 0.236 %;
 * lib-text-layout (B8) 0.286 %.
 */
const TEXT_TIER_MAX_RATIO = 0.01;
const TEXT_TIER_SCENES = ["text-with-halo", "lib-text", "lib-halos", "lib-text-layout"] as const;
const FILTER_SCENES = ["filter-clip-brown", "filter-hide-505", "filter-moved", "filter-show-only"] as const;
/**
 * Arena path vs golden on the filter scenes (map-rendering.md §6.2), measured at introduction (D3,
 * headless Chromium): clip-brown 0.885 %, hide-505 0.891 %, moved 0.720 %, show-only 1.046 % —
 * MSAA coverage steps on hairlines, the same on hide-505, which has no mask.
 */
const ARENA_FILTER_MAX_RATIO = 0.015;

type Probe = { at: [number, number] | [number, number, number, number]; colour: string; drawn: boolean };
const BROWN = "#bf4000", GREEN = "#33ff00", BLACK = "#000000";
/** The straight 101 contour (2, 6) → (58, 30) mm at x mm. */
const contour = (x: number): [number, number] => [x, 6 + ((x - 2) * 24) / 56];
/**
 * What each filter scene's masks decide (scene module `__fixtures__/filter/index.ts`), paper mm: a
 * point, or a segment sampled every 0.5 mm. The pentagon (radius 10 mm round (24, 20), turned 12°)
 * spans x 14.1–32.7, y 10.9–29.8; moved, x 24.1–42.7.
 */
const FILTER_PROBES: Record<(typeof FILTER_SCENES)[number], Probe[]> = {
  "filter-clip-brown": [
    { at: contour(24), colour: BROWN, drawn: false },
    { at: contour(50), colour: BROWN, drawn: true },
    { at: [18, 4, 22, 36], colour: BLACK, drawn: true },
  ],
  "filter-hide-505": [
    { at: [18, 4, 22, 36], colour: BLACK, drawn: false },
    { at: [41, 6, 43, 34], colour: BLACK, drawn: true },
    { at: contour(24), colour: BROWN, drawn: true },
  ],
  "filter-moved": [
    { at: [41, 6, 43, 34], colour: BLACK, drawn: false },
    { at: [18, 4, 22, 36], colour: BLACK, drawn: true },
    { at: contour(36), colour: BROWN, drawn: false },
    { at: contour(20), colour: BROWN, drawn: true },
  ],
  "filter-show-only": [
    { at: [16, 22, 20, 22], colour: GREEN, drawn: false },
    { at: [46, 22, 50, 22], colour: GREEN, drawn: true },
    { at: contour(24), colour: BROWN, drawn: true },
  ],
};

/** Does any pixel in a 5 × 5 window round each probed point show the colour (Σ|Δ| ≤ 90)? Frame: the 407 area (0–60 × 0–40 mm) plus 1 mm, 10 px/mm. */
function probeDrawn(img: PNG, probe: Probe): boolean {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(probe.colour.slice(i, i + 2), 16));
  const pts: [number, number][] = [];
  if (probe.at.length === 2) pts.push(probe.at);
  else {
    const [x0, y0, x1, y1] = probe.at;
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5);
    for (let k = 0; k <= n; k++) pts.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  for (const [x, y] of pts) {
    const px = Math.round(10 * x + 10), py = Math.round(410 - 10 * y);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const o = ((py + dy) * img.width + (px + dx)) * 4;
      if (Math.abs(img.data[o] - r) + Math.abs(img.data[o + 1] - g) + Math.abs(img.data[o + 2] - b) <= 90) return true;
    }
  }
  return false;
}

const scenes = [
  "fill-with-holes",
  "dashed-bezier-stroke",
  "glyph-instances",
  "hatch-area",
  "colour-order",
  "text-with-halo",
  "pilot-scene",
  // Library fixtures, research 04 §8 rows 1–9 + colour order + precision (B1).
  "lib-dash-ocad",
  "lib-dash-omap",
  "lib-line-glyphs",
  "lib-pattern",
  "lib-hatch",
  "lib-borders",
  "lib-holes",
  "lib-text",
  "lib-halos",
  "lib-text-layout",
  "lib-colour-order",
  "lib-precision",
  // Course layer (C0): courseLayer() merged with a library base map in one stream.
  "course-legs",
  "course-cuts",
  "course-objects",
  "course-sprint",
  "course-all-controls",
  // Filter regions (D3): clip by colour, hide by symbol, the moved polygon, "show only" (invert).
  ...FILTER_SCENES,
] as const;

function diffPng(actual: PNG, golden: PNG): { differing: number; total: number; diff: PNG } {
  const diff = new PNG({ width: golden.width, height: golden.height });
  let differing = 0;
  for (let i = 0; i < golden.width * golden.height; i++) {
    const o = i * 4;
    let m = 0;
    for (let c = 0; c < 3; c++) m = Math.max(m, Math.abs(actual.data[o + c] - golden.data[o + c]));
    const bad = m > CHANNEL_TOLERANCE;
    if (bad) differing++;
    const g = Math.round(((golden.data[o] + golden.data[o + 1] + golden.data[o + 2]) / 3) * 0.3 + 178);
    diff.data[o] = bad ? 255 : g;
    diff.data[o + 1] = bad ? 0 : g;
    diff.data[o + 2] = bad ? 0 : g;
    diff.data[o + 3] = 255;
  }
  return { differing, total: golden.width * golden.height, diff };
}

async function compareScene(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo, name: string, path: "pass" | "arena", maxRatio: number): Promise<{ actual: PNG; golden: PNG }> {
  const goldenPath = `${GOLDEN_DIR}${name}.png`;
  expect(existsSync(goldenPath), `missing golden ${name}.png — run pnpm --filter @oxygen/api golden:render`).toBe(true);
  const golden = PNG.sync.read(readFileSync(goldenPath));

  await page.goto(`/dev/map-gl?fixture=${name}${path === "arena" ? "&path=arena" : ""}`);
  const canvas = page.getByTestId("map-gl-canvas");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  const stats = await page.getByTestId("map-gl-stats").textContent();
  testInfo.annotations.push({ type: "map-gl", description: stats ?? "" });

  const dataUrl = await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL("image/png"));
  const actual = PNG.sync.read(Buffer.from(dataUrl.split(",")[1], "base64"));
  await testInfo.attach(`${name}-${path}-actual.png`, { body: PNG.sync.write(actual), contentType: "image/png" });

  expect({ width: actual.width, height: actual.height }).toEqual({ width: golden.width, height: golden.height });

  const { differing, total, diff } = diffPng(actual, golden);
  const ratio = differing / total;
  testInfo.annotations.push({ type: "map-gl-diff", description: `${path}: ${differing}/${total} = ${(ratio * 100).toFixed(3)} %` });
  if (ratio > maxRatio) {
    await testInfo.attach(`${name}-${path}-diff.png`, { body: PNG.sync.write(diff), contentType: "image/png" });
  }
  expect(ratio, `${differing} of ${total} pixels differ by more than ${CHANNEL_TOLERANCE} levels`).toBeLessThanOrEqual(maxRatio);
  return { actual, golden };
}

test.describe("WebGL2 map backend — golden images", () => {
  for (const name of scenes) {
    test(`${name} matches the reference raster`, async ({ page }, testInfo) => {
      await compareScene(page, testInfo, name, "pass", MAX_DIFF_RATIO);
    });
  }
});

test.describe("WebGL2 map backend — MSDF text tier (arena path)", () => {
  for (const name of TEXT_TIER_SCENES) {
    test(`${name} through the arena path matches the reference raster within the text tier`, async ({ page }, testInfo) => {
      await compareScene(page, testInfo, name, "arena", TEXT_TIER_MAX_RATIO);
    });
  }
});

test.describe("WebGL2 map backend — filter regions (arena path)", () => {
  for (const name of FILTER_SCENES) {
    test(`${name} through the arena path matches the reference raster and its probes`, async ({ page }, testInfo) => {
      const { actual, golden } = await compareScene(page, testInfo, name, "arena", ARENA_FILTER_MAX_RATIO);
      for (const probe of FILTER_PROBES[name]) {
        const where = `${probe.colour} ${probe.drawn ? "drawn" : "absent"} at ${probe.at.join(", ")} mm`;
        expect(probeDrawn(golden, probe), `golden: ${where}`).toBe(probe.drawn);
        expect(probeDrawn(actual, probe), `arena: ${where}`).toBe(probe.drawn);
      }
    });
  }
});
