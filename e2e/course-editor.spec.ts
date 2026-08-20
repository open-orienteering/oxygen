import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";

// This spec mutates seed data (imports courses, uploads a map, creates and
// deletes controls), so it starts from a clean seed per the e2e hygiene
// convention.
test.beforeAll(reseed);

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

/**
 * Give the event coordinate-bearing controls and a map: import courses
 * from test.ocd (append mode) and upload the same file as the event map.
 * Without this the editor has no affine transform (screen ↔ map mm) and
 * no tiles to draw on.
 */
async function importCoursesAndMap(page: Page) {
  await clickTab(page, "Courses");
  await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });

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

  await page.getByTestId("course-import-replace-all").uncheck();
  await page.getByRole("button", { name: "Import 5 courses" }).click();
  await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Done" }).click();

  const mapPanel = page.getByTestId("map-panel");
  const mapChooserPromise = page.waitForEvent("filechooser");
  await mapPanel.getByRole("button", { name: "Upload map" }).click();
  const mapChooser = await mapChooserPromise;
  await mapChooser.setFiles("e2e/test.ocd");
  // Wait until the viewer actually renders (tiles generated server-side).
  await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
}

/**
 * Idempotent variant: only import + upload when the event has no map yet.
 * A failed test makes Playwright restart the worker, which re-runs the
 * beforeAll reseed and wipes the map — every test calls this so one
 * failure doesn't cascade through the rest of the file.
 */
async function ensureCoursesAndMap(page: Page) {
  await clickTab(page, "Courses");
  const uploadButton = page.getByRole("button", { name: "Upload map" });
  const viewer = page.getByTestId("map-viewer");
  await expect(uploadButton.or(viewer).first()).toBeVisible({ timeout: 60000 });
  if (await uploadButton.isVisible()) {
    await importCoursesAndMap(page);
  }
}

async function openEditor(page: Page) {
  await clickTab(page, "Course Editor");
  await expect(page.getByTestId("course-editor-page")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
  // Editing needs the control hit targets — they appear once the affine
  // transform is built from the control coordinates.
  await expect(page.getByTestId("editor-control-hit").first()).toBeAttached({ timeout: 30000 });
}

/**
 * Codes of the first `n` positioned, numeric-coded (regular) controls whose
 * hit target is clickable — i.e. not hidden behind the floating in-map
 * course selector, which swallows clicks over the map's top-left corner.
 */
async function pickClickableControlCodes(page: Page, n: number): Promise<string[]> {
  const overlay = page.getByTestId("editor-map-course-selector");
  const card = (await overlay.isVisible()) ? await overlay.boundingBox() : null;
  const hits = page.getByTestId("editor-control-hit");
  const count = await hits.count();
  const codes: string[] = [];
  for (let i = 0; i < count && codes.length < n; i++) {
    const hit = hits.nth(i);
    const code = await hit.getAttribute("data-control-code");
    if (!code || !/^\d+$/.test(code)) continue;
    const b = await hit.boundingBox();
    if (!b) continue;
    const covered =
      card !== null &&
      b.x < card.x + card.width && b.x + b.width > card.x &&
      b.y < card.y + card.height && b.y + b.height > card.y;
    if (!covered) codes.push(code);
  }
  return codes;
}

/**
 * Find a click point inside the map viewer that is NOT near any existing
 * control (clicking a control selects it instead of placing) and NOT on
 * an invisible leg hit-line (clicking a leg inserts into the course
 * instead of appending). Scans a coarse grid and returns the first free
 * spot.
 */
async function findEmptyMapPoint(page: Page): Promise<{ x: number; y: number }> {
  const viewer = page.getByTestId("map-viewer");
  const box = await viewer.boundingBox();
  if (!box) throw new Error("map viewer has no bounding box");

  const hitBoxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  const hits = page.getByTestId("editor-control-hit");
  const count = await hits.count();
  for (let i = 0; i < count; i++) {
    const b = await hits.nth(i).boundingBox();
    if (b) hitBoxes.push({ x: b.x, y: b.y, w: b.width, h: b.height });
  }
  // The in-map course selector floats over the map's top-left corner and
  // swallows clicks — treat it as an obstacle too.
  const overlay = page.getByTestId("editor-map-course-selector");
  if (await overlay.isVisible()) {
    const b = await overlay.boundingBox();
    if (b) hitBoxes.push({ x: b.x, y: b.y, w: b.width, h: b.height });
  }

  // Leg hit-lines are SVG paths in container-relative pixels; collect
  // their segments so the grid scan can keep its distance.
  const legPaths: string[] = await page
    .locator('[data-testid="editor-leg-hit"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("d") ?? ""));
  const legSegments: Array<[number, number, number, number]> = [];
  for (const d of legPaths) {
    const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
    for (let i = 0; i + 3 < nums.length; i += 2) {
      legSegments.push([nums[i], nums[i + 1], nums[i + 2], nums[i + 3]]);
    }
  }
  const distToSegment = (px: number, py: number, [x1, y1, x2, y2]: [number, number, number, number]) => {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  };

  const margin = 24; // keep clear of controls and their labels
  for (let gy = 0.25; gy <= 0.75; gy += 0.125) {
    for (let gx = 0.2; gx <= 0.8; gx += 0.1) {
      const px = box.x + box.width * gx;
      const py = box.y + box.height * gy;
      // Keep away from the zoom/measure buttons in the bottom-right corner.
      if (px > box.x + box.width - 80 && py > box.y + box.height - 200) continue;
      const nearControl = hitBoxes.some(
        (b) =>
          px > b.x - margin && px < b.x + b.w + margin &&
          py > b.y - margin && py < b.y + b.h + margin,
      );
      if (nearControl) continue;
      // Leg hits have a 12px stroke; stay well clear.
      const relX = px - box.x, relY = py - box.y;
      const nearLeg = legSegments.some((s) => distToSegment(relX, relY, s) < 20);
      if (!nearLeg) return { x: px, y: py };
    }
  }
  throw new Error("no empty map point found");
}

test.describe("Course editor", () => {
  test("place, move, persist and delete a control", async ({ page }) => {
    // Auto-accept the delete confirmation at the end.
    page.on("dialog", (dialog) => dialog.accept());

    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await openEditor(page);

    const hits = page.getByTestId("editor-control-hit");
    const initialCount = await hits.count();
    expect(initialCount).toBeGreaterThan(0);

    // ── Place: click an empty spot → phantom + contextual "Add control".
    const spot = await findEmptyMapPoint(page);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
    await page.getByTestId("editor-action-add").click();

    // The new control is created server-side and auto-selected; the
    // toolbar readout appears with its (suggested) punch code.
    const info = page.getByTestId("editor-selected-info");
    await expect(info).toBeVisible({ timeout: 15000 });
    const placedText = (await info.textContent()) ?? "";
    const codeMatch = placedText.match(/(\d+)/);
    expect(codeMatch).not.toBeNull();
    const newCode = codeMatch![1];

    // One more hit target on the map (flexible: ≥ so parallel label
    // rendering can't make this flaky).
    await expect(async () => {
      expect(await hits.count()).toBeGreaterThanOrEqual(initialCount + 1);
    }).toPass({ timeout: 15000 });
    const newControl = page.locator(`[data-testid="editor-control-hit"][data-control-code="${newCode}"]`);
    await expect(newControl).toBeAttached();

    // ── Move: drag the new control. The destination must be another
    // verified-empty spot — a fixed offset can land on an existing
    // control, and the post-reload click below would then select that
    // overlapping control instead of this one. Escape first so the
    // context menu doesn't overlap candidate grid points.
    await page.keyboard.press("Escape");
    const dest = await findEmptyMapPoint(page);
    const beforeBox = await newControl.boundingBox();
    expect(beforeBox).not.toBeNull();
    const startX = beforeBox!.x + beforeBox!.width / 2;
    const startY = beforeBox!.y + beforeBox!.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(dest.x, dest.y, { steps: 8 });
    await page.mouse.up();

    // The toolbar readout shows the stored mm position — it changes once
    // the control.update round-trip and refetch complete.
    await expect(info).not.toHaveText(placedText, { timeout: 15000 });
    const movedText = (await info.textContent()) ?? "";
    expect(movedText).toContain(`Control ${newCode}`);

    // ── Undo the move (toolbar button): the circle must visibly return
    // to where it was placed — regression for the anti-snap-back bridge
    // masking undone moves (data reverted but the map kept rendering the
    // dragged position).
    await page.getByTestId("editor-undo").click();
    await expect(info).toHaveText(placedText, { timeout: 15000 });
    await expect(async () => {
      const box = await newControl.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(box!.x + box!.width / 2 - startX)).toBeLessThan(5);
      expect(Math.abs(box!.y + box!.height / 2 - startY)).toBeLessThan(5);
    }).toPass({ timeout: 15000 });

    // ── Redo (toolbar button): back at the drop position.
    await page.getByTestId("editor-redo").click();
    await expect(info).toHaveText(movedText, { timeout: 15000 });
    await expect(async () => {
      const box = await newControl.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.abs(box!.x + box!.width / 2 - dest.x)).toBeLessThan(5);
      expect(Math.abs(box!.y + box!.height / 2 - dest.y)).toBeLessThan(5);
    }).toPass({ timeout: 15000 });

    // ── Persist: reload, re-select the control, same stored position.
    await page.reload();
    await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
    const reloadedControl = page.locator(`[data-testid="editor-control-hit"][data-control-code="${newCode}"]`);
    await expect(reloadedControl).toBeAttached({ timeout: 30000 });
    const reloadedBox = await reloadedControl.boundingBox();
    expect(reloadedBox).not.toBeNull();
    await page.mouse.click(reloadedBox!.x + reloadedBox!.width / 2, reloadedBox!.y + reloadedBox!.height / 2);
    await expect(info).toBeVisible({ timeout: 10000 });
    await expect(info).toHaveText(movedText);

    // ── Delete: contextual action next to the selected control.
    await page.getByTestId("editor-action-delete").click();
    await expect(reloadedControl).not.toBeAttached({ timeout: 15000 });
    await expect(info).not.toBeVisible();
  });

  test("build a course by clicking, reorder, undo/redo, persist", async ({ page }) => {
    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await openEditor(page);

    // ── Create a course from the sidebar.
    await page.getByTestId("editor-new-course-name").fill("E2E Editor Bana");
    await page.getByTestId("editor-create-course").click();
    // The new course is auto-selected: its sequence panel appears.
    await expect(page.getByTestId("editor-sequence")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("editor-course-total")).toContainText("0 controls");

    // ── Append two existing (numeric-coded, i.e. regular) controls via
    // the contextual "Add to course" action.
    const codes = await pickClickableControlCodes(page, 2);
    expect(codes.length).toBe(2);
    const [codeA, codeB] = codes;

    const controlRows = page.locator('[data-testid="editor-seq-row"][data-kind="control"]');
    const hitFor = (code: string) =>
      page.locator(`[data-testid="editor-control-hit"][data-control-code="${code}"]`);

    const appendViaMenu = async (code: string) => {
      // Close any open context menu first — it floats next to the previous
      // selection and could cover the control we're about to click.
      if (await page.getByTestId("editor-context-menu").isVisible()) {
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("editor-context-menu")).not.toBeVisible();
      }
      const box = await hitFor(code).boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      // Make sure the click selected the intended control before acting.
      await expect(page.getByTestId("editor-selected-info")).toContainText(
        `Control ${code}`,
        { timeout: 10000 },
      );
      await page.getByTestId("editor-action-append").click();
    };

    await appendViaMenu(codeA);
    await expect(controlRows).toHaveCount(1, { timeout: 15000 });
    // With a course selected, controls off the course fade (Purple Pen
    // style) while course members stay at full strength.
    await expect(
      page.locator('[data-testid="map-viewer"] svg circle[opacity="0.3"]').first(),
    ).toBeAttached({ timeout: 15000 });
    await appendViaMenu(codeB);
    await expect(controlRows).toHaveCount(2, { timeout: 15000 });
    await expect(controlRows.nth(0)).toHaveAttribute("data-code", codeA);
    await expect(controlRows.nth(1)).toHaveAttribute("data-code", codeB);

    // ── Create + append in one action: click empty map, pick "Add to
    // course". Escape first so the open context menu can't cover the
    // grid points the empty-spot scan probes.
    await page.keyboard.press("Escape");
    const spot = await findEmptyMapPoint(page);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
    await page.getByTestId("editor-action-add-to-course").click();
    await expect(controlRows).toHaveCount(3, { timeout: 15000 });

    // Sidebar footer shows the live count and a non-zero total length.
    await expect(page.getByTestId("editor-course-total")).toContainText("3 controls");
    await expect(page.getByTestId("editor-course-total")).toContainText(/[1-9]\d* m/);

    // ── Reorder: move the second control up — order flips to B, A.
    await controlRows.nth(1).getByTestId("editor-seq-up").click();
    await expect(controlRows.nth(0)).toHaveAttribute("data-code", codeB, { timeout: 15000 });
    await expect(controlRows.nth(1)).toHaveAttribute("data-code", codeA);

    // ── Undo the reorder (Ctrl+Z): back to A, B.
    await page.keyboard.press("Control+z");
    await expect(controlRows.nth(0)).toHaveAttribute("data-code", codeA, { timeout: 15000 });

    // ── Undo the create+append: row AND control disappear together.
    await page.keyboard.press("Control+z");
    await expect(controlRows).toHaveCount(2, { timeout: 15000 });

    // ── Redo (Ctrl+Shift+Z): the control comes back, re-appended.
    await page.keyboard.press("Control+Shift+z");
    await expect(controlRows).toHaveCount(3, { timeout: 15000 });

    // ── Persist: reload, reselect the course, same sequence.
    await page.reload();
    await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
    await page
      .locator('[data-testid="editor-course-item"][data-course-name="E2E Editor Bana"]')
      .click();
    await expect(controlRows).toHaveCount(3, { timeout: 15000 });
    await expect(controlRows.nth(0)).toHaveAttribute("data-code", codeA);
    await expect(controlRows.nth(1)).toHaveAttribute("data-code", codeB);

    // ── Remove a control from the sequence via the sidebar.
    await controlRows.nth(2).getByTestId("editor-seq-remove").click();
    await expect(controlRows).toHaveCount(2, { timeout: 15000 });

    // ── Insert-on-leg: click the middle of a drawn leg → phantom +
    // contextual "Insert into course" creates a control mid-sequence.
    // Editor-geometry legs are straight segments, so a leg's bounding-box
    // center lies on the line; pick a leg whose midpoint isn't covered
    // by a control hit circle (which would swallow the click).
    await expect(page.getByTestId("editor-leg-hit").first()).toBeAttached({ timeout: 15000 });
    const hitBoxes = await page.getByTestId("editor-control-hit").evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }),
    );
    const legBoxes = await page.getByTestId("editor-leg-hit").all();
    let legPoint: { x: number; y: number } | null = null;
    for (const leg of legBoxes) {
      const box = await leg.boundingBox();
      if (!box) continue;
      const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      if (hitBoxes.every((h) => Math.hypot(h.x - mid.x, h.y - mid.y) > 28)) {
        legPoint = mid;
        break;
      }
    }
    expect(legPoint).not.toBeNull();
    await page.mouse.click(legPoint!.x, legPoint!.y);
    await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
    await page.getByTestId("editor-action-insert").click();
    await expect(controlRows).toHaveCount(3, { timeout: 15000 });
    // Undo the insert: row and control disappear together.
    await page.keyboard.press("Control+z");
    await expect(controlRows).toHaveCount(2, { timeout: 15000 });

    // ── Cross-course awareness: put control A on a second course, then
    // edit the first course again — selecting A shows "Also in: …" in
    // the context menu, and dragging A shows the affects-warning chip.
    await page.getByTestId("editor-new-course-name").fill("E2E Editor Bana 2");
    await page.getByTestId("editor-create-course").click();
    await expect(page.getByTestId("editor-course-total")).toContainText("0 controls", { timeout: 15000 });
    await appendViaMenu(codeA);
    await expect(controlRows).toHaveCount(1, { timeout: 15000 });

    await page
      .locator('[data-testid="editor-course-item"][data-course-name="E2E Editor Bana"]')
      .click();
    await expect(controlRows).toHaveCount(2, { timeout: 15000 });
    // Close the still-open context menu before clicking control A.
    await page.keyboard.press("Escape");
    const boxA = await hitFor(codeA).boundingBox();
    expect(boxA).not.toBeNull();
    const aX = boxA!.x + boxA!.width / 2;
    const aY = boxA!.y + boxA!.height / 2;
    await page.mouse.click(aX, aY);
    await expect(page.getByTestId("editor-context-info")).toContainText(
      "E2E Editor Bana 2",
      { timeout: 10000 },
    );

    // Drag chip: appears mid-drag, names the other course, gone on drop.
    // Drag towards the viewer centre — the controls-fit zoom can leave A
    // near an edge, and leaving the container cancels the drag silently.
    const viewerBox = await page.getByTestId("map-viewer").boundingBox();
    expect(viewerBox).not.toBeNull();
    const dragDx = (Math.sign(viewerBox!.x + viewerBox!.width / 2 - aX) || 1) * 40;
    const dragDy = (Math.sign(viewerBox!.y + viewerBox!.height / 2 - aY) || 1) * 40;
    await page.mouse.move(aX, aY);
    await page.mouse.down();
    await page.mouse.move(aX + dragDx, aY + dragDy, { steps: 4 });
    await expect(page.getByTestId("editor-move-warning")).toContainText("E2E Editor Bana 2");
    await page.mouse.move(aX, aY, { steps: 4 });
    await page.mouse.up();
    await expect(page.getByTestId("editor-move-warning")).not.toBeAttached();
  });

  test("deleting a control in a course cascades out of the sequence; remove-from-course action", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());

    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await openEditor(page);

    await page.getByTestId("editor-new-course-name").fill("E2E Editor Kaskad");
    await page.getByTestId("editor-create-course").click();
    await expect(page.getByTestId("editor-course-total")).toContainText("0 controls", { timeout: 15000 });

    const controlRows = page.locator('[data-testid="editor-seq-row"][data-kind="control"]');
    const info = page.getByTestId("editor-selected-info");
    const hitFor = (code: string) =>
      page.locator(`[data-testid="editor-control-hit"][data-control-code="${code}"]`);

    /** Click empty map → "Add to course" → return the new control's code. */
    const placeIntoCourse = async (): Promise<string> => {
      if (await page.getByTestId("editor-context-menu").isVisible()) {
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("editor-context-menu")).not.toBeVisible();
      }
      const spot = await findEmptyMapPoint(page);
      await page.mouse.click(spot.x, spot.y);
      await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
      await page.getByTestId("editor-action-add-to-course").click();
      await expect(info).toBeVisible({ timeout: 15000 });
      return ((await info.textContent()) ?? "").match(/(\d+)/)![1];
    };

    const codeA = await placeIntoCourse();
    await expect(controlRows).toHaveCount(1, { timeout: 15000 });
    const codeB = await placeIntoCourse();
    await expect(controlRows).toHaveCount(2, { timeout: 15000 });

    // ── "Remove from course": membership only — the row disappears but
    // the control survives on the map. B is still selected from placing.
    await page.getByTestId("editor-action-remove-from-course").click();
    await expect(controlRows).toHaveCount(1, { timeout: 15000 });
    await expect(hitFor(codeB)).toBeAttached();

    // ── Delete A while it is in the course: the sequence row goes with
    // it (server cascade) — no ghost row, no route via a missing circle.
    await page.keyboard.press("Escape");
    const boxA = await hitFor(codeA).boundingBox();
    expect(boxA).not.toBeNull();
    await page.mouse.click(boxA!.x + boxA!.width / 2, boxA!.y + boxA!.height / 2);
    await expect(info).toContainText(`Control ${codeA}`, { timeout: 10000 });
    await page.getByTestId("editor-action-delete").click();
    await expect(hitFor(codeA)).not.toBeAttached({ timeout: 15000 });
    await expect(controlRows).toHaveCount(0, { timeout: 15000 });

    // ── Undo: the control comes back AND rejoins the course.
    await page.keyboard.press("Control+z");
    await expect(hitFor(codeA)).toBeAttached({ timeout: 15000 });
    await expect(controlRows).toHaveCount(1, { timeout: 15000 });
    await expect(controlRows.first()).toHaveAttribute("data-code", codeA);

    // ── Clean up both controls this test created.
    const deleteViaMenu = async (code: string) => {
      if (await page.getByTestId("editor-context-menu").isVisible()) {
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("editor-context-menu")).not.toBeVisible();
      }
      const box = await hitFor(code).boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect(info).toContainText(`Control ${code}`, { timeout: 10000 });
      await page.getByTestId("editor-action-delete").click();
      await expect(hitFor(code)).not.toBeAttached({ timeout: 15000 });
    };
    await deleteViaMenu(codeA);
    await deleteViaMenu(codeB);
  });

  test("edit icons on Courses and Controls pages deep-link into the editor", async ({ page }) => {
    await selectCompetition(page);
    await ensureCoursesAndMap(page);

    // Pick a positioned, numeric-coded control from the editor map first,
    // so the Controls-page deep link below targets a control the editor
    // can actually select (unpositioned ones never load into the map).
    await openEditor(page);
    const hits = page.getByTestId("editor-control-hit");
    const n = await hits.count();
    let controlCode: string | null = null;
    for (let i = 0; i < n && !controlCode; i++) {
      const code = await hits.nth(i).getAttribute("data-control-code");
      if (code && /^\d+$/.test(code)) controlCode = code;
    }
    expect(controlCode).not.toBeNull();

    // ── Courses page → pencil icon → editor with that course selected.
    await clickTab(page, "Courses");
    const courseLink = page.getByTestId("course-edit-link").first();
    await expect(courseLink).toBeVisible({ timeout: 10000 });
    await courseLink.click();
    await expect(page.getByTestId("course-editor-page")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("editor-sequence")).toBeVisible({ timeout: 15000 });

    // ── Controls page → pencil icon → editor with that control selected.
    await clickTab(page, "Controls");
    const controlLink = page.locator(
      `[data-testid="control-edit-link"][href*="control=${controlCode}"]`,
    );
    await expect(controlLink).toBeVisible({ timeout: 10000 });
    await controlLink.click();
    await expect(page.getByTestId("course-editor-page")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("editor-selected-info")).toContainText(
      `Control ${controlCode}`,
      { timeout: 30000 },
    );
    await expect(page.getByTestId("editor-selection-ring")).toBeAttached({ timeout: 15000 });
  });

  test("edit a control description via the contextual action", async ({ page }) => {
    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await openEditor(page);

    // Pick a positioned, numeric-coded (i.e. regular) control.
    const [code] = await pickClickableControlCodes(page, 1);
    expect(code).toBeTruthy();

    const clickControl = async () => {
      if (await page.getByTestId("editor-context-menu").isVisible()) {
        await page.keyboard.press("Escape");
      }
      const box = await page
        .locator(`[data-testid="editor-control-hit"][data-control-code="${code}"]`)
        .boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect(page.getByTestId("editor-selected-info")).toContainText(
        `Control ${code}`,
        { timeout: 10000 },
      );
    };

    const dialog = page.getByTestId("desc-editor");
    const boulder = page.getByTestId("desc-opt-2.4");
    const dimInput = page.getByTestId("desc-dim-input");

    /**
     * (Re)open the dialog until it reflects the expected saved state —
     * saves and undos refetch asynchronously, and the dialog snapshots
     * the description when it opens.
     */
    const expectSavedState = async (boulderPressed: boolean, dims: string) => {
      await expect(async () => {
        if (!(await dialog.isVisible())) {
          await page.getByTestId("editor-action-description").click();
          await expect(dialog).toBeVisible();
        }
        const pressed = await boulder.getAttribute("aria-pressed");
        const value = await dimInput.inputValue();
        if (pressed !== String(boulderPressed) || value !== dims) {
          await page.getByTestId("desc-cancel").click();
          throw new Error(`dialog still stale: pressed=${pressed} dims=${value}`);
        }
      }).toPass({ timeout: 20000 });
    };

    // ── Open the editor dialog from the context menu.
    await clickControl();
    await page.getByTestId("editor-action-description").click();
    await expect(dialog).toBeVisible();

    // Escape closes only the dialog — the map selection stays.
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByTestId("editor-selection-ring")).toBeAttached();

    // ── Pick symbols (D: boulder, G: north side), type dimensions;
    // the preview row renders the dimension text live.
    await page.getByTestId("editor-action-description").click();
    await expect(dialog).toBeVisible();
    await boulder.click();
    await expect(boulder).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("desc-opt-11.1N").click();
    await expect(page.getByTestId("desc-opt-11.1N")).toHaveAttribute("aria-pressed", "true");
    await dimInput.fill("1,5");
    await expect(page.getByTestId("desc-preview")).toContainText("1.5m");
    await page.getByTestId("desc-save").click();
    await expect(dialog).not.toBeVisible();

    // ── Persists across reload.
    await page.reload();
    await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
    await expect(page.getByTestId("editor-control-hit").first()).toBeAttached({ timeout: 30000 });
    await clickControl();
    await expectSavedState(true, "1,5");
    await page.getByTestId("desc-cancel").click();

    // ── Clear all + save wipes it; Ctrl+Z restores the saved description.
    await page.getByTestId("editor-action-description").click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("desc-clear").click();
    await expect(boulder).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("desc-save").click();
    await expect(dialog).not.toBeVisible();
    await expectSavedState(false, "");
    await page.getByTestId("desc-cancel").click();

    await page.keyboard.press("Control+z");
    await expectSavedState(true, "1,5");
    await page.getByTestId("desc-cancel").click();
  });

  test("suggests a description from the base map for a placed control", async ({ page }) => {
    page.on("dialog", (dialog) => dialog.accept());

    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await openEditor(page);

    // Place a control in the mapped terrain: the fixture's rough-open
    // area and paths cover the control cluster, so the autodetect always
    // has something to propose there.
    const spot = await findEmptyMapPoint(page);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
    await page.getByTestId("editor-action-add").click();

    const info = page.getByTestId("editor-selected-info");
    await expect(info).toBeVisible({ timeout: 15000 });
    const newCode = ((await info.textContent()) ?? "").match(/(\d+)/)![1];

    // The new control has no description yet, so the menu offers what the
    // map says it sits on.
    const suggestions = page.getByTestId("editor-suggestions");
    await expect(suggestions).toBeVisible({ timeout: 20000 });
    const firstSuggestion = suggestions.locator("button").first();
    const label = await firstSuggestion.getAttribute("data-suggestion-label");
    expect(label).toBeTruthy();

    // Applying it fills column D (and the block disappears — the control
    // now has a description).
    await firstSuggestion.click();
    await expect(suggestions).not.toBeVisible({ timeout: 20000 });

    const dialog = page.getByTestId("desc-editor");
    const pressed = dialog.locator('[data-testid^="desc-opt-"][aria-pressed="true"]');
    const openDescription = async () => {
      await page.getByTestId("editor-action-description").click();
      await expect(dialog).toBeVisible();
    };

    await openDescription();
    await expect(async () => {
      expect(await pressed.count()).toBeGreaterThan(0);
    }).toPass({ timeout: 15000 });
    await page.getByTestId("desc-cancel").click();

    // Ctrl+Z takes the applied description back off.
    await page.keyboard.press("Control+z");
    await expect(suggestions).toBeVisible({ timeout: 20000 });
    await openDescription();
    await expect(pressed).toHaveCount(0);
    await page.getByTestId("desc-cancel").click();

    // Re-apply, then MOVE the control: a just-moved control gets
    // suggestions again even though it already has a description — the
    // old one described the old spot.
    await firstSuggestion.click();
    await expect(suggestions).not.toBeVisible({ timeout: 20000 });
    await page.keyboard.press("Escape"); // close the menu so the empty-spot scan is unobstructed
    const hit = page.locator(
      `[data-testid="editor-control-hit"][data-control-code="${newCode}"]`,
    );
    const dest = await findEmptyMapPoint(page);
    const box = await hit.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(dest.x, dest.y, { steps: 8 });
    await page.mouse.up();
    await expect(suggestions).toBeVisible({ timeout: 20000 });

    // Deselecting settles it: reselecting the (described) control shows
    // no suggestions.
    await page.keyboard.press("Escape");
    const movedBox = await hit.boundingBox();
    expect(movedBox).not.toBeNull();
    await page.mouse.click(
      movedBox!.x + movedBox!.width / 2,
      movedBox!.y + movedBox!.height / 2,
    );
    await expect(page.getByTestId("editor-context-menu")).toBeVisible({ timeout: 10000 });
    await expect(suggestions).toHaveCount(0);

    // Clean up the control this test added.
    await expect(info).toContainText(`Control ${newCode}`);
    await page.getByTestId("editor-action-delete").click();
    await expect(
      page.locator(`[data-testid="editor-control-hit"][data-control-code="${newCode}"]`),
    ).not.toBeAttached({ timeout: 15000 });
  });

  test("description sheet lists every control until a course is selected", async ({ page }) => {
    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await openEditor(page);

    // Descriptions default to on in the editor, and with no course
    // selected the sheet lists every positioned control under an
    // "All controls" title.
    const sheet = page.getByTestId("description-sheet");
    await expect(sheet).toBeVisible({ timeout: 15000 });
    const rows = sheet.locator('[data-testid="desc-row-code"]');
    await expect(async () => {
      expect(await rows.count()).toBeGreaterThan(1);
    }).toPass({ timeout: 15000 });
    await expect(sheet.locator('[data-testid="desc-title"]')).toHaveText("All controls");

    // Selecting a course switches the sheet to that course's card.
    const firstCourse = page.getByTestId("editor-course-item").first();
    const courseName = await firstCourse.getAttribute("data-course-name");
    expect(courseName).toBeTruthy();
    await firstCourse.click();
    await expect(page.getByTestId("editor-sequence")).toBeVisible({ timeout: 15000 });
    await expect(sheet.locator('[data-testid="desc-title"]')).toHaveText(
      courseName!,
      { timeout: 20000 },
    );
  });

  test("in-map course panel switches courses and lives inside the map box", async ({ page }) => {
    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await openEditor(page);

    // The panel is a child of the map panel — the element the browser
    // promotes in fullscreen — so it stays visible while editing there.
    // It is the ONLY course UI: there is no page sidebar.
    const card = page
      .getByTestId("map-panel")
      .getByTestId("editor-map-course-selector");
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card).toContainText("No course");

    // Selecting a course shows its sequence inside the same panel.
    const item = card.getByTestId("editor-course-item").first();
    const courseName = await item.getAttribute("data-course-name");
    expect(courseName).toBeTruthy();
    await item.click();
    await expect(card.getByTestId("editor-sequence")).toBeVisible({ timeout: 15000 });
    await expect(card.getByTestId("editor-map-selector-toggle")).toContainText(courseName!);
    await expect(
      card.locator(`[data-testid="editor-course-item"][data-course-name="${courseName}"]`),
    ).toHaveClass(/bg-purple-50/);

    // Regression: enabling "Hide other controls" must not sprout a second,
    // internal MapPanel toggle next to the editor's own — one button, one
    // state.
    await page.getByTestId("editor-hide-others").click();
    await expect(page.getByRole("button", { name: "Show all controls" })).toHaveCount(0);
    await page.getByTestId("editor-hide-others").click();

    // Collapsing hides list + sequence but keeps the selected course readable.
    await card.getByTestId("editor-map-selector-toggle").click();
    await expect(card.getByTestId("editor-course-item")).toHaveCount(0);
    await expect(card.getByTestId("editor-sequence")).toHaveCount(0);
    await expect(card).toContainText(courseName!);
  });

  test("escape dismisses the phantom, then the control selection", async ({ page }) => {
    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await openEditor(page);

    // Click empty map: phantom ring + context menu appear.
    const spot = await findEmptyMapPoint(page);
    await page.mouse.click(spot.x, spot.y);
    await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
    await expect(page.getByTestId("editor-context-menu")).toBeVisible();

    // Escape #1: phantom (and its menu) dismissed.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-phantom")).not.toBeAttached();
    await expect(page.getByTestId("editor-context-menu")).not.toBeVisible();

    // Select a control by clicking its hit target.
    const [code] = await pickClickableControlCodes(page, 1);
    expect(code).toBeTruthy();
    const box = await page
      .locator(`[data-testid="editor-control-hit"][data-control-code="${code}"]`)
      .boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.getByTestId("editor-selected-info")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("editor-selection-ring")).toBeAttached();
    await expect(page.getByTestId("editor-context-menu")).toBeVisible();

    // Escape #2: selection cleared.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-selected-info")).not.toBeVisible();
    await expect(page.getByTestId("editor-selection-ring")).not.toBeAttached();
  });

  test("H toggles hide-other-controls; Escape walks the cascade before exiting fullscreen", async ({ page }) => {
    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await openEditor(page);

    const hideOthers = page.getByTestId("editor-hide-others");

    // Without a course, H is a no-op (the toggle has nothing to hide).
    await page.keyboard.press("h");
    await expect(hideOthers).not.toHaveClass(/bg-purple-100/);

    // Select a course, then H toggles the filter on and off again.
    const firstCourse = page.getByTestId("editor-course-item").first();
    await firstCourse.click();
    await expect(page.getByTestId("editor-sequence")).toBeVisible({ timeout: 15000 });
    await page.keyboard.press("h");
    await expect(hideOthers).toHaveClass(/bg-purple-100/);
    await page.keyboard.press("h");
    await expect(hideOthers).not.toHaveClass(/bg-purple-100/);

    // Fullscreen: with a course still selected, Escape deselects it and
    // STAYS fullscreen; only the next Escape (empty cascade) exits.
    // (Playwright's synthetic Esc never triggers the browser's own
    // fullscreen exit, so this exercises exactly the page-side logic —
    // in a real Chromium session the keyboard lock keeps the browser
    // from swallowing the short press.)
    await page.getByRole("button", { name: "Fullscreen" }).first().click();
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement), { timeout: 10000 })
      .toBe(true);

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-sequence")).toHaveCount(0); // course deselected
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);

    await page.keyboard.press("Escape");
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement), { timeout: 10000 })
      .toBe(false);
  });

  test("renders automatic circle slits and leg gaps over black map features", async ({ page }) => {
    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    await openEditor(page);

    // The fixture plants a boulder exactly on control 79's circle rim and
    // another exactly on the midpoint of the 79→80 leg (see
    // scripts/generate-test-ocd.mjs). Building a course through 79 and 80
    // must therefore produce a slit circle and a gapped leg — computed
    // server-side into the course geometry, rendered by the viewer.
    await page.getByTestId("editor-new-course-name").fill("E2E Cut Bana");
    await page.getByTestId("editor-create-course").click();
    await expect(page.getByTestId("editor-sequence")).toBeVisible({ timeout: 15000 });

    const appendViaMenu = async (code: string) => {
      if (await page.getByTestId("editor-context-menu").isVisible()) {
        await page.keyboard.press("Escape");
        await expect(page.getByTestId("editor-context-menu")).not.toBeVisible();
      }
      const hit = page.locator(
        `[data-testid="editor-control-hit"][data-control-code="${code}"]`,
      );
      const box = await hit.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect(page.getByTestId("editor-selected-info")).toContainText(
        `Control ${code}`,
        { timeout: 10000 },
      );
      await page.getByTestId("editor-action-append").click();
    };

    const controlRows = page.locator('[data-testid="editor-seq-row"][data-kind="control"]');
    await appendViaMenu("79");
    await expect(controlRows).toHaveCount(1, { timeout: 15000 });
    await appendViaMenu("80");
    await expect(controlRows).toHaveCount(2, { timeout: 15000 });

    // Circle 79 renders as arcs with a slit (a <path>, not a <circle>) …
    await expect(page.getByTestId("control-circle-cut").first()).toBeAttached({
      timeout: 20000,
    });
    // … and the 79→80 leg is drawn with a gap over the boulder.
    await expect(
      page.locator('[data-testid="map-viewer"] line[data-leg-gapped="true"]').first(),
    ).toBeAttached({ timeout: 20000 });
  });
});
