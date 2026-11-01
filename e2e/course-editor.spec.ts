// The new course editor on the GL canvas (docs/course-editor.md), mounted
// for `vector ∧ pinned ∧ map.editor.vector` (docs/map-pipeline-switch.md
// §3.6). D4 starts it with the parity flows; D10 completes it and moves it
// under the `map-vector` project — until then the spec sets the event
// pipeline and the flag itself. The legacy page's spec is
// `course-editor-legacy.spec.ts`.
import { inflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { API_BASE as API } from "./helpers/api-base";
import { reseed } from "./helpers/reseed";
import { setEditorVector, setMapPipeline } from "./helpers/map-pipeline";
import { clickMap, drag, editorReady, emptyPoint, inkIn, legMidpoint, legPieces, site, sitePoint, sites, toolShapes, toPage, toPaper } from "./helpers/editor";
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

// pdf-lib is the API's dependency; load it from there (as course-maps.spec.ts does).
const { PDFDocument } = createRequire(resolve(process.cwd(), "packages/api/package.json"))("pdf-lib") as {
  PDFDocument: { load(bytes: Uint8Array): Promise<{ getPageCount(): number }> };
};

/**
 * The event's all-controls sheet as printed (`maps.pdf`): its page count and its hatch fills — the PDF backend
 * draws a hatch pass (709) as a clip (`W* n`) and one stroke of separate `m … l` segments (`print/operators.ts`).
 */
async function printedAllControls(page: Page, nameId: string): Promise<{ pages: number; hatches: number }> {
  const res = await page.request.get(`/api/maps/${nameId}/maps.pdf?allControls=1`);
  expect(res.ok(), await res.text().catch(() => "")).toBe(true);
  const bytes = await res.body();
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  const text = bytes.toString("latin1");
  let hatches = 0;
  const run = /W\* n[^]*?(?:-?[\d.]+ -?[\d.]+ m -?[\d.]+ -?[\d.]+ l ){3,}-?[\d.]+ -?[\d.]+ m -?[\d.]+ -?[\d.]+ l S/g;
  for (let at = text.indexOf("stream"); at >= 0; at = text.indexOf("stream", at + 6)) {
    if (text.slice(at - 3, at) === "end") continue;
    const start = at + 6 + (text[at + 6] === "\r" ? 2 : 1);
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    let inflated: string | null = null;
    try { inflated = inflateSync(bytes.subarray(start, end)).toString("latin1"); } catch { /* not Flate */ }
    if (inflated) hatches += inflated.match(run)?.length ?? 0;
    at = end;
  }
  return { pages, hatches };
}

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
    // The shell: top bar, tool rail, inspector, status bar; Layout / Field shown, not enterable.
    for (const id of ["editor-top-bar", "editor-tool-rail", "editor-inspector", "editor-status"]) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-mode-layout")).toBeDisabled();
    // No SVG hit targets: the viewer hit-tests the layer's shapes.
    await expect(page.getByTestId("editor-control-hit")).toHaveCount(0);
    // The rail (§6): exchange and crossing wait for slice F.
    for (const key of ["V", "S", "K", "M", "A", "T"]) await expect(page.getByTestId(`editor-tool-${key}`)).toBeEnabled();
    for (const key of ["X", "C"]) await expect(page.getByTestId(`editor-tool-${key}`)).toBeDisabled();
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

  // docs/course-editor.md §6–§7 (D5): the tools.
  test.describe("tools", () => {
    async function newCourse(page: Page, prefix: string): Promise<string> {
      const name = `${prefix} ${Date.now() % 100000}`;
      await page.getByTestId("editor-new-course-name").fill(name);
      const created = waitForTrpc(page, "course.create");
      await page.getByTestId("editor-create-course").click();
      await created;
      await expect(page.getByTestId("editor-course-picker").locator("option:checked")).toHaveText(name, { timeout: 10000 });
      return name;
    }

    test("ten controls in ten clicks with the armed K tool; Ctrl+Z steps back; Esc returns to V", async ({ page }) => {
      await openEditor(page);
      await newCourse(page, "D5 K");
      const before = (await sites(page)).length;

      await page.keyboard.press("k");
      await expect(page.getByTestId("editor-tool-K")).toHaveAttribute("aria-pressed", "true");
      // The ghost: true-size circle, the next number and code; the pending leg from the start, its length in the status bar.
      const first = await emptyPoint(page, 40);
      await page.mouse.move(first.x, first.y);
      await expect(page.getByTestId("editor-ghost")).toBeAttached({ timeout: 10000 });
      await expect(page.getByTestId("editor-ghost-label")).toHaveText(/^1 · \d+$/);
      await expect(page.getByTestId("editor-pending-leg").first()).toBeAttached();
      await expect(page.getByTestId("editor-pending-leg-length")).toHaveText(/\d+ m/);

      const spots = [first];
      for (let i = 1; i < 10; i++) spots.push(await emptyPoint(page, 30, spots));
      for (const p of spots) {
        await page.mouse.move(p.x, p.y);
        await page.mouse.click(p.x, p.y);
        // No action bar while armed.
        await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
      }
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
    });

    test("an armed click on an existing control reuses the site", async ({ page }) => {
      await openEditor(page);
      await newCourse(page, "D5 reuse");
      const [a, b] = await regularCodes(page, 2);
      const before = (await sites(page)).length;
      await page.getByTestId("editor-tool-K").click();
      for (const code of [a, b]) {
        const p = await sitePoint(page, code);
        await page.mouse.move(p.x, p.y);
        await expect(page.getByTestId("editor-ghost-label")).toHaveText(`Add ${code}`, { timeout: 10000 });
        const saved = waitForTrpc(page, "course.setStructure");
        await page.mouse.click(p.x, p.y);
        await saved;
      }
      await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
      await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", a);
      await expect(controlRows(page).nth(1)).toHaveAttribute("data-control-id", b);
      expect((await sites(page)).length).toBe(before);
    });

    test("Shift-click selects several controls for one add-to-course; notes are written from the inspector", async ({ page }) => {
      await openEditor(page);
      await newCourse(page, "D5 multi");
      const [a, b, c] = await regularCodes(page, 3);
      await clickMap(page, await sitePoint(page, a));
      await expect(selectedCode(page)).toContainText(a, { timeout: 10000 });
      for (const code of [b, c]) {
        const p = await sitePoint(page, code);
        await page.keyboard.down("Shift");
        await page.mouse.click(p.x, p.y);
        await page.keyboard.up("Shift");
      }
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
      await clickMap(page, await sitePoint(page, a));
      await expect(selectedCode(page)).toContainText(a, { timeout: 10000 });
      const note = `checked ${Date.now() % 1000}`;
      const updated = waitForTrpc(page, "control.update");
      await page.getByTestId("editor-selected-notes").fill(note);
      await page.getByTestId("editor-selected-notes").blur();
      await updated;
      await page.reload();
      await editorReady(page);
      await clickMap(page, await sitePoint(page, a));
      await expect(page.getByTestId("editor-selected-notes")).toHaveValue(note, { timeout: 10000 });
    });

    test("G: a drag along the rim opens a circle gap, stored on the site", async ({ page }) => {
      await openEditor(page);
      const [code] = await regularCodes(page, 1);
      await clickMap(page, await sitePoint(page, code));
      await expect(selectedCode(page)).toContainText(code, { timeout: 10000 });
      // G: no action bar while a tool is active, so nothing covers the rim.
      await page.keyboard.press("g");
      await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
      const [target] = await toolShapes(page, "editor-gap-target");
      expect(target).toBeDefined();
      const r = Number(target.data.r);
      const rim = (deg: number) => toPage(page, { x: target.x + r * Math.sin((deg * Math.PI) / 180), y: target.y + r * Math.cos((deg * Math.PI) / 180) });
      const saved = waitForTrpc(page, "control.update");
      await drag(page, await rim(40), await rim(100));
      await saved;
      const covers = async () => (await toolShapes(page, "editor-gap")).some((g) => {
        const start = Number(g.data.start), end = Number(g.data.end);
        return ((70 - start + 360) % 360) <= ((end - start + 360) % 360);
      });
      await expect.poll(covers, { timeout: 15000 }).toBe(true);

      // Stored: after a reload the gap is the site's.
      await page.reload();
      await editorReady(page);
      await clickMap(page, await sitePoint(page, code));
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
      await page.getByTestId("editor-tool-A").click();
      await page.getByTestId("editor-area-oob_area").click();
      const a = await emptyPoint(page, 40);
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
      const id = await page.getByTestId("editor-object").getAttribute("data-object-id");
      await expect(page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`)).toHaveCount(1);

      // On screen: the hatch's purple inside the area (the GL canvas), none there before it existed.
      await expect.poll(() => inkIn(page, inner, "purple"), { timeout: 30000 }).toBeGreaterThan(purpleBefore + 5);

      // Printed: the all-controls sheet (an `all`-scoped object) carries the 709 hatch — present with it, absent parked.
      // The page raster itself is `course-print.test.ts` "course objects on the page" (docs/course-editor.md Tests).
      const nameId = new URL(page.url()).pathname.split("/")[1];
      const headers = { "content-type": "application/json", "x-event-id": nameId };
      const seqOf = async (res: Awaited<ReturnType<Page["request"]["post"]>>) => {
        expect(res.ok(), await res.text()).toBe(true);
        return ((await res.json()) as { result: { data: { seq: number } } }).result.data.seq;
      };
      const templateId = await seqOf(await page.request.post(`${API}/trpc/mapTemplate.create`, {
        headers,
        data: {
          name: `D5 print ${Date.now() % 100000}`, paper: "A4", orientation: "portrait", printScale: 10000, objects: [],
          settings: {
            printMarginMm: 3, mapFrame: { x: 8, y: 8, width: 194, height: 281 }, description: { visible: false, x: 150, y: 12, cellSizeMm: 6 },
            appearance: { purple: "#a626ff", circleRadiusMm: 2.5, lineWidthMm: 0.35, numberHeightMm: 4 },
          },
        },
      }));
      const sheetId = await seqOf(await page.request.post(`${API}/trpc/courseMap.create`, { headers, data: { kind: "all_controls", templateId } }));
      try {
        const withArea = await printedAllControls(page, nameId);
        expect(withArea.pages).toBe(1);
        expect(withArea.hatches, "hatch strokes with the area").toBeGreaterThan(0);
        const hidden = await page.request.post(`${API}/trpc/courseObject.update`, { headers, data: { id: Number(id), scope: { courses: [], classes: [] } } });
        expect(hidden.ok(), await hidden.text()).toBe(true);
        const without = await printedAllControls(page, nameId);
        expect(without.pages).toBe(1);
        expect(without.hatches, "the area's hatch is gone when it is parked").toBeLessThan(withArea.hatches);
        await page.request.post(`${API}/trpc/courseObject.update`, { headers, data: { id: Number(id), scope: { all: true } } });
      } finally {
        await page.request.post(`${API}/trpc/courseMap.delete`, { headers, data: { id: sheetId } });
        await page.request.post(`${API}/trpc/mapTemplate.delete`, { headers, data: { id: templateId } });
      }
      await page.reload();
      await editorReady(page);
      await page.getByTestId("editor-object-row").first().waitFor({ state: "attached" });
      // Select it again on the canvas (a click inside the area).
      await clickMap(page, { x: a.x + 30, y: a.y + 15 });
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", id!, { timeout: 15000 });
      // Its border from the inspector, then delete it (Delete key) and undo.
      const updated = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-prop-border").selectOption("dashed");
      await updated;
      await expect(page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`)).toHaveAttribute("data-props", '{"border":"dashed"}', { timeout: 15000 });
      await page.getByTestId("editor-object-delete").click();
      await expect(page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`)).toHaveCount(0, { timeout: 15000 });
      await page.keyboard.press("Control+z");
      await expect(page.locator('[data-testid="editor-object-row"][data-object-kind="oob_area"]')).not.toHaveCount(0, { timeout: 15000 });
    });

    test("a filter region hides the path under it live", async ({ page }) => {
      await openEditor(page);
      // e2e/test.ocd: a 505 path runs along y ≈ −4 mm (the fixture's symbol index 3).
      const band = { minX: -8, minY: -6, maxX: 8, maxY: -2 };
      const before = await inkIn(page, band);
      expect(before, "path ink before the region").toBeGreaterThan(5);
      await page.getByTestId("editor-tool-A").click();
      await page.getByTestId("editor-area-filter_region").click();
      for (const p of [{ x: -12, y: -9 }, { x: 12, y: -9 }, { x: 12, y: 1 }, { x: -12, y: 1 }]) {
        const q = await toPage(page, p);
        await page.mouse.click(q.x, q.y);
      }
      const created = waitForTrpc(page, "courseObject.create");
      const firstVertex = await toPage(page, { x: -12, y: -9 });
      await page.mouse.click(firstVertex.x, firstVertex.y);
      await created;
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-kind", "filter_region", { timeout: 15000 });
      await page.getByTestId("editor-filter-by").selectOption("symbols");
      await page.getByTestId("editor-filter-search").fill("505");
      const updated = waitForTrpc(page, "courseObject.update");
      // Listed by the source code (no applied match in the fixture): symbol index 3, "505.0 Path". A fixture change fails here.
      const path505 = page.getByTestId("editor-filter-symbol-505.0");
      await expect(path505.locator("xpath=..")).toContainText("Path");
      await path505.check();
      await updated;
      await expect.poll(() => inkIn(page, band), { timeout: 30000 }).toBeLessThan(before / 3);
      // Delete it: the path is back.
      await page.getByTestId("editor-object-delete").click();
      await expect.poll(() => inkIn(page, band), { timeout: 30000 }).toBeGreaterThan(before / 2);
    });
  });
});
