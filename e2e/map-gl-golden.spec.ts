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
 * golden. Measured at introduction (B3): text-with-halo 0.364 %, lib-text 0.688 %, lib-halos 0.236 %.
 */
const TEXT_TIER_MAX_RATIO = 0.01;
const TEXT_TIER_SCENES = ["text-with-halo", "lib-text", "lib-halos"] as const;

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
  "lib-colour-order",
  "lib-precision",
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

async function compareScene(page: import("@playwright/test").Page, testInfo: import("@playwright/test").TestInfo, name: string, path: "pass" | "arena", maxRatio: number) {
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
