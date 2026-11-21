// Heights along a course in the editor (docs/course-elevation.md §4): the computed climb in the course-info
// popover, the selected leg's numbers, what the numbers rest on, and a field that cannot be read.
// The event's terrain descriptor is replaced and `height.bin` answered with a plane rising east
// (`helpers/dem-field.ts` `planeFieldBytes`), so every number is known from the controls' positions.
// It runs under the `chromium` project (desktop); the phone's line is `course-editor-phone.spec.ts`.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`; courses a test creates carry a prefix and go with the
// next reseed; a moved control is moved back (undo).

import { expect, test, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { coveredBy, drag, editorReady, legPieces, mapScale, site, sites, statsRow, toPage, trpcCall } from "./helpers/editor";
import { waitForTrpc } from "./helpers/trpc";
import { type Pt, desktopOnly, selectLeg, twoControlCourse } from "./helpers/course-editor-spec";
import { DEM_PROVIDER } from "./helpers/dem-field";
import { PLANE_SLOPE, servePlane } from "./helpers/terrain";

test.beforeAll(async () => {
  await reseed();
});

test.setTimeout(120_000);

const SLOPE = PLANE_SLOPE;

/** The plane's height at a paper point, metres above its zero. */
const heightAt = (p: Pt, groundMPerMm: number) => p.x * groundMPerMm * SLOPE;

/** docs/course-elevation.md §2 over heights in order: the climb, 1 m threshold. */
function climbOf(h: number[], T = 1): number {
  let low = h[0], high = h[0], rising = false, sum = 0;
  for (const z of h.slice(1)) {
    if (!rising) {
      if (z < low) low = z;
      else if (z - low >= T) { rising = true; high = z; }
    } else if (z > high) high = z;
    else if (high - z >= T) { sum += high - low; low = z; rising = false; }
  }
  return rising ? sum + (high - low) : sum;
}

/** The course's sites in order, from its drawn legs: each leg's ends are the sites nearest its first and last points. */
async function courseSites(page: Page, name: string): Promise<Pt[]> {
  const all = (await sites(page)).map((s) => s.mm);
  const nearest = (p: Pt) => all.reduce((best, s) => (Math.hypot(s.x - p.x, s.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y) ? s : best));
  const byLeg = new Map<number, Pt[]>();
  for (const piece of await legPieces(page, name)) byLeg.set(piece.leg, [...(byLeg.get(piece.leg) ?? []), ...piece.points]);
  const legs = [...byLeg.entries()].sort((a, b) => a[0] - b[0]).map(([, pts]) => pts);
  return [nearest(legs[0][0]), ...legs.map((pts) => nearest(pts[pts.length - 1]))];
}

const num = async (page: Page, testId: string) => Number(await page.getByTestId(testId).getAttribute("data-m"));

test.describe("the computed climb (docs/course-elevation.md §4)", () => {
  desktopOnly();

  test("the popover states the course's climb from the contour field, with the disclaimer; a leg shows its own numbers; moving a control changes them", async ({ page }) => {
    await servePlane(page, "contours");
    const { name, a, b } = await twoControlCourse(page, "CE climb");
    const gm = (await mapScale(page)) / 1000;

    // The course: one pass of the rule over its heights in order.
    const heights = (await courseSites(page, name)).map((p) => heightAt(p, gm));
    await expect.poll(() => statsRow(page, "climb", "state"), { timeout: 20000 }).toBe("ready");
    const climb = Number(await statsRow(page, "climb", "m"));
    expect(Math.abs(climb - climbOf(heights))).toBeLessThanOrEqual(1);
    expect(await statsRow(page, "climb", "source")).toBe("computed");
    expect(await statsRow(page, "climb", "basis")).toBe("contours");
    expect(await statsRow(page, "climb", "partial")).toBe("false");

    // What the numbers rest on: the disclaimer, no provider's notice.
    await page.getByTestId("editor-stats").click();
    const popover = page.getByTestId("editor-stats-popover");
    await expect(popover.getByTestId("editor-stats-elevation-note")).toBeVisible();
    await expect(popover.getByTestId("editor-stats-elevation-attribution")).toHaveCount(0);
    await expect(popover.getByTestId("editor-stats-climb")).toContainText(/m climb · \d+\.\d %/);
    await page.getByTestId("editor-stats").click();

    // The leg a → b: length, climb, descent and net along its line.
    await selectLeg(page, name, a, b);
    const box = page.getByTestId("editor-leg-elevation");
    await expect(box).toHaveAttribute("data-basis", "contours");
    const net = heightAt(b.mm, gm) - heightAt(a.mm, gm);
    const length = Math.hypot(b.mm.x - a.mm.x, b.mm.y - a.mm.y) * gm;
    expect(Math.abs((await num(page, "editor-leg-length")) - length)).toBeLessThanOrEqual(1);
    expect(Math.abs((await num(page, "editor-leg-net")) - net)).toBeLessThanOrEqual(1);
    // A straight leg on a plane only rises or only falls.
    expect(Math.abs((await num(page, "editor-leg-climb")) - Math.max(0, net))).toBeLessThanOrEqual(2);
    expect(Math.abs((await num(page, "editor-leg-descent")) - Math.max(0, -net))).toBeLessThanOrEqual(2);
    await expect(page.getByTestId("editor-leg-elevation-note")).toBeVisible();

    // b moved sideways: the course's climb follows its new place.
    await page.keyboard.press("Escape");
    const from = await toPage(page, b.mm);
    const others = await Promise.all((await sites(page)).filter((x) => x.code !== b.code).map((x) => toPage(page, x.mm)));
    let to: Pt | null = null;
    for (const [dx, dy] of [[90, 0], [-90, 0], [110, -40], [-110, -40], [110, 40], [-110, 40]]) {
      const q = { x: from.x + dx, y: from.y + dy };
      if (others.every((o) => Math.hypot(o.x - q.x, o.y - q.y) > 45) && !(await coveredBy(page, q))) { to = q; break; }
    }
    expect(to, "a free spot beside b").not.toBeNull();
    const moved = waitForTrpc(page, "control.update");
    await drag(page, from, to!);
    await moved;
    try {
      await expect.poll(async () => Math.abs((await site(page, b.code)).mm.x - b.mm.x), { timeout: 15000 }).toBeGreaterThan(1);
      const after = (await courseSites(page, name)).map((p) => heightAt(p, gm));
      
      await expect.poll(async () => Math.abs(Number(await statsRow(page, "climb", "m")) - climbOf(after)), { timeout: 15000 }).toBeLessThanOrEqual(1);
    } finally {
      const undone = waitForTrpc(page, "control.update");
      await page.getByTestId("editor-undo").click();
      await undone;
    }
  });

  test("a ground model: the numbers carry no disclaimer and state the provider's notice", async ({ page }) => {
    const served = await servePlane(page, "ground");
    await twoControlCourse(page, "CE ground");
    await expect.poll(() => statsRow(page, "climb", "basis"), { timeout: 20000 }).toBe("ground");
    expect(served.asked.every((s) => s === `ground.${DEM_PROVIDER.id}`)).toBe(true);
    await page.getByTestId("editor-stats").click();
    const popover = page.getByTestId("editor-stats-popover");
    await expect(popover.getByTestId("editor-stats-elevation-attribution")).toHaveText(DEM_PROVIDER.attribution);
    await expect(popover.getByTestId("editor-stats-elevation-note")).toHaveCount(0);
  });

  test("a field that cannot be read says so and can be asked for again", async ({ page }) => {
    const served = await servePlane(page, "contours");
    served.fail(true);
    await twoControlCourse(page, "CE retry");
    await expect.poll(() => statsRow(page, "climb", "state"), { timeout: 20000 }).toBe("unavailable");
    served.fail(false);
    await page.getByTestId("editor-stats").click();
    await page.getByTestId("editor-stats-elevation-retry").click();
    await expect(page.getByTestId("editor-stats-climb")).toHaveAttribute("data-state", "ready", { timeout: 15000 });
    await expect(page.getByTestId("editor-stats-elevation-retry")).toHaveCount(0);
  });

  test("no rows without a height field, in the all-controls view, or for a free-order course", async ({ page }) => {
    const served = await servePlane(page, "contours");
    await twoControlCourse(page, "CE views");
    await expect.poll(() => statsRow(page, "climb", "state"), { timeout: 20000 }).toBe("ready");
    // Free order has no legs to read along.
    const saved = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-order-mode").selectOption("free_order");
    await saved;
    await expect.poll(() => statsRow(page, "climb", "state"), { timeout: 15000 }).toBeNull();
    const back = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-order-mode").selectOption("ordered");
    await back;
    await expect.poll(() => statsRow(page, "climb", "state"), { timeout: 15000 }).toBe("ready");
    // All controls: no course's line.
    await page.getByTestId("editor-view-all").click();
    await expect.poll(() => statsRow(page, "climb", "state"), { timeout: 15000 }).toBeNull();
    expect(served.asked.length).toBe(1);
  });

  test("a typed climb is the course's climb: the computed one is not shown in its place", async ({ page }) => {
    await servePlane(page, "contours");
    const { name, a, b } = await twoControlCourse(page, "CE typed");
    await expect.poll(() => statsRow(page, "climb", "source"), { timeout: 20000 }).toBe("computed");
    const id = Number(await page.getByTestId("editor-course-picker").inputValue());
    await trpcCall("course.update", { id, climb: 777 });
    await page.reload();
    await editorReady(page);
    await expect.poll(() => statsRow(page, "climb", "source"), { timeout: 20000 }).toBe("manual");
    expect(await statsRow(page, "climb", "m")).toBe("777");
    await page.getByTestId("editor-stats").click();
    await expect(page.getByTestId("editor-stats-elevation-note")).toHaveCount(0);
    // The profile and a leg's heights are the map's, whatever the course states: both stay.
    await expect(page.getByTestId("editor-stats-profile-toggle")).toBeVisible();
    await page.getByTestId("editor-stats").click();
    await selectLeg(page, name, a, b);
    await expect(page.getByTestId("editor-leg-climb")).toHaveAttribute("data-m", /^\d+$/);
  });

  test("a map without contours shows no climb and asks for no field", async ({ page }) => {
    const served = await servePlane(page, "none");
    await twoControlCourse(page, "CE none");
    // The course is derived (its length is the layer's): still no climb row.
    await expect.poll(async () => Number(await statsRow(page, "length", "m")), { timeout: 15000 }).toBeGreaterThan(0);
    expect(await statsRow(page, "climb", "m")).toBeNull();
    expect(await statsRow(page, "climb", "state")).toBeNull();
    expect(served.asked).toEqual([]);
  });
});
