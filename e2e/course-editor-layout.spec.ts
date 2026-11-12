// Layout mode (docs/course-layout.md): sheets, auto templates, setter maps (F10), description sheets (F11), and the
// white-outs (P7, F12).
// Split from the editor's one spec file along its describes (docs/e2e-sharding.md "CI"); the
// helpers they share are `helpers/course-editor-spec.ts`. It runs under the `chromium` project (desktop) only.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`, the fixture import idempotent per test
// (`openEditor` → `ensureCoursesAndMap`), courses a test creates carry a prefix and go with the
// next reseed, controls / objects / sheets it creates are deleted in `finally` (`cleanup`).

import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { analysePdf, cleanup, clickMap, drag, editorReady, geometryOf, inkIn, nameIdOf, openEditor, pageToPaperOf, printed, probeTemplate, toPage, toPaper, trpcCall, viewCentre, viewSettled, statsRow, type Frame } from "./helpers/editor";
import { migrateLegacySheetObjects } from "./helpers/legacy-objects";
import { waitForTrpc } from "./helpers/trpc";
import { type Pt, desktopOnly, courseIdByName } from "./helpers/course-editor-spec";

test.beforeAll(async () => {
  await reseed();
});

test.setTimeout(120_000);

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

  test("a sheet from the Courses page: page text drawn as printed, align map saves the window centre, undo, one A4 page", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const { template, sheet, drop } = await sheetFixture("Layout");
    try {
      // The Courses page's Edit layout opens the course's first sheet in Layout mode (E-pages); the /maps link redirects there.
      const courseId = (await trpcCall<{ courseId: number | null; seq: number }[]>("courseMap.list", undefined, false)).find((m) => m.seq === sheet.seq)!.courseId!;
      await page.goto(`/${nameId}/maps?course=${courseId}`);
      await expect(page).toHaveURL(new RegExp(`/courses\\?course=${courseId}$`));
      const edit = page.locator("tbody tr").filter({ has: page.getByTestId(`course-template-${courseId}`) }).locator("[data-testid^='edit-course-map-']");
      await expect(edit).toHaveAttribute("href", new RegExp(`course-editor\\?course=${courseId}&mode=layout&sheet=\\d+$`));
      // The course may hold earlier sheets; this one opens by its own link.
      await page.goto(`/${nameId}/course-editor?mode=layout&sheet=${sheet.seq}&course=${courseId}`);
      // F31: the editor writes its canonical form (docs/course-editor.md §1 "URL").
      await expect(page).toHaveURL(new RegExp(`course-editor\\?course=${courseId}&mode=layout&sheet=${sheet.seq}$`));
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

      // An old Map templates link opens the same template scope (E-pages: the page redirects to Layout mode).
      await page.goto(`/${nameId}/map-templates?template=${template.seq}`);
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

      // P: corners by Alt-clicks, a curve vertex by a click-drag, a smooth one by a plain click (F18), closed by a click
      // on the first vertex — one write.
      await page.getByTestId("editor-layout-tool-P").click();
      await expect(page.getByTestId("editor-layout-tool-P")).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.down("Alt");
      await clickMap(page, await at(40, 60));
      await clickMap(page, await at(90, 60));
      await page.keyboard.up("Alt");
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
      // The plain click's vertex is smooth; the Alt-clicks' are corners.
      expect(path.points![3].hIn && path.points![3].hOut).toBeTruthy();
      expect(path.points!.slice(0, 2).every((v) => !v.hIn && !v.hOut)).toBe(true);
      // Selected, back in V, with the course editor's handles and grips.
      await expect(page.getByTestId("editor-layout-selected")).toHaveAttribute("data-kind", "object");
      await expect(page.getByTestId("editor-layout-tool-V")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-tool-layer").getByTestId("editor-layout-handle")).toHaveCount(4);
      await expect(page.getByTestId("editor-tool-layer").getByTestId("editor-layout-grip")).toHaveCount(4);

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

// P7 (user 2026-11-07): a white-out outside whose shape crossed the frame turned the whole frame white (first vertex
// left of the frame) or left a white slash (crossing the bottom, first vertex inside) — the GL fill's even-odd
// triangulation (docs/bugfix-whiteout-layout.md). Its own describe, so the parallel rows' edits above merge cleanly.
test.describe("P7: a white-out outside crossing the frame hides only what is outside its shape", () => {
  desktopOnly();
  const frame: Frame = { x: 10, y: 40, width: 190, height: 247 };

  test("Layout mode: toner savers across the left and bottom edges; a page white-out outside dragged across both", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const courses = await trpcCall<{ id: number }[]>("course.list", undefined, false);
    const template = await probeTemplate("P7 whiteout", frame, 5);
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId: courses[0].id, templateId: template.seq, overrides: {}, objects: [] });
    // The page white-out outside: tall enough that the inside square stays in it after the drag down (page mm).
    const rect = { id: "p7-wo", kind: "rectangle", anchor: "page", x: 30, y: 150, width: 100, height: 120, fillMode: "whiteoutInverted" };
    const sheet2 = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId: courses[0].id, templateId: template.seq, overrides: {}, objects: [rect] });
    const ids: number[] = [];
    try {
      const open = async (seq: number) => {
        await page.goto(`/${nameId}/course-editor?mode=layout&sheet=${seq}`);
        await editorReady(page);
        await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(seq));
        await viewSettled(page);
      };
      await open(sheet.seq);
      const toPaperMm = await pageToPaperOf(page, frame);
      const pagePt = async (x: number, y: number) => toPage(page, toPaperMm({ x, y }));
      // Two 709 squares on the map (page mm): `inside` lies in every white-out shape below, `outside` in none.
      const squareAt = (x: number, y: number) => [{ x, y }, { x: x + 20, y }, { x: x + 20, y: y + 15 }, { x, y: y + 15 }].map(toPaperMm);
      const inner = (sq: Pt[]) => ({
        minX: Math.min(...sq.map((p) => p.x)) + 2, maxX: Math.max(...sq.map((p) => p.x)) - 2,
        minY: Math.min(...sq.map((p) => p.y)) + 2, maxY: Math.max(...sq.map((p) => p.y)) - 2,
      });
      const inside = squareAt(60, 200), outside = squareAt(150, 200);
      for (const sq of [inside, outside]) {
        ids.push((await trpcCall<{ id: number }>("courseObject.create", { kind: "oob_area", geometry: sq, props: {}, scope: { all: true } })).id);
      }
      /** Purple in a square's interior, zoomed in on it (the hatch resolves into purple lines), then back out. */
      const purpleIn = async (sq: Pt[]) => {
        const r = inner(sq);
        const c = await toPage(page, { x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });
        await page.mouse.move(c.x, c.y);
        for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
        await viewSettled(page);
        const ink = await inkIn(page, r, "purple");
        for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 200);
        await viewSettled(page);
        return ink;
      };
      /** Reloaded (the editor caches the objects): `inside` keeps its purple, `outside` loses it. */
      const hidesOnlyOutside = async () => {
        await expect.poll(() => purpleIn(inside), { timeout: 30000 }).toBeGreaterThan(5);
        await expect.poll(() => purpleIn(outside), { timeout: 30000 }).toBe(0);
      };
      await page.reload();
      await editorReady(page);
      await viewSettled(page);
      await expect.poll(() => purpleIn(outside), { timeout: 30000 }).toBeGreaterThan(5);

      // A toner saver whose first (leftmost) vertex is left of the frame: the whole frame went white.
      const left = [{ x: 0, y: 190 }, { x: 130, y: 190 }, { x: 130, y: 230 }, { x: 0, y: 230 }].map(toPaperMm);
      let saver = (await trpcCall<{ id: number }>("courseObject.create", { kind: "toner_saver", geometry: left, props: {}, scope: { all: true } })).id;
      ids.push(saver);
      await page.reload();
      await editorReady(page);
      await viewSettled(page);
      await hidesOnlyOutside();

      // One crossing the frame's bottom (page y 287) with its first vertex inside: a white slash.
      await cleanup("courseObject.delete", { id: saver });
      ids.splice(ids.indexOf(saver), 1);
      const below = [{ x: 40, y: 190 }, { x: 130, y: 190 }, { x: 130, y: 297 }, { x: 40, y: 297 }].map(toPaperMm);
      saver = (await trpcCall<{ id: number }>("courseObject.create", { kind: "toner_saver", geometry: below, props: {}, scope: { all: true } })).id;
      ids.push(saver);
      await page.reload();
      await editorReady(page);
      await viewSettled(page);
      await hidesOnlyOutside();
      await cleanup("courseObject.delete", { id: saver });
      ids.splice(ids.indexOf(saver), 1);

      // The page white-out outside, dragged with V past the frame's bottom, then past its left edge.
      await open(sheet2.seq);
      await hidesOnlyOutside();
      type Stored = { objects: { id: string; x: number; y: number; width: number; height: number }[] };
      const stored = async () => (await trpcCall<Stored>("courseMap.get", { seq: sheet2.seq }, false)).objects.find((o) => o.id === rect.id)!;
      let saved = waitForTrpc(page, "courseMap.saveLayout");
      await drag(page, await pagePt(100, 240), await pagePt(100, 270));
      await saved;
      await expect.poll(async () => { const o = await stored(); return o.y + o.height; }).toBeGreaterThan(frame.y + frame.height);
      await hidesOnlyOutside();
      saved = waitForTrpc(page, "courseMap.saveLayout");
      await drag(page, await pagePt(100, 240), await pagePt(70, 240));
      await saved;
      await expect.poll(async () => (await stored()).x).toBeLessThan(frame.x);
      expect((await stored()).y).toBeLessThan(200);
      await hidesOnlyOutside();
    } finally {
      for (const id of ids) await cleanup("courseObject.delete", { id });
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("courseMap.delete", { id: sheet2.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
    }
  });
});

test.describe("F11: description sheets (docs/course-print.md §6.4)", () => {
  desktopOnly();

  test("Export ▾ → Description sheets… → two classes, two copies each: one A4 page per class", async ({ page }) => {
    await openEditor(page);
    const classes = (await trpcCall<{ id: number; name: string; courseIds: number[] }[]>("class.list", undefined, false)).filter((c) => c.courseIds.length > 0);
    expect(classes.length, "classes with a course").toBeGreaterThanOrEqual(2);
    const [a, b] = classes;

    await page.getByTestId("editor-export").click();
    await page.getByTestId("editor-export-descriptions").click();
    const dialog = page.getByTestId("editor-descriptions-dialog");
    await expect(dialog).toBeVisible();
    // Focus starts inside the dialog, and Tab keeps it there.
    await expect(dialog.locator(":focus")).toHaveCount(1);
    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    await expect(dialog.locator(":focus")).toHaveCount(1);
    // Every class with a course is checked by default.
    for (const c of classes) await expect(dialog.getByTestId(`editor-descriptions-class-${c.id}`)).toBeChecked();
    await dialog.getByTestId("editor-descriptions-none").click();
    await expect(dialog.getByTestId("editor-descriptions-download")).toBeDisabled();
    await dialog.getByTestId(`editor-descriptions-class-${a.id}`).check();
    await dialog.getByTestId(`editor-descriptions-class-${b.id}`).check();
    await dialog.getByTestId("editor-descriptions-copies-value").fill("2");
    await expect(dialog.getByTestId("editor-descriptions-copies-n")).toBeChecked();
    // A tool's key typed in the dialog arms no tool (the editor's single keys are inert while it is open).
    await dialog.getByTestId("editor-descriptions-copies-value").press("k");
    await expect(page.getByTestId("editor-tool-K")).not.toHaveAttribute("aria-pressed", "true");
    await dialog.getByTestId("editor-descriptions-cell").selectOption("5");

    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("editor-descriptions-download").click()]);
    expect(download.suggestedFilename()).toMatch(/_descriptions\.pdf$/);
    const pdf = await analysePdf(await readFile((await download.path())!));
    expect(pdf.pages).toBe(2);
    expect(pdf.sizeMm).toEqual([210, 297]);
    await expect(dialog).toHaveCount(0);

    // Escape closes the dialog and nothing else.
    await page.getByTestId("editor-export").click();
    await page.getByTestId("editor-export-descriptions").click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("editor-page")).toBeVisible();
  });
});

// F10 (docs/course-layout.md §8): Layout mode's Setter maps section, Move to next setter, Recalculate, Export ▾ Setter
// maps. Its own describe at the end of the file, so the parallel rows' edits above merge cleanly.
test.describe("F10: setter maps (docs/course-layout.md §8)", () => {
  desktopOnly();

  type Listed = { seq: number; kind: string; courseId: number | null; windowCenter: Pt | null; template: { autoKey: string | null } | null; setter: { index: number; controls: number[] } | null };
  const setterSheets = async () =>
    (await trpcCall<Listed[]>("courseMap.list", undefined, false)).filter((s) => s.kind === "setter" && s.courseId === null).sort((a, b) => a.setter!.index - b.setter!.index);

  test.afterEach(async () => {
    for (const s of await setterSheets()) await trpcCall("courseMap.delete", { id: s.seq });
  });

  test("Setter maps 2 in view All: two sheets listed, a control moved to the next setter and back, Recalculate, two pages", async ({ page }) => {
    await openEditor(page);
    await page.getByTestId("editor-view-all").click();
    await page.getByTestId("editor-mode-layout").click();
    await expect(page.getByTestId("editor-layout-setter")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("editor-layout-setter-scope")).toHaveText(/event/i);

    await page.getByTestId("editor-layout-setter-groups").fill("2");
    page.once("dialog", (d) => void d.accept());
    const generated = waitForTrpc(page, "layout.setterMaps");
    await page.getByTestId("editor-layout-setter-generate").click();
    await generated;
    const rows = page.getByTestId("editor-layout-setter-row");
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(rows.nth(0)).toHaveAttribute("data-setter", "1");
    const [s1, s2] = await setterSheets();
    expect(s1.setter!.controls.length + s2.setter!.controls.length).toBeGreaterThan(2);
    for (const s of [s1, s2]) expect(s.template?.autoKey).toMatch(/^A4-(portrait|landscape)-(4000|5000|7500|10000|15000)$/);
    // The first opens.
    const scope = page.getByTestId("editor-layout-scope");
    await expect(scope).toHaveAttribute("data-sheet", String(s1.seq), { timeout: 30_000 });

    // Setter 2: its controls; Move to next setter wraps to setter 1; undo moves it back.
    await rows.nth(1).click();
    await expect(scope).toHaveAttribute("data-sheet", String(s2.seq), { timeout: 30_000 });
    const control = page.getByTestId("editor-layout-setter-control").first();
    await expect(control).toBeVisible();
    const id = Number(await control.getAttribute("data-control-id"));
    const moved = waitForTrpc(page, "layout.moveToSetter");
    await control.getByTestId("editor-layout-setter-move").click();
    await moved;
    await expect.poll(async () => (await setterSheets())[0].setter!.controls.includes(id), { timeout: 15000 }).toBe(true);
    expect((await setterSheets())[1].setter!.controls).not.toContain(id);
    await expect(page.locator(`[data-testid="editor-layout-setter-control"][data-control-id="${id}"]`)).toHaveCount(0, { timeout: 15000 });
    const back = waitForTrpc(page, "layout.moveToSetter");
    await page.getByTestId("editor-undo").click();
    await back;
    await expect.poll(async () => (await setterSheets())[1].setter!.controls.includes(id), { timeout: 15000 }).toBe(true);

    // Recalculate: a moved window comes back to the group's centre (window centre NULL).
    await trpcCall("courseMap.update", { id: s2.seq, windowCenter: { x: 1, y: 1 } });
    const recalculated = waitForTrpc(page, "layout.recalculateSheet");
    await page.getByTestId("editor-layout-recalculate").click();
    await recalculated;
    expect((await setterSheets())[1].windowCenter).toBeNull();

    // Export ▾ Setter maps: one A4 page per setter sheet.
    await page.getByTestId("editor-export").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("editor-export-setter").click()]);
    const pdf = await analysePdf(await readFile((await download.path())!));
    expect(pdf.pages).toBe(2);
    expect([...pdf.sizeMm].sort((a, b) => a - b)).toEqual([210, 297]);
  });
});

test.describe("F12: a legacy map-anchored white-out is a course object (docs/course-layer.md §3.6, §8)", () => {
  desktopOnly();

  test("seeded on a sheet and migrated: listed in Course mode scoped to the sheet's course, white on the canvas, printed; the sheet keeps its page objects", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const courses = await trpcCall<{ id: number; name: string }[]>("course.list", undefined, false);
    const course = courses[0];
    await page.getByTestId("editor-course-picker").selectOption(await courseIdByName(page, course.name));
    await viewSettled(page);
    const template = await probeTemplate("F12 legacy");
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId: course.id, templateId: template.seq, overrides: {}, objects: [] });
    const moved: number[] = [];
    try {
      const before = await printed(page, nameId, `maps=${sheet.seq}`);
      // A white-out and a 709 area beside it, near the view's centre (paper mm), where the map has ink.
      const c = await viewCentre(page);
      const x = c.x / 1000 - 30, y = c.y / 1000 - 8;
      const inner = { minX: x + 2, maxX: x + 18, minY: y + 2, maxY: y + 13 };
      await expect.poll(() => inkIn(page, inner, "map"), { timeout: 30000 }).toBeGreaterThan(20);
      const inkBefore = await inkIn(page, inner, "map");
      const pageText = { id: "f12-page", anchor: "page", kind: "text", x: 12, y: 20, text: "{course}", fontSizeMm: 4, color: "#000000" };
      const kept = await migrateLegacySheetObjects(nameId, sheet.seq, [
        { id: "f12-wo", anchor: "map", kind: "rectangle", x, y, width: 20, height: 15, fillMode: "whiteout" },
        { id: "f12-oob", anchor: "map", kind: "rectangle", x: x + 40, y, width: 20, height: 15, fillMode: "outOfBounds" },
        pageText,
      ]);
      expect(kept).toEqual([pageText]);

      // The editor caches the objects: reloaded, it holds them as course objects scoped to the course.
      await page.reload();
      await editorReady(page);
      const rows = page.locator('[data-testid="editor-object-row"]');
      /** The migrated object of `kind` whose first vertex is `at`: its public id and wire scope. */
      const find = async (kind: string, at: Pt) => {
        for (const r of await rows.all()) {
          const g = await geometryOf(r);
          if ((await r.getAttribute("data-object-kind")) === kind && g.length === 4 && Math.abs(g[0].x - at.x) < 1e-6 && Math.abs(g[0].y - at.y) < 1e-6) {
            return { id: Number(await r.getAttribute("data-object-id")), scope: await r.getAttribute("data-scope") };
          }
        }
        return null;
      };
      const scope = JSON.stringify({ courses: [course.id], classes: [] });
      await expect.poll(async () => (await find("whiteout", { x, y }))?.scope, { timeout: 15000 }).toBe(scope);
      for (const [kind, at] of [["whiteout", { x, y }], ["oob_area", { x: x + 40, y }]] as const) {
        const o = await find(kind, at);
        expect(o?.scope, kind).toBe(scope);
        moved.push(o!.id);
      }
      // Drawn with the course: the white-out covers the map's ink under it (a course leg across it may leave an
      // anti-aliased pixel that is not purple enough to count as overprint).
      await page.getByTestId("editor-course-picker").selectOption(await courseIdByName(page, course.name));
      await viewSettled(page);
      await expect.poll(() => inkIn(page, inner, "map"), { timeout: 30000 }).toBeLessThanOrEqual(Math.min(3, inkBefore / 10));

      // Printed from course_objects: the course's sheet gains the 709 hatch; one page.
      const after = await printed(page, nameId, `maps=${sheet.seq}`);
      expect(after.pages).toBe(1);
      expect(after.hatches).toBeGreaterThan(before.hatches);
    } finally {
      for (const id of moved) await cleanup("courseObject.delete", { id });
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
    }
  });
});
