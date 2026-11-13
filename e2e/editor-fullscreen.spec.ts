// Fullscreen in the new course editor (docs/course-editor.md §3): the map
// panel locks Escape (Keyboard Lock API) once per fullscreen session, not
// once per editor render — each re-lock made Chrome show its "press Esc to
// exit full screen" bubble again on every hover with an armed tool
// (docs/bugfix-fullscreen-bubble-flicker.md). Kept apart from
// `course-editor.spec.ts` until D10 folds the editor specs together.
import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { editorReady, emptyPoint } from "./helpers/editor";

test.beforeAll(reseed);

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

/** Courses and controls from `e2e/test.ocd` and the same file as the event map (as `course-editor.spec.ts`). */
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

/** Keyboard Lock call counts, recorded by the stub `addInitScript` installs. */
const lockCounts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __kbLock: { lock: number; unlock: number } }).__kbLock);

test("fullscreen locks Escape once; hovering with an armed tool does not re-lock", async ({ page }) => {
  // Count the Keyboard Lock calls (the API itself is Chromium-only and invisible to the test otherwise).
  await page.addInitScript(() => {
    const counts = { lock: 0, unlock: 0 };
    (window as unknown as { __kbLock: typeof counts }).__kbLock = counts;
    Object.defineProperty(Navigator.prototype, "keyboard", {
      configurable: true,
      get: () => ({ lock: async () => { counts.lock += 1; }, unlock: () => { counts.unlock += 1; } }),
    });
  });
  await selectCompetition(page);
  await ensureCoursesAndMap(page);
  await clickTab(page, "Course Editor");
  await editorReady(page);

  const firstCourse = await page.getByTestId("editor-course-picker").locator("option").nth(1).getAttribute("value");
  await page.getByTestId("editor-course-picker").selectOption(firstCourse!);
  await expect(page.getByTestId("editor-sequence")).toBeVisible({ timeout: 15000 });

  await page.getByTestId("map-panel").getByRole("button", { name: /^(enter )?fullscreen$/i }).first().click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement), { timeout: 10000 }).toBe(true);
  await expect.poll(() => lockCounts(page)).toEqual({ lock: 1, unlock: 0 });

  // An armed tool re-renders the editor on every pointer move (the ghost follows the cursor).
  await page.keyboard.press("k");
  await expect(page.getByTestId("editor-tool-K")).toHaveAttribute("aria-pressed", "true");
  const spots = [await emptyPoint(page, 40)];
  for (let i = 1; i < 8; i++) spots.push(await emptyPoint(page, 30, spots));
  for (const p of spots) {
    await page.mouse.move(p.x, p.y);
    await expect(page.getByTestId("editor-ghost-label")).toBeAttached({ timeout: 10000 });
  }
  expect(await lockCounts(page)).toEqual({ lock: 1, unlock: 0 });

  // Escape leaves the tool, not fullscreen; the lock stays.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  expect(await lockCounts(page)).toEqual({ lock: 1, unlock: 0 });

  // The map-info dialog (P6, docs/course-editor.md §2) opens inside the fullscreen element; Escape closes it and
  // stays in fullscreen.
  await page.getByTestId("editor-map-info").click();
  await expect(page.getByTestId("editor-map-info-dialog")).toBeVisible();
  expect(await page.evaluate(() => !!document.fullscreenElement?.querySelector('[data-testid="editor-map-info-dialog"]'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("editor-map-info-dialog")).toHaveCount(0);
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);

  // Leaving fullscreen releases it once.
  await page.getByTestId("map-panel").getByRole("button", { name: /^exit fullscreen$/i }).first().click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement), { timeout: 10000 }).toBe(false);
  await expect.poll(() => lockCounts(page)).toEqual({ lock: 1, unlock: 1 });
});
