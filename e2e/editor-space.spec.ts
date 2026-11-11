// The editor fills a laptop screen (docs/course-editor.md §2 "The editor
// fills the window", F28; feedback-2026-11-11-merge.md item 1). Outside
// fullscreen the shell gives the `course-editor` route the wide container at
// every viewport, and the editor takes the viewport's height less the
// shell's header and the container's padding, so the page is one screen
// with no band under the editor. Every other route keeps `max-w-7xl`
// (1280 px) below 2200 px.
import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { nameIdOf, openEditor } from "./helpers/editor";

test.beforeAll(reseed);

test.setTimeout(120_000);

/** The user's laptop screenshot (2026-11-11). */
const LAPTOP = { width: 1840, height: 1090 };
/** The shell's side padding at `lg`: `lg:px-8`, 32 px each side. */
const SIDE_PADDING = 64;

async function box(page: Page, testId: string) {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return b;
}

/** The header's inner row: `w-full` on the editor, `max-w-7xl` elsewhere. */
async function headerInnerWidth(page: Page) {
  const b = await page.getByTestId("shell-header-inner").boundingBox();
  if (!b) throw new Error("the header's inner row has no box");
  return b.width;
}

test.describe("Editor space (F28)", () => {
  test.use({ viewport: LAPTOP });

  test("the editor spans the width and reaches the bottom of a 1840 × 1090 screen; other routes stay boxed", async ({ page }) => {
    await openEditor(page);
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-layout", "desktop");

    const editor = await box(page, "editor-page");
    // Wide: only the shell's side padding is left.
    expect(editor.width).toBeGreaterThanOrEqual(LAPTOP.width - SIDE_PADDING);
    // Tall: its bottom sits at the viewport's, less the container's bottom padding (12 px).
    const bottom = editor.y + editor.height;
    expect(bottom).toBeGreaterThanOrEqual(LAPTOP.height - 16);
    expect(bottom).toBeLessThanOrEqual(LAPTOP.height);
    // And the page does not scroll: the editor is the viewport less the real chrome.
    const overflow = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    expect(overflow).toBeLessThanOrEqual(0);
    // The header's row follows the container.
    expect(await headerInnerWidth(page)).toBeGreaterThanOrEqual(LAPTOP.width - SIDE_PADDING);

    // Every other route keeps the 1280 px container.
    await page.goto(`/${nameIdOf(page)}/courses`);
    await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
    expect((await box(page, "shell-container")).width).toBeLessThanOrEqual(1280);
    expect(await headerInnerWidth(page)).toBeLessThanOrEqual(1280);
  });
});
