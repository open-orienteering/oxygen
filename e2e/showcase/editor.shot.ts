/**
 * The course editor: the README hero, layout mode with the printed page, and
 * map mode.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { sites, toPage } from "../helpers/editor";
import { changesData, clearScratch, EVENT, mapDrawn, OUT_DIR, pickCourse, PRIVATE, SCRATCH_DIR, selectEvent, shot, showcaseGuards } from "./shot";

showcaseGuards();

/**
 * Zoom the map in about the view centre with the viewer's own button and
 * shoot the viewer alone; with `select`, first click the control nearest the
 * centre, so its action menu shows.
 */
async function closeUp(page: Page, name: string, steps: number, select = false): Promise<void> {
  const viewer = page.getByTestId("map-viewer");
  // The map alone: no description sheet on it, no panels over it.
  const hide = page.getByRole("button", { name: "Hide descriptions" });
  if (await hide.count()) await hide.first().click();
  await page.addStyleTag({ content: `[data-testid="editor-inspector"], [data-testid="editor-tool-rail"] { visibility: hidden !important; }` });
  for (let i = 0; i < steps; i++) {
    await viewer.getByRole("button", { name: "Zoom in" }).first().click();
    await page.waitForTimeout(400);
  }
  await mapDrawn(page);
  await page.waitForTimeout(1000);
  if (select) {
    const box = (await viewer.boundingBox())!;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    let best: { at: { x: number; y: number }; d: number } | null = null;
    for (const s of await sites(page)) {
      if (s.type !== "Control") continue;
      const at = await toPage(page, s.mm);
      const d = Math.hypot(at.x - centre.x, at.y - centre.y);
      if (!best || d < best.d) best = { at, d };
    }
    if (!best) throw new Error("no control in view to select");
    await page.mouse.click(best.at.x, best.at.y);
    await expect(page.getByTestId("editor-action-bar")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
  }
  await shot(page, name, viewer);
}

async function openEditor(page: Page, query = ""): Promise<void> {
  await selectEvent(page);
  // The contour interval banner (docs/course-elevation.md §0.43) is not part of a showcase shot: it is dismissed as a person would.
  await page.addInitScript((key) => { try { window.sessionStorage.setItem(key, "1"); } catch { /* not remembered */ } }, `oxygen:interval-banner-dismissed:${EVENT}`);
  await page.goto(`/${EVENT}/course-editor${query}`);
  await expect(page.getByTestId("editor-page")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("editor-site").first()).toBeAttached({ timeout: 60_000 });
  await mapDrawn(page);
}

test("course editor (hero)", async ({ page }) => {
  await openEditor(page);
  await pickCourse(page);
  await page.waitForTimeout(1000);
  await shot(page, "course-editor");
  await closeUp(page, "course-editor-closeup", 2, true);
});

test("layout mode and the printed page", async ({ page }) => {
  await openEditor(page);
  await pickCourse(page);
  await page.getByTestId("editor-mode-layout").click();
  await expect(page).toHaveURL(/[?&]mode=layout/);
  const create = page.getByText("Create sheet", { exact: true });
  const sheetName = page.getByTestId("editor-layout-sheet-name");
  await expect(create.or(sheetName).first()).toBeVisible({ timeout: 30_000 });
  if (await create.isVisible()) {
    changesData();
    await create.click();
    await expect(sheetName).toBeVisible({ timeout: 30_000 });
  }
  await mapDrawn(page);
  await page.waitForTimeout(1500);
  await shot(page, "course-editor-layout");

  // The printed result: Export ▾ This sheet, its page as a PNG (pdftoppm, from poppler).
  await page.getByTestId("editor-export").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("editor-export-sheet").click()]);
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const pdf = path.join(SCRATCH_DIR, "sheet.pdf");
  await download.saveAs(pdf);
  try {
    execFileSync("pdftoppm", ["-png", "-r", "110", "-singlefile", pdf, path.join(OUT_DIR, "course-map-print")]);
    console.log(`  ${path.relative(path.resolve(OUT_DIR, "..", ".."), path.join(OUT_DIR, "course-map-print.png"))} (from the exported PDF)`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // Without poppler the shot is missing, not stale: fail a public run, warn a private one.
    if (!PRIVATE) throw new Error("pdftoppm (poppler) is needed for course-map-print.png");
    console.warn("  pdftoppm not found: course-map-print.png skipped");
  } finally {
    clearScratch();
  }
});

test("map mode", async ({ page }) => {
  await openEditor(page, "?mode=map");
  await page.waitForTimeout(1000);
  await shot(page, "course-editor-map-mode");
  await closeUp(page, "map-closeup", 3);
});
