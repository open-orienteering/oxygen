// The new course editor on the GL canvas (docs/course-editor.md), mounted
// for `vector ∧ pinned ∧ map.editor.vector` (docs/map-pipeline-switch.md
// §3.6). D4 starts it with the parity flows; D10 completes it and moves it
// under the `map-vector` project — until then the spec sets the event
// pipeline and the flag itself. The legacy page's spec is
// `course-editor-legacy.spec.ts`.
import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { API_BASE as API } from "./helpers/api-base";
import { reseed } from "./helpers/reseed";
import { setEditorVector, setMapPipeline } from "./helpers/map-pipeline";
import { clickMap, coveredBy, drag, editorReady, emptyPoint, inkIn, legMidpoint, legPieces, site, sitePoint, sites, toolShapes, toPage, toPaper } from "./helpers/editor";
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
 * The event's all-controls sheet as printed (`maps.pdf`): its page count, its hatch fills — the PDF backend
 * draws a hatch pass (709) as a clip (`W* n`) and one stroke of separate `m … l` segments (`print/operators.ts`) —
 * and its curved fills: fill paths (`m … h f*`) with a Bézier `c` among their segments (the base map has its own,
 * so tests compare counts).
 */
async function printedAllControls(page: Page, nameId: string): Promise<{ pages: number; hatches: number; curvedFills: number }> {
  const res = await page.request.get(`/api/maps/${nameId}/maps.pdf?allControls=1`);
  expect(res.ok(), await res.text().catch(() => "")).toBe(true);
  const bytes = await res.body();
  const pages = (await PDFDocument.load(bytes)).getPageCount();
  const text = bytes.toString("latin1");
  let hatches = 0, curvedFills = 0;
  const run = /W\* n[^]*?(?:-?[\d.]+ -?[\d.]+ m -?[\d.]+ -?[\d.]+ l ){3,}-?[\d.]+ -?[\d.]+ m -?[\d.]+ -?[\d.]+ l S/g;
  for (let at = text.indexOf("stream"); at >= 0; at = text.indexOf("stream", at + 6)) {
    if (text.slice(at - 3, at) === "end") continue;
    const start = at + 6 + (text[at + 6] === "\r" ? 2 : 1);
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    let inflated: string | null = null;
    try { inflated = inflateSync(bytes.subarray(start, end)).toString("latin1"); } catch { /* not Flate */ }
    if (inflated) {
      hatches += inflated.match(run)?.length ?? 0;
      let curved = false;
      for (const op of inflated.split(/\s+/)) {
        if (op === "c") curved = true;
        else if (op === "f*" || op === "f") {
          if (curved) curvedFills++;
          curved = false;
        } else if (op === "S" || op === "n" || op === "B" || op === "B*") curved = false;
      }
    }
    at = end;
  }
  return { pages, hatches, curvedFills };
}

/** A template and an all-controls sheet on it for the event (`maps.pdf?allControls=1`); `drop` removes both. */
async function allControlsSheet(page: Page): Promise<{ nameId: string; headers: Record<string, string>; drop: () => Promise<void> }> {
  const nameId = new URL(page.url()).pathname.split("/")[1];
  const headers = { "content-type": "application/json", "x-event-id": nameId };
  const seqOf = async (res: Awaited<ReturnType<Page["request"]["post"]>>) => {
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { result: { data: { seq: number } } }).result.data.seq;
  };
  const templateId = await seqOf(await page.request.post(`${API}/trpc/mapTemplate.create`, {
    headers,
    data: {
      name: `Print probe ${Date.now() % 100000}`, paper: "A4", orientation: "portrait", printScale: 10000, objects: [],
      settings: {
        printMarginMm: 3, mapFrame: { x: 8, y: 8, width: 194, height: 281 }, description: { visible: false, x: 150, y: 12, cellSizeMm: 6 },
        appearance: { purple: "#a626ff", circleRadiusMm: 2.5, lineWidthMm: 0.35, numberHeightMm: 4 },
      },
    },
  }));
  const sheetId = await seqOf(await page.request.post(`${API}/trpc/courseMap.create`, { headers, data: { kind: "all_controls", templateId } }));
  return {
    nameId, headers,
    drop: async () => {
      await page.request.post(`${API}/trpc/courseMap.delete`, { headers, data: { id: sheetId } });
      await page.request.post(`${API}/trpc/mapTemplate.delete`, { headers, data: { id: templateId } });
    },
  };
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
    // The shell: top bar, tool rail, inspector, status bar; Layout (D7) and Field (D9) enterable.
    for (const id of ["editor-top-bar", "editor-tool-rail", "editor-inspector", "editor-status"]) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-mode-layout")).toBeEnabled();
    await expect(page.getByTestId("editor-mode-field")).toBeEnabled();
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
      // The layer draws the pending leg (§6.1); the UI layer only labels it, with the status bar's metres.
      await expect(page.getByTestId("editor-pending-leg")).toHaveCount(0);
      await expect(page.getByTestId("editor-pending-leg-length")).toHaveText(/\d+ m/);
      const metres = (await page.getByTestId("editor-pending-leg-length").textContent())!.match(/(\d+) m/)![1];
      await expect(page.getByTestId("editor-leg-length")).toHaveText(`${metres} m`);

      const spots = [first];
      for (let i = 1; i < 10; i++) spots.push(await emptyPoint(page, 30, spots));
      for (const p of spots) {
        await page.mouse.move(p.x, p.y);
        await page.mouse.click(p.x, p.y);
        // No action bar while armed, and no selection ring beside the placed circle (§6.1): the purple is the mark.
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
      // Arm once the new course's structure is loaded (else the tool only creates sites).
      await expect(page.locator('[data-testid="editor-seq-row"][data-kind="start"]')).toBeAttached({ timeout: 15000 });
      await page.keyboard.press("k");
      const spots: { x: number; y: number }[] = [];
      for (let i = 0; i < 3; i++) {
        const p = await emptyPoint(page, 60, spots);
        spots.push(p);
        await page.mouse.move(p.x, p.y);
        await expect(page.getByTestId("editor-ghost-label")).toHaveText(new RegExp(`^${i + 1} · `), { timeout: 10000 });
        await page.mouse.click(p.x, p.y);
        await expect(controlRows(page)).toHaveCount(i + 1, { timeout: 15000 });
      }

      /** A drawn leg piece of the course ending at the rim of a circle around the page point (a circle is ~13 px here). */
      const legEndsNear = async (p: { x: number; y: number }) => {
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
        const metres = (await page.getByTestId("editor-pending-leg-length").textContent())!.match(/(\d+) m/)![1];
        await expect(page.getByTestId("editor-leg-length")).toHaveText(`${metres} m`);
      }

      // Back to V: no provisional visit, no label; a drag of the middle control labels its two legs.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-ghost")).toHaveCount(0);
      await expect(page.getByTestId("editor-leg-length")).toHaveCount(0);
      // A second Escape drops the placed control's selection: its action bar can leave no empty map point.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
      const middle = (await controlRows(page).nth(1).getAttribute("data-control-id"))!;
      const from = await toPage(page, (await sites(page)).find((x) => x.id === middle)!.mm);
      const to = await emptyPoint(page, 60, spots);
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
      const [a, ...rest] = await regularCodes(page, 6);
      await clickMap(page, await sitePoint(page, a));
      await expect(selectedCode(page)).toContainText(a, { timeout: 10000 });
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
      const [b, c] = picked;
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

    test("stored gaps and a hidden number are what the layer draws", async ({ page }) => {
      await openEditor(page);
      await newCourse(page, "D5 drawn");
      const [a, b] = await regularCodes(page, 2);
      await page.keyboard.press("k");
      for (const code of [a, b]) {
        const p = await sitePoint(page, code);
        await page.mouse.move(p.x, p.y);
        const saved = waitForTrpc(page, "course.setStructure");
        await page.mouse.click(p.x, p.y);
        await saved;
      }
      // Escape drops the tool, a second one the placed control's selection (its action bar may cover the leg).
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
      const name = (await page.getByTestId("editor-course-picker").locator("option:checked").textContent()) ?? "";
      const A = (await site(page, a)).mm, B = (await site(page, b)).mm;

      // A leg gap: G on the leg a → b, a drag from 35 % to 55 % of it; the drawn leg is cut there.
      await expect.poll(async () => (await legPieces(page, name)).length, { timeout: 15000 }).toBeGreaterThan(0);
      const at = (f: number) => ({ x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f });
      await clickMap(page, await toPage(page, await legMidpoint(page, name, A, B)));
      await page.keyboard.press("g");
      await expect(page.getByTestId("editor-tool-layer").getByTestId("editor-gap-target")).toHaveAttribute("data-kind", "leg");
      const legSaved = waitForTrpc(page, "course.setStructure");
      await drag(page, await toPage(page, at(0.35)), await toPage(page, at(0.55)));
      await legSaved;
      const near = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y) < 0.3;
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
      await clickMap(page, await sitePoint(page, a));
      await expect(selectedCode(page)).toContainText(a, { timeout: 10000 });
      await page.keyboard.press("g");
      const [target] = await toolShapes(page, "editor-gap-target");
      const r = Number(target.data.r);
      const rim = (deg: number) => toPage(page, { x: target.x + r * Math.sin((deg * Math.PI) / 180), y: target.y + r * Math.cos((deg * Math.PI) / 180) });
      const circleSaved = waitForTrpc(page, "control.update");
      await drag(page, await rim(40), await rim(100));
      await circleSaved;
      const drawnCut = async () => {
        const cuts = (await page.locator(`[data-testid="course-site"][data-site-id="${a}"]`).getAttribute("data-cuts")) ?? "";
        return cuts.split(" ").filter(Boolean).some((g) => {
          const [start, end] = g.split("-").map(Number);
          return ((70 - start + 360) % 360) <= ((end - start + 360) % 360);
        });
      };
      await expect.poll(drawnCut, { timeout: 15000 }).toBe(true);
      await page.keyboard.press("Escape");

      // A hidden number: the layer draws control a without its number on this course.
      await expect(page.locator(`[data-testid="course-label"][data-site-id="${a}"]`)).toHaveCount(1);
      await clickMap(page, await sitePoint(page, a));
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
      const id = await page.getByTestId("editor-object").getAttribute("data-object-id");
      await expect(page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`)).toHaveCount(1);

      // On screen: the hatch's purple inside the area (the GL canvas), none there before it existed.
      await expect.poll(() => inkIn(page, inner, "purple"), { timeout: 30000 }).toBeGreaterThan(purpleBefore + 5);

      // Printed: the all-controls sheet (an `all`-scoped object) carries the 709 hatch — present with it, absent parked.
      // The page raster itself is `course-print.test.ts` "course objects on the page" (docs/course-editor.md Tests).
      const { nameId, headers, drop } = await allControlsSheet(page);
      try {
        const withArea = await printedAllControls(page, nameId);
        expect(withArea.pages).toBe(1);
        expect(withArea.hatches, "hatch strokes with the area").toBeGreaterThan(0);
        // The dangerous area (hatch 710, course-layer.md §3.1): 709's stripes crossed — one more hatch pass.
        const setHatch = async (props: Record<string, string>) => {
          const res = await page.request.post(`${API}/trpc/courseObject.update`, { headers, data: { id: Number(id), props } });
          expect(res.ok(), await res.text()).toBe(true);
        };
        await setHatch({ hatch: "710" });
        const crossed = await printedAllControls(page, nameId);
        expect(crossed.pages).toBe(1);
        expect(crossed.hatches, "the 710 cross-hatch prints both diagonals").toBe(withArea.hatches + 1);
        await setHatch({});
        const hidden = await page.request.post(`${API}/trpc/courseObject.update`, { headers, data: { id: Number(id), scope: { courses: [], classes: [] } } });
        expect(hidden.ok(), await hidden.text()).toBe(true);
        const without = await printedAllControls(page, nameId);
        expect(without.pages).toBe(1);
        expect(without.hatches, "the area's hatch is gone when it is parked").toBeLessThan(withArea.hatches);
        await page.request.post(`${API}/trpc/courseObject.update`, { headers, data: { id: Number(id), scope: { all: true } } });
      } finally {
        await drop();
      }
      await page.reload();
      await editorReady(page);
      await page.getByTestId("editor-object-row").first().waitFor({ state: "attached" });
      // Select it again on the canvas (a click on its outline — inside, the map is the map, §7), once the layer
      // draws it and its hit index has it.
      await expect.poll(() => inkIn(page, inner, "purple"), { timeout: 30000 }).toBeGreaterThan(purpleBefore + 5);
      // The reloaded view need not be the one it was drawn in: the edge midpoint from the stored geometry, the one
      // farthest from every site (a control there would win the press).
      const stored = ((await page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`).getAttribute("data-geometry")) ?? "")
        .split(" ").map((q) => ({ x: Number(q.split(",")[0]), y: Number(q.split(",")[1]) }));
      const marks = await Promise.all((await sites(page)).map((s) => toPage(page, s.mm)));
      const edges = await Promise.all(stored.map((v, i) => {
        const w = stored[(i + 1) % stored.length];
        return toPage(page, { x: (v.x + w.x) / 2, y: (v.y + w.y) / 2 });
      }));
      const clearance = (p: { x: number; y: number }) => Math.min(Infinity, ...marks.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
      const onEdge = edges.sort((p, q) => clearance(q) - clearance(p))[0];
      await expect(async () => {
        await page.keyboard.press("Escape"); // a missed attempt's selection or phantom (its action bar) goes first
        await clickMap(page, onEdge);
        await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", id!, { timeout: 2000 });
      }).toPass({ timeout: 20000 });
      // Its hatch and border from the inspector, then delete it (Delete key) and undo.
      const row = page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`);
      const hatched = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-prop-hatch").selectOption("710");
      await hatched;
      await expect(row).toHaveAttribute("data-props", '{"hatch":"710"}', { timeout: 15000 });
      const updated = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-prop-border").selectOption("dashed");
      await updated;
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-props")) ?? "{}"), { timeout: 15000 }).toEqual({ hatch: "710", border: "dashed" });
      await page.getByTestId("editor-object-delete").click();
      await expect(page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`)).toHaveCount(0, { timeout: 15000 });
      await page.keyboard.press("Control+z");
      await expect(page.locator('[data-testid="editor-object-row"][data-object-kind="oob_area"]')).not.toHaveCount(0, { timeout: 15000 });
    });

    test("a press inside an out-of-bounds area pans the map; its outline selects and moves it (§7)", async ({ page }) => {
      // docs/bugfix-editor-area-press-pans.md: an area (the toner saver covers every control) swallowed every press.
      await openEditor(page);
      const viewer = page.getByTestId("map-viewer");
      const nameId = new URL(page.url()).pathname.split("/")[1];
      const headers = { "content-type": "application/json", "x-event-id": nameId };
      // A 70 px square around a clear point (no site within 60 px of its centre, no leg within 20 px).
      const clear = await emptyPoint(page, 60);
      const geometry = await Promise.all([[-35, -35], [35, -35], [35, 35], [-35, 35]].map(([dx, dy]) => toPaper(page, { x: clear.x + dx, y: clear.y + dy })));
      type Pt = { x: number; y: number };
      const mid = (p: Pt, q: Pt): Pt => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
      const parse = (s: string | null): Pt[] => (s ?? "").split(" ").map((q) => ({ x: Number(q.split(",")[0]), y: Number(q.split(",")[1]) }));
      const centreMm = mid(geometry[0], geometry[2]);
      const inner = {
        minX: Math.min(geometry[0].x, geometry[2].x) + 1, maxX: Math.max(geometry[0].x, geometry[2].x) - 1,
        minY: Math.min(geometry[0].y, geometry[2].y) + 1, maxY: Math.max(geometry[0].y, geometry[2].y) - 1,
      };
      const purpleBefore = await inkIn(page, inner, "purple");
      const made = await page.request.post(`${API}/trpc/courseObject.create`, { headers, data: { kind: "oob_area", geometry, props: {}, scope: { all: true } } });
      expect(made.ok(), await made.text()).toBe(true);
      const id = ((await made.json()) as { result: { data: { id: number } } }).result.data.id;
      try {
        await page.reload();
        await editorReady(page);
        const row = page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`);
        await expect(row).toBeAttached({ timeout: 15000 });
        const stored = await row.getAttribute("data-geometry");
        // Drawn (its 709 hatch), so the hit index has it.
        await expect.poll(() => inkIn(page, inner, "purple"), { timeout: 30000 }).toBeGreaterThan(purpleBefore + 5);

        /** The edge midpoint (page px) farthest from every site and drawn leg: where a press is the outline's, not the course's. */
        const pressOnEdge = async (): Promise<Pt> => {
          const marks = await Promise.all((await sites(page)).map((s) => toPage(page, s.mm)));
          const legs = await Promise.all((await legPieces(page)).map((l) => Promise.all(l.points.map((q) => toPage(page, q)))));
          const g = parse(await row.getAttribute("data-geometry"));
          const edges = await Promise.all(g.map((v, i) => toPage(page, mid(v, g[(i + 1) % g.length]))));
          const segDist = (p: Pt, a: Pt, b: Pt) => {
            const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
            const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
            return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
          };
          const clearance = (p: Pt) => Math.min(
            Infinity,
            ...marks.map((q) => Math.hypot(q.x - p.x, q.y - p.y)),
            ...legs.flatMap((poly) => poly.slice(1).map((b, i) => segDist(p, poly[i], b))),
          );
          return edges.sort((p, q) => clearance(q) - clearance(p))[0];
        };
        const centre = async () => ({ x: Number(await viewer.getAttribute("data-centre-x")), y: Number(await viewer.getAttribute("data-centre-y")) });
        const pans = async () => {
          const before = await centre();
          const inside = await toPage(page, centreMm);
          await drag(page, inside, { x: inside.x - 60, y: inside.y + 40 });
          await expect.poll(async () => (await centre()).x, { timeout: 10000 }).not.toBe(before.x);
          await expect(row).toHaveAttribute("data-geometry", stored!);
        };

        // Unselected: a drag starting inside it moves the view and leaves the area alone.
        await pans();
        await expect(page.getByTestId("editor-object")).toHaveCount(0);

        // A press on its outline selects it (four vertex handles).
        await expect(async () => {
          await clickMap(page, await pressOnEdge());
          await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(id), { timeout: 2000 });
        }).toPass({ timeout: 20000 });
        await expect(page.getByTestId("editor-object-handle")).toHaveCount(4);

        // Selected: a drag inside still pans; the selection stays.
        await pans();
        await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(id));

        // Its edge moves it: one write, every vertex translated by the drag.
        const edge = await pressOnEdge();
        const [e0, e1] = await Promise.all([toPaper(page, edge), toPaper(page, { x: edge.x, y: edge.y + 30 })]);
        const moved = waitForTrpc(page, "courseObject.update");
        await drag(page, edge, { x: edge.x, y: edge.y + 30 });
        await moved;
        await expect.poll(async () => (await row.getAttribute("data-geometry")) !== stored, { timeout: 15000 }).toBe(true);
        const now = parse(await row.getAttribute("data-geometry"));
        parse(stored).forEach((v, i) => {
          expect(now[i].x - v.x).toBeCloseTo(e1.x - e0.x, 0);
          expect(now[i].y - v.y).toBeCloseTo(e1.y - e0.y, 0);
        });

        // A click inside is a map click: the area is deselected.
        await clickMap(page, await toPage(page, mid(now[0], now[2])));
        await expect(page.getByTestId("editor-object")).toHaveCount(0);
      } finally {
        await page.request.post(`${API}/trpc/courseObject.delete`, { headers, data: { id } });
      }
    });

    test("A: a curved white-out in three clicks and one drag prints a Bézier; a vertex inserted on an edge and deleted", async ({ page }) => {
      await openEditor(page);
      const { nameId, drop } = await allControlsSheet(page);
      try {
        const before = await printedAllControls(page, nameId);
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
        const id = await page.getByTestId("editor-object").getAttribute("data-object-id");
        const row = page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`);
        const stored = async () => JSON.parse((await row.getAttribute("data-geometry-json")) ?? "[]") as { x: number; y: number; hIn?: { x: number; y: number }; hOut?: { x: number; y: number } }[];
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
        const printed = await printedAllControls(page, nameId);
        expect(printed.pages).toBe(1);
        expect(printed.curvedFills, "the curved white-out's fill").toBe(before.curvedFills + 1);

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
        // At the minimum (three), Delete on a focused vertex does nothing.

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

    test("A then S: the toner saver is the smooth offset hull of the course at 25 mm, handles stored", async ({ page }) => {
      await openEditor(page);
      await newCourse(page, "D13 toner");
      await expect(page.locator('[data-testid="editor-seq-row"][data-kind="start"]')).toBeAttached({ timeout: 15000 });
      await page.keyboard.press("k");
      const spots: { x: number; y: number }[] = [];
      for (let i = 0; i < 3; i++) {
        const p = await emptyPoint(page, 60, spots);
        spots.push(p);
        await page.mouse.click(p.x, p.y);
        await expect(controlRows(page)).toHaveCount(i + 1, { timeout: 15000 });
      }
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");

      const created = waitForTrpc(page, "courseObject.create");
      await page.keyboard.press("a");
      await page.keyboard.press("s");
      await created;
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-kind", "toner_saver", { timeout: 15000 });
      const id = await page.getByTestId("editor-object").getAttribute("data-object-id");
      const row = page.locator(`[data-testid="editor-object-row"][data-object-id="${id}"]`);
      await expect(row).toHaveCount(1, { timeout: 15000 });
      expect(JSON.parse((await row.getAttribute("data-props")) ?? "{}")).toMatchObject({ marginMm: 25 });
      const g = JSON.parse((await row.getAttribute("data-geometry-json")) ?? "[]") as { x: number; y: number; hIn?: unknown; hOut?: { x: number; y: number } }[];
      expect(g.filter((v) => v.hOut).length, "Bézier arcs, not an octagon").toBeGreaterThanOrEqual(3);
      // Three sites: three arcs of one or two pieces, three straight offset edges.
      expect(g.length).toBeGreaterThanOrEqual(6);
      await expect(page.getByTestId("editor-prop-margin")).toHaveValue("25");
      // The selected outline samples every curved segment.
      const outline = page.getByTestId("editor-tool-layer").locator(`[data-testid="editor-object-outline"][data-object-id="${id}"]`);
      expect(((await outline.getAttribute("data-points")) ?? "").split(" ").length).toBeGreaterThan(g.length);
    });
  });
});

// Checks and KPIs (docs/course-editor.md §8; course-layer.md §9).
/** A tRPC call as the e2e admin (the event seeded by `reseed`). */
async function trpcCall<T>(path: string, input: unknown, mutation = true): Promise<T> {
  const headers = { "content-type": "application/json", "x-competition-id": "itest", "x-forwarded-email": "e2e-admin@oxygen.test" };
  const res = mutation
    ? await fetch(`${API}/trpc/${path}`, { method: "POST", headers, body: JSON.stringify(input) })
    : await fetch(`${API}/trpc/${path}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`, { headers });
  const body = await res.text();
  expect(res.ok, body).toBe(true);
  return (JSON.parse(body) as { result: { data: T } }).result.data;
}

/** The frame's corners in paper mm (the UI layer's frame shape): page mm → paper mm by its affine map. */
async function pageToPaperOf(page: Page, frame: { x: number; y: number; width: number; height: number }) {
  const pts = (await page.getByTestId("editor-tool-layer").getByTestId("editor-layout-frame").getAttribute("data-points"))!
    .split(" ").map((p) => { const [x, y] = p.split(",").map(Number); return { x, y }; });
  const [c0, c1, , c3] = pts;
  return (p: { x: number; y: number }) => {
    const u = (p.x - frame.x) / frame.width, v = (p.y - frame.y) / frame.height;
    return { x: c0.x + u * (c1.x - c0.x) + v * (c3.x - c0.x), y: c0.y + u * (c1.y - c0.y) + v * (c3.y - c0.y) };
  };
}

test.describe("Course editor layout (docs/course-layout.md)", () => {
  const frame = { x: 10, y: 40, width: 190, height: 247 };

  test("a sheet from the Maps page: page text drawn as printed, align map saves the window centre, undo, one A4 page", async ({ page }) => {
    await openEditor(page);
    const nameId = new URL(page.url()).pathname.split("/")[1];
    // A template and a sheet for the first imported course, as the Maps page would make them.
    const courses = await trpcCall<{ id: number; name: string; controls?: unknown[] }[]>("course.list", undefined, false);
    expect(courses.length).toBeGreaterThan(0);
    const course = courses[0];
    const template = await trpcCall<{ seq: number }>("mapTemplate.create", {
      name: `Layout ${Date.now()}`, paper: "A4", orientation: "portrait", printScale: 10000, objects: [],
      settings: { printMarginMm: 5, mapFrame: frame, description: { visible: false, x: 150, y: 12, cellSizeMm: 6 }, appearance: { purple: "#a626ff", circleRadiusMm: 2.5, lineWidthMm: 0.35, numberHeightMm: 4 } },
    });
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId: course.id, templateId: template.seq, overrides: {}, objects: [] });

    await page.goto(`/${nameId}/maps`);
    await page.getByTestId(`edit-course-map-${sheet.seq}`).click();
    await expect(page).toHaveURL(new RegExp(`course-editor\\?mode=layout&sheet=${sheet.seq}`));
    await editorReady(page);
    await expect(page.getByTestId("editor-mode-layout")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq));
    for (const id of ["editor-layout-paper", "editor-layout-printable", "editor-layout-frame"]) {
      await expect(page.getByTestId("editor-tool-layer").getByTestId(id)).toBeAttached();
    }
    // Course mode's tools are not here: Layout's rail replaces the rail.
    await expect(page.getByTestId("editor-tool-rail")).toHaveCount(0);
    await expect(page.getByTestId("editor-layout-rail")).toBeVisible();

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
    const centre = async () => (await state.getAttribute("data-centre"))!.split(",").map(Number);
    const [cx, cy] = await centre();
    const to = { x: inside.x + 60, y: inside.y + 40 };
    const [a, b] = [await toPaper(page, inside), await toPaper(page, to)];
    const saved = waitForTrpc(page, "courseMap.saveLayout");
    await drag(page, inside, to);
    await saved;
    const stored = await trpcCall<{ windowCenter: { x: number; y: number } }>("courseMap.get", { seq: sheet.seq }, false);
    expect(stored.windowCenter.x).toBeCloseTo(cx + (b.x - a.x), 0);
    expect(stored.windowCenter.y).toBeCloseTo(cy + (b.y - a.y), 0);
    expect(Math.hypot(stored.windowCenter.x - cx, stored.windowCenter.y - cy)).toBeGreaterThan(2);

    // Undo writes the previous centre back.
    const undone = waitForTrpc(page, "courseMap.saveLayout");
    await page.keyboard.press("Control+z");
    await undone;
    await expect.poll(async () => (await trpcCall<{ windowCenter: { x: number; y: number } }>("courseMap.get", { seq: sheet.seq }, false)).windowCenter.x).toBeCloseTo(cx, 3);

    // The sheet prints as one page of the template's paper.
    const res = await page.request.get(`/api/maps/${nameId}/maps.pdf?maps=${sheet.seq}`);
    expect(res.ok(), await res.text().catch(() => "")).toBe(true);
    const pdf = await PDFDocument.load(await res.body()) as unknown as { getPageCount(): number; getPages(): { getSize(): { width: number; height: number } }[] };
    expect(pdf.getPageCount()).toBe(1);
    const { width, height } = pdf.getPages()[0].getSize();
    expect([Math.round((width * 25.4) / 72), Math.round((height * 25.4) / 72)]).toEqual([210, 297]);

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
  });
});

test.describe("Course editor auto templates (docs/course-layout.md §5–§7)", () => {
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
    const pdf = await PDFDocument.load(await readFile((await download.path())!));
    expect(pdf.getPageCount()).toBe(1);
    const own = (await trpcCall<{ seq: number; courseId: number | null; class: unknown }[]>("courseMap.list", undefined, false))
      .filter((s) => s.courseId === course!.id && s.class === null);
    expect(own).toHaveLength(1);

    // Layout mode: the sheet's template is its key's auto template.
    await page.getByTestId("editor-mode-layout").click();
    await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(own[0].seq), { timeout: 30_000 });
    const badge = page.getByTestId("editor-layout-template-badge");
    await expect(badge).toHaveAttribute("data-extra", "false");
    await expect(badge).toHaveAttribute("data-auto-key", /^A4-(portrait|landscape)-\d+$/);
    await expect(page.getByTestId("editor-status-sheet")).toHaveAttribute("data-key", /^1:\d+ A4 /);

    // A class prints at 1:15000: its class sheet appears.
    const overridden = waitForTrpc(page, "layout.setClassOverride");
    await page.getByTestId(`editor-layout-class-scale-${cls!.seq}`).fill("15000");
    await page.getByTestId(`editor-layout-class-scale-${cls!.seq}`).press("Enter");
    await overridden;
    await expect(page.getByTestId(`editor-layout-class-${cls!.seq}`)).toHaveAttribute("data-sheets", "1");

    // Class view in Course mode: the course as the class prints it.
    await page.getByTestId("editor-mode-course").click();
    await page.getByTestId("editor-view-class").selectOption(String(cls!.seq));
    await expect(page.getByTestId("editor-status-sheet")).toHaveAttribute("data-key", /^1:15000 A4 /, { timeout: 15_000 });
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
  test("two controls 20 m apart: a marker, a row that locates them, the status-bar count", async ({ page }) => {
    await openEditor(page);
    const kpis = await page.getByTestId("editor-status-kpis").textContent();
    const scale = Number(/1:([\d\s ]+)/.exec(kpis ?? "")?.[1].replace(/[\s ]/g, ""));
    expect(scale).toBeGreaterThan(0);
    const spot = await toPaper(page, await emptyPoint(page, 40));
    const dMm = 20_000 / scale;
    const nameId = new URL(page.url()).pathname.split("/")[1];
    const headers = { "content-type": "application/json", "x-event-id": nameId };
    const codes = [251, 252];
    for (const [i, code] of codes.entries()) {
      const res = await page.request.post(`${API}/trpc/control.create`, {
        headers, data: { codes: String(code), xpos: spot.x + i * dMm, ypos: spot.y, description: { d: `1.00${i + 1}` } },
      });
      expect(res.ok(), await res.text()).toBe(true);
    }
    try {
      await page.reload();
      await editorReady(page);
      // The section is collapsed by default; its count stands beside the title.
      await expect(page.getByTestId("editor-checks-count")).toBeVisible({ timeout: 20000 });
      await page.getByTestId("editor-checks-toggle").click();
      const row = page.locator('[data-testid="editor-check-row"][data-code="CONTROL_TOO_CLOSE"][data-sites="251,252"]');
      await expect(row).toBeVisible({ timeout: 20000 });
      await expect(row).toContainText("20 m");
      await expect(page.locator('[data-testid="editor-check-marker"][data-code="CONTROL_TOO_CLOSE"][data-site="251"]')).toBeAttached();
      await expect(page.locator('[data-testid="editor-check-marker"][data-code="CONTROL_TOO_CLOSE"][data-site="252"]')).toBeAttached();
      expect(Number(await page.getByTestId("editor-status-checks").getAttribute("data-count"))).toBeGreaterThan(0);

      // Click-to-locate: selects the first site and centres the view on the pair's midpoint.
      await row.click();
      await expect(selectedCode(page)).toHaveText("251", { timeout: 10000 });
      const viewer = page.getByTestId("map-viewer");
      await expect.poll(async () => Number(await viewer.getAttribute("data-centre-x")) / 1000, { timeout: 10000 }).toBeCloseTo(spot.x + dMm / 2, 1);
      await expect.poll(async () => Number(await viewer.getAttribute("data-centre-y")) / 1000, { timeout: 10000 }).toBeCloseTo(spot.y, 1);
    } finally {
      for (const code of codes) await page.request.post(`${API}/trpc/control.delete`, { headers, data: { id: code } });
    }
  });
});
