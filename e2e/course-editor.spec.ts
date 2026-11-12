// The editor's core (docs/course-editor.md §1–§4, §12): the GL canvas, Course mode and its descriptions, automatic
// cuts, the checks, the action bar's place, and variation authoring (F7).
// Split from the editor's one spec file along its describes (docs/e2e-sharding.md "CI"); the
// helpers they share are `helpers/course-editor-spec.ts`. It runs under the `chromium` project (desktop) only.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`, the fixture import idempotent per test
// (`openEditor` → `ensureCoursesAndMap`), courses a test creates carry a prefix and go with the
// next reseed, controls / objects / sheets it creates are deleted in `finally` (`cleanup`).

import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { analysePdf, arm, canvasInCircle, cleanup, clickMap, clickTab, controlRows, coveredBy, drag, editorReady, emptyPoint, ensureCoursesAndMap, labelOf, legMidpoint, legPieces, nameIdOf, openEditor, place, placeOneShot, probeTemplate, regularCodes, select, selectCompetition, selectedCode, selectedPosition, siteCuts, site, sitePoint, sites, toolShapes, toPage, toPaper, trpcCall, viewCentre, viewSettled, newCourse, mapScale, statsRow, sheetBoxes, type Site } from "./helpers/editor";
import { waitForTrpc } from "./helpers/trpc";
import { type Pt, desktopOnly, courseIdByName, act, appendClear, dropSelection, dragNumber, dragTarget } from "./helpers/course-editor-spec";

test.beforeAll(async () => {
  await reseed();
});

test.setTimeout(120_000);

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
    // The rail (§6): every placement tool, the crossing point (F4) and the map exchange (F5) included.
    for (const key of ["V", "S", "K", "M", "X", "C", "A", "T"]) await expect(page.getByTestId(`editor-tool-${key}`)).toBeEnabled();
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

// F7 (docs/course-editor.md §12): variation authoring. Its own describe, after F3–F5's (F10 shares this file).
test.describe("F7: variations and loops (docs/course-editor.md §12)", () => {
  desktopOnly();

  /**
   * The leg's drawn colour around a paper point: the mean of the canvas pixels in the purple-to-blue family
   * (blue well above green — the tints; the map's yellows, oranges and greens are left out).
   */
  async function colourAt(page: Page, mm: Pt): Promise<number[]> {
    const p = await toPage(page, mm);
    const { rgb } = await canvasInCircle(page, { x: p.x - 6, y: p.y - 6, width: 12, height: 12 }, 0);
    const sum = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < rgb.length; i += 3) {
      const [r, g, b] = [rgb[i], rgb[i + 1], rgb[i + 2]];
      if (b - g < 80) continue;
      sum[0] += r; sum[1] += g; sum[2] += b; n++;
    }
    expect(n, "tinted pixels at the leg").toBeGreaterThan(0);
    return sum.map((v) => v / n);
  }

  /**
   * A page point well off the leg a → b (half its length to one side) where a click reaches the map: clear of every
   * site and drawn number, of the editor's chrome (the inspector, the rail, the action bar) and of the description
   * sheet. The viewer spans the whole editor under its floating panels, so "inside the viewer" is not enough — a point
   * under the inspector got the K click there and placed nothing (bugfix-f7-offleg-under-inspector.md).
   */
  async function offLeg(page: Page, a: Site, b: Site): Promise<Pt> {
    await viewSettled(page);
    const pa = await toPage(page, a.mm), pb = await toPage(page, b.mm);
    const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const n = { x: -(pb.y - pa.y) / len, y: (pb.x - pa.x) / len };
    const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
    const marks = await Promise.all((await sites(page)).map((s) => toPage(page, s.mm)));
    const numbers = await Promise.all((await page.getByTestId("course-label").evaluateAll((els) => els.map((el) => ({
      x: Number(el.getAttribute("data-x")), y: Number(el.getAttribute("data-y")),
    })))).map((q) => toPage(page, q)));
    const sheets = await sheetBoxes(page);
    for (const k of [0.5, -0.5, 0.7, -0.7, 0.35, -0.35, 0.9, -0.9, 0.25, -0.25]) {
      const p = { x: mid.x + n.x * len * k, y: mid.y + n.y * len * k };
      const inside = p.x > viewer.x + 60 && p.x < viewer.x + viewer.width - 100 && p.y > viewer.y + 60 && p.y < viewer.y + viewer.height - 120;
      if (!inside) continue;
      if (marks.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= 45)) continue;
      if (numbers.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= 30)) continue;
      if (sheets.some((s) => p.x > s.x - 12 && p.x < s.x + s.width + 12 && p.y > s.y - 12 && p.y < s.y + s.height + 12)) continue;
      if ((await coveredBy(page, p)) !== null) continue;
      return p;
    }
    return emptyPoint(page, 40);
  }

  test("Create variation here, a control into B, Variant and All-variations views, the unbalanced check, Loop, export, undo", async ({ page }) => {
    await openEditor(page);
    const name = await newCourse(page, "F7 variation");
    const codeA = await appendClear(page);
    const codeB = await appendClear(page, [codeA]);
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    const a = await site(page, codeA), b = await site(page, codeB);
    const courseId = (await trpcCall<{ id: number; name: string }[]>("course.list", undefined, false)).find((c) => c.name === name)!.id;
    const keys = async () => (await trpcCall<{ variantKey: string }[]>("course.variantList", { courseId }, false)).map((v) => v.variantKey);

    // The leg a → b, then Create variation here: one write, A and B empty (answer 5), the leg still drawn straight.
    await viewSettled(page);
    const mid = await legMidpoint(page, name, a.mm, b.mm);
    await expect(async () => {
      await dropSelection(page);
      await clickMap(page, await toPage(page, mid));
      await expect(page.getByTestId("editor-action-create-variation")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });
    const created = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-create-variation").click();
    await created;
    const block = page.getByTestId("editor-variation");
    await expect(block).toHaveCount(1, { timeout: 15000 });
    await expect(block.getByTestId("editor-variation-tab-A")).toHaveAttribute("aria-pressed", "true");
    await expect(block.getByTestId("editor-variation-tab-B")).toBeVisible();
    await expect.poll(keys, { timeout: 15000 }).toEqual(["A", "B"]);
    await expect.poll(async () => (await legPieces(page, name)).length, { timeout: 15000 }).toBeGreaterThan(0);

    // Tab B, then K with nothing selected: the control goes into B (§12).
    const offPt = await offLeg(page, a, b);
    await block.getByTestId("editor-variation-tab-B").click();
    await expect(block.getByTestId("editor-variation-tab-B")).toHaveAttribute("aria-pressed", "true");
    await arm(page, "K");
    const placed = waitForTrpc(page, "course.setStructure");
    const x = await place(page, offPt);
    await placed;
    await page.keyboard.press("v");
    await expect(page.locator('[data-testid="editor-seq-row"][data-alternative="B"]')).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator('[data-testid="editor-seq-row"][data-alternative="B"]')).toHaveAttribute("data-control-id", x.id);
    await expect(controlRows(page)).toHaveCount(3);

    // Variant ▾ B: the variant's numbering (a 1, x 2, b 3); A: x is on no leg of it.
    await page.getByTestId("editor-view-variant").selectOption("B");
    await expect(page.getByTestId("editor-view-variant")).toHaveValue("B");
    await expect(page.locator(`[data-testid="course-label"][data-site-id="${x.id}"]`)).toHaveAttribute("data-text", "2", { timeout: 15000 });
    await page.getByTestId("editor-view-variant").selectOption("A");
    await expect(page.locator(`[data-testid="course-label"][data-site-id="${b.id}"]`)).toHaveAttribute("data-text", "2", { timeout: 15000 });

    // All variations: every alternative drawn, each in its own tint (screen only).
    await page.getByTestId("editor-view-all-variations").click();
    await expect(page.getByTestId("editor-view-all-variations")).toHaveAttribute("aria-pressed", "true");
    const branchA = `${name}#v1/A`, branchB = `${name}#v1/B`;
    await expect.poll(async () => (await legPieces(page, branchB)).length, { timeout: 15000 }).toBeGreaterThan(0);
    await viewSettled(page);
    const tintA = await colourAt(page, await legMidpoint(page, branchA, a.mm, b.mm));
    const tintB = await colourAt(page, await legMidpoint(page, branchB, a.mm, x.mm));
    expect(Math.hypot(tintA[0] - tintB[0], tintA[1] - tintB[1], tintA[2] - tintB[2]), `tints ${tintA} / ${tintB}`).toBeGreaterThan(40);

    // Back in Course view: A straight against B through x — the unbalanced check, which locates at the anchor.
    await page.getByTestId("editor-view-course").click();
    await page.getByTestId("editor-checks-toggle").click();
    const row = page.locator('[data-testid="editor-check-row"][data-code="VARIATION_UNBALANCED"]');
    await expect(row).toBeVisible({ timeout: 20000 });
    await expect(row).toContainText("A and B");
    await row.click();
    await expect(selectedCode(page)).toHaveText(codeA, { timeout: 10000 });
    await dropSelection(page);

    // Loop: the butterfly's variants are the visiting orders.
    const looped = waitForTrpc(page, "course.setStructure");
    // The box shows the stored flag, so it flips once the write lands: a click, not `check()`.
    await page.getByTestId("editor-variation-loop").click();
    await looped;
    await expect(page.getByTestId("editor-variation-loop")).toBeChecked({ timeout: 15000 });
    await expect.poll(keys, { timeout: 15000 }).toEqual(["AB", "BA"]);

    // F8 (course-print.md §4.6): Export ▾ this course prints one page per variant, AB and BA; All variations one page.
    const exported = async (entry: string) => {
      await page.getByTestId("editor-export").click();
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId(`editor-export-${entry}`).click()]);
      return analysePdf(await readFile((await download.path())!));
    };
    await page.getByTestId("editor-export").click();
    await expect(page.getByTestId("editor-export-course")).toContainText("2 variants");
    // No runner is assigned yet: no hand-out stack to print.
    await expect(page.getByTestId("editor-export-courseRunners")).toBeDisabled();
    await page.keyboard.press("Escape");
    // One page per own sheet and variant: a reused control may be another test's map exchange (two part sheets).
    const printed = await exported("course");
    type Listed = { courseId: number | null; class: unknown; kind: string };
    const sheets = (await trpcCall<Listed[]>("courseMap.list", undefined, false)).filter((s) => s.courseId === courseId && s.class === null && s.kind === "course").length;
    expect(sheets).toBeGreaterThanOrEqual(1);
    expect(printed.pages).toBe(2 * sheets);
    expect((await exported("allVariations")).pages).toBe(sheets);

    // Layout mode draws the sheet as one variant (the first key); Variant ▾ picks another, the mode kept.
    await page.getByTestId("editor-mode-layout").click();
    await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", /\d+/, { timeout: 30_000 });
    await expect(page.getByTestId("editor-view-variant")).toHaveValue("AB");
    await expect(page.getByTestId("editor-view-all-variations")).toHaveCount(0);
    const read = waitForTrpc(page, "courseMap.resolveSheet");
    await page.getByTestId("editor-view-variant").selectOption("BA");
    await read;
    await expect(page.getByTestId("editor-view-variant")).toHaveValue("BA");
    await expect(page.getByTestId("editor-mode-layout")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("editor-export").click();
    await expect(page.getByTestId("editor-export-variant")).toContainText("BA");
    await page.keyboard.press("Escape");
    expect((await exported("variant")).pages).toBe(sheets);
    await page.getByTestId("editor-mode-course").click();
    await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");

    // Undo: the loop, the placement, the group — each one entry; the course is plain again.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+z");
    await expect.poll(keys, { timeout: 15000 }).toEqual(["A", "B"]);
    await page.keyboard.press("Control+z");
    await expect(page.locator('[data-testid="editor-seq-row"][data-alternative="B"]')).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByTestId("editor-variation")).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await expect(page.getByTestId("editor-variation")).toHaveCount(0, { timeout: 15000 });
    await expect.poll(keys, { timeout: 15000 }).toEqual([]);
    await expect(controlRows(page)).toHaveCount(2);
  });

  test("F15: All variations numbers the sites when the variants number alike, codes when a fork is unequal (course-layer.md §12.7)", async ({ page }) => {
    await openEditor(page);
    const name = await newCourse(page, "F15 numbers");
    const codeA = await appendClear(page);
    const codeB = await appendClear(page, [codeA]);
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    const a = await site(page, codeA), b = await site(page, codeB);
    await viewSettled(page);
    const mid = await legMidpoint(page, name, a.mm, b.mm);
    await expect(async () => {
      await dropSelection(page);
      await clickMap(page, await toPage(page, mid));
      await expect(page.getByTestId("editor-action-create-variation")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });
    const created = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-create-variation").click();
    await created;
    const block = page.getByTestId("editor-variation");
    await expect(block).toHaveCount(1, { timeout: 15000 });

    /** A control into the alternative `tab` (K with nothing selected: it goes into the shown alternative, §12). */
    const into = async (tab: "A" | "B") => {
      await block.getByTestId(`editor-variation-tab-${tab}`).click();
      await expect(block.getByTestId(`editor-variation-tab-${tab}`)).toHaveAttribute("aria-pressed", "true");
      await dropSelection(page);
      await arm(page, "K");
      const placed = waitForTrpc(page, "course.setStructure");
      const c = await place(page, await offLeg(page, a, b));
      await placed;
      await page.keyboard.press("v");
      return c;
    };
    const label = (id: string) => page.locator(`[data-testid="course-label"][data-site-id="${id}"]`);
    const x = await into("B");
    const y = await into("A");
    await expect(page.locator('[data-testid="editor-seq-row"][data-alternative="A"]')).toHaveCount(1, { timeout: 15000 });

    // a 1, x and y 2 (the alternatives number alike), b 3.
    await page.getByTestId("editor-view-all-variations").click();
    await expect(page.getByTestId("editor-view-all-variations")).toHaveAttribute("aria-pressed", "true");
    await expect(label(x.id)).toHaveAttribute("data-text", "2", { timeout: 15000 });
    await expect(label(y.id)).toHaveAttribute("data-text", "2");
    await expect(label(a.id)).toHaveAttribute("data-text", "1");
    await expect(label(b.id)).toHaveAttribute("data-text", "3");

    // A second control into B: the variants number unalike (b is 3 or 4), so codes again.
    await page.getByTestId("editor-view-course").click();
    const z = await into("B");
    await expect(page.locator('[data-testid="editor-seq-row"][data-alternative="B"]')).toHaveCount(2, { timeout: 15000 });
    await page.getByTestId("editor-view-all-variations").click();
    await expect(label(x.id)).toHaveAttribute("data-text", x.code, { timeout: 15000 });
    await expect(label(b.id)).toHaveAttribute("data-text", b.code);
    await expect(label(z.id)).toHaveAttribute("data-text", z.code);
  });
});

test.describe("The action bar stays inside the viewer (docs/course-editor.md §2)", () => {
  desktopOnly();

  test("a long Also-in list on a control left of the middle: the bar is shifted inside the viewer and Add to … works", async ({ page }) => {
    await openEditor(page);
    const stamp = Date.now() % 100000;
    const listed = `Bar edge long course name 14 ${stamp}`;
    const controls = (await trpcCall<{ id: number; kind: string }[]>("control.list", undefined, false)).filter((c) => c.kind === "control");
    const made: number[] = [];
    try {
      // Fourteen courses through every control: each control's "Also in" names all of them, wider than the viewer
      // (docs/bugfix-action-bar-off-viewer.md: the F15 flake had thirteen left by earlier tests).
      for (let i = 1; i <= 14; i++) {
        const { id } = await trpcCall<{ id: number }>("course.create", { name: `Bar edge long course name ${i} ${stamp}` });
        made.push(id);
        await trpcCall("course.setStructure", {
          courseId: id,
          structure: { version: 1, id: `bar-${i}`, orderMode: "ordered", items: controls.map((c) => ({ siteId: c.id })) },
        });
      }
      await page.goto(`/${nameIdOf(page)}/course-editor`);
      await editorReady(page);
      await newCourse(page, "Bar edge");
      const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
      // The leftmost clear control: centred under it, a bar as wide as the viewer began left of the viewer.
      const codes = await regularCodes(page, 1000);
      const at = await Promise.all(codes.map((c) => sitePoint(page, c)));
      const k = at.reduce((best, p, j) => (p.x < at[best].x ? j : best), 0);
      expect(at[k].x, "a clear control left of the viewer's middle").toBeLessThan(viewer.x + viewer.width / 2 - 50);
      await select(page, codes[k]);

      const bar = page.getByTestId("editor-action-bar");
      const info = bar.getByTestId("editor-context-info");
      await expect(info).toHaveAttribute("title", new RegExp(listed));
      const box = (await bar.boundingBox())!;
      expect(box.x, "the bar's left edge").toBeGreaterThanOrEqual(viewer.x);
      expect(box.x + box.width, "the bar's right edge").toBeLessThanOrEqual(viewer.x + viewer.width);
      // The list is cut with an ellipsis inside the bar, never drawn past its border.
      const infoBox = (await info.boundingBox())!;
      expect(infoBox.x + infoBox.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      const add = bar.getByTestId("editor-action-append");
      const addBox = (await add.boundingBox())!;
      expect(addBox.x).toBeGreaterThanOrEqual(viewer.x);
      expect(addBox.x + addBox.width).toBeLessThanOrEqual(viewer.x + viewer.width);

      const saved = waitForTrpc(page, "course.setStructure");
      await add.click();
      await saved;
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
      await dropSelection(page);

      // The lowest clear control: the bar goes above it when it does not fit below, never past the viewer's bottom.
      const rest = await regularCodes(page, 1000, [codes[k]]);
      const ys = await Promise.all(rest.map((c) => sitePoint(page, c)));
      const low = ys.reduce((best, p, j) => (p.y > ys[best].y ? j : best), 0);
      await select(page, rest[low]);
      const lowBox = (await bar.boundingBox())!;
      expect(lowBox.y, "the bar's top").toBeGreaterThanOrEqual(viewer.y);
      expect(lowBox.y + lowBox.height, "the bar's bottom").toBeLessThanOrEqual(viewer.y + viewer.height);
      if (ys[low].y + 30 + lowBox.height > viewer.y + viewer.height - 8) {
        await expect(bar).toHaveAttribute("data-placement", "above");
        expect(lowBox.y + lowBox.height).toBeLessThan(ys[low].y);
      }
      const appended = waitForTrpc(page, "course.setStructure");
      await bar.getByTestId("editor-action-append").click();
      await appended;
      await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
      // Nothing scrolled the clipping viewer to reach a button.
      expect(await page.getByTestId("map-viewer").evaluate((el) => [el.scrollLeft, el.scrollTop])).toEqual([0, 0]);
    } finally {
      for (const id of made) await trpcCall("course.delete", { id }).catch(() => undefined);
    }
  });
});
