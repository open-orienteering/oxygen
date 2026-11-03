// Field mode and the phone chrome of the new course editor
// (docs/course-editor.md §9, §10). Runs in the `mobile` project
// (`devices["Pixel 7"]`, `vector`); the fix is Playwright's
// `context.setGeolocation` — only a phone in a forest proves the mode
// (D-mobile, §10 "On a real phone"). The fixture (courses and the map from
// `e2e/test.ocd`) is set up once from a desktop context; until D10 the spec
// sets `map.editor.vector` itself, as `course-editor.spec.ts` does.
import { devices, type BrowserContext, type Page } from "@playwright/test";
import { test, expect, setEditorVector, setMapPipeline } from "./helpers/map-pipeline";
import { reseed } from "./helpers/reseed";
import { editorReady, purpleInCircle, site, sites, toPage, toPaper } from "./helpers/editor";
import { touchDrag, touchEnd, touchMove, touchStart, touchTap } from "./helpers/touch";

type Pt = { x: number; y: number };

let nameId = "";

test.setTimeout(120_000);

test.beforeAll(async ({ browser }) => {
  await reseed();
  // The map is uploaded under `vector`, so the event pins its document (the editor's mount rule).
  await setMapPipeline("vector");
  await setEditorVector(true);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the browser type is the project's
  const { defaultBrowserType: _, ...desktop } = devices["Desktop Chrome"];
  const ctx = await browser.newContext({ ...desktop, baseURL: test.info().project.use.baseURL, extraHTTPHeaders: test.info().project.use.extraHTTPHeaders });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
  nameId = new URL(page.url()).pathname.split("/")[1];
  await page.goto(`/${nameId}/courses`);
  const uploadButton = page.getByRole("button", { name: "Upload map" });
  await expect(uploadButton.or(page.getByTestId("map-viewer")).first()).toBeVisible({ timeout: 60000 });
  if (await uploadButton.isVisible()) {
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
  await ctx.close();
});

test.afterAll(async () => {
  await setEditorVector(null);
  await setMapPipeline("legacy");
});

async function openEditor(page: Page, query = "") {
  await page.goto(`/${nameId}/course-editor${query}`);
  await editorReady(page);
}

/** The first course in the picker; returns its name. */
async function pickCourse(page: Page): Promise<string> {
  const picker = page.getByTestId("editor-course-picker");
  const value = await picker.locator("option").nth(1).getAttribute("value");
  await picker.selectOption(value!);
  const name = (await picker.locator("option:checked").textContent())!;
  await expect(page.getByTestId("editor-field-row").first()).toBeAttached({ timeout: 15000 });
  return name;
}

/** Put the fix at the view centre (WGS 84 from the viewer) — what Field mode then measures from, in paper mm. */
async function fixAtCentre(page: Page, context: BrowserContext, accuracy = 6): Promise<Pt> {
  const viewer = page.getByTestId("map-viewer");
  const lat = Number(await viewer.getAttribute("data-center-lat"));
  const lng = Number(await viewer.getAttribute("data-center-lng"));
  const mm = { x: Number(await viewer.getAttribute("data-centre-x")) / 1000, y: Number(await viewer.getAttribute("data-centre-y")) / 1000 };
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: lat, longitude: lng, accuracy });
  // The watch started before the permission and stopped on its denial: a reload starts it granted.
  await page.reload();
  await editorReady(page);
  return mm;
}

/** A control site whose page point is in the band above the sheet and clear of the chrome. */
async function visibleControl(page: Page, exclude: string[] = []): Promise<{ code: string; id: string; mm: Pt; at: Pt }> {
  const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
  const sheet = (await page.getByTestId("editor-sheet").boundingBox())!;
  const all = await sites(page);
  for (const s of all) {
    if (s.type !== "Control" || !/^\d+$/.test(s.code) || exclude.includes(s.code)) continue;
    const at = await toPage(page, s.mm);
    if (at.x < viewer.x + 60 || at.x > viewer.x + viewer.width - 60 || at.y < viewer.y + 90 || at.y > sheet.y - 90) continue;
    const others = await Promise.all(all.filter((o) => o.id !== s.id).map((o) => toPage(page, o.mm)));
    if (others.some((o) => Math.hypot(o.x - at.x, o.y - at.y) < 50)) continue;
    return { code: s.code, id: s.id, mm: s.mm, at };
  }
  throw new Error("no clear control in view");
}

const sheet = (page: Page) => page.getByTestId("editor-sheet");

test.describe("Field mode on a phone (docs/course-editor.md §9, §10)", () => {
  test("opens in Field mode, full-bleed, with the compact chrome and the sheet at peek", async ({ page }) => {
    await openEditor(page);
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-layout", "phone");
    await expect(page.getByTestId("editor-mode-field")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-field-top-bar")).toBeVisible();
    await expect(sheet(page)).toHaveAttribute("data-detent", "peek");
    for (const id of ["editor-tool-rail", "editor-inspector", "editor-top-bar"]) await expect(page.getByTestId(id)).toHaveCount(0);
    // Full-bleed: the editor covers the screen, the app's header is under it.
    const box = (await page.getByTestId("editor-page").boundingBox())!;
    const vp = page.viewportSize()!;
    expect([box.x, box.y, box.width, box.height]).toEqual([0, 0, vp.width, vp.height]);
    // The overflow holds what the desktop top bar has beside the mode switch.
    await page.getByTestId("editor-overflow").click();
    for (const id of ["editor-undo", "editor-redo", "editor-view-course", "editor-view-all", "editor-hide-others", "editor-toggle-cuts"]) {
      await expect(page.getByTestId("editor-overflow-menu").getByTestId(id)).toBeVisible();
    }
    await page.getByTestId("editor-overflow").click();
    // Every target in the peek row is at least 44 px tall (08 §5.5).
    await expect(page.getByTestId("editor-field-add")).toBeVisible();
    expect((await page.getByTestId("editor-field-add").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });

  test("the fix and its accuracy ring; the control list with distance and bearing from it", async ({ page, context }) => {
    await openEditor(page);
    const fix = await fixAtCentre(page, context, 8);
    await pickCourse(page);
    const marker = page.getByTestId("my-location-marker");
    await expect(marker).toBeVisible({ timeout: 15000 });
    await expect(marker).toHaveAttribute("data-accuracy-m", "8");
    await expect(page.getByTestId("editor-field-fix")).toHaveAttribute("data-state", "fix");
    await page.getByTestId("editor-sheet-handle").click();
    await expect(sheet(page)).toHaveAttribute("data-detent", "half");
    const rows = page.locator('[data-testid="editor-field-row"][data-kind="control"]');
    await expect(rows.first()).not.toHaveAttribute("data-distance-m", "", { timeout: 15000 });
    // Distance and bearing are the paper geometry at the map's scale, one scale for every row.
    let scale: number | null = null;
    for (const row of (await rows.all()).slice(0, 5)) {
      const id = (await row.getAttribute("data-control-id"))!;
      const s = (await sites(page)).find((x) => x.id === id);
      if (!s) continue;
      const mm = Math.hypot(s.mm.x - fix.x, s.mm.y - fix.y);
      const d = Number(await row.getAttribute("data-distance-m"));
      if (mm < 5) continue;
      scale ??= (d * 1000) / mm;
      expect(Math.abs(d - (mm * scale) / 1000)).toBeLessThanOrEqual(1.5);
      const bearing = ((Math.round((Math.atan2(s.mm.x - fix.x, s.mm.y - fix.y) * 180) / Math.PI) % 360) + 360) % 360;
      expect(Number(await row.getAttribute("data-bearing-deg"))).toBe(bearing);
    }
    expect(scale).not.toBeNull();
    expect(scale!).toBeGreaterThan(4000);
    expect(scale!).toBeLessThan(20000);
  });

  test("detents; selecting from the list keeps the control above the sheet", async ({ page }) => {
    await openEditor(page);
    await pickCourse(page);
    await page.getByTestId("editor-sheet-handle").click();
    await expect(sheet(page)).toHaveAttribute("data-detent", "half");
    const row = page.locator('[data-testid="editor-field-row"][data-kind="control"]').nth(1);
    const id = (await row.getAttribute("data-control-id"))!;
    await row.locator("button").first().click();
    await expect(page.getByTestId("editor-sheet-selection")).toBeVisible();
    // The view centres the selection in the band above the sheet.
    await expect.poll(async () => {
      const s = (await sites(page)).find((x) => x.id === id)!;
      const at = await toPage(page, s.mm);
      const top = (await sheet(page).boundingBox())!.y;
      return at.y < top - 20 && at.y > 60;
    }, { timeout: 10000 }).toBe(true);
    // Dragging the handle up settles at full; a tap goes back to peek.
    const h = (await page.getByTestId("editor-sheet-handle").boundingBox())!;
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await page.mouse.down();
    await page.mouse.move(h.x + h.width / 2, 80, { steps: 6 });
    await page.mouse.up();
    await expect(sheet(page)).toHaveAttribute("data-detent", "full");
    await page.getByTestId("editor-sheet-handle").click();
    await expect(sheet(page)).toHaveAttribute("data-detent", "peek");
  });

  test("a drag on an unselected control pans; a long press moves it, drawn above the finger", async ({ page }) => {
    await openEditor(page);
    const c = await visibleControl(page);
    const viewer = page.getByTestId("map-viewer");
    // Quick drag: the map pans, the control stays put and is not selected.
    const before = Number(await viewer.getAttribute("data-centre-x"));
    await touchDrag(page, c.at, { x: c.at.x + 40, y: c.at.y });
    await expect.poll(async () => Number(await viewer.getAttribute("data-centre-x"))).not.toBe(before);
    expect((await site(page, c.code)).mm).toEqual(c.mm);
    await expect(page.getByTestId("editor-sheet-selection")).toHaveCount(0);

    // Long press then drag: selected, lifted above the finger, dropped where drawn.
    const again = await visibleControl(page);
    const to = { x: again.at.x + 30, y: again.at.y + 20 };
    await touchStart(page, [again.at]);
    await page.waitForTimeout(650);
    for (let i = 1; i <= 6; i++) await touchMove(page, [{ x: again.at.x + (30 * i) / 6, y: again.at.y + (20 * i) / 6 }]);
    await expect(page.getByTestId("editor-touch-handle")).toBeVisible();
    // The loupe (§10 "Loupe"): 120 px, above the handle, the GL canvas magnified inside it —
    // the dragged control's purple circle at ×2.5 about the crosshair, more purple than the 1×
    // map shows in the same circle once it is gone.
    const loupe = page.getByTestId("editor-loupe");
    await expect(loupe).toBeVisible();
    const lb = (await loupe.boundingBox())!;
    expect(Math.abs(lb.width - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(lb.height - 120)).toBeLessThanOrEqual(1);
    expect(lb.y + lb.height).toBeLessThanOrEqual(to.y - 48);
    expect(Math.abs(lb.x + lb.width / 2 - to.x)).toBeLessThanOrEqual(1);
    let magnified = 0;
    await expect.poll(async () => (magnified = await purpleInCircle(page, lb)), { timeout: 10000 }).toBeGreaterThan(200);
    const drawnAt = await toPaper(page, { x: to.x, y: to.y - 48 });
    await touchEnd(page, [to]);
    await expect(loupe).toHaveCount(0);
    await expect(page.getByTestId("editor-touch-handle")).toHaveCount(0);
    expect(await purpleInCircle(page, lb)).toBeLessThan(magnified / 2);
    await expect(page.getByTestId("editor-sheet-selection")).toContainText(again.code);
    await expect(page.getByTestId("editor-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15000 });
    await page.reload();
    await editorReady(page);
    const moved = (await site(page, again.code)).mm;
    expect(Math.hypot(moved.x - drawnAt.x, moved.y - drawnAt.y)).toBeLessThan(0.5);
  });

  test("two fingers cancel a pending press and pinch the map", async ({ page }) => {
    await openEditor(page);
    const c = await visibleControl(page);
    const viewer = page.getByTestId("map-viewer");
    const zoom = Number(await viewer.getAttribute("data-px-per-um"));
    await touchStart(page, [c.at]);
    await touchStart(page, [c.at, { x: c.at.x + 60, y: c.at.y + 60 }]);
    await page.waitForTimeout(650);
    for (let i = 1; i <= 5; i++) await touchMove(page, [{ x: c.at.x - 10 * i, y: c.at.y - 10 * i }, { x: c.at.x + 60 + 10 * i, y: c.at.y + 60 + 10 * i }]);
    await touchEnd(page, [c.at]);
    await expect.poll(async () => Number(await viewer.getAttribute("data-px-per-um"))).toBeGreaterThan(zoom);
    await expect(page.getByTestId("editor-sheet-selection")).toHaveCount(0);
    expect((await site(page, c.code)).mm).toEqual(c.mm);
  });

  test("nudge pad: 0.1 mm and 1 m steps, numeric fields, undo", async ({ page }) => {
    await openEditor(page);
    const c = await visibleControl(page);
    await touchTap(page, c.at);
    await expect(page.getByTestId("editor-sheet-selection")).toContainText(c.code);
    await page.getByTestId("editor-sheet-handle").click();
    await expect(sheet(page)).toHaveAttribute("data-detent", "half");
    const y0 = c.mm.y, x0 = c.mm.x;
    await page.getByTestId("editor-nudge-up-mm").click();
    await page.getByTestId("editor-nudge-up-mm").click();
    await expect.poll(async () => (await site(page, c.code)).mm.y, { timeout: 15000 }).toBeCloseTo(y0 + 0.2, 3);
    await page.getByTestId("editor-nudge-unit").click();
    await page.getByTestId("editor-nudge-right-m").click();
    await expect.poll(async () => (await site(page, c.code)).mm.x - x0, { timeout: 15000 }).toBeGreaterThan(0.05);
    const metreMm = (await site(page, c.code)).mm.x - x0;
    expect(metreMm).toBeLessThan(0.2); // 1 m at 1:5 000 … 1:20 000
    await page.getByTestId("editor-nudge-x").fill((x0 + 1).toFixed(2));
    await page.getByTestId("editor-nudge-x").press("Enter");
    await expect.poll(async () => (await site(page, c.code)).mm.x, { timeout: 15000 }).toBeCloseTo(x0 + 1, 2);
    await expect(page.getByTestId("editor-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15000 });
    // Each press was one undo entry: four undos put it back.
    for (let i = 0; i < 4; i++) {
      await page.getByTestId("editor-overflow").click();
      await page.getByTestId("editor-overflow-menu").getByTestId("editor-undo").click();
      await expect(page.getByTestId("editor-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15000 });
    }
    await expect.poll(async () => (await site(page, c.code)).mm, { timeout: 15000 }).toEqual(c.mm);
  });

  test("+ arms a tool in the pin-drop flow: Place above the sheet, Done", async ({ page }) => {
    await openEditor(page);
    const count = (await sites(page)).length;
    await page.getByTestId("editor-field-add").click();
    for (const id of ["editor-add-K", "editor-add-S", "editor-add-M", "editor-add-T", "editor-area-oob_area"]) await expect(page.getByTestId(id)).toBeVisible();
    await page.getByTestId("editor-add-K").click();
    const bar = page.getByTestId("editor-touch-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("editor-field-add")).toHaveCount(0);
    // Place / Done sit above the sheet, every target ≥ 44 px.
    const barBox = (await bar.boundingBox())!, sheetBox = (await sheet(page).boundingBox())!;
    expect(barBox.y + barBox.height).toBeLessThanOrEqual(sheetBox.y + 1);
    expect((await page.getByTestId("editor-touch-place").boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByTestId("editor-touch-place").click();
    await expect.poll(async () => (await sites(page)).length, { timeout: 15000 }).toBe(count + 1);
    await page.getByTestId("editor-touch-done").click();
    await expect(bar).toHaveCount(0);
    await expect(page.getByTestId("editor-field-add")).toBeVisible();
  });

  test("a tap selects an area object; two fingers on its handle ring scale it", async ({ page }) => {
    await openEditor(page);
    // A square of 100 px in the empty paper above the drawn map (clear of every control).
    const viewer = page.getByTestId("map-viewer");
    const box = (await viewer.boundingBox())!;
    const mid = { x: box.x + box.width / 2, y: box.y + 140 };
    const geometry = await Promise.all([[-50, -50], [50, -50], [50, 50], [-50, 50]].map(([dx, dy]) => toPaper(page, { x: mid.x + dx, y: mid.y + dy })));
    const diag = (g: Pt[]) => Math.hypot(g[2].x - g[0].x, g[2].y - g[0].y);
    const made = await page.request.post("/trpc/courseObject.create", {
      headers: { "x-competition-id": nameId },
      data: { kind: "oob_area", geometry, props: {}, scope: { all: true } },
    });
    expect(made.ok(), await made.text()).toBe(true);
    const id = ((await made.json()) as { result: { data: { id: number } } }).result.data.id;
    await page.reload();
    await editorReady(page);
    const row = page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`);
    await expect(row).toBeAttached();
    // A tap inside it selects it (its handles drawn).
    const zoom = Number(await viewer.getAttribute("data-px-per-um"));
    const inside = await toPage(page, { x: (geometry[0].x + geometry[2].x) / 2, y: (geometry[0].y + geometry[2].y) / 2 });
    await touchTap(page, inside);
    await expect(page.getByTestId("editor-object-handle").first()).toBeAttached({ timeout: 10000 });
    // Two fingers: one on a corner handle, one on the opposite corner; spread them.
    const a = await toPage(page, geometry[2]), b = await toPage(page, geometry[0]);
    const ux = (a.x - b.x) / Math.hypot(a.x - b.x, a.y - b.y), uy = (a.y - b.y) / Math.hypot(a.x - b.x, a.y - b.y);
    const d0 = Math.hypot(a.x - b.x, a.y - b.y);
    await touchStart(page, [a]);
    await touchStart(page, [a, b]);
    for (let i = 1; i <= 5; i++) await touchMove(page, [{ x: a.x + ux * 6 * i, y: a.y + uy * 6 * i }, { x: b.x - ux * 6 * i, y: b.y - uy * 6 * i }]);
    await touchEnd(page, [{ x: a.x + ux * 30, y: a.y + uy * 30 }, { x: b.x - ux * 30, y: b.y - uy * 30 }]);
    const k = (d0 + 60) / d0;
    await expect.poll(async () => {
      const pts = ((await row.getAttribute("data-geometry")) ?? "").split(" ").map((q) => ({ x: Number(q.split(",")[0]), y: Number(q.split(",")[1]) }));
      return diag(pts) / diag(geometry);
    }, { timeout: 15000 }).toBeCloseTo(k, 1);
    // The map did not pinch with it.
    expect(Number(await viewer.getAttribute("data-px-per-um"))).toBe(zoom);
  });

  test("check-off is one undoable write and persists over a reload", async ({ page }) => {
    await openEditor(page);
    await pickCourse(page);
    await page.getByTestId("editor-sheet-handle").click();
    const row = page.locator('[data-testid="editor-field-row"][data-kind="control"]').first();
    const id = (await row.getAttribute("data-control-id"))!;
    const was = (await row.getAttribute("data-checked")) === "true";
    await row.getByTestId("editor-field-check").click();
    const rowById = () => page.locator(`[data-testid="editor-field-row"][data-control-id="${id}"]`).first();
    await expect(rowById()).toHaveAttribute("data-checked", String(!was), { timeout: 15000 });
    await page.reload();
    await editorReady(page);
    await pickCourse(page);
    await expect(rowById()).toHaveAttribute("data-checked", String(!was), { timeout: 15000 });
    // Put it back (a reload cleared the undo stack): the toggle again.
    await page.getByTestId("editor-sheet-handle").click();
    await rowById().getByTestId("editor-field-check").click();
    await expect(rowById()).toHaveAttribute("data-checked", String(was), { timeout: 15000 });
  });

  test("offline, Field mode views only and says so", async ({ page, context }) => {
    await openEditor(page);
    await expect(page.getByTestId("editor-field-offline")).toHaveCount(0);
    await context.setOffline(true);
    try {
      await expect(page.getByTestId("editor-field-offline")).toBeVisible();
      await expect(page.getByTestId("editor-field-add")).toBeDisabled();
      // A long-press move snaps back instead of writing.
      const c = await visibleControl(page);
      await touchDrag(page, c.at, { x: c.at.x + 30, y: c.at.y }, { holdMs: 650, steps: 6 });
      await expect.poll(async () => (await site(page, c.code)).mm, { timeout: 5000 }).toEqual(c.mm);
    } finally {
      await context.setOffline(false);
    }
    await expect(page.getByTestId("editor-field-offline")).toHaveCount(0);
  });
});

test.describe("Field mode on a desktop (docs/course-editor.md §9)", () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the browser type is the project's
  const { defaultBrowserType: _, ...desktop } = devices["Desktop Chrome"];
  test.use(desktop);

  test("the mode switch enters Field mode: the list with distances, check-off, no tool rail", async ({ page, context }) => {
    await openEditor(page);
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-layout", "desktop");
    await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("editor-mode-field").click();
    await expect(page.getByTestId("editor-mode-field")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-tool-rail")).toHaveCount(0);
    await expect(page.getByTestId("editor-inspector-field")).toBeVisible();
    await fixAtCentre(page, context);
    await page.getByTestId("editor-mode-field").click();
    await pickCourse(page);
    await expect(page.getByTestId("my-location-marker")).toBeVisible({ timeout: 15000 });
    const row = page.locator('[data-testid="editor-field-row"][data-kind="control"]').first();
    await expect(row).not.toHaveAttribute("data-distance-m", "", { timeout: 15000 });
    const was = (await row.getAttribute("data-checked")) === "true";
    await row.getByTestId("editor-field-check").click();
    await expect(row).toHaveAttribute("data-checked", String(!was), { timeout: 15000 });
    await page.keyboard.press("Control+z");
    await expect(row).toHaveAttribute("data-checked", String(was), { timeout: 15000 });
    // Back to Course mode: the selection model and the rail are back.
    await page.getByTestId("editor-mode-course").click();
    await expect(page.getByTestId("editor-tool-rail")).toBeVisible();
    await expect(page.getByTestId("my-location-marker")).toHaveCount(0);
  });
});
