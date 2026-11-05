/**
 * Course editor bootstrap on a fresh event:
 *
 *   - With a map but ZERO controls, empty-map clicks must still resolve
 *     (the mm↔WGS84 affine comes from the map's calibration metadata,
 *     not from existing control positions — regression for the "clicking
 *     the map does nothing on a new event" bug).
 *   - Start and finish controls can be placed from the action bar
 *     (code-less rows, auto-named Start N / Mål N).
 *   - Multiple starts: a course can be pointed at a specific start.
 */
import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { waitForTrpc } from "./helpers/trpc";
import { clickMap, emptyPoint, newCourse, selectedCode, viewSettled } from "./helpers/editor";

test.describe("editor start/finish on a fresh event", () => {
  test.beforeAll(async () => {
    await reseed();
  });

  test("place start/control/finish from scratch, reassign multi-start", async ({
    page,
  }) => {
    // The map upload waits up to 60 s for the map's import, which the
    // 30 s default would cut short.
    test.setTimeout(120_000);
    const stamp = Date.now();
    const eventName = `E2E StartFinish ${stamp}`;

    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(eventName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    // Upload the map — the event has no controls at all.
    const mapPanel = page.getByTestId("map-panel").first();
    const chooserPromise = page.waitForEvent("filechooser");
    await mapPanel.getByRole("button", { name: "Upload map" }).click();
    await (await chooserPromise).setFiles("e2e/test.ocd");
    await expect(page.getByTestId("map-viewer").first()).toBeVisible({
      timeout: 60000,
    });

    await clickTab(page, "Course Editor");
    // The new editor (the stack is `vector`, docs/map-pipeline-switch.md §5).
    // No sites yet, so `editorReady` (which waits for one) does not apply.
    await expect(page.getByTestId("editor-page")).toBeVisible({ timeout: 15000 });
    const viewer = page.getByTestId("map-viewer");
    await expect(viewer).toHaveAttribute("data-editor-hit", "shared", { timeout: 60000 });
    await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-ready", "true", {
      timeout: 60000,
    });

    // A click on the empty map must produce a phantom even though no
    // control exists to derive the transform from.
    await clickEmptySpot(page);
    await page.getByTestId("editor-action-add-start").click();
    await expect(siteByCode(page, "Start 1")).toBeAttached({ timeout: 15000 });
    await page.keyboard.press("Escape");

    await clickEmptySpot(page);
    await page.getByTestId("editor-action-add-finish").click();
    await expect(siteByCode(page, "Mål 1")).toBeAttached({ timeout: 15000 });
    await page.keyboard.press("Escape");

    // Create a course and add one numbered control to it.
    await newCourse(page, "Bana A");

    await clickEmptySpot(page);
    const created = waitForTrpc(page, "control.create");
    await page.getByTestId("editor-action-add-to-course").click();
    await created;
    await expect(selectedCode(page)).toBeVisible({ timeout: 15000 });
    await page.keyboard.press("Escape");

    // Sequence shows start + control + finish.
    const start1 = await siteId(page, "Start 1");
    const finish1 = await siteId(page, "Mål 1");
    const seqRows = page.getByTestId("editor-seq-row");
    await expect(seqRows).toHaveCount(3, { timeout: 15000 });
    await expect(seqRows.nth(0)).toHaveAttribute("data-kind", "start");
    await expect(seqRows.nth(0)).toHaveAttribute("data-control-id", start1);
    await expect(seqRows.nth(1)).toHaveAttribute("data-kind", "control");
    await expect(seqRows.nth(2)).toHaveAttribute("data-kind", "finish");
    await expect(seqRows.nth(2)).toHaveAttribute("data-control-id", finish1);

    // Second start; the freshly placed control is selected, so the
    // action bar directly offers assigning it to the selected course.
    await clickEmptySpot(page);
    await page.getByTestId("editor-action-add-start").click();
    await expect(siteByCode(page, "Start 2")).toBeAttached({ timeout: 15000 });
    const start2 = await siteId(page, "Start 2");
    await page.getByTestId("editor-action-use-as-start").click();
    await expect(seqRows.nth(0)).toHaveAttribute("data-control-id", start2, {
      timeout: 15000,
    });

    // Undo the assignment → back to the default Start 1.
    await page.getByTestId("editor-undo").click();
    await expect(seqRows.nth(0)).toHaveAttribute("data-control-id", start1, {
      timeout: 15000,
    });
  });
});

async function clickTab(page: Page, name: string) {
  const mainTab = page
    .locator("nav[aria-label='Tabs']")
    .getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page
      .getByTestId("more-menu-content")
      .getByRole("link", { name, exact: true })
      .click();
  }
}

/** An editor site by its code or start / finish name (the viewer's `editor-site` mirror). */
function siteByCode(page: Page, code: string) {
  return page.locator(`[data-testid="editor-site"][data-control-code="${code}"]`);
}

async function siteId(page: Page, code: string): Promise<string> {
  return (await siteByCode(page, code).getAttribute("data-control-id"))!;
}

/**
 * Click a map point away from every site, leg and the editor's chrome; a
 * phantom appears. With one or two sites the editor's fit zooms far in and
 * a start triangle or finish ring spans a few hundred px, more than
 * `emptyPoint`'s clearance: zoom out until 6 mm of paper is at most 100 px.
 */
async function clickEmptySpot(page: Page) {
  const viewer = page.getByTestId("map-viewer");
  for (let i = 0; i < 6; i++) {
    await viewSettled(page);
    if (Number(await viewer.getAttribute("data-px-per-um")) * 6000 <= 100) break;
    await viewer.getByTitle("Zoom out").click();
  }
  await clickMap(page, await emptyPoint(page));
  await expect(page.getByTestId("editor-phantom")).toBeAttached({
    timeout: 10000,
  });
}
