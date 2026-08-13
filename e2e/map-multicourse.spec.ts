import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";

// Mutates seed data (imports courses, uploads a map, reassigns classes) —
// start from a clean seed per the e2e hygiene convention.
test.beforeAll(reseed);

const API = "http://localhost:3002";
const EVENT = "itest";

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function clickTab(page: Page, name: string) {
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name, exact: true }).click();
  }
}

/** tRPC GET query against the live API (same pattern as lease.spec.ts). */
async function trpcQuery<T>(page: Page, path: string): Promise<T> {
  const res = await page.request.get(`${API}/trpc/${path}`, {
    headers: { "x-event-id": EVENT },
  });
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

/**
 * Multi-course map display (feature): with several courses selected, each
 * leg carries the classes that run it, and the Descriptions toggle keeps
 * showing control CODES on the map (no per-course renumbering) while the
 * sheet lists the union of all selected courses' controls.
 */
test.describe("Multi-course map: class labels + combined descriptions", () => {
  test("legs are labeled with classes and descriptions keep control codes", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await selectCompetition(page);
    await clickTab(page, "Courses");
    await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });

    // ── Import test.ocd (replace-all default) → courses A–E with real
    // coordinates, then upload the same file as the event map.
    await page.getByRole("button", { name: "Import courses" }).click();
    const importChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    const importChooser = await importChooserPromise;
    await importChooser.setFiles("e2e/test.ocd");
    await expect(page.getByText("Courses and Class Assignments")).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "Import 5 courses" }).click();
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("5 courses")).toBeVisible({ timeout: 5000 });

    const mapPanel = page.getByTestId("map-panel");
    const mapChooserPromise = page.waitForEvent("filechooser");
    await mapPanel.getByRole("button", { name: "Upload map" }).click();
    const mapChooser = await mapChooserPromise;
    await mapChooser.setFiles("e2e/test.ocd");
    const overlayLabels = mapPanel.locator("svg text");
    await expect(overlayLabels.first()).toBeVisible({ timeout: 30000 });

    // ── Deterministic class assignments via the API: Öppen 1 → A,
    // Öppen 2 → B. (The import dialog's heuristics are not under test.)
    const courses = await trpcQuery<Array<{ id: number; name: string; controls: string }>>(
      page,
      "course.list",
    );
    const courseA = courses.find((c) => c.name === "A")!;
    const courseB = courses.find((c) => c.name === "B")!;
    const classes = await trpcQuery<Array<{ id: number; name: string }>>(page, "class.list");
    for (const [clsName, courseId] of [
      ["Öppen 1", courseA.id],
      ["Öppen 2", courseB.id],
    ] as const) {
      const cls = classes.find((c) => c.name === clsName)!;
      const res = await page.request.post(`${API}/trpc/class.update`, {
        headers: { "content-type": "application/json", "x-event-id": EVENT },
        data: { id: cls.id, courseId },
      });
      expect(res.ok()).toBe(true);
    }
    // The map's class list is cached for the session — reload to pick up
    // the new assignments.
    await page.reload();
    await expect(page.getByText("5 courses")).toBeVisible({ timeout: 15000 });

    // ── Select courses A and B via the row checkboxes. Single-letter
    // course names need the exact name cell — row innerText joins cells
    // with newlines, so substring/regex row matching is unreliable.
    const rowFor = (name: string) =>
      page.getByRole("row").filter({
        has: page.getByRole("cell", { name, exact: true }),
      });
    await rowFor("A").getByRole("checkbox").check();
    await rowFor("B").getByRole("checkbox").check();

    // Leg labels: A's legs carry "Öppen 1", B's carry "Öppen 2" (legs
    // shared between the courses merge into "Öppen 1, Öppen 2" — the
    // substring match covers both cases). The pills are sized to the
    // course line's thickness and dropped below 5px, so they only render
    // once zoomed in enough — click zoom-in until they appear. Fit zoom
    // sits near the visibility threshold, so never assert without
    // zooming first.
    const zoomUntilLegLabels = async () => {
      const zoomIn = mapPanel.getByTitle("Zoom in");
      await expect(zoomIn).toBeVisible({ timeout: 10000 });
      for (let i = 0; i < 8; i++) {
        if ((await overlayLabels.filter({ hasText: "Öppen 1" }).count()) > 0) break;
        await zoomIn.click();
        await page.waitForTimeout(250);
      }
      await expect(
        overlayLabels.filter({ hasText: "Öppen 1" }).first(),
      ).toBeVisible({ timeout: 10000 });
    };
    await zoomUntilLegLabels();
    await expect(
      overlayLabels.filter({ hasText: "Öppen 2" }).first(),
    ).toBeVisible();

    // ── Descriptions with multiple courses: codes stay, union sheet.
    // The Descriptions toggle lives in the persistent map-pane toolbar,
    // which renders on wide viewports (>=2200px) — resize into it. The
    // inline map unmounts and the pane MapPanel takes over with the same
    // highlighted courses, but back at fit zoom — zoom in again.
    await page.setViewportSize({ width: 2400, height: 1200 });
    await zoomUntilLegLabels();
    await page.getByRole("button", { name: "Descriptions", exact: true }).click();

    // Map labels keep control CODES — the first codes of both courses
    // remain visible (before this feature the first course was renumbered
    // to 1, 2, 3, …).
    const codesA = courseA.controls.split(";").filter(Boolean);
    const codesB = courseB.controls.split(";").filter(Boolean);
    expect(codesA.length).toBeGreaterThan(2);
    for (const code of [codesA[0], codesB[0]]) {
      await expect(
        overlayLabels.filter({ hasText: new RegExp(`^${code}$`) }).first(),
      ).toBeVisible({ timeout: 10000 });
    }

    // The sheet header names both courses, and the union covers codes
    // from BOTH (a code unique to B appears even though A is "first").
    await expect(overlayLabels.filter({ hasText: "A · B" }).first()).toBeVisible();
    const bOnly = codesB.find((c) => !codesA.includes(c));
    if (bOnly) {
      // Appears at least twice: once as a map label, once as a sheet row.
      await expect
        .poll(async () => overlayLabels.filter({ hasText: new RegExp(`^${bOnly}$`) }).count())
        .toBeGreaterThanOrEqual(2);
    }

    // ── Single course keeps the classic sequence card: deselect B, and
    // sequence number 1 appears on the map (renumbering is single-course
    // behaviour only).
    await rowFor("B").getByRole("checkbox").uncheck();
    await expect(
      overlayLabels.filter({ hasText: /^1$/ }).first(),
    ).toBeVisible({ timeout: 10000 });
  });
});
