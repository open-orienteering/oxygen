// Leg routes in the editor (docs/course-elevation.md §7.4): a route drawn for the selected leg, the leg's
// and the course's climb read along the chosen route, the choice handed back to the drawn line, removal,
// and a draft given up. Heights come from the plane rising east of `helpers/terrain.ts`, so every number
// is known from the points clicked. It runs under the `chromium` project (desktop).
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`; courses a test creates carry a prefix and go with
// the next reseed, and their routes with them; every route a test stores it removes.

import { expect, test, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { clickMap, coveredBy, mapScale, sites, statsRow, toPage } from "./helpers/editor";
import { waitForTrpc } from "./helpers/trpc";
import { type Pt, desktopOnly, selectLeg, twoControlCourse } from "./helpers/course-editor-spec";
import { PLANE_SLOPE, servePlane } from "./helpers/terrain";

test.beforeAll(async () => {
  await reseed();
});

test.setTimeout(120_000);

const num = async (page: Page, testId: string) => Number(await page.getByTestId(testId).getAttribute("data-m"));
const items = (page: Page) => page.getByTestId("editor-leg-route");

/** A paper point beside the leg a → b whose place on screen is free map: off the leg's middle, across it. */
async function besideLeg(page: Page, a: Pt, b: Pt): Promise<{ mm: Pt; px: Pt }> {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  const others = await Promise.all((await sites(page)).map((s) => toPage(page, s.mm)));
  for (const off of [0.5, -0.5, 0.8, -0.8, 0.3, -0.3]) {
    const mm = { x: mid.x + n.x * len * off, y: mid.y + n.y * len * off };
    const px = await toPage(page, mm);
    if (others.every((o) => Math.hypot(o.x - px.x, o.y - px.y) > 30) && !(await coveredBy(page, px))) return { mm, px };
  }
  throw new Error("no free map beside the leg");
}

test.describe("leg routes (docs/course-elevation.md §7.4)", () => {
  desktopOnly();

  test("a route drawn for a leg is chosen: the leg and the course are read along it; the drawn line can be chosen back; the route is removed", async ({ page }) => {
    await servePlane(page, "contours");
    const { name, a, b } = await twoControlCourse(page, "CE route", { minChordPx: 120 });
    const gm = (await mapScale(page)) / 1000;
    await expect.poll(() => statsRow(page, "climb", "state"), { timeout: 20000 }).toBe("ready");
    const lineClimb = Number(await statsRow(page, "climb", "m"));
    await page.getByTestId("editor-stats").click();

    await selectLeg(page, name, a, b);
    // Without a route: the drawn line alone, chosen.
    await expect(items(page)).toHaveCount(1);
    await expect(items(page).first()).toHaveAttribute("data-source", "line");
    await expect(items(page).first()).toHaveAttribute("data-chosen", "true");
    const lineM = Math.hypot(b.mm.x - a.mm.x, b.mm.y - a.mm.y) * gm;
    expect(Math.abs(Number(await items(page).first().getAttribute("data-m")) - lineM)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("editor-leg-elevation")).toHaveAttribute("data-routed", "false");

    // Draw: one vertex beside the leg, saved with the button.
    const via = await besideLeg(page, a.mm, b.mm);
    await page.getByTestId("editor-leg-route-draw").click();
    await expect(page.getByTestId("editor-leg-routes")).toHaveAttribute("data-drawing", "true");
    await expect(page.getByTestId("editor-leg-route-done")).toBeDisabled();
    await clickMap(page, via.px);
    await expect(page.getByTestId("editor-leg-route-drawing")).toHaveAttribute("data-points", "1");
    await expect(page.getByTestId("editor-route-draft")).toBeAttached();
    // The leg stays selected: the click was a vertex, not a selection.
    await expect(page.getByTestId("editor-leg")).toContainText(`${a.code} → ${b.code}`);
    const saved = waitForTrpc(page, "legRoute.save");
    await page.getByTestId("editor-leg-route-done").click();
    await saved;

    const route = items(page).nth(1);
    try {
      await expect(items(page)).toHaveCount(2, { timeout: 15000 });
      await expect(route).toHaveAttribute("data-source", "drawn");
      await expect(route).toHaveAttribute("data-chosen", "true");
      await expect(items(page).first()).toHaveAttribute("data-chosen", "false");
      await expect(page.getByTestId("editor-leg-routes")).toHaveAttribute("data-drawing", "false");
      const routeM = (Math.hypot(via.mm.x - a.mm.x, via.mm.y - a.mm.y) + Math.hypot(b.mm.x - via.mm.x, b.mm.y - via.mm.y)) * gm;
      expect(Math.abs(Number(await route.getAttribute("data-m")) - routeM)).toBeLessThanOrEqual(2);
      // On the plane a route's climb is what it rises eastwards, vertex to vertex.
      const h = (p: Pt) => p.x * gm * PLANE_SLOPE;
      const routeClimb = Math.max(0, h(via.mm) - h(a.mm)) + Math.max(0, h(b.mm) - h(via.mm));
      expect(Math.abs(Number(await route.getAttribute("data-climb")) - routeClimb)).toBeLessThanOrEqual(2);
      // The map draws it, screen only.
      await expect(page.locator('[data-testid="editor-route-line"][data-chosen="true"]')).toBeAttached();

      // The leg's numbers are the route's; the course's length did not change, its climb follows the route.
      await expect(page.getByTestId("editor-leg-elevation")).toHaveAttribute("data-routed", "true", { timeout: 15000 });
      await expect.poll(async () => Math.abs((await num(page, "editor-leg-length")) - routeM), { timeout: 15000 }).toBeLessThanOrEqual(2);
      const straightClimb = Math.max(0, h(b.mm) - h(a.mm));
      const expected = lineClimb + (routeClimb - straightClimb);
      if (Math.abs(routeClimb - straightClimb) >= 3) {
        await expect.poll(async () => Math.abs(Number(await statsRow(page, "climb", "m")) - expected), { timeout: 15000 }).toBeLessThanOrEqual(3);
        await page.getByTestId("editor-stats").click();
      }

      // The drawn line chosen back: the route stays in the list, the leg is read along its line again.
      const unchosen = waitForTrpc(page, "legRoute.choose");
      await items(page).first().getByTestId("editor-leg-route-choose").check();
      await unchosen;
      await expect(items(page).first()).toHaveAttribute("data-chosen", "true", { timeout: 15000 });
      await expect(route).toHaveAttribute("data-chosen", "false");
      await expect(page.getByTestId("editor-leg-elevation")).toHaveAttribute("data-routed", "false", { timeout: 15000 });
      await expect(page.locator('[data-testid="editor-route-line"][data-chosen="false"]')).toBeAttached();
      await expect.poll(async () => Number(await statsRow(page, "climb", "m")), { timeout: 15000 }).toBe(lineClimb);
      await page.getByTestId("editor-stats").click();

      // And the route again.
      const chosen = waitForTrpc(page, "legRoute.choose");
      await route.getByTestId("editor-leg-route-choose").check();
      await chosen;
      await expect(route).toHaveAttribute("data-chosen", "true", { timeout: 15000 });
    } finally {
      const removed = waitForTrpc(page, "legRoute.delete");
      await route.getByTestId("editor-leg-route-remove").click();
      await removed;
    }
    await expect(items(page)).toHaveCount(1, { timeout: 15000 });
    await expect(page.getByTestId("editor-route-line")).toHaveCount(0);
  });

  test("a draft: Backspace takes the last vertex back, Enter saves, Escape gives it up and stores nothing", async ({ page }) => {
    await servePlane(page, "contours");
    const { name, a, b } = await twoControlCourse(page, "CE route keys", { minChordPx: 120 });
    await selectLeg(page, name, a, b);
    const via = await besideLeg(page, a.mm, b.mm);
    let saves = 0;
    page.on("request", (r) => { if (r.url().includes("legRoute.save")) saves++; });

    await page.getByTestId("editor-leg-route-draw").click();
    await clickMap(page, via.px);
    await expect(page.getByTestId("editor-leg-route-drawing")).toHaveAttribute("data-points", "1");
    await page.keyboard.press("Backspace");
    await expect(page.getByTestId("editor-leg-route-drawing")).toHaveAttribute("data-points", "0");
    // Nothing to save yet: Enter stores nothing.
    await page.keyboard.press("Enter");
    await clickMap(page, via.px);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-leg-routes")).toHaveAttribute("data-drawing", "false");
    await expect(items(page)).toHaveCount(1);
    expect(saves).toBe(0);
    // The leg is still the selection: Escape ended the draft, not the selection.
    await expect(page.getByTestId("editor-leg")).toContainText(`${a.code} → ${b.code}`);

    await page.getByTestId("editor-leg-route-draw").click();
    await clickMap(page, via.px);
    const saved = waitForTrpc(page, "legRoute.save");
    await page.keyboard.press("Enter");
    await saved;
    await expect(items(page)).toHaveCount(2, { timeout: 15000 });
    const removed = waitForTrpc(page, "legRoute.delete");
    await items(page).nth(1).getByTestId("editor-leg-route-remove").click();
    await removed;
    await expect(items(page)).toHaveCount(1, { timeout: 15000 });
  });
});
