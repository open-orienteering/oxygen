// The elevation profile under the editor's map (docs/course-elevation.md §5): the toggle and its memory, the graph
// of the course on a synthetic plane field (`helpers/terrain.ts` `servePlane`), the pointer's readout and its dot
// on the map, and a click that selects the leg. It runs under the `chromium` project (desktop).
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`; courses a test creates carry a prefix and go with the next reseed.

import { expect, test, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { editorReady, mapScale, sites, statsRow } from "./helpers/editor";
import { desktopOnly, twoControlCourse } from "./helpers/course-editor-spec";
import { PLANE_SLOPE, servePlane } from "./helpers/terrain";

test.beforeAll(async () => {
  await reseed();
});

test.setTimeout(120_000);

async function openProfile(page: Page): Promise<void> {
  await expect.poll(() => statsRow(page, "climb", "state"), { timeout: 20000 }).toBe("ready");
  await page.getByTestId("editor-stats").click();
  await page.getByTestId("editor-stats-profile-toggle").click();
  await expect(page.getByTestId("editor-profile-line")).toBeVisible({ timeout: 15000 });
}

test.describe("the elevation profile (docs/course-elevation.md §5)", () => {
  desktopOnly();

  test("the toggle opens the panel under the map with the course's line and controls; it is remembered; ✕ closes it", async ({ page }) => {
    await servePlane(page, "contours");
    await twoControlCourse(page, "CE profile");
    await expect(page.getByTestId("editor-profile")).toHaveCount(0);
    await openProfile(page);

    const panel = page.getByTestId("editor-profile");
    await expect(panel).toHaveAttribute("data-basis", "contours");
    await expect(panel).toHaveAttribute("data-datum", "relative");
    await expect(page.getByTestId("editor-profile-note")).toBeVisible();
    // Start, two controls, finish.
    await expect(page.getByTestId("editor-profile-control")).toHaveCount(4);
    expect(Number(await panel.getAttribute("data-length-m"))).toBe(Number(await statsRow(page, "length", "m")));
    await expect(page.getByTestId("editor-profile-summary")).toContainText(`↑ ${await statsRow(page, "climb", "m")} m`);
    // The map gave the panel its height: the viewer ends where the panel starts.
    const map = (await page.getByTestId("map-viewer").boundingBox())!, box = (await panel.boundingBox())!;
    expect(map.y + map.height).toBeLessThanOrEqual(box.y + 1);
    expect(box.height).toBeGreaterThan(120);
    // The tool rail stays above the panel (it scrolls in a short window).
    const rail = (await page.getByTestId("editor-tool-rail").boundingBox())!;
    expect(rail.y + rail.height).toBeLessThanOrEqual(box.y + 1);

    // Remembered on this device.
    await page.reload();
    await editorReady(page);
    await expect(page.getByTestId("editor-profile-line")).toBeVisible({ timeout: 20000 });
    await page.getByTestId("editor-profile-close").click();
    await expect(page.getByTestId("editor-profile")).toHaveCount(0);
    await page.reload();
    await editorReady(page);
    await expect.poll(() => statsRow(page, "climb", "state"), { timeout: 20000 }).toBe("ready");
    await expect(page.getByTestId("editor-profile")).toHaveCount(0);
  });

  test("the pointer reads a place: distance, height and leg, with a dot on the map; a click selects the leg", async ({ page }) => {
    await servePlane(page, "contours");
    await twoControlCourse(page, "CE hover");
    const gm = (await mapScale(page)) / 1000;
    await openProfile(page);
    const graph = (await page.getByTestId("editor-profile-graph").boundingBox())!;
    const lengthM = Number(await page.getByTestId("editor-profile").getAttribute("data-length-m"));
    const marks = await page.getByTestId("editor-profile-control").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-d"))));
    expect(marks[0]).toBe(0);
    expect(marks[3]).toBe(lengthM);

    // The middle of the second leg (control 1 → control 2).
    const pxOf = (d: number) => graph.x + 40 + (d / lengthM) * (graph.width - 40 - 12);
    const d = (marks[1] + marks[2]) / 2;
    await page.mouse.move(pxOf(d), graph.y + graph.height / 2);
    const tip = page.getByTestId("editor-profile-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toHaveAttribute("data-leg", "1");
    expect(Math.abs(Number(await tip.getAttribute("data-d")) - d)).toBeLessThanOrEqual(lengthM / 100 + 2);
    await expect(page.getByTestId("editor-profile-crosshair")).toBeAttached();

    // The dot on the map is that place: on the plane, its height above the course's lowest point is the readout's.
    const dot = page.getByTestId("editor-profile-map-dot");
    await expect(dot).toHaveAttribute("data-leg", "1", { timeout: 5000 });
    const xs = (await sites(page)).map((s) => s.mm.x);
    const z = Number(await tip.getAttribute("data-z"));
    expect(z).toBeGreaterThanOrEqual(0);
    expect((Number(await dot.getAttribute("data-x")) - Math.min(...xs)) * gm * PLANE_SLOPE).toBeGreaterThanOrEqual(z - 1.5);

    // A click selects the leg under the pointer: the Leg section, and the graph shades it.
    await page.mouse.click(pxOf(d), graph.y + graph.height / 2);
    await expect(page.getByTestId("editor-leg")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("editor-profile-selected")).toHaveAttribute("data-leg", "1");
    await expect(page.getByTestId("editor-leg-elevation")).toBeVisible();

    // The pointer gone: no readout, no dot.
    await page.mouse.move(graph.x + graph.width / 2, graph.y - 200);
    await expect(tip).toHaveCount(0);
    await expect(dot).toHaveCount(0);
  });
});
