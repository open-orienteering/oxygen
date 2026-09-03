import { test, expect } from "@playwright/test";
import { reseed } from "./helpers/reseed";

// This spec mutates seed data (imports courses, uploads a map file), so it
// starts from a clean seed per the e2e hygiene convention.
test.beforeAll(reseed);

async function selectCompetition(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function clickTab(page: import("@playwright/test").Page, name: string) {
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name, exact: true }).click();
  }
}

/**
 * Regression test for the "circles vanish on selection" bug.
 *
 * The map drew all control circles with no selection, but selecting a
 * class/course/control anywhere hid every circle and code label — only
 * the leg lines remained. Cause: `course.controlCoordinates` exposed
 * `seq` as the overlay id while the selection filters compare punch
 * codes, so on any fresh event (seq 1,2,3… vs codes 31+) the
 * "show only relevant" filter matched nothing.
 *
 * The imported test.ocd controls get their seq from allocate_event_seq()
 * (guaranteed ≠ code), which is exactly the state that triggered the bug.
 * We assert on the SVG code labels rather than <circle> elements because
 * a highlighted course with geometry legitimately renders controls as
 * broken-circle <path>s — but the code label is drawn for every visible
 * control in both states.
 */
test.describe("Map control visibility with active selection", () => {
  test("control code labels stay visible when a course is selected", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Courses");
    await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });

    // ── Import courses from test.ocd (append mode) so the event has
    // controls WITH coordinates and seq ≠ code.
    await page.getByRole("button", { name: "Import courses" }).click();
    await expect(page.getByText("Import Courses (IOF XML or OCAD OCD)")).toBeVisible();

    const importChooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    const importChooser = await importChooserPromise;
    await importChooser.setFiles("e2e/test.ocd");
    await expect(page.getByText("Courses and Class Assignments")).toBeVisible({ timeout: 20000 });

    // Course "E" gets a heuristic suggestion for seed class "Öppen 1";
    // reset it to Skip so the seed class keeps its course assignment.
    const eDropdown = page.getByRole("button", { name: "Öppen 1" });
    await expect(eDropdown).toBeVisible();
    await eDropdown.click();
    await page
      .getByRole("row", { name: /^E / })
      .getByRole("button", { name: "— Skip —", exact: true })
      .click();

    // Append instead of replacing the seed courses.
    await page.getByTestId("course-import-replace-all").uncheck();
    await page.getByRole("button", { name: "Import 5 courses" }).click();
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByText("8 courses")).toBeVisible({ timeout: 5000 });

    // ── Upload the same OCD as the event map so the map viewer renders.
    const mapPanel = page.getByTestId("map-panel");
    const mapChooserPromise = page.waitForEvent("filechooser");
    await mapPanel.getByRole("button", { name: "Upload map" }).click();
    const mapChooser = await mapChooserPromise;
    await mapChooser.setFiles("e2e/test.ocd");

    // Baseline (no selection): the overlay draws code labels for the
    // imported controls.
    const overlayLabels = mapPanel.locator("svg text");
    await expect(overlayLabels.first()).toBeVisible({ timeout: 30000 });

    // ── Select (expand) imported course "A" — this switches the map
    // into "course" filter mode with "show only relevant" on.
    await page.getByRole("cell", { name: "A", exact: true }).click();
    // Generous timeout: the map upload above kicks off server-side tile
    // rendering which can stall API responses for ~10s.
    await expect(page.getByText("Control Sequence")).toBeVisible({ timeout: 30000 });

    // Read the course's real punch codes from the expanded editor.
    const codesStr = await page
      .getByPlaceholder("e.g. 67;39;78;53;44;50;")
      .inputValue();
    const codes = codesStr.split(";").map((s) => s.trim()).filter(Boolean);
    expect(codes.length).toBeGreaterThan(3);

    // Regression: the selected course's controls must keep their code
    // labels (and thus their circles) on the map. Before the fix the
    // selection filter hid every regular control.
    for (const code of codes.slice(0, 3)) {
      await expect(
        overlayLabels.filter({ hasText: new RegExp(`^${code}$`) }).first(),
      ).toBeVisible({ timeout: 10000 });
    }

    // Controls NOT on course A are filtered out ("show only relevant"),
    // so the label count should be less than the full control set.
    const visibleCount = await overlayLabels.count();
    expect(visibleCount).toBeGreaterThanOrEqual(codes.length - 1);

    // ── Regression: the map toolbar used to share the header's z-10, so
    // its "Show progress" / "Hide descriptions" buttons painted straight
    // through an open More menu. The dashboard is where they live, and it
    // now has a map thanks to the upload above.
    await clickTab(page, "Dashboard");
    await expect(page.getByTestId("map-toolbar")).toBeVisible({ timeout: 30000 });
    const stacking = await page.evaluate(() => {
      const zOf = (el: Element | null) =>
        el ? Number.parseInt(getComputedStyle(el).zIndex, 10) : Number.NaN;
      return {
        header: zOf(document.querySelector("header")),
        toolbar: zOf(document.querySelector('[data-testid="map-toolbar"]')),
      };
    });
    expect(stacking.toolbar).toBeGreaterThan(0);
    expect(stacking.header).toBeGreaterThan(stacking.toolbar);

    await page.getByTestId("more-menu-button").click();
    const menu = page.getByTestId("more-menu-content");
    await expect(menu).toBeVisible();
    const lastItem = menu.getByRole("link").last();
    const box = await lastItem.boundingBox();
    expect(box).not.toBeNull();
    const hitsTheMenu = await page.evaluate(
      ({ x, y }) =>
        Boolean(
          document
            .elementFromPoint(x, y)
            ?.closest('[data-testid="more-menu-content"]'),
        ),
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(hitsTheMenu).toBe(true);
  });
});
