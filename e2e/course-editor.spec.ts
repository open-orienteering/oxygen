// The new course editor on the GL canvas (docs/course-editor.md), mounted
// for `vector ∧ pinned ∧ map.editor.vector` (docs/map-pipeline-switch.md
// §3.6). D4 starts it with the parity flows; D10 completes it and moves it
// under the `map-vector` project — until then the spec sets the event
// pipeline and the flag itself. The legacy page's spec is
// `course-editor-legacy.spec.ts`.
import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { setEditorVector, setMapPipeline } from "./helpers/map-pipeline";
import { clickMap, drag, editorReady, emptyPoint, legMidpoint, legPieces, site, sitePoint, sites, toPage } from "./helpers/editor";
import { waitForTrpc } from "./helpers/trpc";

test.beforeAll(async () => {
  await reseed();
  await setMapPipeline("vector");
  await setEditorVector(true);
});

test.afterAll(async () => {
  await setEditorVector(null);
  await setMapPipeline("legacy");
});

test.setTimeout(120_000);

async function selectCompetition(page: Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
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

/** Courses and controls from `e2e/test.ocd` (append) and the same file as the event map — once per seed. */
async function ensureCoursesAndMap(page: Page) {
  await clickTab(page, "Courses");
  const uploadButton = page.getByRole("button", { name: "Upload map" });
  const viewer = page.getByTestId("map-viewer");
  await expect(uploadButton.or(viewer).first()).toBeVisible({ timeout: 60000 });
  if (!(await uploadButton.isVisible())) return;
  await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Import courses" }).click();
  const importChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await importChooser).setFiles("e2e/test.ocd");
  await expect(page.getByText("Courses and Class Assignments")).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Öppen 1" }).click();
  await page.getByRole("row", { name: /^E / }).getByRole("button", { name: "— Skip —", exact: true }).click();
  await page.getByTestId("course-import-replace-all").uncheck();
  await page.getByRole("button", { name: "Import 5 courses" }).click();
  await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Done" }).click();
  const mapChooser = page.waitForEvent("filechooser");
  await page.getByTestId("map-panel").getByRole("button", { name: "Upload map" }).click();
  await (await mapChooser).setFiles("e2e/test.ocd");
  await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
}

async function openEditor(page: Page, query = "") {
  await selectCompetition(page);
  await ensureCoursesAndMap(page);
  if (query) {
    const nameId = new URL(page.url()).pathname.split("/")[1];
    await page.goto(`/${nameId}/course-editor${query}`);
  } else {
    await clickTab(page, "Course Editor");
  }
  await editorReady(page);
}

const selectedCode = (page: Page) => page.getByTestId("editor-selected-code");
const selectedPosition = (page: Page) => page.getByTestId("editor-selected-position");
const controlRows = (page: Page) => page.locator('[data-testid="editor-seq-row"][data-kind="control"]');

/** Regular (numeric-code) controls whose page points are inside the viewer and clear of the chrome. */
async function regularCodes(page: Page, n: number): Promise<string[]> {
  const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
  const inspector = await page.getByTestId("editor-inspector").boundingBox();
  const out: string[] = [];
  for (const s of await sites(page)) {
    if (s.type !== "Control" || !/^\d+$/.test(s.code)) continue;
    const p = await toPage(page, s.mm);
    if (p.x < viewer.x + 30 || p.x > viewer.x + viewer.width - 90 || p.y < viewer.y + 30 || p.y > viewer.y + viewer.height - 30) continue;
    if (inspector && p.x < inspector.x + inspector.width + 40) continue;
    out.push(s.code);
    if (out.length === n) break;
  }
  return out;
}

test.describe("Course editor (new, GL canvas)", () => {
  test("mounts behind map.editor.vector; the legacy page otherwise", async ({ page }) => {
    await setEditorVector(false);
    try {
      await selectCompetition(page);
      await ensureCoursesAndMap(page);
      await clickTab(page, "Course Editor");
      await expect(page.getByTestId("course-editor-page")).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId("editor-page")).toHaveCount(0);
    } finally {
      await setEditorVector(true);
    }
    await page.reload();
    await editorReady(page);
    await expect(page.getByTestId("course-editor-page")).toHaveCount(0);
    // The shell: top bar, V-only tool rail, inspector, status bar; Layout / Field shown, not enterable.
    for (const id of ["editor-top-bar", "editor-tool-rail", "editor-inspector", "editor-status"]) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-mode-layout")).toBeDisabled();
    // No SVG hit targets: the viewer hit-tests the layer's shapes.
    await expect(page.getByTestId("editor-control-hit")).toHaveCount(0);
  });

  test("place, move, undo / redo, persist and delete a control", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());
    await openEditor(page);

    const spot = await emptyPoint(page);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
    const bar = page.getByTestId("editor-action-bar");
    await expect(bar).toBeVisible();
    await bar.getByTestId("editor-action-add").click();

    await expect(selectedCode(page)).toBeVisible({ timeout: 15000 });
    const code = ((await selectedCode(page).textContent()) ?? "").match(/\d+/)![0];
    await expect.poll(async () => (await sites(page)).some((s) => s.code === code), { timeout: 15000 }).toBe(true);
    const placed = (await selectedPosition(page).textContent()) ?? "";

    // Move: drag the new control to another empty spot; the stored position changes.
    await page.keyboard.press("Escape");
    const from = await sitePoint(page, code);
    const dest = await emptyPoint(page, 40, [from]);
    await drag(page, from, dest);
    await expect(selectedCode(page)).toContainText(code, { timeout: 15000 });
    await expect(selectedPosition(page)).not.toHaveText(placed, { timeout: 15000 });
    const moved = (await selectedPosition(page).textContent()) ?? "";

    // Undo puts it back where it was placed (no snap-back bridge masking it), redo moves it again.
    await page.getByTestId("editor-undo").click();
    await expect(selectedPosition(page)).toHaveText(placed, { timeout: 15000 });
    await expect.poll(async () => {
      const p = await sitePoint(page, code);
      return Math.hypot(p.x - from.x, p.y - from.y);
    }, { timeout: 15000 }).toBeLessThan(5);
    await page.keyboard.press("Control+Shift+Z");
    await expect(selectedPosition(page)).toHaveText(moved, { timeout: 15000 });

    // Persist: reload, select it by clicking its circle on the canvas.
    await page.reload();
    await editorReady(page);
    await clickMap(page, await sitePoint(page, code));
    await expect(selectedCode(page)).toContainText(code, { timeout: 10000 });
    await expect(selectedPosition(page)).toHaveText(moved);

    // Delete from the action bar.
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-delete").click();
    await expect.poll(async () => (await sites(page)).some((s) => s.code === code), { timeout: 15000 }).toBe(false);
  });

  test("build a course: append, add on the map, reorder, insert on a leg, remove, undo, persist", async ({ page }) => {
    await openEditor(page);
    const name = `D4 ${Date.now() % 100000}`;
    await page.getByTestId("editor-new-course-name").fill(name);
    const created = waitForTrpc(page, "course.create");
    await page.getByTestId("editor-create-course").click();
    await created;
    await expect(page.getByTestId("editor-course-picker").locator("option:checked")).toHaveText(name, { timeout: 10000 });
    await expect(page.getByTestId("editor-sequence")).toBeVisible();

    // Append two existing controls through the action bar. Escape drops the
    // selection after each, so its action bar cannot cover the next control.
    const [a, b] = await regularCodes(page, 2);
    for (const code of [a, b]) {
      await clickMap(page, await sitePoint(page, code));
      await expect(selectedCode(page)).toContainText(code, { timeout: 10000 });
      const saved = waitForTrpc(page, "course.setStructure");
      await page.getByTestId("editor-action-bar").getByTestId("editor-action-append").click();
      await saved;
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
    }
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a);

    // Create-and-append on empty map: one undo entry.
    const spot = await emptyPoint(page);
    await page.mouse.click(spot.x, spot.y);
    const saved = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-add-to-course").click();
    await saved;
    await expect(controlRows(page)).toHaveCount(3, { timeout: 15000 });

    // Reorder: the first control moves down.
    await controlRows(page).nth(0).getByTestId("editor-seq-down").click();
    await expect(controlRows(page).nth(1)).toHaveAttribute("data-control-id", a, { timeout: 15000 });
    // Undo the reorder.
    await page.keyboard.press("Control+z");
    await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a, { timeout: 15000 });

    // Insert on a leg: click the middle of the leg a → b on the canvas.
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await legPieces(page, name)).length, { timeout: 15000 }).toBeGreaterThan(1);
    const mid = await legMidpoint(page, name, (await site(page, a)).mm, (await site(page, b)).mm);
    await clickMap(page, await toPage(page, mid));
    const inserted = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-insert").click();
    await inserted;
    await expect(controlRows(page)).toHaveCount(4, { timeout: 15000 });
    await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a);
    await expect(controlRows(page).nth(2)).toHaveAttribute("data-control-id", b);

    // Remove one row; persist across a reload with the deep link.
    await controlRows(page).nth(3).getByTestId("editor-seq-remove").click();
    await expect(controlRows(page)).toHaveCount(3, { timeout: 15000 });
    const courseId = await page.getByTestId("editor-course-picker").inputValue();
    const nameId = new URL(page.url()).pathname.split("/")[1];
    await page.goto(`/${nameId}/course-editor?course=${courseId}`);
    await editorReady(page);
    await expect(controlRows(page)).toHaveCount(3, { timeout: 15000 });
    await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a);
    // The structure is explicit now: a start and a finish row around the controls.
    await expect(page.locator('[data-testid="editor-seq-row"][data-kind="start"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="editor-seq-row"][data-kind="finish"]')).toHaveCount(1);
  });

  test("deep links, H hides other controls, Escape steps back", async ({ page }) => {
    await openEditor(page);
    const [code] = await regularCodes(page, 1);
    const firstCourse = await page.getByTestId("editor-course-picker").locator("option").nth(1).getAttribute("value");
    const nameId = new URL(page.url()).pathname.split("/")[1];
    await page.goto(`/${nameId}/course-editor?course=${firstCourse}&control=${code}`);
    await editorReady(page);
    await expect(page.getByTestId("editor-course-picker")).toHaveValue(firstCourse!);
    await expect(selectedCode(page)).toContainText(code, { timeout: 10000 });

    const hide = page.getByTestId("editor-hide-others");
    await expect(hide).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("h");
    await expect(hide).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("h");
    await expect(hide).toHaveAttribute("aria-pressed", "false");

    // Escape: the control, then the course.
    await page.keyboard.press("Escape");
    await expect(selectedCode(page)).toHaveCount(0);
    await expect(page.getByTestId("editor-course-picker")).toHaveValue(firstCourse!);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-course-picker")).toHaveValue("");
  });
});
