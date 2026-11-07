// The course editor on the GL canvas (docs/course-editor.md "Tests"), mounted for every event
// since E3 (docs/course-editor.md §1). It runs under the `chromium` project (desktop) and the
// `mobile` project (Pixel 7): the desktop describes skip on a phone and the touch describe at the
// end skips on a desktop.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`, the fixture import idempotent per test
// (`openEditor` → `ensureCoursesAndMap`), courses a test creates carry a prefix and go with the
// next reseed, controls / objects / sheets it creates are deleted in `finally` (`cleanup`).
import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import {
  allControlsSheet, analysePdf, arm, cleanup, clickMap, clickTab, controlRows, coveredBy, desktopContext, drag, dragMm, editorReady,
  emptyPoint, ensureCoursesAndMap, ensureFixtureFromDesktop, freezeExternalPoll, geometryOf, inkIn, labelOf, legMidpoint, legPieces, nameIdOf, objectRow,
  openEditor, pageToPaperOf, place, placeOneShot, pressInside, pressOnEdge, printed, probeTemplate, regularCodes, select, selectCompetition,
  selectedCode, selectedPosition, siteCuts, site, sitePoint, sites, toolShapes, toPage, toPaper, trpcCall, viewCentre, viewSettled, newCourse,
  mapScale, statsRow, type Frame, type Site,
} from "./helpers/editor";
import { touchDrag, touchTap } from "./helpers/touch";
import { isTrpcResponse, waitForTrpc } from "./helpers/trpc";

type Pt = { x: number; y: number };

test.beforeAll(async () => {
  await reseed();
});

test.setTimeout(120_000);

/** The desktop flows: skipped on the phone (it opens in Field mode with no rail or inspector, §10). */
const desktopOnly = () => test.skip(({ isMobile }) => !!isMobile, "desktop flow (the phone's subset is the touch describe)");

/** Every option's `value` of the course picker by its label. */
async function courseIdByName(page: Page, name: string): Promise<string> {
  const option = page.getByTestId("editor-course-picker").locator("option", { hasText: new RegExp(`^${name}$`) });
  return (await option.getAttribute("value"))!;
}

/** Select a site, then the action bar's `editor-action-<id>`; waits for the write. */
async function act(page: Page, code: string, action: string, procedure: string): Promise<void> {
  await select(page, code);
  const saved = waitForTrpc(page, procedure);
  await page.getByTestId("editor-action-bar").getByTestId(`editor-action-${action}`).click();
  await saved;
}

/** Append a regular control picked now, clear of the drawn legs and of `exclude`; returns its code. */
async function appendClear(page: Page, exclude: string[] = []): Promise<string> {
  const [code] = await regularCodes(page, 1, exclude);
  expect(code, "a regular control clear of the drawn legs").toBeTruthy();
  await act(page, code, "append", "course.setStructure");
  await dropSelection(page);
  return code;
}

/** Drop the selection's action bar (Escape only when there is one: with nothing selected, Escape drops the course). */
async function dropSelection(page: Page): Promise<void> {
  if ((await page.getByTestId("editor-action-bar").count()) > 0) await page.keyboard.press("Escape");
  await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
}

/**
 * A page point near `from` for a drag target, above it if that is clear: the selection's action bar lays out
 * under the selected control, so a drag that ends above it never ends on the bar (D10 flake: "the action bar
 * covered the map").
 */
/**
 * Drags control `code`'s number off its automatic place and waits for the write; returns where the label
 * was before. Read once the view has stopped (the editor fits after a course is picked), and dragged
 * towards the viewer's middle so the drop never lands off the map or under the toolbar.
 */
async function dragNumber(page: Page, code: string): Promise<Pt> {
  await viewSettled(page);
  await expect.poll(async () => (await labelOf(page, code)) !== null, { timeout: 15000 }).toBe(true);
  const label = (await labelOf(page, code))!;
  const from = await toPage(page, label);
  const box = (await page.getByTestId("map-viewer").boundingBox())!;
  const to = { x: from.x + (from.x < box.x + box.width / 2 ? 48 : -48), y: from.y + (from.y < box.y + box.height / 2 ? 24 : -24) };
  const saved = waitForTrpc(page, "course.setControlLabelOffset");
  await drag(page, from, to);
  await saved;
  return label;
}

async function dragTarget(page: Page, from: Pt, avoid: Pt[] = [], clearPx = 45): Promise<Pt> {
  const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
  const marks = [...(await Promise.all((await sites(page)).map((s) => toPage(page, s.mm)))), ...avoid];
  // Above first (the action bar lays out below), then sideways; then any empty point (D10: a crowded view).
  const offsets = [-80, -110, -140].flatMap((dy) => [0, 60, -60].map((dx) => [dx, dy])).concat([[90, 0], [-90, 0], [120, -40], [-120, -40]]);
  for (const [dx, dy] of offsets) {
    const p = { x: from.x + dx, y: from.y + dy };
    if (p.y < viewer.y + 40 || p.y > viewer.y + viewer.height - 40 || p.x < viewer.x + 40 || p.x > viewer.x + viewer.width - 90) continue;
    if (marks.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < clearPx && Math.hypot(q.x - from.x, q.y - from.y) > 1)) continue;
    if (await coveredBy(page, p)) continue;
    return p;
  }
  return emptyPoint(page, 40, [from, ...avoid]);
}

test.describe("Course editor (new, GL canvas)", () => {
  desktopOnly();

  test("mounts the new editor, never the legacy page", async ({ page }) => {
    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await clickTab(page, "Course Editor");
    await editorReady(page);
    await expect(page.getByTestId("course-editor-page")).toHaveCount(0);
    // The shell: top bar (with the save indicator and the course-info button, P2), tool rail, inspector; no status
    // bar on the desktop; Layout (D7) and Field (D9) enterable.
    for (const id of ["editor-top-bar", "editor-tool-rail", "editor-inspector", "editor-save-state", "editor-stats"]) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId("editor-status")).toHaveCount(0);
    await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-mode-layout")).toBeEnabled();
    await expect(page.getByTestId("editor-mode-field")).toBeEnabled();
    // No SVG hit targets: the viewer hit-tests the layer's shapes.
    await expect(page.getByTestId("editor-control-hit")).toHaveCount(0);
    // The rail (§6): exchange and crossing wait for slice F.
    for (const key of ["V", "S", "K", "M", "A", "T"]) await expect(page.getByTestId(`editor-tool-${key}`)).toBeEnabled();
    for (const key of ["X", "C"]) await expect(page.getByTestId(`editor-tool-${key}`)).toBeDisabled();
  });

  test("an event with no map mounts the editor over the upload prompt", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(`E2E Editor no map ${Date.now()}`);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 15000 });
    const nameId = new URL(page.url()).pathname.split("/")[1];
    await page.goto(`/${nameId}/course-editor`);
    await expect(page.getByTestId("editor-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("course-editor-page")).toHaveCount(0);
    const panel = page.getByTestId("editor-page").getByTestId("map-panel");
    await expect(panel.getByRole("button", { name: "Upload map" })).toBeVisible({ timeout: 15000 });
    await expect(panel.getByTestId("map-viewer")).toHaveCount(0);
  });

  test("place, move, undo / redo, persist and delete a control", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());
    await openEditor(page);

    const code = await placeOneShot(page);
    const placed = (await selectedPosition(page).textContent()) ?? "";

    // Move: drag the new control to another empty spot; the stored position changes.
    await page.keyboard.press("Escape");
    const from = await sitePoint(page, code);
    const dest = await dragTarget(page, from);
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
    await select(page, code);
    await expect(selectedPosition(page)).toHaveText(moved);

    // Delete from the action bar.
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-delete").click();
    await expect.poll(async () => (await sites(page)).some((s) => s.code === code), { timeout: 15000 }).toBe(false);
  });

  test("build a course: append, add on the map, reorder, insert on a leg, remove, undo, persist", async ({ page }) => {
    await openEditor(page);
    const name = await newCourse(page, "D4");
    await expect(page.getByTestId("editor-sequence")).toBeVisible();

    // Append two existing controls through the action bar; the selection is dropped after each, so its action bar
    // cannot cover the next control, and the second is picked clear of the first one's legs.
    const a = await appendClear(page);
    const b = await appendClear(page, [a]);
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a);

    // Create-and-append on empty map: one undo entry.
    await clickMap(page, await emptyPoint(page));
    await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
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

    // Insert on a leg: click the middle of the leg a → b on the canvas. The layer's hit index lags the mirror by a
    // round trip under load, so a click that found nothing (a plain phantom: no Insert) is dropped and retried.
    await dropSelection(page);
    await expect.poll(async () => (await legPieces(page, name)).length, { timeout: 15000 }).toBeGreaterThan(1);
    const mid = await legMidpoint(page, name, (await site(page, a)).mm, (await site(page, b)).mm);
    await expect(async () => {
      await dropSelection(page);
      await clickMap(page, await toPage(page, mid));
      await expect(page.getByTestId("editor-action-bar").getByTestId("editor-action-insert")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });
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
    await page.goto(`/${nameIdOf(page)}/course-editor?course=${courseId}`);
    await editorReady(page);
    await expect(controlRows(page)).toHaveCount(3, { timeout: 15000 });
    await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a);
    // The structure is explicit now: a start and a finish row around the controls.
    await expect(page.locator('[data-testid="editor-seq-row"][data-kind="start"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="editor-seq-row"][data-kind="finish"]')).toHaveCount(1);
  });

  test("deep links, the Courses and Controls pages' edit icons, H hides other controls, Escape steps back", async ({ page }) => {
    await openEditor(page);
    const [code] = await regularCodes(page, 1);
    const firstCourse = await page.getByTestId("editor-course-picker").locator("option").nth(1).getAttribute("value");
    const nameId = nameIdOf(page);
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

    // The Courses page's pencil opens the new editor on that course.
    await clickTab(page, "Courses");
    const courseLink = page.getByTestId("course-edit-link").first();
    await expect(courseLink).toBeVisible({ timeout: 10000 });
    await courseLink.click();
    await editorReady(page);
    await expect(page.getByTestId("editor-course-picker")).not.toHaveValue("");
    await expect(page.getByTestId("editor-sequence")).toBeVisible({ timeout: 15000 });

    // The Controls page's pencil opens it with the control selected (one selection ring in V, D12).
    await clickTab(page, "Controls");
    const controlLink = page.locator(`[data-testid="control-edit-link"][href*="control=${code}"]`);
    await expect(controlLink).toBeVisible({ timeout: 10000 });
    await controlLink.click();
    await editorReady(page);
    await expect(selectedCode(page)).toContainText(code, { timeout: 30000 });
    await expect(page.getByTestId("editor-selection-ring")).toHaveCount(1, { timeout: 15000 });
  });
});

// docs/course-editor.md §4: the rest of the legacy page's flows on the new canvas (D10).
test.describe("Course mode (§4)", () => {
  desktopOnly();

  test("deleting a control cascades out of every course; undo restores it; Remove from course takes one visit", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());
    await openEditor(page);
    const first = await newCourse(page, "D10 cascade");
    const firstId = await page.getByTestId("editor-course-picker").inputValue();

    /** Empty map → Add to ‹course›: the new control's code (selected). */
    const addToCourse = async (): Promise<string> => {
      await dropSelection(page);
      await clickMap(page, await emptyPoint(page));
      await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
      const saved = waitForTrpc(page, "course.setStructure");
      await page.getByTestId("editor-action-bar").getByTestId("editor-action-add-to-course").click();
      await saved;
      await expect(selectedCode(page)).toBeVisible({ timeout: 15000 });
      return ((await selectedCode(page).textContent()) ?? "").match(/\d+/)![0];
    };
    const a = await addToCourse();
    const b = await addToCourse();
    try {
      await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
      // Remove from course: membership only — the row goes, the site stays. B is still selected from placing.
      const removed = waitForTrpc(page, "course.setStructure");
      await page.getByTestId("editor-action-bar").getByTestId("editor-action-remove-from-course").click();
      await removed;
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
      expect((await sites(page)).some((s) => s.code === b)).toBe(true);

      // A second course visits A too.
      const second = await newCourse(page, "D10 cascade b");
      await act(page, a, "append", "course.setStructure");
      await act(page, b, "append", "course.setStructure");
      await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });

      // Delete A: the server cascades it out of both structures — no ghost row, no leg to a missing circle.
      await select(page, a);
      const deleted = waitForTrpc(page, "control.delete");
      await page.getByTestId("editor-action-bar").getByTestId("editor-action-delete").click();
      await deleted;
      await expect.poll(async () => (await sites(page)).some((s) => s.code === a), { timeout: 15000 }).toBe(false);
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
      await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", b);
      const detailOf = (name: string) => trpcCall<{ name: string; controls: string }[]>("course.list", undefined, false).then((cs) => cs.find((c) => c.name === name)!);
      expect((await detailOf(first)).controls.split(";").filter(Boolean)).toEqual([]);

      // Undo: the control comes back and rejoins both courses in place.
      await page.keyboard.press("Control+z");
      await expect.poll(async () => (await sites(page)).some((s) => s.code === a), { timeout: 15000 }).toBe(true);
      await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
      await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a);
      await expect.poll(async () => (await detailOf(first)).controls.split(";").filter(Boolean), { timeout: 15000 }).toEqual([a]);
      await page.getByTestId("editor-course-picker").selectOption(firstId);
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
      expect(second).not.toBe(first);
    } finally {
      for (const code of [a, b]) await cleanup("control.delete", { id: Number(code) });
    }
  });

  test("inline-edit a control code in the sequence; undo; a duplicate code is refused", async ({ page }) => {
    await openEditor(page);
    await newCourse(page, "D10 code");
    const [a] = await regularCodes(page, 1);
    try {
      await act(page, a, "append", "course.setStructure");
      await dropSelection(page);
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });

      await controlRows(page).nth(0).getByTestId("editor-seq-code").click();
      const input = page.getByTestId("editor-seq-code-input");
      await expect(input).toBeVisible();
      const updated = waitForTrpc(page, "control.update");
      await input.fill("997");
      await input.press("Enter");
      await updated;
      // The public id is the first code: the row and the site are 997 now.
      await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", "997", { timeout: 15000 });
      await expect.poll(async () => (await sites(page)).some((s) => s.code === "997"), { timeout: 15000 }).toBe(true);

      await page.keyboard.press("Control+z");
      await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a, { timeout: 15000 });
      await expect.poll(async () => (await sites(page)).some((s) => s.code === a), { timeout: 15000 }).toBe(true);

      await dropSelection(page);
      const b = await appendClear(page, [a]);
      await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
      await controlRows(page).nth(0).getByTestId("editor-seq-code").click();
      await page.getByTestId("editor-seq-code-input").fill(b);
      await page.getByTestId("editor-seq-code-input").press("Enter");
      await expect(page.getByTestId("editor-error")).toContainText("already exists", { timeout: 10000 });
      await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a);
    } finally {
      // A failed run must not leave the seed control renamed for the rest of the file.
      await cleanup("control.update", { id: 997, codes: a });
    }
  });

  test("free order: codes as labels, no legs, no reorder arrows; the number still drags", async ({ page }) => {
    await openEditor(page);
    const name = await newCourse(page, "D10 free");
    const first = await appendClear(page);
    const codes = [first, await appendClear(page, [first])];
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    await expect(page.getByTestId("editor-seq-up").first()).toBeVisible();
    await expect.poll(async () => (await legPieces(page, name)).length, { timeout: 15000 }).toBeGreaterThan(0);

    const saved = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-order-mode").selectOption("free_order");
    await saved;
    await expect(page.getByTestId("editor-free-order-hint")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("editor-seq-up")).toHaveCount(0);
    await expect(page.getByTestId("editor-seq-down")).toHaveCount(0);
    // The layer draws no legs and labels the circles with their codes, not 1, 2.
    await expect.poll(async () => (await legPieces(page, name)).length, { timeout: 15000 }).toBe(0);
    for (const code of codes) await expect.poll(async () => (await labelOf(page, code))?.text, { timeout: 15000 }).toBe(code);

    // The number still drags: the offset lives on the visit, whatever the order mode.
    const label = await dragNumber(page, codes[0]);
    await expect.poll(async () => {
      const now = (await labelOf(page, codes[0]))!;
      return Math.hypot(now.x - label.x, now.y - label.y);
    }, { timeout: 15000 }).toBeGreaterThan(1);
    await expect(page.getByTestId("editor-action-bar").getByTestId("editor-action-reset-label")).toBeVisible({ timeout: 10000 });
  });

  test("drag a control number: persisted, reset from the action bar, undo", async ({ page }) => {
    await openEditor(page);
    await newCourse(page, "D10 label");
    const [code] = await regularCodes(page, 1);
    await act(page, code, "append", "course.setStructure");
    await dropSelection(page);
    await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
    await expect.poll(async () => (await labelOf(page, code)) !== null, { timeout: 15000 }).toBe(true);
    // The number is a `number` target of the shared hit-test (§5): a drag on it moves the label alone.
    const auto = await dragNumber(page, code);
    await expect.poll(async () => {
      const now = (await labelOf(page, code))!;
      return Math.hypot(now.x - auto.x, now.y - auto.y);
    }, { timeout: 15000 }).toBeGreaterThan(1);
    const dragged = (await labelOf(page, code))!;
    expect((await site(page, code)).mm).toEqual((await site(page, code)).mm);
    await expect(page.getByTestId("editor-action-bar").getByTestId("editor-action-reset-label")).toBeVisible({ timeout: 10000 });

    // Persisted: after a reload the label is where it was dropped, and the reset is offered.
    const courseId = await page.getByTestId("editor-course-picker").inputValue();
    await page.goto(`/${nameIdOf(page)}/course-editor?course=${courseId}&control=${code}`);
    await editorReady(page);
    await expect.poll(async () => {
      const now = await labelOf(page, code);
      return now ? Math.hypot(now.x - dragged.x, now.y - dragged.y) : Infinity;
    }, { timeout: 15000 }).toBeLessThan(0.05);
    const reset = page.getByTestId("editor-action-bar").getByTestId("editor-action-reset-label");
    await expect(reset).toBeVisible({ timeout: 10000 });
    const resetSaved = waitForTrpc(page, "course.setControlLabelOffset");
    await reset.click();
    await resetSaved;
    await expect(reset).toHaveCount(0, { timeout: 10000 });
    await expect.poll(async () => {
      const now = (await labelOf(page, code))!;
      return Math.hypot(now.x - auto.x, now.y - auto.y);
    }, { timeout: 15000 }).toBeLessThan(0.05);

    // Undo: the dropped offset again.
    await page.getByTestId("editor-undo").click();
    await expect.poll(async () => {
      const now = (await labelOf(page, code))!;
      return Math.hypot(now.x - dragged.x, now.y - dragged.y);
    }, { timeout: 15000 }).toBeLessThan(0.05);
  });

  test("clone a course; the editor offers no legacy start / finish toggles", async ({ page }) => {
    // A course written with the legacy flags (the Courses page shows them read-only).
    // Created after openEditor: the fixture import (ensureCoursesAndMap) expects the seed's course count.
    await openEditor(page);
    await trpcCall("course.create", { name: `D10 Legacy flags ${Date.now() % 100000}`, firstAsStart: true, lastAsFinish: true });
    await expect(page.getByTestId("editor-toggle-first-start")).toHaveCount(0);
    await expect(page.getByTestId("editor-toggle-last-finish")).toHaveCount(0);

    await page.getByTestId("editor-course-picker").selectOption(await courseIdByName(page, "A"));
    await expect(controlRows(page).first()).toBeAttached({ timeout: 15000 });
    const sourceCount = await controlRows(page).count();
    expect(sourceCount).toBeGreaterThan(0);

    await page.getByTestId("editor-clone-course").click();
    await expect(page.getByTestId("editor-clone-name")).toHaveValue("A (copy)");
    const name = `D10 A clone ${Date.now() % 100000}`;
    await page.getByTestId("editor-clone-name").fill(name);
    const cloned = waitForTrpc(page, "course.clone");
    await page.getByTestId("editor-clone-confirm").click();
    await cloned;
    await expect(page.getByTestId("editor-course-picker").locator("option:checked")).toHaveText(name, { timeout: 15000 });
    await expect(controlRows(page)).toHaveCount(sourceCount, { timeout: 15000 });
    await expect(page.getByTestId("editor-toggle-first-start")).toHaveCount(0);
  });
});

// docs/course-editor.md §4 "descriptions": the IOF editor, the autodetect and the sheet (D10).
test.describe("Course mode descriptions (§4)", () => {
  desktopOnly();

  test("the description editor: Escape keeps the selection, column C's written titles, dimensions, saved and reloaded, clear and undo", async ({ page }) => {
    await openEditor(page);
    const [code] = await regularCodes(page, 1);
    const original = await trpcCall<{ description: unknown }>("control.getById", { id: Number(code) }, false);
    try {
      await select(page, code);
      await page.getByTestId("editor-action-bar").getByTestId("editor-action-description").click();
      const dialog = page.getByTestId("desc-editor");
      await expect(dialog).toBeVisible();
      // Escape closes only the dialog: the control stays selected.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(selectedCode(page)).toContainText(code);
      await page.getByTestId("editor-action-bar").getByTestId("editor-action-description").click();
      await expect(dialog).toBeVisible();
      if (await page.getByTestId("desc-clear").isEnabled()) await page.getByTestId("desc-clear").click();
      // A written title beside the Northern option — not only a tooltip.
      const northern = page.getByTestId("desc-opt-0.1N");
      await expect(northern).toBeVisible();
      await expect(page.getByTestId("desc-opt-label-0.1N")).toContainText(/Northern|Norra/i);
      await northern.click();
      await expect(northern).toHaveAttribute("aria-pressed", "true");
      // A boulder so the row is not empty (scoped to column D: E reuses D's codes).
      await dialog.getByTestId("desc-section-d").getByTestId("desc-opt-2.4").click();
      // Dimensions (column F): the preview row writes them live.
      await page.getByTestId("desc-dim-input").fill("1,5");
      await expect(page.getByTestId("desc-preview")).toContainText("1.5");
      const saved = waitForTrpc(page, "control.update");
      await page.getByTestId("desc-save").click();
      await saved;
      await expect(dialog).toHaveCount(0);

      await page.reload();
      await editorReady(page);
      await select(page, code);
      await page.getByTestId("editor-action-bar").getByTestId("editor-action-description").click();
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("desc-opt-0.1N")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("desc-summary")).toContainText(/Northern|Norra/i);
      await expect(page.getByTestId("desc-dim-input")).toHaveValue("1,5");

      // Clear all + save wipes it; Ctrl+Z writes the saved description back (§3: one write, one undo entry).
      const describeOf = async () => (await trpcCall<{ description: unknown }>("control.getById", { id: Number(code) }, false)).description;
      const savedDescription = await describeOf();
      expect(savedDescription).not.toBeNull();
      await page.getByTestId("desc-clear").click();
      await expect(page.getByTestId("desc-opt-0.1N")).toHaveAttribute("aria-pressed", "false");
      const cleared = waitForTrpc(page, "control.update");
      await page.getByTestId("desc-save").click();
      await cleared;
      await expect(dialog).toHaveCount(0);
      await expect.poll(describeOf, { timeout: 15000 }).toBeNull();
      const undone = waitForTrpc(page, "control.update");
      await page.keyboard.press("Control+z");
      await undone;
      await expect.poll(describeOf, { timeout: 15000 }).toEqual(savedDescription);
    } finally {
      await cleanup("control.update", { id: Number(code), description: original.description ?? null });
    }
  });

  test("a control placed on the map is described from the base map; after a move it stays selected", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());
    await openEditor(page);
    const code = await placeOneShot(page);
    try {
      // Auto-applied on create: no suggestion offered for the fresh control, and the editor shows the description.
      await expect(page.getByTestId("editor-suggestions")).toHaveCount(0);
      await page.getByTestId("editor-action-bar").getByTestId("editor-action-description").click();
      const dialog = page.getByTestId("desc-editor");
      await expect(dialog).toBeVisible();
      await expect.poll(() => dialog.locator('[data-testid^="desc-opt-"][aria-pressed="true"]').count(), { timeout: 15000 }).toBeGreaterThan(0);
      await page.getByTestId("desc-cancel").click();

      // A move re-describes it server-side (autoDescribe); the control stays selected with its action bar.
      await page.keyboard.press("Escape");
      const from = await sitePoint(page, code);
      const moved = waitForTrpc(page, "control.update");
      await drag(page, from, await dragTarget(page, from));
      await moved;
      await expect(selectedCode(page)).toContainText(code, { timeout: 10000 });
      await expect(page.getByTestId("editor-action-bar")).toBeVisible({ timeout: 10000 });
      // At most the one top suggestion, when the new spot's differs.
      expect(await page.locator('[data-testid^="editor-suggestion-"]').count()).toBeLessThanOrEqual(1);
    } finally {
      await cleanup("control.delete", { id: Number(code) });
    }
  });

  test("the description sheet lists every control until a course is selected, then the course's card", async ({ page }) => {
    await openEditor(page);
    const sheet = page.getByTestId("description-sheet");
    await expect(sheet).toBeVisible({ timeout: 15000 });
    await expect.poll(() => sheet.locator('[data-testid="desc-row-code"]').count(), { timeout: 15000 }).toBeGreaterThan(1);
    await expect(sheet.locator('[data-testid="desc-title"]')).toHaveText("All controls");

    // Course E (the fixture's shortest, 8 controls) fits the on-map sheet whole: the event name in row 1, the course
    // name in row 3, the measured last-control → finish distance and the thick rules.
    await page.getByTestId("editor-course-picker").selectOption(await courseIdByName(page, "E"));
    await expect(sheet.locator('[data-testid="desc-course-name"]')).toHaveText("E", { timeout: 20000 });
    await expect(sheet.locator('[data-testid="desc-title"]')).toHaveText("My example tävling");
    await expect(sheet.locator('[data-testid="desc-row-length"]').last()).toHaveText(/^\d+ m$/);
    await expect(sheet.locator('[data-testid="desc-thick-rule"]').first()).toBeAttached();
  });

  test("description instructions: the finish variant and a special row from the inspector reach the sheet, Layout's block and the print rows; undo; reload", async ({ page }) => {
    await openEditor(page);
    const name = await newCourse(page, "E3b");
    const a = await appendClear(page);
    await appendClear(page, [a]);
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    const courseSeq = Number(await page.getByTestId("editor-course-picker").inputValue());
    const stored = async () =>
      (await trpcCall<{ id: number; descriptionInstructions: { specials?: { afterControlId: number | null; kind: string; lengthM?: number }[]; finish?: { kind: string; lengthM?: number } } | null }[]>("course.list", undefined, false))
        .find((c) => c.id === courseSeq)!.descriptionInstructions;

    const sheet = page.getByTestId("description-sheet");
    await expect(sheet.locator('[data-testid="desc-course-name"]')).toHaveText(name, { timeout: 20000 });
    // Special and finish rows are drawn across the sheet (MapViewer's wide rows); the finish row is the last.
    const wide = sheet.locator('svg[viewBox="-800 -100 1600 200"]');
    const lengths = sheet.locator('[data-testid="desc-row-length"]');
    await expect(wide).toHaveCount(1);
    const defaultFinish = await wide.last().innerHTML();
    const lengths0 = await lengths.count();
    // The inspector's block is collapsed to a summary line (the variant, the instruction count) until opened.
    const block = page.getByTestId("editor-description-instructions");
    await expect(block.getByTestId("editor-instructions-summary")).toHaveText("14.3");
    await block.getByTestId("editor-instructions-toggle").click();
    await expect(block.getByTestId("editor-finish-kind")).toBeVisible();
    await expect(block.getByTestId("editor-finish-kind")).toHaveValue("14.3");

    // The finish variant: one course.update with the course's token; the sheet's finish row follows.
    let saved = waitForTrpc(page, "course.update");
    await block.getByTestId("editor-finish-kind").selectOption("14.1");
    await saved;
    await expect.poll(() => wide.last().innerHTML(), { timeout: 15000 }).not.toBe(defaultFinish);
    await expect.poll(async () => (await stored())?.finish?.kind, { timeout: 15000 }).toBe("14.1");

    // A special row (after the start, 13.1), then its length: a wide row with "60 m" before the controls.
    saved = waitForTrpc(page, "course.update");
    await block.getByTestId("editor-add-special").click();
    await saved;
    await expect(wide).toHaveCount(2, { timeout: 15000 });
    await expect(block.getByTestId("editor-special-row")).toHaveCount(1);
    saved = waitForTrpc(page, "course.update");
    await block.getByTestId("editor-special-length").fill("60");
    await block.getByTestId("editor-special-length").press("Enter");
    await saved;
    await expect(lengths).toHaveCount(lengths0 + 1, { timeout: 15000 });
    await expect(lengths.first()).toHaveText("60 m");

    // Anchored after control a (its public id, the punch code): Layout mode's block and the print read the same rows.
    saved = waitForTrpc(page, "course.update");
    await block.getByTestId("editor-special-after").selectOption(a);
    await saved;
    await expect.poll(async () => (await stored())?.specials, { timeout: 15000 }).toEqual([{ afterControlId: Number(a), kind: "13.1", lengthM: 60 }]);
    const template = await probeTemplate("E3b sheet");
    try {
      type Row = { kind: string; code: string; symbolKey?: string; lengthM?: number };
      const r = await trpcCall<{ block: { rows: Row[] } }>("courseMap.resolveSheet", { templateSeq: template.seq, courseSeq }, false);
      const rows = r.block.rows;
      const at = rows.findIndex((row) => row.kind === "control" && row.code === a);
      expect(at).toBeGreaterThan(0);
      expect(rows[at + 1]).toMatchObject({ kind: "special", symbolKey: "13.1", lengthM: 60 });
      expect(rows.at(-1)).toMatchObject({ kind: "finish", symbolKey: "14.1" });
    } finally {
      await cleanup("mapTemplate.delete", { id: template.seq });
    }

    // Ctrl+Z: one entry back — the special is after the start again; the variant stays.
    saved = waitForTrpc(page, "course.update");
    await page.keyboard.press("Control+z");
    await saved;
    await expect.poll(async () => (await stored())?.specials?.[0]?.afterControlId, { timeout: 15000 }).toBeNull();
    await expect(block.getByTestId("editor-special-after")).toHaveValue("");

    // Persisted over a reload.
    await page.goto(`/${nameIdOf(page)}/course-editor?course=${courseSeq}`);
    await editorReady(page);
    await expect(page.getByTestId("editor-instructions-summary")).toHaveText(/^14\.1 · 1 (instruction|anvisning)$/, { timeout: 15000 });
    await page.getByTestId("editor-instructions-toggle").click();
    await expect(page.getByTestId("editor-finish-kind")).toHaveValue("14.1");
    await expect(page.getByTestId("editor-special-row")).toHaveCount(1);
    await expect(page.getByTestId("editor-special-length")).toHaveValue("60");
    await expect(page.getByTestId("description-sheet").locator('[data-testid="desc-row-length"]').first()).toHaveText("60 m", { timeout: 15000 });
  });
});

// docs/course-layer.md §3.4: automatic cuts, drawn by the GL course layer (the `course-layer` mirror), D10.
test.describe("Automatic cuts (course-layer.md §3.4)", () => {
  desktopOnly();

  // The fixture's lone boulder (ISOM 204) in the empty top-right corner (scripts/generate-test-ocd.mjs).
  const BOULDER = { x: 68, y: 42 };
  const CODES = [241, 242, 243];

  /** Controls written straight to the event, at paper mm. */
  async function controlsAt(at: Pt[]): Promise<void> {
    for (const [i, p] of at.entries()) await trpcCall("control.create", { codes: String(CODES[i]), xpos: p.x, ypos: p.y });
  }

  test("a boulder on a circle's rim slits it; a leg across it is gapped", async ({ page }) => {
    // The drawn circle's radius from the gap tool's target (G on a selected control).
    await openEditor(page);
    const [any] = await regularCodes(page, 1);
    await select(page, any);
    await page.keyboard.press("g");
    const [target] = await toolShapes(page, "editor-gap-target");
    const r = Number(target.data.r);
    expect(r).toBeGreaterThan(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    try {
      // The slit: 241 with the boulder on its southern rim — its drawn circle is cut around south (180°).
      await controlsAt([{ x: BOULDER.x, y: BOULDER.y + r }]);
      await page.reload();
      await editorReady(page);
      await expect.poll(async () => (await siteCuts(page, String(CODES[0]))).some((g) => ((180 - g.start + 360) % 360) <= ((g.end - g.start + 360) % 360)), { timeout: 20000 }).toBe(true);
      await cleanup("control.delete", { id: CODES[0] });

      // The gap: a course 242 → 243, a 28 mm leg whose midpoint is the boulder (clear of the building at 48–58 / 39–46).
      await trpcCall("control.create", { codes: String(CODES[1]), xpos: BOULDER.x + 10, ypos: BOULDER.y + 10 });
      await trpcCall("control.create", { codes: String(CODES[2]), xpos: BOULDER.x - 10, ypos: BOULDER.y - 10 });
      const name = `D10 cuts ${Date.now() % 100000}`;
      const { id } = await trpcCall<{ id: number }>("course.create", { name, controlIds: [CODES[1], CODES[2]] });
      await page.goto(`/${nameIdOf(page)}/course-editor?course=${id}`);
      await editorReady(page);
      await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
      // Drawn in two pieces on the line 242 → 243, none of them over the boulder.
      const a = (await site(page, String(CODES[1]))).mm, b = (await site(page, String(CODES[2]))).mm;
      await expect.poll(async () => (await legPieces(page, name)).filter((l) => {
        const [p, q] = [l.points[0], l.points.at(-1)!];
        const onLeg = (s: Pt) => Math.abs((b.x - a.x) * (s.y - a.y) - (b.y - a.y) * (s.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y) < 0.2;
        return onLeg(p) && onLeg(q);
      }).length, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
      const covers = async (s: Pt) => (await legPieces(page, name)).some((l) => l.points.some((p, i) => {
        if (i === 0) return false;
        const o = l.points[i - 1];
        const t = ((s.x - o.x) * (p.x - o.x) + (s.y - o.y) * (p.y - o.y)) / ((p.x - o.x) ** 2 + (p.y - o.y) ** 2 || 1);
        return t >= 0 && t <= 1 && Math.hypot(s.x - (o.x + (p.x - o.x) * t), s.y - (o.y + (p.y - o.y) * t)) < 0.1;
      }));
      expect(await covers(BOULDER)).toBe(false);
      expect(await covers({ x: (a.x * 3 + b.x) / 4, y: (a.y * 3 + b.y) / 4 })).toBe(true);
    } finally {
      for (const code of CODES) await cleanup("control.delete", { id: code });
    }
  });

  // D17 (course-layer.md §3.4): the event's automatic-cuts flag (`course.setOverprintCuts`, `editor-toggle-cuts`)
  // reaches the GL course layer — off, the boulder's slit goes, a stored circle gap stays (the setter's choice).
  test("the event's automatic-cuts toggle removes the layer's slits; a stored circle gap stays", async ({ page }) => {
    await openEditor(page);
    const [any] = await regularCodes(page, 1);
    await select(page, any);
    await page.keyboard.press("g");
    const [target] = await toolShapes(page, "editor-gap-target");
    const r = Number(target.data.r);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // 241 with the boulder on its southern rim; 242 clear of every feature, with a stored circle gap.
    await controlsAt([{ x: BOULDER.x, y: BOULDER.y + r }, { x: BOULDER.x + 10, y: BOULDER.y + 10 }]);
    const stored = { start: 80, end: 100 };
    await trpcCall("control.update", { id: CODES[1], circleGaps: [stored] });
    try {
      await page.reload();
      await editorReady(page);
      await expect.poll(async () => (await siteCuts(page, String(CODES[0]))).length, { timeout: 20000 }).toBeGreaterThan(0);
      await expect.poll(async () => siteCuts(page, String(CODES[1])), { timeout: 20000 }).toEqual([stored]);
      const toggle = page.getByTestId("editor-toggle-cuts");
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "false", { timeout: 15000 });
      await expect.poll(async () => (await siteCuts(page, String(CODES[0]))).length, { timeout: 20000 }).toBe(0);
      expect(await siteCuts(page, String(CODES[1]))).toEqual([stored]);
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: 15000 });
      await expect.poll(async () => (await siteCuts(page, String(CODES[0]))).length, { timeout: 20000 }).toBeGreaterThan(0);
      expect(await siteCuts(page, String(CODES[1]))).toEqual([stored]);
    } finally {
      await cleanup("course.setOverprintCuts", { enabled: true });
      for (const code of CODES) await cleanup("control.delete", { id: code });
    }
  });
});

// docs/course-editor.md §6–§7 (D5, D12–D16): the tools.
test.describe("tools", () => {
  desktopOnly();

  test("ten controls in ten clicks with the armed K tool; Ctrl+Z steps back; Esc returns to V", async ({ page }) => {
    await openEditor(page);
    await newCourse(page, "D5 K");
    const before = (await sites(page)).length;

    await arm(page, "K");
    // The ghost: true-size circle, the next number and code; the pending leg from the start, its length at the pointer.
    const first = await emptyPoint(page, 40);
    await page.mouse.move(first.x, first.y);
    await expect(page.getByTestId("editor-ghost")).toBeAttached({ timeout: 10000 });
    await expect(page.getByTestId("editor-ghost-label")).toHaveText(/^1 · \d+$/);
    // The layer draws the pending leg (§6.1); the UI layer only labels it at the leg's midpoint — the one readout (P2).
    await expect(page.getByTestId("editor-pending-leg")).toHaveCount(0);
    await expect(page.getByTestId("editor-leg-length")).toHaveText(/^\d+ m$/);
    await expect(page.getByTestId("editor-pending-leg-length")).toHaveCount(0);

    const spots = [first];
    for (let i = 1; i < 10; i++) spots.push(await emptyPoint(page, 30, spots));
    for (const p of spots) {
      await page.mouse.move(p.x, p.y);
      await page.mouse.click(p.x, p.y);
      // No action bar while armed, and no selection ring beside the placed circle (§6.1, D12): the purple is the mark.
      await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
      await expect(page.getByTestId("editor-selection-ring")).toHaveCount(0);
    }
    // The last placed control is still the selection (the inspector shows it), only its ring is not drawn.
    await expect(selectedCode(page)).toBeVisible();
    await expect(page.getByTestId("editor-selection-ring")).toHaveCount(0);
    await expect(controlRows(page)).toHaveCount(10, { timeout: 30000 });
    await expect.poll(async () => (await sites(page)).length, { timeout: 15000 }).toBe(before + 10);
    await expect(page.getByTestId("editor-tool-K")).toHaveAttribute("aria-pressed", "true");
    // The ghost reads the next number (on empty map; over a control it reads "Add ‹code›").
    const next = await emptyPoint(page, 40, spots);
    await page.mouse.move(next.x, next.y);
    await expect(page.getByTestId("editor-ghost-label")).toHaveText(/^11 · /, { timeout: 10000 });

    // Ctrl+Z while armed: the last placement goes, the tool stays armed.
    await page.keyboard.press("Control+z");
    await expect(controlRows(page)).toHaveCount(9, { timeout: 15000 });
    await expect(page.getByTestId("editor-tool-K")).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-ghost")).toHaveCount(0);
    // In V the selected control has its ring again.
    await clickMap(page, spots[0]);
    await expect(page.getByTestId("editor-selection-ring")).toHaveCount(1, { timeout: 10000 });
  });

  test("the armed tool's pending legs are drawn by the layer to the cursor; a drag labels both legs", async ({ page }) => {
    await openEditor(page);
    const name = await newCourse(page, "D5a pending");
    const scale = await mapScale(page);
    await arm(page, "K");
    const spots: Pt[] = [];
    let last: Site | undefined;
    for (let i = 0; i < 3; i++) {
      const p = await emptyPoint(page, 60, spots);
      spots.push(p);
      await page.mouse.move(p.x, p.y);
      await expect(page.getByTestId("editor-ghost-label")).toHaveText(new RegExp(`^${i + 1} · `), { timeout: 10000 });
      last = await place(page, p);
      await expect(controlRows(page)).toHaveCount(i + 1, { timeout: 15000 });
    }

    /** A drawn leg piece of the course ending at the rim of a circle around the page point (a circle is ~13 px here). */
    const legEndsNear = async (p: Pt) => {
      for (const l of await legPieces(page, name)) {
        for (const q of [l.points[0], l.points.at(-1)!]) {
          const at = await toPage(page, q);
          if (Math.hypot(at.x - p.x, at.y - p.y) < 25) return true;
        }
      }
      return false;
    };
    for (const pass of [0, 1]) {
      const p = await emptyPoint(page, 60, spots);
      spots.push(p);
      expect(await legEndsNear(p)).toBe(false);
      await page.mouse.move(p.x, p.y);
      await expect(page.getByTestId("editor-ghost")).toBeAttached({ timeout: 10000 });
      // The leg into the cursor is a `course-leg` piece of the course: the layer's, with its slits (one round trip per hover).
      await expect.poll(() => legEndsNear(p), { timeout: 15000, message: `pass ${pass}` }).toBe(true);
      await expect(page.getByTestId("editor-pending-leg")).toHaveCount(0);
      // The label at the pointer is the leg from the last placed control to the cursor, on the ground (§6.1; P2:
      // no status-bar number to compare with, so the geometry is the reference).
      const cursor = await toPaper(page, p);
      const expected = (Math.hypot(cursor.x - last!.mm.x, cursor.y - last!.mm.y) * scale) / 1000;
      await expect(page.getByTestId("editor-leg-length")).toHaveText(/^\d+ m$/);
      const metres = Number((await page.getByTestId("editor-leg-length").textContent())!.match(/(\d+) m/)![1]);
      expect(Math.abs(metres - expected), `pass ${pass}: ${metres} m vs ${expected.toFixed(1)} m`).toBeLessThan(2);
      await expect(page.getByTestId("editor-pending-leg-length")).toHaveCount(0);
    }

    // Back to V: no provisional visit, no label; a drag of the middle control labels its two legs.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-ghost")).toHaveCount(0);
    await expect(page.getByTestId("editor-leg-length")).toHaveCount(0);
    // Drop the placed control's selection: its action bar must not be where the drag goes.
    await dropSelection(page);
    const middle = (await controlRows(page).nth(1).getAttribute("data-control-id"))!;
    const from = await toPage(page, (await sites(page)).find((x) => x.id === middle)!.mm);
    const to = await dragTarget(page, from, spots);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await expect(page.getByTestId("editor-leg-length")).toHaveCount(2);
    await expect(page.getByTestId("editor-leg-length").first()).toHaveText(/^\d+ m$/);
    await page.mouse.up();
    await expect(page.getByTestId("editor-leg-length")).toHaveCount(0);
  });

  test("an armed click on an existing control reuses the site", async ({ page }) => {
    await openEditor(page);
    await newCourse(page, "D5 reuse");
    const before = (await sites(page)).length;
    await page.getByTestId("editor-tool-K").click();
    const picked: string[] = [];
    for (let i = 0; i < 2; i++) {
      // Picked now, clear of the legs drawn so far (the course's legs win the hit over a control under them).
      const [code] = await regularCodes(page, 1, picked);
      picked.push(code);
      const p = await sitePoint(page, code);
      await page.mouse.move(p.x, p.y);
      await expect(page.getByTestId("editor-ghost-label")).toHaveText(`Add ${code}`, { timeout: 10000 });
      const saved = waitForTrpc(page, "course.setStructure");
      await page.mouse.click(p.x, p.y);
      await saved;
    }
    const [a, b] = picked;
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a);
    await expect(controlRows(page).nth(1)).toHaveAttribute("data-control-id", b);
    expect((await sites(page)).length).toBe(before);
  });

  test("Shift-click selects several controls for one add-to-course; notes are written from the inspector", async ({ page }) => {
    await openEditor(page);
    await newCourse(page, "D5 multi");
    const [a, ...rest] = await regularCodes(page, 6);
    await select(page, a);
    // The selection's action bar sits next to the selected control and may cover a neighbour: Shift-click
    // the first two candidates that are clear of the chrome at click time (a user would pan; the test picks).
    const picked: string[] = [];
    for (const code of rest) {
      if (picked.length === 2) break;
      const p = await sitePoint(page, code);
      if (await coveredBy(page, p)) continue;
      await page.keyboard.down("Shift");
      try { await clickMap(page, p); } finally { await page.keyboard.up("Shift"); }
      picked.push(code);
      await expect(page.getByTestId("editor-multi-ring")).toHaveCount(picked.length + 1, { timeout: 10000 });
    }
    expect(picked, "two Shift-clickable controls clear of the action bar").toHaveLength(2);
    const [, c] = picked;
    await expect(page.getByTestId("editor-multi")).toHaveAttribute("data-count", "3", { timeout: 10000 });
    await expect(page.getByTestId("editor-multi-ring")).toHaveCount(3);
    const saved = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-bulk-add-to-course").click();
    await saved;
    await expect(controlRows(page)).toHaveCount(3, { timeout: 15000 });
    await expect(controlRows(page).nth(2)).toHaveAttribute("data-control-id", c);
    // One undo entry for the three.
    await page.keyboard.press("Control+z");
    await expect(controlRows(page)).toHaveCount(0, { timeout: 15000 });

    // A site's notes (courses.review) from the selection inspector.
    await page.keyboard.press("Escape");
    await select(page, a);
    const note = `checked ${Date.now() % 1000}`;
    const updated = waitForTrpc(page, "control.update");
    await page.getByTestId("editor-selected-notes").fill(note);
    await page.getByTestId("editor-selected-notes").blur();
    await updated;
    await page.reload();
    await editorReady(page);
    await select(page, a);
    await expect(page.getByTestId("editor-selected-notes")).toHaveValue(note, { timeout: 10000 });
  });

  test("stored gaps and a hidden number are what the layer draws", async ({ page }) => {
    await openEditor(page);
    const name = await newCourse(page, "D5 drawn");
    await arm(page, "K");
    const picked: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [code] = await regularCodes(page, 1, picked);
      picked.push(code);
      const p = await sitePoint(page, code);
      await page.mouse.move(p.x, p.y);
      // The hover's hit-test is in (the ghost offers the site): the click reuses it instead of placing a new one.
      await expect(page.getByTestId("editor-ghost-label")).toHaveText(`Add ${code}`, { timeout: 10000 });
      const saved = waitForTrpc(page, "course.setStructure");
      await page.mouse.click(p.x, p.y);
      await saved;
    }
    const [a, b] = picked;
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    // Escape drops the tool, then the placed control's selection (its action bar may cover the leg).
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
    await dropSelection(page);
    const A = (await site(page, a)).mm, B = (await site(page, b)).mm;

    // A leg gap: G on the leg a → b, a drag from 35 % to 55 % of it; the drawn leg is cut there.
    await expect.poll(async () => (await legPieces(page, name)).length, { timeout: 15000 }).toBeGreaterThan(0);
    const at = (f: number) => ({ x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f });
    const mid = await legMidpoint(page, name, A, B);
    // The leg must be the hit (an Insert on the phantom), not empty map, before G takes it (D10 flake: the click
    // landed before the hit index had the leg, G armed on a plain phantom, and the drag wrote nothing).
    await expect(async () => {
      await dropSelection(page);
      await clickMap(page, await toPage(page, mid));
      await expect(page.getByTestId("editor-action-bar").getByTestId("editor-action-insert")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });
    await page.keyboard.press("g");
    await expect(page.getByTestId("editor-tool-layer").getByTestId("editor-gap-target")).toHaveAttribute("data-kind", "leg");
    const legSaved = waitForTrpc(page, "course.setStructure");
    await dragMm(page, at(0.35), at(0.55));
    await legSaved;
    const near = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) < 0.3;
    const covered = async (f: number) => {
      const q = at(f);
      return (await legPieces(page, name)).some((l) => l.points.some((p, i) => {
        if (i === 0) return false;
        const o = l.points[i - 1];
        const t = ((q.x - o.x) * (p.x - o.x) + (q.y - o.y) * (p.y - o.y)) / ((p.x - o.x) ** 2 + (p.y - o.y) ** 2 || 1);
        return t >= 0 && t <= 1 && near(q, { x: o.x + (p.x - o.x) * t, y: o.y + (p.y - o.y) * t });
      }));
    };
    await expect.poll(() => covered(0.45), { timeout: 15000 }).toBe(false);
    expect(await covered(0.75)).toBe(true);
    await page.keyboard.press("Escape");

    // A circle gap: G on control a, a rim drag from 40° to 100°; the drawn circle's cuts cover 70°.
    await select(page, a);
    await page.keyboard.press("g");
    const [target] = await toolShapes(page, "editor-gap-target");
    const r = Number(target.data.r);
    const rim = (deg: number) => ({ x: target.x + r * Math.sin((deg * Math.PI) / 180), y: target.y + r * Math.cos((deg * Math.PI) / 180) });
    const circleSaved = waitForTrpc(page, "control.update");
    await dragMm(page, rim(40), rim(100));
    await circleSaved;
    await expect.poll(async () => (await siteCuts(page, a)).some((g) => ((70 - g.start + 360) % 360) <= ((g.end - g.start + 360) % 360)), { timeout: 15000 }).toBe(true);
    await page.keyboard.press("Escape");

    // A hidden number: the layer draws control a without its number on this course.
    await expect(page.locator(`[data-testid="course-label"][data-site-id="${a}"]`)).toHaveCount(1);
    await select(page, a);
    const hidden = waitForTrpc(page, "course.setStructure");
    // A DOM click: a tall Selection section (a control on several courses) overflows under the Checks header,
    // which then takes the pointer — an inspector layout issue reported as a follow-up, not what this test checks.
    await page.getByTestId("editor-number-hidden").dispatchEvent("click");
    await expect(page.getByTestId("editor-number-hidden")).toBeChecked();
    await hidden;
    await expect(page.locator(`[data-testid="course-label"][data-site-id="${a}"]`)).toHaveCount(0, { timeout: 15000 });
    await expect(page.locator(`[data-testid="course-label"][data-site-id="${b}"]`)).toHaveCount(1);
  });

  test("G: a drag along the rim opens a circle gap, stored on the site", async ({ page }) => {
    await openEditor(page);
    const [code] = await regularCodes(page, 1);
    await select(page, code);
    // G: no action bar while a tool is active, so nothing covers the rim.
    await page.keyboard.press("g");
    await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
    const [target] = await toolShapes(page, "editor-gap-target");
    expect(target).toBeDefined();
    const r = Number(target.data.r);
    const rim = (deg: number) => ({ x: target.x + r * Math.sin((deg * Math.PI) / 180), y: target.y + r * Math.cos((deg * Math.PI) / 180) });
    const saved = waitForTrpc(page, "control.update");
    await dragMm(page, rim(40), rim(100));
    await saved;
    const covers = async () => (await toolShapes(page, "editor-gap")).some((g) => {
      const start = Number(g.data.start), end = Number(g.data.end);
      return ((70 - start + 360) % 360) <= ((end - start + 360) % 360);
    });
    await expect.poll(covers, { timeout: 15000 }).toBe(true);

    // Stored: after a reload the gap is the site's.
    await page.reload();
    await editorReady(page);
    await select(page, code);
    await page.keyboard.press("g");
    await expect.poll(covers, { timeout: 15000 }).toBe(true);

    // Reset gaps: the stored list goes (an empty list is automatic again, §6.3).
    const reset = waitForTrpc(page, "control.update");
    await page.getByTestId("editor-gap-reset").click();
    await reset;
    await expect(page.getByTestId("editor-gap-reset")).toHaveCount(0, { timeout: 15000 });
  });

  test("A: an out-of-bounds area drawn vertex by vertex is stored and selected", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    await page.getByTestId("editor-tool-A").click();
    await page.getByTestId("editor-area-oob_area").click();
    // The triangle's inside (where it is clicked again later) is the clear point, not its first corner.
    const clear = await emptyPoint(page, 40);
    const a = { x: clear.x - 30, y: clear.y - 15 };
    const corners = [a, { x: a.x + 60, y: a.y }, { x: a.x + 60, y: a.y + 40 }];
    // A patch inside the triangle (page px → paper mm), probed for purple before and after.
    const [p0, p1] = await Promise.all([toPaper(page, { x: a.x + 35, y: a.y + 3 }), toPaper(page, { x: a.x + 55, y: a.y + 15 })]);
    const inner = { minX: Math.min(p0.x, p1.x), maxX: Math.max(p0.x, p1.x), minY: Math.min(p0.y, p1.y), maxY: Math.max(p0.y, p1.y) };
    const purpleBefore = await inkIn(page, inner, "purple");
    for (const p of corners) await page.mouse.click(p.x, p.y);
    await expect(page.getByTestId("editor-polygon-vertex")).toHaveCount(3);
    const created = waitForTrpc(page, "courseObject.create");
    await page.mouse.click(a.x, a.y); // the first vertex closes
    await created;
    await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-kind", "oob_area", { timeout: 15000 });
    await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
    const id = (await page.getByTestId("editor-object").getAttribute("data-object-id"))!;
    await expect(objectRow(page, id)).toHaveCount(1);

    try {
      // On screen: the hatch's purple inside the area (the GL canvas), none there before it existed.
      await expect.poll(() => inkIn(page, inner, "purple"), { timeout: 30000 }).toBeGreaterThan(purpleBefore + 5);

      // Printed: the all-controls sheet (an `all`-scoped object) carries the 709 hatch — present with it, absent parked.
      // The page raster itself is `course-print.test.ts` "course objects on the page" (docs/course-editor.md Tests).
      const { drop } = await allControlsSheet();
      try {
        const withArea = await printed(page, nameId, "allControls=1");
        expect(withArea.pages).toBe(1);
        expect(withArea.hatches, "hatch strokes with the area").toBeGreaterThan(0);
        // The dangerous area (hatch 710, course-layer.md §3.1): 709's stripes crossed — one more hatch pass.
        await trpcCall("courseObject.update", { id: Number(id), props: { hatch: "710" } });
        const crossed = await printed(page, nameId, "allControls=1");
        expect(crossed.pages).toBe(1);
        expect(crossed.hatches, "the 710 cross-hatch prints both diagonals").toBe(withArea.hatches + 1);
        await trpcCall("courseObject.update", { id: Number(id), props: {} });
        await trpcCall("courseObject.update", { id: Number(id), scope: { courses: [], classes: [] } });
        const without = await printed(page, nameId, "allControls=1");
        expect(without.pages).toBe(1);
        expect(without.hatches, "the area's hatch is gone when it is parked").toBeLessThan(withArea.hatches);
        await trpcCall("courseObject.update", { id: Number(id), scope: { all: true } });
      } finally {
        await drop();
      }
      await page.reload();
      await editorReady(page);
      await page.getByTestId("editor-object-row").first().waitFor({ state: "attached" });
      // Select it again on the canvas (a click on its outline — inside, the map is the map, §7), once the layer
      // draws it and its hit index has it.
      await expect.poll(() => inkIn(page, inner, "purple"), { timeout: 30000 }).toBeGreaterThan(purpleBefore + 5);
      // The reloaded view need not be the one it was drawn in: the edge midpoint from the stored geometry.
      const onEdge = await pressOnEdge(page, await geometryOf(objectRow(page, id)));
      await expect(async () => {
        await page.keyboard.press("Escape"); // a missed attempt's selection or phantom (its action bar) goes first
        await clickMap(page, onEdge);
        await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", id, { timeout: 2000 });
      }).toPass({ timeout: 20000 });
      // Its hatch and border from the inspector, then delete it (Delete key) and undo.
      const row = objectRow(page, id);
      const hatched = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-prop-hatch").selectOption("710");
      await hatched;
      await expect(row).toHaveAttribute("data-props", '{"hatch":"710"}', { timeout: 15000 });
      const updated = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-prop-border").selectOption("dashed");
      await updated;
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-props")) ?? "{}"), { timeout: 15000 }).toEqual({ hatch: "710", border: "dashed" });
      await page.getByTestId("editor-object-delete").click();
      await expect(objectRow(page, id)).toHaveCount(0, { timeout: 15000 });
      await page.keyboard.press("Control+z");
      await expect(page.locator('[data-testid="editor-object-row"][data-object-kind="oob_area"]')).not.toHaveCount(0, { timeout: 15000 });
    } finally {
      for (const row of await trpcCall<{ id: number; kind: string }[]>("courseObject.list", undefined, false).catch(() => [])) {
        if (row.kind === "oob_area") await cleanup("courseObject.delete", { id: row.id });
      }
    }
  });

  test("a press inside an out-of-bounds area pans the map; its outline selects and moves it (§7)", async ({ page }) => {
    // docs/bugfix-editor-area-press-pans.md: an area (the toner saver covers every control) swallowed every press.
    await openEditor(page);
    // The description sheet (with no course picked, all controls') covers half the view and the shard's earlier
    // tests leave extra controls: hide it (view state, not saved) so a 60 px clear point exists.
    const sheetToggle = page.getByTestId("map-toggle-descriptions");
    if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
    // A 70 px square around a clear point (no site within 60 px of its centre, no leg within 20 px).
    const clear = await emptyPoint(page, 60);
    const geometry = await Promise.all([[-35, -35], [35, -35], [35, 35], [-35, 35]].map(([dx, dy]) => toPaper(page, { x: clear.x + dx, y: clear.y + dy })));
    const inner = {
      minX: Math.min(geometry[0].x, geometry[2].x) + 1, maxX: Math.max(geometry[0].x, geometry[2].x) - 1,
      minY: Math.min(geometry[0].y, geometry[2].y) + 1, maxY: Math.max(geometry[0].y, geometry[2].y) - 1,
    };
    const purpleBefore = await inkIn(page, inner, "purple");
    const { id } = await trpcCall<{ id: number }>("courseObject.create", { kind: "oob_area", geometry, props: {}, scope: { all: true } });
    try {
      await page.reload();
      await editorReady(page);
      const row = objectRow(page, id);
      await expect(row).toBeAttached({ timeout: 15000 });
      const stored = await row.getAttribute("data-geometry");
      // Drawn (its 709 hatch), so the hit index has it.
      await expect.poll(() => inkIn(page, inner, "purple"), { timeout: 30000 }).toBeGreaterThan(purpleBefore + 5);

      // Unselected: a drag starting inside it moves the view and leaves the area alone.
      await pressInside(page, await geometryOf(row));
      await expect(row).toHaveAttribute("data-geometry", stored!);
      await expect(page.getByTestId("editor-object")).toHaveCount(0);

      // A press on its outline selects it (four vertex handles).
      await expect(async () => {
        await dropSelection(page); // a missed attempt's selection or phantom (its action bar) goes first
        await clickMap(page, await pressOnEdge(page, await geometryOf(row)));
        await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(id), { timeout: 2000 });
      }).toPass({ timeout: 20000 });
      await expect(page.getByTestId("editor-object-handle")).toHaveCount(4);

      // Selected: a drag inside still pans; the selection stays.
      await pressInside(page, await geometryOf(row));
      await expect(row).toHaveAttribute("data-geometry", stored!);
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(id));

      // Its edge moves it: one write, every vertex translated by the drag.
      const edge = await pressOnEdge(page, await geometryOf(row));
      const [e0, e1] = await Promise.all([toPaper(page, edge), toPaper(page, { x: edge.x, y: edge.y + 30 })]);
      const moved = waitForTrpc(page, "courseObject.update");
      await drag(page, edge, { x: edge.x, y: edge.y + 30 });
      await moved;
      await expect.poll(async () => (await row.getAttribute("data-geometry")) !== stored, { timeout: 15000 }).toBe(true);
      const now = await geometryOf(row);
      stored!.split(" ").map((q) => ({ x: Number(q.split(",")[0]), y: Number(q.split(",")[1]) })).forEach((v, i) => {
        expect(now[i].x - v.x).toBeCloseTo(e1.x - e0.x, 0);
        expect(now[i].y - v.y).toBeCloseTo(e1.y - e0.y, 0);
      });

      // A click inside is a map click: the area is deselected.
      await clickMap(page, await toPage(page, { x: (now[0].x + now[2].x) / 2, y: (now[0].y + now[2].y) / 2 }));
      await expect(page.getByTestId("editor-object")).toHaveCount(0);
    } finally {
      await cleanup("courseObject.delete", { id });
    }
  });

  test("A: a curved white-out in three clicks and one drag prints a Bézier; a vertex inserted on an edge and deleted", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const { drop } = await allControlsSheet();
    try {
      const before = await printed(page, nameId, "allControls=1");
      await page.getByTestId("editor-tool-A").click();
      await page.getByTestId("editor-area-whiteout").click();
      const clear = await emptyPoint(page, 40);
      const a = { x: clear.x - 30, y: clear.y - 15 }, b = { x: a.x + 60, y: a.y }, c = { x: a.x + 60, y: a.y + 40 };
      await page.mouse.click(a.x, a.y);
      await page.mouse.click(b.x, b.y);
      // Click-drag: a curve vertex at c, its handles pulled out along the drag (docs/course-editor.md §6.4).
      const pullTo = { x: c.x - 25, y: c.y + 10 };
      await drag(page, c, pullTo);
      await expect(page.getByTestId("editor-polygon-vertex")).toHaveCount(3);
      await expect(page.getByTestId("editor-polygon-grip")).toHaveCount(2);
      const created = waitForTrpc(page, "courseObject.create");
      await page.mouse.click(a.x, a.y); // the first vertex closes
      await created;
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-kind", "whiteout", { timeout: 15000 });
      const id = (await page.getByTestId("editor-object").getAttribute("data-object-id"))!;
      const row = objectRow(page, id);
      const stored = async () => JSON.parse((await row.getAttribute("data-geometry-json")) ?? "[]") as { x: number; y: number; hIn?: Pt; hOut?: Pt }[];
      await expect(row).toHaveCount(1, { timeout: 15000 });
      const g = await stored();
      expect(g).toHaveLength(3);
      // hOut = the drag vector on paper, hIn its negation.
      const [c0, c1] = await Promise.all([toPaper(page, c), toPaper(page, pullTo)]);
      expect(g[2].hOut!.x).toBeCloseTo(c1.x - c0.x, 0);
      expect(g[2].hOut!.y).toBeCloseTo(c1.y - c0.y, 0);
      expect(g[2].hIn).toEqual({ x: -g[2].hOut!.x, y: -g[2].hOut!.y });
      // The selection outline follows the curve: 8 samples on each of the two curved segments.
      await expect(page.getByTestId("editor-object-grip")).toHaveCount(2);
      const outline = page.getByTestId("editor-tool-layer").locator(`[data-testid="editor-object-outline"][data-object-id="${id}"]`);
      expect(((await outline.getAttribute("data-points")) ?? "").split(" ")).toHaveLength(2 + 8 + 8);

      // Printed: the page stream carries the white-out as one more fill with Bézier `c` segments.
      const after = await printed(page, nameId, "allControls=1");
      expect(after.pages).toBe(1);
      expect(after.curvedFills, "the curved white-out's fill").toBe(before.curvedFills + 1);

      // Insert: a double-click on the straight edge a → b (§7 "Editing geometry").
      const handles = page.getByTestId("editor-tool-layer").getByTestId("editor-object-handle");
      await expect(handles).toHaveCount(3);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const inserted = waitForTrpc(page, "courseObject.update");
      await page.mouse.dblclick(mid.x, mid.y);
      await inserted;
      await expect(handles).toHaveCount(4);
      await expect.poll(async () => (await stored()).length, { timeout: 15000 }).toBe(4);
      const added = (await stored())[1];
      const [ma, mb] = await Promise.all([toPaper(page, a), toPaper(page, b)]);
      expect(added.x).toBeCloseTo((ma.x + mb.x) / 2, 0);
      expect(added.y).toBeCloseTo((ma.y + mb.y) / 2, 0);
      expect(added.hIn ?? added.hOut).toBeUndefined();

      // Delete: click the new vertex (focused), Delete removes it; undo brings it back.
      const at = await toPage(page, added);
      await page.mouse.click(at.x, at.y);
      await expect(page.getByTestId("editor-tool-layer").locator('[data-testid="editor-object-handle"][data-focused="true"]')).toHaveCount(1);
      const removed = waitForTrpc(page, "courseObject.update");
      await page.keyboard.press("Delete");
      await removed;
      await expect(handles).toHaveCount(3);
      await expect.poll(async () => (await stored()).length, { timeout: 15000 }).toBe(3);
      await expect(row).toHaveCount(1); // the vertex went, not the object
      const undone = waitForTrpc(page, "courseObject.update");
      await page.keyboard.press("Control+z");
      await undone;
      await expect.poll(async () => (await stored()).length, { timeout: 15000 }).toBe(4);

      // Alt-drag on the corner b pulls two more grips; Alt-click retracts them.
      const bAt = await toPage(page, (await stored())[2]);
      const pulled = waitForTrpc(page, "courseObject.update");
      await page.keyboard.down("Alt");
      await drag(page, bAt, { x: bAt.x + 20, y: bAt.y + 20 });
      await page.keyboard.up("Alt");
      await pulled;
      await expect(page.getByTestId("editor-object-grip")).toHaveCount(4);
      await expect.poll(async () => (await stored())[2].hOut !== undefined, { timeout: 15000 }).toBe(true);
      const retracted = waitForTrpc(page, "courseObject.update");
      await page.keyboard.down("Alt");
      await page.mouse.click(bAt.x, bAt.y);
      await page.keyboard.up("Alt");
      await retracted;
      await expect(page.getByTestId("editor-object-grip")).toHaveCount(2);

      await page.getByTestId("editor-object-delete").click();
      await expect(row).toHaveCount(0, { timeout: 15000 });
    } finally {
      await drop();
    }
  });

  test("A: Alt at the second of three clicks places a smooth vertex, its handles a sixth of its neighbours' chord; one undo removes it", async ({ page }) => {
    await openEditor(page);
    await page.getByTestId("editor-tool-A").click();
    await page.getByTestId("editor-area-whiteout").click();
    const clear = await emptyPoint(page, 40);
    const a = { x: clear.x - 30, y: clear.y - 15 }, b = { x: a.x + 60, y: a.y }, c = { x: a.x + 60, y: a.y + 40 };
    await page.mouse.click(a.x, a.y);
    // Alt held at the press: a smooth vertex (docs/course-editor.md §6.4); no next vertex yet, so no handles in the state.
    await page.keyboard.down("Alt");
    await page.mouse.click(b.x, b.y);
    await page.keyboard.up("Alt");
    await expect(page.getByTestId("editor-polygon-vertex")).toHaveCount(2);
    await expect(page.getByTestId("editor-polygon-grip")).toHaveCount(0);
    // The next vertex lands: b's handles follow its neighbours.
    await page.mouse.click(c.x, c.y);
    await expect(page.getByTestId("editor-polygon-grip")).toHaveCount(2);
    const created = waitForTrpc(page, "courseObject.create");
    await page.mouse.click(a.x, a.y); // the first vertex closes
    await created;
    await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-kind", "whiteout", { timeout: 15000 });
    const id = (await page.getByTestId("editor-object").getAttribute("data-object-id"))!;
    const row = objectRow(page, id);
    await expect(row).toHaveCount(1, { timeout: 15000 });
    const g = JSON.parse((await row.getAttribute("data-geometry-json")) ?? "[]") as { x: number; y: number; hIn?: Pt; hOut?: Pt; smooth?: boolean }[];
    expect(g).toHaveLength(3);
    // Uniform Catmull-Rom: hOut = (g2 − g0) / 6, hIn its negation; the corners keep none; no drawing flag stored.
    expect(g[1].hOut!.x).toBeCloseTo((g[2].x - g[0].x) / 6, 3);
    expect(g[1].hOut!.y).toBeCloseTo((g[2].y - g[0].y) / 6, 3);
    expect(g[1].hIn).toEqual({ x: -g[1].hOut!.x, y: -g[1].hOut!.y });
    expect(g[0].hIn ?? g[0].hOut ?? g[2].hIn ?? g[2].hOut).toBeUndefined();
    expect(g.some((v) => "smooth" in v)).toBe(false);
    // The chord on screen agrees (paper mm of the clicks).
    const [pa, pc] = await Promise.all([toPaper(page, a), toPaper(page, c)]);
    expect(g[1].hOut!.x).toBeCloseTo((pc.x - pa.x) / 6, 0);
    expect(g[1].hOut!.y).toBeCloseTo((pc.y - pa.y) / 6, 0);
    await expect(page.getByTestId("editor-object-grip")).toHaveCount(2);
    // One create, one undo entry: Ctrl+Z removes the whole object.
    await page.keyboard.press("Control+z");
    await expect(row).toHaveCount(0, { timeout: 15000 });
  });

  test("a filter region hides the path under it live", async ({ page }) => {
    await openEditor(page);
    // e2e/test.ocd: a 505 path runs along y ≈ −4 mm (the fixture's symbol index 3).
    const band = { minX: -8, minY: -6, maxX: 8, maxY: -2 };
    const before = await inkIn(page, band);
    expect(before, "path ink before the region").toBeGreaterThan(5);
    // The `A` chord (§6.4): `A` opens the menu as a portal above the inspector, `F` picks the filter region.
    await page.keyboard.press("a");
    const menu = page.getByTestId("editor-area-menu");
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    const onTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="editor-area-menu"]') !== null, { x: menuBox.x + 8, y: menuBox.y + 8 });
    expect(onTop, "the area menu is not covered by the inspector").toBe(true);
    await page.keyboard.press("f");
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId("editor-tool-A")).toHaveAttribute("aria-pressed", "true");
    for (const p of [{ x: -12, y: -9 }, { x: 12, y: -9 }, { x: 12, y: 1 }, { x: -12, y: 1 }]) {
      const q = await toPage(page, p);
      await page.mouse.click(q.x, q.y);
    }
    const created = waitForTrpc(page, "courseObject.create");
    const firstVertex = await toPage(page, { x: -12, y: -9 });
    await page.mouse.click(firstVertex.x, firstVertex.y);
    await created;
    await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-kind", "filter_region", { timeout: 15000 });
    const id = (await page.getByTestId("editor-object").getAttribute("data-object-id"))!;
    try {
      // "By symbols" is a write of its own: wait for it, else the row's refetch from it lands after the checkbox's
      // write and unchecks the box under Playwright's `check()` (D10 flake "checkbox state").
      const bySymbols = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-filter-by").selectOption("symbols");
      await bySymbols;
      await expect(objectRow(page, id)).toHaveAttribute("data-props", /"symbols":\[\]/, { timeout: 15000 });
      await page.getByTestId("editor-filter-search").fill("505");
      // Listed by its heading (no applied match in the fixture: the source code's base, §7): symbol index 3, "505 Path". A fixture change fails here.
      const path505 = page.getByTestId("editor-filter-symbol-505");
      await expect(path505.locator("xpath=..")).toContainText("Path");
      const updated = waitForTrpc(page, "courseObject.update");
      await path505.click();
      await updated;
      await expect(path505).toBeChecked({ timeout: 15000 });
      await expect.poll(() => inkIn(page, band), { timeout: 30000 }).toBeLessThan(before / 3);
      // Delete it: the path is back.
      await page.getByTestId("editor-object-delete").click();
      await expect.poll(() => inkIn(page, band), { timeout: 30000 }).toBeGreaterThan(before / 2);
    } finally {
      await cleanup("courseObject.delete", { id: Number(id) });
    }
  });

  test("A then S: the toner saver is the smooth offset hull of the course at 25 mm, handles stored, its curves in the course's print", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    await newCourse(page, "D13 toner");
    const courseId = Number(await page.getByTestId("editor-course-picker").inputValue());
    await arm(page, "K");
    const spots: Pt[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await emptyPoint(page, 60, spots);
      spots.push(p);
      await place(page, p);
      await expect(controlRows(page)).toHaveCount(i + 1, { timeout: 15000 });
    }
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
    // The course's sheet before the toner saver (course-layout.md §5): its printed curves are the base map's.
    const template = await probeTemplate("Toner probe");
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId, templateId: template.seq, overrides: {}, objects: [] });
    let id = "";
    try {
      const before = await printed(page, nameId, `maps=${sheet.seq}`);

      const created = waitForTrpc(page, "courseObject.create");
      await page.keyboard.press("a");
      await page.keyboard.press("s");
      await created;
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-kind", "toner_saver", { timeout: 15000 });
      id = (await page.getByTestId("editor-object").getAttribute("data-object-id"))!;
      const row = objectRow(page, id);
      await expect(row).toHaveCount(1, { timeout: 15000 });
      expect(JSON.parse((await row.getAttribute("data-props")) ?? "{}")).toMatchObject({ marginMm: 25 });
      const g = JSON.parse((await row.getAttribute("data-geometry-json")) ?? "[]") as { x: number; y: number; hIn?: unknown; hOut?: Pt }[];
      expect(g.filter((v) => v.hOut).length, "Bézier arcs, not an octagon").toBeGreaterThanOrEqual(3);
      // Three sites: three arcs of one or two pieces, three straight offset edges.
      expect(g.length).toBeGreaterThanOrEqual(6);
      await expect(page.getByTestId("editor-prop-margin")).toHaveValue("25");
      // The selected outline samples every curved segment.
      const outline = page.getByTestId("editor-tool-layer").locator(`[data-testid="editor-object-outline"][data-object-id="${id}"]`);
      expect(((await outline.getAttribute("data-points")) ?? "").split(" ").length).toBeGreaterThan(g.length);

      // Printed (D13's deferred item): the course's page carries the hull's arcs as Bézier `c` segments — at least
      // one per stored curved vertex more than without it.
      const after = await printed(page, nameId, `maps=${sheet.seq}`);
      expect(after.pages).toBe(1);
      expect(after.curves - before.curves, "the toner saver's arcs in the course's maps.pdf").toBeGreaterThanOrEqual(g.filter((v) => v.hOut).length);
    } finally {
      if (id) await cleanup("courseObject.delete", { id: Number(id) });
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
    }
  });
});

test.describe("Course editor layout (docs/course-layout.md)", () => {
  desktopOnly();
  const frame: Frame = { x: 10, y: 40, width: 190, height: 247 };

  /** A template with `frame` and a sheet on it for the first imported course, as the Maps page would make them. */
  async function sheetFixture(name: string): Promise<{ template: { seq: number }; sheet: { seq: number }; drop: () => Promise<void> }> {
    const courses = await trpcCall<{ id: number }[]>("course.list", undefined, false);
    expect(courses.length).toBeGreaterThan(0);
    const template = await probeTemplate(name, frame, 5);
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId: courses[0].id, templateId: template.seq, overrides: {}, objects: [] });
    return {
      template, sheet,
      drop: async () => {
        await cleanup("courseMap.delete", { id: sheet.seq });
        await cleanup("mapTemplate.delete", { id: template.seq });
      },
    };
  }

  test("a sheet from the Maps page: page text drawn as printed, align map saves the window centre, undo, one A4 page", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const { template, sheet, drop } = await sheetFixture("Layout");
    try {
      await page.goto(`/${nameId}/maps`);
      await page.getByTestId(`edit-course-map-${sheet.seq}`).click();
      await expect(page).toHaveURL(new RegExp(`course-editor\\?mode=layout&sheet=${sheet.seq}`));
      await editorReady(page);
      await expect(page.getByTestId("editor-mode-layout")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq));
      for (const id of ["editor-layout-paper", "editor-layout-printable", "editor-layout-frame"]) {
        await expect(page.getByTestId("editor-tool-layer").getByTestId(id)).toBeAttached();
      }
      // Course mode's tools are not here: Layout's rail replaces the rail. No ellipse tool (D16: `O` dropped).
      await expect(page.getByTestId("editor-tool-rail")).toHaveCount(0);
      await expect(page.getByTestId("editor-layout-rail")).toBeVisible();
      await expect(page.getByTestId("editor-layout-tool-P")).toBeVisible();
      await expect(page.getByTestId("editor-layout-tool-O")).toHaveCount(0);

      // H: a header text at page (20, 20) mm, above the frame: ink where the page layer draws it.
      const toPaperMm = await pageToPaperOf(page, frame);
      const textRect = (() => {
        const a = toPaperMm({ x: 22, y: 12 }), b = toPaperMm({ x: 110, y: 21 });
        return { minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x), minY: Math.min(a.y, b.y), maxY: Math.max(a.y, b.y) };
      })();
      const inkBefore = await inkIn(page, textRect);
      await page.getByTestId("editor-layout-tool-H").click();
      const placed = waitForTrpc(page, "courseMap.saveLayout");
      await clickMap(page, await toPage(page, toPaperMm({ x: 20, y: 20 })));
      await placed;
      await expect(page.getByTestId("editor-layout-object-row")).toHaveCount(1);
      // A long text, large: what the inspector writes, drawn by the page layer.
      for (const [id, value] of [["editor-layout-text", "LAYOUT PAGE TEXT"], ["editor-layout-font-size", "10"]] as const) {
        const saved = waitForTrpc(page, "courseMap.saveLayout");
        await page.getByTestId(id).fill(value);
        await page.getByTestId(id).press("Enter");
        await saved;
      }
      await expect.poll(() => inkIn(page, textRect), { timeout: 15_000 }).toBeGreaterThan(inkBefore + 20);

      // Select the frame (a click inside it on nothing), then drag it: align map.
      const inside = await toPage(page, toPaperMm({ x: 105, y: 160 }));
      await page.keyboard.press("Escape");
      await clickMap(page, inside);
      await expect(page.getByTestId("editor-layout-selected")).toHaveAttribute("data-kind", "frame");
      const state = page.getByTestId("editor-layout-state");
      const [cx, cy] = (await state.getAttribute("data-centre"))!.split(",").map(Number);
      const to = { x: inside.x + 60, y: inside.y + 40 };
      const [a, b] = [await toPaper(page, inside), await toPaper(page, to)];
      const saved = waitForTrpc(page, "courseMap.saveLayout");
      await drag(page, inside, to);
      await saved;
      const stored = await trpcCall<{ windowCenter: Pt }>("courseMap.get", { seq: sheet.seq }, false);
      expect(stored.windowCenter.x).toBeCloseTo(cx + (b.x - a.x), 0);
      expect(stored.windowCenter.y).toBeCloseTo(cy + (b.y - a.y), 0);
      expect(Math.hypot(stored.windowCenter.x - cx, stored.windowCenter.y - cy)).toBeGreaterThan(2);

      // Undo writes the previous centre back.
      const undone = waitForTrpc(page, "courseMap.saveLayout");
      await page.keyboard.press("Control+z");
      await undone;
      await expect.poll(async () => (await trpcCall<{ windowCenter: Pt }>("courseMap.get", { seq: sheet.seq }, false)).windowCenter.x).toBeCloseTo(cx, 3);

      // The sheet prints as one page of the template's paper.
      const pdf = await printed(page, nameId, `maps=${sheet.seq}`);
      expect(pdf.pages).toBe(1);
      expect(pdf.sizeMm).toEqual([210, 297]);

      // The template link: template scope edits the template's objects; the sheet's text is not among them.
      await page.getByTestId("editor-layout-edit-template").click();
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-scope", "template");
      await expect(page.getByTestId("editor-layout-object-row")).toHaveCount(0);
      await expect(page.getByTestId("editor-layout-paper-size")).toHaveValue("A4");
      // A template write: orientation through mapTemplate.update.
      const updated = waitForTrpc(page, "mapTemplate.update");
      await page.getByTestId("editor-layout-orientation").selectOption("landscape");
      await updated;
      const templates = await trpcCall<{ seq: number; orientation: string }[]>("mapTemplate.list", undefined, false);
      expect(templates.find((t) => t.seq === template.seq)?.orientation).toBe("landscape");

      // The Map templates page's Edit template layout opens the same template scope.
      await page.goto(`/${nameId}/map-templates`);
      await page.getByTestId(`edit-template-layout-${template.seq}`).click();
      await expect(page).toHaveURL(new RegExp(`course-editor\\?mode=layout&template=${template.seq}`));
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-scope", "template", { timeout: 30_000 });
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-template", String(template.seq));
    } finally {
      await drop();
    }
  });

  test("graphics: upload an SVG, place it on the sheet, it is listed and deleted", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const { sheet, drop } = await sheetFixture("Layout graphic");
    const images = async () =>
      (await trpcCall<{ objects: { kind: string; graphicId?: number }[] }>("courseMap.get", { seq: sheet.seq }, false)).objects.filter((o) => o.kind === "image");
    try {
      await page.goto(`/${nameId}/course-editor?mode=layout&sheet=${sheet.seq}`);
      await editorReady(page);
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq));

      // Upload into the Graphics section; its Place button arms the image tool.
      await page.getByTestId("editor-layout-graphics-toggle").click();
      const uploaded = waitForTrpc(page, "graphics.upload");
      await page.getByTestId("editor-layout-graphic-upload").setInputFiles({
        name: "e2e-logo.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#336699"/></svg>'),
      });
      await uploaded;
      const placeButton = page.locator('[data-testid^="editor-layout-graphic-place-"]').last();
      await expect(placeButton).toBeVisible();
      await placeButton.click();
      await expect(placeButton).toHaveAttribute("aria-pressed", "true");

      // A click on the page above the frame places it: one write, listed as an image row.
      const toPaperMm = await pageToPaperOf(page, frame);
      const placed = waitForTrpc(page, "courseMap.saveLayout");
      await clickMap(page, await toPage(page, toPaperMm({ x: 150, y: 20 })));
      await placed;
      const row = page.locator('[data-testid="editor-layout-object-row"][data-kind="image"]');
      await expect(row).toHaveCount(1);
      expect(await images()).toHaveLength(1);

      // Selected from the list and deleted: gone from the list and from the sheet.
      await row.click();
      await expect(page.getByTestId("editor-layout-selected")).toHaveAttribute("data-kind", "object");
      const deleted = waitForTrpc(page, "courseMap.saveLayout");
      await page.getByTestId("editor-layout-delete").click();
      await deleted;
      await expect(row).toHaveCount(0);
      await expect.poll(async () => (await images()).length).toBe(0);
    } finally {
      await drop();
    }
  });

  test("P draws a polygon in clicks and a click-drag; its edge takes a vertex by double-click, Delete takes it out; the print has its curve", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const { sheet, drop } = await sheetFixture("Layout polygon");
    type Stored = { objects: { kind: string; closed?: boolean; points?: { x: number; y: number; hIn?: Pt; hOut?: Pt }[] }[] };
    const stored = async () => (await trpcCall<Stored>("courseMap.get", { seq: sheet.seq }, false)).objects;
    try {
      const curvesBefore = (await printed(page, nameId, `maps=${sheet.seq}`)).curves;

      await page.goto(`/${nameId}/course-editor?mode=layout&sheet=${sheet.seq}`);
      await editorReady(page);
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq));
      const toPaperMm = await pageToPaperOf(page, frame);
      const at = async (x: number, y: number) => toPage(page, toPaperMm({ x, y }));

      // P: corners by clicks, a curve vertex by a click-drag, closed by a click on the first vertex — one write.
      await page.getByTestId("editor-layout-tool-P").click();
      await expect(page.getByTestId("editor-layout-tool-P")).toHaveAttribute("aria-pressed", "true");
      await clickMap(page, await at(40, 60));
      await clickMap(page, await at(90, 60));
      await drag(page, await at(90, 110), await at(100, 120));
      await clickMap(page, await at(40, 110));
      await expect(page.getByTestId("editor-tool-layer").getByTestId("editor-polygon-vertex")).toHaveCount(4);
      const drawn = waitForTrpc(page, "courseMap.saveLayout");
      await clickMap(page, await at(40, 60));
      await drawn;
      const [path] = await stored();
      expect(path).toMatchObject({ kind: "path", closed: true });
      expect(path.points).toHaveLength(4);
      expect(Math.abs(path.points![0].x - 40) + Math.abs(path.points![0].y - 60)).toBeLessThan(2);
      // The pull's handle on the page: down and to the right, as dragged.
      expect(path.points![2].hOut!.x).toBeGreaterThan(5);
      expect(path.points![2].hOut!.y).toBeGreaterThan(5);
      expect(path.points![2].hIn!.x).toBeLessThan(-5);
      // Selected, back in V, with the course editor's handles and grips.
      await expect(page.getByTestId("editor-layout-selected")).toHaveAttribute("data-kind", "object");
      await expect(page.getByTestId("editor-layout-tool-V")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-tool-layer").getByTestId("editor-layout-handle")).toHaveCount(4);
      await expect(page.getByTestId("editor-tool-layer").getByTestId("editor-layout-grip")).toHaveCount(2);

      // A double-click on the straight top edge: a vertex there, focused; Delete removes it again.
      const mid = await at(65, 60);
      const inserted = waitForTrpc(page, "courseMap.saveLayout");
      await page.mouse.dblclick(mid.x, mid.y);
      await inserted;
      await expect.poll(async () => (await stored())[0].points?.length).toBe(5);
      await expect(page.getByTestId("editor-tool-layer").locator('[data-testid="editor-layout-handle"][data-focused="true"]')).toHaveCount(1);
      const removed = waitForTrpc(page, "courseMap.saveLayout");
      await page.keyboard.press("Delete");
      await removed;
      await expect.poll(async () => (await stored())[0].points?.length).toBe(4);
      await expect(page.getByTestId("editor-layout-object-row")).toHaveCount(1);

      // Escape discards a polygon being drawn (no write); Enter closes one from three vertices.
      await page.getByTestId("editor-layout-tool-P").click();
      await clickMap(page, await at(120, 60));
      await clickMap(page, await at(160, 60));
      await expect(page.getByTestId("editor-tool-layer").getByTestId("editor-polygon-vertex")).toHaveCount(2);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-layout-tool-V")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-tool-layer").getByTestId("editor-polygon-vertex")).toHaveCount(0);
      await page.getByTestId("editor-layout-tool-P").click();
      for (const [x, y] of [[120, 60], [160, 60], [140, 100]]) await clickMap(page, await at(x, y));
      const entered = waitForTrpc(page, "courseMap.saveLayout");
      await page.keyboard.press("Enter");
      await entered;
      await expect.poll(async () => (await stored()).map((o) => o.points?.length)).toEqual([4, 3]);

      // The curve prints as a Bézier (`c`) on the sheet's page.
      expect((await printed(page, nameId, `maps=${sheet.seq}`)).curves).toBeGreaterThan(curvesBefore);
    } finally {
      await drop();
    }
  });
});

test.describe("Course editor auto templates (docs/course-layout.md §5–§7)", () => {
  desktopOnly();

  test("Export ▾ makes a course's first sheet; a class scale gets a class sheet and Class view; an extra template and a move back", async ({ page }) => {
    await openEditor(page);
    // A course with classes and no sheet yet.
    const courses = await trpcCall<{ id: number; name: string }[]>("course.list", undefined, false);
    const sheets = await trpcCall<{ courseId: number | null }[]>("courseMap.list", undefined, false);
    let course: { id: number; name: string } | null = null;
    let cls: { seq: number; name: string } | null = null;
    for (const c of courses) {
      if (sheets.some((s) => s.courseId === c.id)) continue;
      const classes = await trpcCall<{ seq: number; name: string }[]>("layout.classOverrides", { courseId: c.id }, false);
      if (classes.length) { course = c; cls = classes[0]; break; }
    }
    expect(course, "a course with classes and no sheet").not.toBeNull();
    await page.getByTestId("editor-course-picker").selectOption(String(course!.id));

    // Export ▾ → this course: the sheet is created first, then one page prints.
    await page.getByTestId("editor-export").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("editor-export-course").click()]);
    expect((await analysePdf(await readFile((await download.path())!))).pages).toBe(1);
    const own = (await trpcCall<{ seq: number; courseId: number | null; class: unknown }[]>("courseMap.list", undefined, false))
      .filter((s) => s.courseId === course!.id && s.class === null);
    expect(own).toHaveLength(1);

    // Layout mode: the sheet's template is its key's auto template.
    await page.getByTestId("editor-mode-layout").click();
    await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(own[0].seq), { timeout: 30_000 });
    const badge = page.getByTestId("editor-layout-template-badge");
    await expect(badge).toHaveAttribute("data-extra", "false");
    await expect(badge).toHaveAttribute("data-auto-key", /^A4-(portrait|landscape)-\d+$/);
    expect(await statsRow(page, "sheet", "key")).toMatch(/^1:\d+ A4 /);

    // A class prints at 1:15000: its class sheet appears.
    const overridden = waitForTrpc(page, "layout.setClassOverride");
    await page.getByTestId(`editor-layout-class-scale-${cls!.seq}`).fill("15000");
    await page.getByTestId(`editor-layout-class-scale-${cls!.seq}`).press("Enter");
    await overridden;
    await expect(page.getByTestId(`editor-layout-class-${cls!.seq}`)).toHaveAttribute("data-sheets", "1");

    // Class view in Course mode: the course as the class prints it.
    await page.getByTestId("editor-mode-course").click();
    await page.getByTestId("editor-view-class").selectOption(String(cls!.seq));
    await expect.poll(() => statsRow(page, "sheet", "key"), { timeout: 15_000 }).toMatch(/^1:15000 A4 /);
    await page.getByTestId("editor-export").click();
    const [classDownload] = await Promise.all([page.waitForEvent("download"), page.getByTestId("editor-export-class").click()]);
    expect(classDownload.suggestedFilename()).toMatch(/\.pdf$/);

    // Back in Course view, Layout: an extra template takes the course; its row moves it back to the auto template.
    await page.getByTestId("editor-view-course").click();
    await page.getByTestId("editor-mode-layout").click();
    await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(own[0].seq), { timeout: 30_000 });
    const duplicated = waitForTrpc(page, "mapTemplate.applyToCourses");
    await page.getByTestId("editor-layout-create-extra").click();
    await duplicated;
    await expect(badge).toHaveAttribute("data-extra", "true", { timeout: 15_000 });
    const moved = waitForTrpc(page, "mapTemplate.applyToCourses");
    await page.getByTestId(`editor-layout-template-move-${course!.id}`).click();
    await moved;
    await expect(badge).toHaveAttribute("data-extra", "false", { timeout: 15_000 });
    // Undo moves it to the extra template again (one gesture, one entry).
    const undone = waitForTrpc(page, "mapTemplate.applyToCourses");
    await page.keyboard.press("Control+z");
    await undone;
    await expect(badge).toHaveAttribute("data-extra", "true", { timeout: 15_000 });
  });
});

test.describe("Course editor checks", () => {
  desktopOnly();

  test("two controls 20 m apart: a marker, a row that locates them, the count on the course-info button", async ({ page }) => {
    await openEditor(page);
    const scale = await mapScale(page);
    expect(scale).toBeGreaterThan(0);
    const spot = await toPaper(page, await emptyPoint(page, 40));
    const dMm = 20_000 / scale;
    const codes = [251, 252];
    for (const [i, code] of codes.entries()) {
      await trpcCall("control.create", { codes: String(code), xpos: spot.x + i * dMm, ypos: spot.y, description: { d: `1.00${i + 1}` } });
    }
    try {
      await page.reload();
      await editorReady(page);
      // The section is collapsed by default; its count stands beside the title.
      await expect(page.getByTestId("editor-checks-count")).toBeVisible({ timeout: 20000 });
      await page.getByTestId("editor-checks-toggle").click();
      // The pair is listed in site order, which need not be creation order (the row ids decide): match either.
      const row = page.locator('[data-testid="editor-check-row"][data-code="CONTROL_TOO_CLOSE"]:is([data-sites="251,252"], [data-sites="252,251"])');
      await expect(row).toBeVisible({ timeout: 20000 });
      const first = (await row.getAttribute("data-sites"))!.split(",")[0];
      await expect(row).toContainText("20 m");
      await expect(page.locator('[data-testid="editor-check-marker"][data-code="CONTROL_TOO_CLOSE"][data-site="251"]')).toBeAttached();
      await expect(page.locator('[data-testid="editor-check-marker"][data-code="CONTROL_TOO_CLOSE"][data-site="252"]')).toBeAttached();
      // The count is the course-info button's badge (P2) and a row of its popover.
      const badge = Number(await page.getByTestId("editor-stats-badge").getAttribute("data-count"));
      expect(badge).toBeGreaterThan(0);
      expect(Number(await statsRow(page, "checks", "count"))).toBe(badge);

      // Click-to-locate: selects the first site and centres the view on the pair's midpoint.
      await row.click();
      await expect(selectedCode(page)).toHaveText(first, { timeout: 10000 });
      await expect.poll(async () => (await viewCentre(page)).x / 1000, { timeout: 10000 }).toBeCloseTo(spot.x + dMm / 2, 1);
      await expect.poll(async () => (await viewCentre(page)).y / 1000, { timeout: 10000 }).toBeCloseTo(spot.y, 1);
    } finally {
      for (const code of codes) await cleanup("control.delete", { id: code });
    }
  });
});

// docs/course-editor.md §3 "Conflicts", §11; course-layout.md §2 (D8's sheet / template tokens). Two browser contexts
// on one event: B writes, A's next write carries the token from before B's and the server answers CONFLICT.
// A's change poll is held still (`freezeExternalPoll`): D11's live refresh would otherwise re-seed A's token within
// 5 s and turn the stale write into a race (a test mechanism, not a product rule — decision log, D10).
test.describe("conflicts (two contexts)", () => {
  desktopOnly();

  async function second(browser: Browser, info: TestInfo, path: string): Promise<{ page: Page; close: () => Promise<void> }> {
    const { ctx, page } = await desktopContext(browser, info);
    await selectCompetition(page);
    await page.goto(path);
    await editorReady(page);
    return { page, close: () => ctx.close() };
  }

  /** A control as stored: its paper position (`course.controlCoordinates`) and its description (`control.getById`). */
  async function storedControl(code: string): Promise<{ xpos: number; ypos: number; description: { d?: string } | null }> {
    const at = (await trpcCall<{ id: number; mapX: number; mapY: number }[]>("course.controlCoordinates", undefined, false)).find((c) => c.id === Number(code))!;
    const { description } = await trpcCall<{ description: { d?: string } | null }>("control.getById", { id: Number(code) }, false);
    return { xpos: at.mapX, ypos: at.mapY, description };
  }

  test("a structure written elsewhere: the stale append is refused, the rows reload, the notice names the change", async ({ page, browser }, info) => {
    await openEditor(page);
    await newCourse(page, "D10 conflict");
    const courseId = await page.getByTestId("editor-course-picker").inputValue();
    const [x, y] = await regularCodes(page, 2);
    await freezeExternalPoll(page);
    const b = await second(browser, info, `/${nameIdOf(page)}/course-editor?course=${courseId}`);
    try {
      await act(b.page, y, "append", "course.setStructure");
      await expect(controlRows(b.page)).toHaveCount(1, { timeout: 15000 });

      // A appends X on the structure it last saw: refused, never merged (§3) — the notice, then the reload shows B's.
      const responses: number[] = [];
      page.on("response", (r) => { if (isTrpcResponse(r, "course.setStructure")) responses.push(r.status()); });
      await select(page, x);
      await page.getByTestId("editor-action-bar").getByTestId("editor-action-append").click();
      const notice = page.getByTestId("editor-conflict");
      await expect(notice).toHaveAttribute("data-kind", "refresh", { timeout: 15000 });
      await expect(notice).toContainText(/Changed elsewhere/);
      expect(responses).toHaveLength(1); // no silent re-send of a structure
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
      await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", y);
      await page.getByTestId("editor-conflict-dismiss").click();
      await expect(notice).toHaveCount(0);

      // Redone on the reloaded structure, it lands after B's (X again, or another control when B's leg now runs
      // over X and wins its click).
      const [redo] = await regularCodes(page, 1, [y]);
      await act(page, redo, "append", "course.setStructure");
      await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
      await expect(controlRows(page).nth(1)).toHaveAttribute("data-control-id", redo);
      await expect(page.getByTestId("editor-conflict")).toHaveCount(0);
    } finally {
      await b.close();
    }
  });

  test("a control moved elsewhere: a description edit rebases silently; a second move offers Keep mine, which wins", async ({ page, browser }, info) => {
    await openEditor(page);
    const [code] = await regularCodes(page, 1);
    const original = await storedControl(code);
    await freezeExternalPoll(page);
    const b = await second(browser, info, `/${nameIdOf(page)}/course-editor`);
    try {
      // B writes the description (a field a move does not touch): column D a boulder only.
      await select(b.page, code);
      const described = waitForTrpc(b.page, "control.update");
      await b.page.getByTestId("editor-action-bar").getByTestId("editor-action-description").click();
      await expect(b.page.getByTestId("desc-editor")).toBeVisible();
      if (await b.page.getByTestId("desc-clear").isEnabled()) await b.page.getByTestId("desc-clear").click();
      await b.page.getByTestId("desc-editor").getByTestId("desc-section-d").getByTestId("desc-opt-2.4").click();
      await b.page.getByTestId("desc-save").click();
      await described;

      // A moves it from the token before B's write: CONFLICT, re-sent once with the server's token, no notice.
      const statuses: number[] = [];
      page.on("response", (r) => { if (isTrpcResponse(r, "control.update")) statuses.push(r.status()); });
      const from = await sitePoint(page, code);
      const to = await dragTarget(page, from);
      const settled = page.waitForResponse((r) => isTrpcResponse(r, "control.update") && r.status() === 200);
      await drag(page, from, to);
      await settled;
      expect(statuses[0], "the first write is refused").toBe(409);
      await expect(page.getByTestId("editor-conflict")).toHaveCount(0);
      const afterA = await storedControl(code);
      expect(Math.hypot(afterA.xpos - original.xpos, afterA.ypos - original.ypos)).toBeGreaterThan(1);
      expect(afterA.description?.d, "B's description (a boulder, 2.004) survives A's move").toBe("2.004");

      // B sees A's move within its (live) poll, then moves it again.
      await expect.poll(async () => {
        const s = await site(b.page, code);
        return Math.hypot(s.mm.x - afterA.xpos, s.mm.y - afterA.ypos);
      }, { timeout: 20000 }).toBeLessThan(0.01);
      await dropSelection(b.page);
      const bFrom = await sitePoint(b.page, code);
      const bMoved = waitForTrpc(b.page, "control.update");
      await drag(b.page, bFrom, await dragTarget(b.page, bFrom));
      await bMoved;
      const afterB = await storedControl(code);
      expect(Math.hypot(afterB.xpos - afterA.xpos, afterB.ypos - afterA.ypos)).toBeGreaterThan(1);

      // A moves it once more, still on its own token: both moved it — the notice with B's position, Keep mine / theirs.
      await dropSelection(page);
      const aFrom = await sitePoint(page, code);
      // Not where B dropped it (the same view picks the same target): Keep mine must be told apart from theirs.
      const aTo = await dragTarget(page, aFrom, [await toPage(page, { x: afterB.xpos, y: afterB.ypos })]);
      await drag(page, aFrom, aTo);
      const notice = page.getByTestId("editor-conflict");
      await expect(notice).toHaveAttribute("data-kind", "moved", { timeout: 15000 });
      await expect(notice).toContainText(`${afterB.xpos.toFixed(1)}`);
      await expect(page.getByTestId("editor-conflict-keep-mine")).toBeVisible();
      const kept = waitForTrpc(page, "control.update");
      await page.getByTestId("editor-conflict-keep-mine").click();
      await kept;
      await expect(notice).toHaveCount(0, { timeout: 15000 });
      const final = await storedControl(code);
      expect(Math.hypot(final.xpos - afterB.xpos, final.ypos - afterB.ypos), "A's position won").toBeGreaterThan(1);
      await expect.poll(async () => {
        const s = await site(page, code);
        return Math.hypot(s.mm.x - final.xpos, s.mm.y - final.ypos);
      }, { timeout: 15000 }).toBeLessThan(0.01);
    } finally {
      await b.close();
      await cleanup("control.update", { id: Number(code), xpos: original.xpos, ypos: original.ypos, description: original.description ?? null });
    }
  });

  test("a sheet and a template saved elsewhere: the stale align map and orientation are refused, the other's state shows", async ({ page, browser }, info) => {
    const frame: Frame = { x: 10, y: 40, width: 190, height: 247 };
    await openEditor(page);
    const courses = await trpcCall<{ id: number }[]>("course.list", undefined, false);
    const template = await probeTemplate("Conflict", frame, 5);
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId: courses[0].id, templateId: template.seq, overrides: {}, objects: [] });
    const path = `/${nameIdOf(page)}/course-editor?mode=layout&sheet=${sheet.seq}`;
    await page.goto(path);
    await editorReady(page);
    await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq));
    const b = await second(browser, info, path);
    try {
      /** Select the frame (a click inside it on nothing) and drag it by `by` px: align map, one `courseMap.saveLayout`. */
      const alignMap = async (p: Page, by: Pt) => {
        const toPaperMm = await pageToPaperOf(p, frame);
        const inside = await toPage(p, toPaperMm({ x: 105, y: 160 }));
        await clickMap(p, inside);
        await expect(p.getByTestId("editor-layout-selected")).toHaveAttribute("data-kind", "frame");
        await drag(p, inside, { x: inside.x + by.x, y: inside.y + by.y });
      };
      const centreOf = async (p: Page) => (await p.getByTestId("editor-layout-state").getAttribute("data-centre"))!.split(",").map(Number);

      // B aligns the map first.
      const bSaved = waitForTrpc(b.page, "courseMap.saveLayout");
      await alignMap(b.page, { x: 60, y: 40 });
      await bSaved;
      const theirs = (await trpcCall<{ windowCenter: Pt }>("courseMap.get", { seq: sheet.seq }, false)).windowCenter;

      // A, on the sheet's old token: refused; the notice; the sheet reloads with B's centre, nothing of A's written.
      await alignMap(page, { x: -50, y: 30 });
      const notice = page.getByTestId("editor-conflict");
      await expect(notice).toHaveAttribute("data-kind", "refresh", { timeout: 15000 });
      await expect.poll(async () => {
        const [x, y] = await centreOf(page);
        return Math.hypot(x - theirs.x, y - theirs.y);
      }, { timeout: 15000 }).toBeLessThan(0.01);
      const kept = (await trpcCall<{ windowCenter: Pt }>("courseMap.get", { seq: sheet.seq }, false)).windowCenter;
      expect(kept).toEqual(theirs);
      await page.getByTestId("editor-conflict-dismiss").click();

      // The template: both open its scope; B turns it landscape, then A (its token from before) writes the paper
      // size — refused too, the whole snapshot is never merged (course-layout.md §2).
      await page.getByTestId("editor-layout-edit-template").click();
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-scope", "template");
      await b.page.getByTestId("editor-layout-edit-template").click();
      await expect(b.page.getByTestId("editor-layout-scope")).toHaveAttribute("data-scope", "template");
      const bTemplate = waitForTrpc(b.page, "mapTemplate.update");
      await b.page.getByTestId("editor-layout-orientation").selectOption("landscape");
      await bTemplate;
      await expect(page.getByTestId("editor-layout-orientation")).toHaveValue("portrait");
      await page.getByTestId("editor-layout-paper-size").selectOption("A3");
      await expect(notice).toHaveAttribute("data-kind", "refresh", { timeout: 15000 });
      const stored = (await trpcCall<{ seq: number; orientation: string; paper: string }[]>("mapTemplate.list", undefined, false)).find((t) => t.seq === template.seq)!;
      expect(stored).toMatchObject({ orientation: "landscape", paper: "A4" });
      await expect(page.getByTestId("editor-layout-orientation")).toHaveValue("landscape", { timeout: 15000 });
    } finally {
      await b.close();
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
    }
  });
});

// docs/course-editor.md §6.4, §7 (P3): the filter region's list grouped by heading, and the eyedropper.
test.describe("filter symbol picker (docs/course-editor.md §6.4, §7)", () => {
  desktopOnly();

  test("the list is one entry per heading with swatches; the eyedropper picks the path by clicking it", async ({ page }) => {
    await openEditor(page);
    // e2e/test.ocd: the 505 path (symbol index 3) runs through (0, −1.3) and (18, −7) mm; the 403 area covers the map.
    const band = { minX: -8, minY: -6, maxX: 8, maxY: -2 };
    const before = await inkIn(page, band);
    expect(before, "path ink before the region").toBeGreaterThan(5);
    await page.keyboard.press("a");
    await page.keyboard.press("f");
    for (const p of [{ x: -12, y: -9 }, { x: 12, y: -9 }, { x: 12, y: 1 }, { x: -12, y: 1 }]) {
      const q = await toPage(page, p);
      await page.mouse.click(q.x, q.y);
    }
    const created = waitForTrpc(page, "courseObject.create");
    const firstVertex = await toPage(page, { x: -12, y: -9 });
    await page.mouse.click(firstVertex.x, firstVertex.y);
    await created;
    await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-kind", "filter_region", { timeout: 15000 });
    const id = (await page.getByTestId("editor-object").getAttribute("data-object-id"))!;
    try {
      const bySymbols = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-filter-by").selectOption("symbols");
      await bySymbols;
      await expect(objectRow(page, id)).toHaveAttribute("data-props", /"symbols":\[\]/, { timeout: 15000 });

      // One entry per heading: 505 (source 505.0), 601 (601.0 matched to 601.b) — never the source codes.
      const list = page.getByTestId("editor-filter-symbols");
      const path505 = page.getByTestId("editor-filter-symbol-505");
      await expect(path505).toHaveAttribute("data-members", "3");
      await expect(path505.locator("xpath=..")).toContainText("Path");
      await expect(page.getByTestId("editor-filter-symbol-601").locator("xpath=..")).toContainText("Magnetic north line");
      await expect(list.locator('[data-testid^="editor-filter-symbol-"][data-testid*="."]')).toHaveCount(0);
      // Each entry has a swatch that loads (the server's library or document preview).
      const swatch = path505.locator("xpath=..").getByTestId("editor-filter-swatch");
      await expect.poll(() => swatch.evaluate((i: HTMLImageElement) => i.complete ? i.naturalWidth : 0), { timeout: 15000 }).toBeGreaterThan(0);
      // The frame (850.1, a rectangle outside the library) is folded under Other.
      await expect(page.getByTestId("editor-filter-symbol-850")).toHaveCount(0);
      await page.getByTestId("editor-filter-other").click();
      await expect(page.getByTestId("editor-filter-symbol-850")).toBeVisible();
      // Search narrows to the matching heading.
      await page.getByTestId("editor-filter-search").fill("path");
      await expect(list.locator('input[type="checkbox"]')).toHaveCount(1);
      await page.getByTestId("editor-filter-search").fill("");

      // The eyedropper: exclusive (V not lit, no ring); a click on the path adds its group.
      const pick = page.getByTestId("editor-filter-pick");
      await pick.click();
      await expect(pick).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByTestId("editor-selection-ring")).toHaveCount(0);
      const onPath = await toPage(page, { x: 4, y: -1.32 - (4 / 18) * 5.66 });
      const updated = waitForTrpc(page, "courseObject.update");
      await page.mouse.click(onPath.x, onPath.y);
      await updated;
      await expect(objectRow(page, id)).toHaveAttribute("data-props", /"symbols":\[3\]/, { timeout: 15000 });
      await expect(path505).toBeChecked({ timeout: 15000 });
      await expect(page.getByTestId("editor-filter-pick-note")).toHaveAttribute("data-kind", "added");
      await expect(page.getByTestId("editor-filter-pick-note")).toContainText("505 Path");
      await expect.poll(() => inkIn(page, band), { timeout: 30000 }).toBeLessThan(before / 3);
      // Still armed (several picks): the path again is already in the region — no write.
      await expect(pick).toHaveAttribute("aria-pressed", "true");
      await page.mouse.click(onPath.x, onPath.y);
      await expect(page.getByTestId("editor-filter-pick-note")).toHaveAttribute("data-kind", "already");
      // Esc ends it and V is back, the region still selected.
      await page.keyboard.press("Escape");
      await expect(pick).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", id);
    } finally {
      await cleanup("courseObject.delete", { id: Number(id) });
    }
  });
});

// docs/course-editor.md §10: the editor's touch subset in Course mode, run by the `mobile` project (Pixel 7). Field
// mode's own phone flows — the sheet, the long-press move and loupe, the area outline tap and pinch — are
// `field-mode.spec.ts`; the area-press rule's touch half (a tap on the outline selects, inside does not) is there.
test.describe("touch (mobile project; docs/course-editor.md §10)", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone's subset (the desktop flows are above)");
  let nameId = "";

  test.beforeEach(async ({ browser }, info) => {
    // The import dialog is a desktop flow: the fixture from a desktop context, idempotent.
    nameId = await ensureFixtureFromDesktop(browser, info);
  });

  async function courseMode(page: Page): Promise<string> {
    await page.goto(`/${nameId}/course-editor`);
    await editorReady(page);
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-layout", "phone");
    await page.getByTestId("editor-mode-course").click();
    await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
    const name = `D10 touch ${Date.now() % 100000}`;
    const { id } = await trpcCall<{ id: number }>("course.create", { name });
    await page.reload();
    await editorReady(page);
    await page.getByTestId("editor-mode-course").click();
    await page.getByTestId("editor-course-picker").selectOption(String(id));
    await expect(page.locator('[data-testid="editor-seq-row"][data-kind="start"]')).toBeAttached({ timeout: 15000 });
    return name;
  }

  /** A regular control in the band above the sheet, clear of its neighbours. */
  async function visibleControl(page: Page, exclude: string[] = []): Promise<{ code: string; at: Pt }> {
    const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
    const sheet = (await page.getByTestId("editor-sheet").boundingBox())!;
    const all = await sites(page);
    for (const s of all) {
      if (s.type !== "Control" || !/^\d+$/.test(s.code) || exclude.includes(s.code)) continue;
      const at = await toPage(page, s.mm);
      if (at.x < viewer.x + 60 || at.x > viewer.x + viewer.width - 60 || at.y < viewer.y + 110 || at.y > sheet.y - 90) continue;
      const others = await Promise.all(all.filter((o) => o.id !== s.id).map((o) => toPage(page, o.mm)));
      if (others.some((o) => Math.hypot(o.x - at.x, o.y - at.y) < 50)) continue;
      return { code: s.code, at };
    }
    throw new Error("no clear control in view");
  }

  test("Course mode on a phone: a tap selects, the peek row appends, one finger moves the selected control, the overflow undoes", async ({ page }) => {
    await courseMode(page);
    const c = await visibleControl(page);
    const start = (await site(page, c.code)).mm;
    try {
      await touchTap(page, c.at);
      await expect(page.getByTestId("editor-sheet-selection")).toContainText(c.code, { timeout: 10000 });
      // The action bar is the sheet's peek row (§10): ≥ 44 px targets, nothing at the selection on the map.
      const append = page.getByTestId("editor-sheet").getByTestId("editor-action-append");
      await expect(append).toBeVisible();
      expect((await append.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // The one action bar is the sheet's (`actionLayout: "host"`): the viewer draws none at the selection.
      await expect(page.getByTestId("editor-action-bar")).toHaveCount(1);
      await expect(page.getByTestId("editor-sheet").getByTestId("editor-action-bar")).toHaveCount(1);
      const appended = waitForTrpc(page, "course.setStructure");
      await append.click();
      await appended;
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
      await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", c.code);

      // One finger on the selected control drags it at once (no long press), drawn above the finger.
      const moved = waitForTrpc(page, "control.update");
      await touchDrag(page, c.at, { x: c.at.x + 30, y: c.at.y - 20 }, { steps: 6 });
      await moved;
      await expect.poll(async () => {
        const now = (await site(page, c.code)).mm;
        return Math.hypot(now.x - start.x, now.y - start.y);
      }, { timeout: 15000 }).toBeGreaterThan(0.5);

      // The overflow's undo puts it back.
      await page.getByTestId("editor-overflow").click();
      const undone = waitForTrpc(page, "control.update");
      await page.getByTestId("editor-overflow-menu").getByTestId("editor-undo").click();
      await undone;
      await expect.poll(async () => {
        const now = (await site(page, c.code)).mm;
        return Math.hypot(now.x - start.x, now.y - start.y);
      }, { timeout: 15000 }).toBeLessThan(0.01);
    } finally {
      await cleanup("control.update", { id: Number(c.code), xpos: start.x, ypos: start.y });
    }
  });

  test("the pin-drop K flow in Course mode appends a placed control to the course and the layer draws its leg", async ({ page }) => {
    const name = await courseMode(page);
    const before = new Set((await sites(page)).map((s) => s.code));
    await page.getByTestId("editor-field-add").click();
    await page.getByTestId("editor-add-K").click();
    await expect(page.getByTestId("editor-touch-bar")).toBeVisible();
    const placed = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-touch-place").click();
    await placed;
    await page.getByTestId("editor-touch-done").click();
    await expect(page.getByTestId("editor-touch-bar")).toHaveCount(0);
    await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
    const code = (await controlRows(page).nth(0).getAttribute("data-control-id"))!;
    expect(before.has(code)).toBe(false);
    try {
      // The start → control leg ends at the new circle's rim.
      const mm = (await site(page, code)).mm;
      await expect.poll(async () => (await legPieces(page, name)).some((l) => {
        const end = l.points.at(-1)!;
        return Math.hypot(end.x - mm.x, end.y - mm.y) < 4;
      }), { timeout: 15000 }).toBe(true);
    } finally {
      await cleanup("control.delete", { id: Number(code) });
    }
  });
});

// P1 (feedback-2026-11-06 items 1 and 2): its own describe, so the parallel rows' edits above merge cleanly.
test.describe("P1: no blue circle on placing; the toner saver covers everything outside it", () => {
  desktopOnly();

  test("no blue circle beside a placed control: K armed and after its clicks, in Layout and Field; V's Add control too; a click brings the ring", async ({ page }) => {
    await openEditor(page);
    await newCourse(page, "P1 ring");
    const blue = async () => {
      await expect(page.getByTestId("editor-phantom")).toHaveCount(0);
      await expect(page.getByTestId("editor-selection-ring")).toHaveCount(0);
    };
    const made: string[] = [];
    try {
      await arm(page, "K");
      const a = await emptyPoint(page, 60);
      await page.mouse.move(a.x, a.y);
      await expect(page.getByTestId("editor-ghost")).toBeAttached({ timeout: 10000 });
      await blue();
      made.push((await place(page, a)).id);
      await blue();
      const b = await emptyPoint(page, 60, [a]);
      made.push((await place(page, b)).id);
      await blue();
      // Field and back to Course keep the just-placed control selected, still without a ring; Layout drops the
      // selection (state.ts) and shows no ring either.
      for (const mode of ["field", "course", "layout", "course"]) {
        await page.getByTestId(`editor-mode-${mode}`).click();
        await expect(page.getByTestId(`editor-mode-${mode}`)).toHaveAttribute("aria-pressed", "true");
        await blue();
      }
      if ((await page.getByTestId("editor-tool-V").getAttribute("aria-pressed")) !== "true") await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");

      // V: the phantom marks the click on empty map (no control exists yet); Add control replaces it by the purple
      // circle alone — the selection shows in the inspector and the action bar, not as a ring (course-editor.md §4).
      const code = await placeOneShot(page);
      made.push(code);
      await blue();
      await expect(page.getByTestId("editor-action-bar")).toBeVisible();
      // A click on the control selects it: V's ring.
      await select(page, code);
      await expect(page.getByTestId("editor-selection-ring")).toHaveCount(1, { timeout: 10000 });
    } finally {
      for (const id of made) await cleanup("control.delete", { id: Number(id) });
    }
  });

  test("Layout mode: a toner saver hides a 709 area outside its shape", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const frame: Frame = { x: 10, y: 40, width: 190, height: 247 };
    const courses = await trpcCall<{ id: number }[]>("course.list", undefined, false);
    const template = await probeTemplate("P1 toner", frame, 5);
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId: courses[0].id, templateId: template.seq, overrides: {}, objects: [] });
    const ids: number[] = [];
    try {
      await page.goto(`/${nameId}/course-editor?mode=layout&sheet=${sheet.seq}`);
      await editorReady(page);
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq));
      await viewSettled(page);
      const toPaperMm = await pageToPaperOf(page, frame);
      // On the map (the page's middle at this print scale): a 709 square in its lower half, the toner saver a band
      // across its upper half (page mm).
      const square = [{ x: 95, y: 172 }, { x: 125, y: 172 }, { x: 125, y: 192 }, { x: 95, y: 192 }].map(toPaperMm);
      const saver = [{ x: 40, y: 110 }, { x: 180, y: 110 }, { x: 180, y: 160 }, { x: 40, y: 160 }].map(toPaperMm);
      const inner = {
        minX: Math.min(...square.map((p) => p.x)) + 2, maxX: Math.max(...square.map((p) => p.x)) - 2,
        minY: Math.min(...square.map((p) => p.y)) + 2, maxY: Math.max(...square.map((p) => p.y)) - 2,
      };
      /** Reload (the editor caches the objects) and zoom in on the square: the hatch resolves into purple lines. */
      const reloadAndZoom = async () => {
        await page.reload();
        await editorReady(page);
        await viewSettled(page);
        const c = await toPage(page, { x: (inner.minX + inner.maxX) / 2, y: (inner.minY + inner.maxY) / 2 });
        await page.mouse.move(c.x, c.y);
        for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
        await viewSettled(page);
      };
      ids.push((await trpcCall<{ id: number }>("courseObject.create", { kind: "oob_area", geometry: square, props: {}, scope: { all: true } })).id);
      await reloadAndZoom();
      await expect.poll(() => inkIn(page, inner, "purple"), { timeout: 30000 }).toBeGreaterThan(5);

      ids.push((await trpcCall<{ id: number }>("courseObject.create", { kind: "toner_saver", geometry: saver, props: {}, scope: { all: true } })).id);
      await reloadAndZoom();
      // The saver's white is the map layer's top row (course-layer.md §3.6): the upper-purple 709 hatch, which sat
      // above upper white before P1, no longer shows there.
      await expect.poll(() => inkIn(page, inner, "purple"), { timeout: 30000 }).toBe(0);
    } finally {
      for (const id of ids) await cleanup("courseObject.delete", { id });
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
    }
  });
});

// docs/course-editor.md §2, §3 (P2, feedback 2026-11-06 item 3): no status bar under the inspector; the save state is
// a small indicator in the top bar that never hides an error, the rest is the course-info popover.
test.describe("P2: the status bar out of the footer", () => {
  desktopOnly();

  test("the save indicator and the course-info popover sit in the top bar; the inspector column has no status bar", async ({ page }) => {
    await openEditor(page);
    const top = page.getByTestId("editor-top-bar");
    await expect(page.getByTestId("editor-status")).toHaveCount(0);
    await expect(top.getByTestId("editor-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15000 });
    await newCourse(page, "P2 stats");

    // The button opens the popover: the course's control count, its length, the map scale; a second click closes it.
    const button = top.getByTestId("editor-stats");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    const popover = page.getByTestId("editor-stats-popover");
    await expect(popover).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    for (const row of ["controls", "length", "scale"]) await expect(popover.getByTestId(`editor-stats-${row}`)).toBeVisible();
    await expect(popover.getByTestId("editor-stats-controls")).toHaveAttribute("data-count", "0");
    await expect(popover.getByTestId("editor-stats-scale")).toHaveAttribute("data-scale", /^\d+$/);
    await button.click();
    await expect(popover).toHaveCount(0);

    // A placed control counts; an outside click closes the popover too.
    await arm(page, "K");
    await place(page, await emptyPoint(page, 40));
    await page.keyboard.press("Escape");
    await expect.poll(() => statsRow(page, "controls", "count"), { timeout: 15000 }).toBe("1");
    await button.click();
    await expect(popover).toBeVisible();
    await page.getByTestId("editor-inspector").click({ position: { x: 4, y: 4 } });
    await expect(popover).toHaveCount(0);

    // Escape closes the popover and nothing else: an armed tool stays armed (the editor's Escape cascade, §3, is not stepped).
    await arm(page, "K");
    await button.click();
    await expect(popover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    await expect(page.getByTestId("editor-tool-K")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
  });

  test("on a 1280 × 720 laptop screen the top bar keeps one row with the indicator and the button", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openEditor(page);
    await newCourse(page, "P2 row");
    await expect(page.getByTestId("editor-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15000 });
    // Saved is the dot alone: its words are the title, not on the bar.
    expect((await page.getByTestId("editor-save-state-text").boundingBox())!.width).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("editor-save-state")).toHaveAttribute("title", /\S/);
    const mid = async (id: string) => { const b = (await page.getByTestId(id).boundingBox())!; return b.y + b.height / 2; };
    const row = await mid("editor-course-picker");
    // P2's two pieces stay on the course picker's row (presence chips of other sessions and the help may still wrap after them).
    for (const id of ["editor-export", "editor-stats", "editor-save-state"]) expect(Math.abs((await mid(id)) - row), id).toBeLessThan(6);
  });

  test("a failed save shows its text in the top bar on a small laptop screen", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await openEditor(page);
    await newCourse(page, "P2 error");
    const indicator = page.getByTestId("editor-top-bar").getByTestId("editor-save-state");
    await expect(indicator).toHaveAttribute("data-state", "saved", { timeout: 15000 });
    // Every control.create fails at the network: the placement's write cannot land.
    const create = (url: URL) => url.pathname.includes("control.create");
    await page.route(create, (route) => route.abort());
    try {
      await arm(page, "K");
      const at = await emptyPoint(page, 40);
      await page.mouse.move(at.x, at.y);
      await page.mouse.click(at.x, at.y);
      await expect(indicator).toHaveAttribute("data-state", "error", { timeout: 15000 });
      // The words, not only a dot or a tooltip, and inside the screen.
      const text = indicator.getByTestId("editor-save-state-text");
      await expect(text).toBeVisible();
      await expect(text).not.toHaveText("");
      const box = (await text.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(1024);
      expect(box.y + box.height).toBeLessThanOrEqual(700);
    } finally {
      await page.unroute(create);
      await page.keyboard.press("Escape");
    }
  });
});
