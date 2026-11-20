// Layout mode (docs/course-layout.md): sheets, auto templates, setter maps (F10), description sheets (F11), and the
// white-outs (P7, F12).
// Split from the editor's one spec file along its describes (docs/e2e-sharding.md "CI"); the
// helpers they share are `helpers/course-editor-spec.ts`. It runs under the `chromium` project (desktop) only.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`, the fixture import idempotent per test
// (`openEditor` → `ensureCoursesAndMap`), courses a test creates carry a prefix and go with the
// next reseed, controls / objects / sheets it creates are deleted in `finally` (`cleanup`).

import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { expect, test } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { analysePdf, canvasColourAt, cleanup, clickMap, drag, dragHold, editorReady, geometryOf, inkIn, nameIdOf, openEditor, pageToPaperOf, printed, probeTemplate, toPage, toPaper, trpcCall, viewCentre, viewSettled, statsRow, type Frame } from "./helpers/editor";
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

  test("graphics: upload an SVG, its thumbnail and size show, place it, save it to the club, delete both", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const { sheet, drop } = await sheetFixture("Layout graphic");
    const images = async () =>
      (await trpcCall<{ objects: { kind: string; graphicId?: number }[] }>("courseMap.get", { seq: sheet.seq }, false)).objects.filter((o) => o.kind === "image");
    // A unique name: the club copy is global, and a failed run must not break the next one.
    const logoName = `e2e-logo-${Date.now()}.svg`;
    try {
      await page.goto(`/${nameId}/course-editor?mode=layout&sheet=${sheet.seq}`);
      await editorReady(page);
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq));

      // J8: `I` opens the picker beside the rail; upload there; a tile's Place button arms the click.
      await page.getByTestId("editor-layout-tool-I").click();
      await expect(page.getByTestId("editor-layout-image-hint")).toBeVisible();
      const uploaded = waitForTrpc(page, "graphics.upload");
      await page.getByTestId("editor-layout-graphic-upload").setInputFiles({
        name: logoName,
        mimeType: "image/svg+xml",
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#336699"/></svg>'),
      });
      await uploaded;
      // J2: the picker's tile shows the thumbnail and the SVG's size at 4096 px.
      const tile = page.getByTestId("editor-layout-graphic-event").getByTestId("editor-layout-graphic-tile").filter({ hasText: logoName }).last();
      await expect(tile).toHaveAttribute("data-club", "false");
      const graphicId = Number(await tile.getAttribute("data-graphic-id"));
      await expect(tile).toContainText("4096 × 4096 px");
      await expect.poll(() => tile.getByTestId("editor-layout-graphic-thumb").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(256);
      const placeButton = page.getByTestId(`editor-layout-graphic-place-${graphicId}`);
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

      // J6: drawn by the map engine with the page layer (no UI-layer image): the SVG's disc at the box centre,
      // its transparent corner shows the sheet under it.
      await expect(page.locator('[data-testid="editor-layout-image"]')).toHaveCount(0);
      await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-graphics", "ready");
      const box = (await images())[0] as unknown as { x: number; y: number; width: number; height: number };
      const centre = toPaperMm({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
      await expect.poll(async () => {
        const c = await canvasColourAt(page, centre);
        return c !== null && Math.abs(c[0] - 0x33) <= 12 && Math.abs(c[1] - 0x66) <= 12 && Math.abs(c[2] - 0x99) <= 12;
      }).toBe(true);
      const corner = await canvasColourAt(page, toPaperMm({ x: box.x + box.width * 0.04, y: box.y + box.height * 0.04 }));
      expect(corner && Math.abs(corner[2] - 0x99) + Math.abs(corner[0] - 0x33) > 40, `corner ${corner}`).toBe(true);

      // Selected from the list and deleted: gone from the list and from the sheet.
      await row.click();
      await expect(page.getByTestId("editor-layout-selected")).toHaveAttribute("data-kind", "object");
      const deleted = waitForTrpc(page, "courseMap.saveLayout");
      await page.getByTestId("editor-layout-delete").click();
      await deleted;
      await expect(row).toHaveCount(0);
      await expect.poll(async () => (await images()).length).toBe(0);

      // Saved to the club library: a club tile; deleted there with a second, confirming click (the picker again).
      await page.getByTestId("editor-layout-tool-I").click();
      const saved = waitForTrpc(page, "graphics.saveToClub");
      await page.getByTestId(`editor-layout-graphic-save-club-${graphicId}`).click();
      await saved;
      const clubTile = page.getByTestId("editor-layout-graphic-club").getByTestId("editor-layout-graphic-tile").filter({ hasText: logoName });
      await expect(clubTile).toHaveCount(1);
      const clubId = Number(await clubTile.getAttribute("data-graphic-id"));
      const del = page.getByTestId(`editor-layout-graphic-delete-${clubId}`);
      await del.click();
      await expect(clubTile).toHaveCount(1);
      const removed = waitForTrpc(page, "graphics.delete");
      await del.click();
      await removed;
      await expect(clubTile).toHaveCount(0);
      const ownDelete = page.getByTestId(`editor-layout-graphic-delete-${graphicId}`);
      await ownDelete.click();
      const removedOwn = waitForTrpc(page, "graphics.delete");
      await ownDelete.click();
      await removedOwn;
      await expect(page.locator(`[data-testid="editor-layout-graphic-tile"][data-graphic-id="${graphicId}"]`)).toHaveCount(0);
    } finally {
      const left = await trpcCall<{ id: number; name: string }[]>("graphics.list", undefined, false).catch(() => []);
      for (const g of left.filter((x) => x.name === logoName)) await cleanup("graphics.delete", { id: g.id });
      await drop();
    }
  });

  test("J20: several files picked at once upload one after another; a bad one is named and the rest still upload", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const { sheet, drop } = await sheetFixture("Layout multi upload");
    const stamp = Date.now();
    const names = [`e2e-multi-a-${stamp}.svg`, `e2e-multi-b-${stamp}.svg`];
    const svg = (fill: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`);
    try {
      await page.goto(`/${nameId}/course-editor?mode=layout&sheet=${sheet.seq}`);
      await editorReady(page);
      await page.getByTestId("editor-layout-tool-I").click();
      await page.getByTestId("editor-layout-graphic-upload").setInputFiles([
        { name: names[0], mimeType: "image/svg+xml", buffer: svg("#336699") },
        { name: `e2e-multi-notes-${stamp}.txt`, mimeType: "text/plain", buffer: Buffer.from("not a graphic") },
        { name: names[1], mimeType: "image/svg+xml", buffer: svg("#993366") },
      ]);
      const tiles = page.getByTestId("editor-layout-graphic-event").getByTestId("editor-layout-graphic-tile");
      for (const n of names) await expect(tiles.filter({ hasText: n })).toHaveCount(1);
      const error = page.getByTestId("editor-layout-graphic-error");
      await expect(error).toContainText(`e2e-multi-notes-${stamp}.txt`);
      await expect(error).not.toContainText(names[0]);
      const listed = await trpcCall<{ name: string }[]>("graphics.list", undefined, false);
      expect(listed.filter((g) => g.name.includes(`-${stamp}.`)).map((g) => g.name).sort()).toEqual([...names].sort());
    } finally {
      const left = await trpcCall<{ id: number; name: string }[]>("graphics.list", undefined, false).catch(() => []);
      for (const g of left.filter((x) => x.name.includes(`-${stamp}.`))) await cleanup("graphics.delete", { id: g.id });
      await drop();
    }
  });

  test("J8: style fields on page objects — an image at its aspect, opacity, Multiply, rotation, size with the lock, flip, crop, undo; a white-out without blend or lock; a text's rotation", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const { sheet, drop } = await sheetFixture("Layout style");
    const objects = async () => (await trpcCall<{ objects: Record<string, unknown>[] }>("courseMap.get", { seq: sheet.seq }, false)).objects;
    const png = new PNG({ width: 16, height: 8 });
    for (let i = 0; i < 128; i++) png.data.set([250, 210, 0, 255], i * 4);
    const { id: graphicId } = await trpcCall<{ id: number }>("graphics.upload", { name: `e2e-j8-${Date.now()}.png`, scope: "event", fileDataBase64: PNG.sync.write(png).toString("base64") });
    try {
      await page.goto(`/${nameId}/course-editor?mode=layout&sheet=${sheet.seq}`);
      await editorReady(page);
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq));
      const toPaperMm = await pageToPaperOf(page, frame);

      // I without a graphic: a click places nothing and the tool stays.
      await page.keyboard.press("i");
      await expect(page.getByTestId("editor-layout-tool-I")).toHaveAttribute("aria-pressed", "true");
      await clickMap(page, await toPage(page, toPaperMm({ x: 150, y: 20 })));
      await expect(page.getByTestId("editor-layout-tool-I")).toHaveAttribute("aria-pressed", "true");
      expect((await objects()).filter((o) => o.kind === "image")).toHaveLength(0);
      await page.getByTestId(`editor-layout-graphic-place-${graphicId}`).click();
      const placed = waitForTrpc(page, "courseMap.saveLayout");
      await clickMap(page, await toPage(page, toPaperMm({ x: 150, y: 20 })));
      await placed;
      const image = async () => (await objects()).find((o) => o.kind === "image") as Record<string, number | string | undefined>;
      await expect.poll(async () => (await image())?.width).toBe(30);
      expect((await image()).height).toBe(15);
      await expect(page.getByTestId("editor-layout-selected")).toHaveAttribute("data-kind", "object");
      await expect(page.getByTestId("editor-layout-style-blend")).toBeVisible();

      // Drawn yellow; opacity 0 shows the page under it; 100 removes the key.
      const centre = toPaperMm({ x: 150, y: 20 });
      await expect.poll(async () => { const c = await canvasColourAt(page, centre); return !!c && c[0] > 220 && c[1] > 180 && c[2] < 60; }, { timeout: 30000 }).toBe(true);
      const commit = async (testId: string, value: string) => {
        const w = waitForTrpc(page, "courseMap.saveLayout");
        await page.getByTestId(testId).fill(value);
        await page.getByTestId(testId).press("Enter");
        await w;
      };
      await commit("editor-layout-style-opacity", "0");
      await expect.poll(async () => (await image()).opacity).toBe(0);
      await expect.poll(async () => { const c = await canvasColourAt(page, centre); return !!c && c[2] > 200; }, { timeout: 30000 }).toBe(true);
      await commit("editor-layout-style-opacity", "100");
      await expect.poll(async () => "opacity" in (await image())).toBe(false);

      // Multiply and Normal; rotation 30; width 20 with the lock → height 10; one Ctrl+Z restores the width.
      const blended = waitForTrpc(page, "courseMap.saveLayout");
      await page.getByTestId("editor-layout-style-blend").selectOption("multiply");
      await blended;
      await expect.poll(async () => (await image()).blend).toBe("multiply");
      const normal = waitForTrpc(page, "courseMap.saveLayout");
      await page.getByTestId("editor-layout-style-blend").selectOption("normal");
      await normal;
      await expect.poll(async () => "blend" in (await image())).toBe(false);
      await commit("editor-layout-style-rotation", "30");
      await expect.poll(async () => (await image()).rotationDeg).toBe(30);
      await commit("editor-layout-style-width", "20");
      await expect.poll(async () => (await image()).width).toBe(20);
      expect((await image()).height).toBeCloseTo(10, 6);
      await page.getByTestId("editor-layout-style-width").blur();
      await page.keyboard.press("Control+z");
      await expect.poll(async () => (await image()).width).toBe(30);

      // Flip H; a crop to the left half halves the box in one write, and one Ctrl+Z restores box and crop.
      const flipped = waitForTrpc(page, "courseMap.saveLayout");
      await page.getByTestId("editor-layout-style-flip-h").check();
      await flipped;
      await expect.poll(async () => (await image()).flipH).toBe(true);
      // J15: "Cut out graphics below" on the page image.
      const knocked = waitForTrpc(page, "courseMap.saveLayout");
      await page.getByTestId("editor-layout-style-knockout").check();
      await knocked;
      await expect.poll(async () => (await image()).knockout).toBe(true);
      await commit("editor-layout-style-crop-w", "50");
      await expect.poll(async () => (await image()).width).toBeCloseTo(15, 6);
      expect((await image()).crop).toEqual({ x: 0, y: 0, width: 0.5, height: 1 });
      await page.getByTestId("editor-layout-style-crop-w").blur();
      await page.keyboard.press("Control+z");
      await expect.poll(async () => (await image()).width).toBe(30);
      expect("crop" in (await image())).toBe(false);

      // A white-out: opacity, no blend; its width without a lock.
      await page.keyboard.press("w");
      const white = waitForTrpc(page, "courseMap.saveLayout");
      await clickMap(page, await toPage(page, toPaperMm({ x: 60, y: 20 })));
      await white;
      await expect(page.getByTestId("editor-layout-style-opacity")).toBeVisible();
      await expect(page.getByTestId("editor-layout-style-blend")).toHaveCount(0);
      await expect(page.getByTestId("editor-layout-style-lock")).toHaveCount(0);
      await expect(page.getByTestId("editor-layout-style-knockout")).toHaveCount(0);
      const rectangle = async () => (await objects()).find((o) => o.kind === "rectangle") as Record<string, number | undefined>;
      const rectHeight = (await rectangle()).height;
      await commit("editor-layout-style-width", "40");
      await expect.poll(async () => (await rectangle()).width).toBe(40);
      expect((await rectangle()).height).toBe(rectHeight);

      // A text turns by its rotation field.
      await page.getByTestId("editor-layout-style-width").blur();
      await page.keyboard.press("t");
      const texted = waitForTrpc(page, "courseMap.saveLayout");
      await clickMap(page, await toPage(page, toPaperMm({ x: 100, y: 120 })));
      await texted;
      await expect(page.getByTestId("editor-layout-style-flip-h")).toHaveCount(0);
      await commit("editor-layout-style-rotation", "15");
      await expect.poll(async () => ((await objects()).find((o) => o.kind === "text") as { rotationDeg?: number }).rotationDeg).toBe(15);
    } finally {
      await drop();
      await cleanup("graphics.delete", { id: graphicId });
    }
  });

  test("J9: transform handles on page objects — the knob turns (Shift in 15° steps, Escape cancels), crop mode crops by an edge, a line turns and flips", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const { sheet, drop } = await sheetFixture("Layout transform");
    const objects = async () => (await trpcCall<{ objects: Record<string, unknown>[] }>("courseMap.get", { seq: sheet.seq }, false)).objects;
    const png = new PNG({ width: 16, height: 8 });
    for (let i = 0; i < 128; i++) png.data.set([250, 210, 0, 255], i * 4);
    const { id: graphicId } = await trpcCall<{ id: number }>("graphics.upload", { name: `e2e-j9-${Date.now()}.png`, scope: "event", fileDataBase64: PNG.sync.write(png).toString("base64") });
    let saves = 0;
    page.on("request", (r) => { if (r.url().includes("courseMap.saveLayout")) saves++; });
    try {
      await page.goto(`/${nameId}/course-editor?mode=layout&sheet=${sheet.seq}`);
      await editorReady(page);
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq));
      const toPaperMm = await pageToPaperOf(page, frame);
      const screen = async (x: number, y: number) => toPage(page, toPaperMm({ x, y }));

      await page.keyboard.press("i");
      await page.getByTestId(`editor-layout-graphic-place-${graphicId}`).click();
      const placed = waitForTrpc(page, "courseMap.saveLayout");
      await clickMap(page, await screen(100, 120));
      await placed;
      const image = async () => (await objects()).find((o) => o.kind === "image") as Record<string, unknown> & { width: number; height: number; rotationDeg?: number; crop?: { width: number } };
      await expect.poll(async () => (await image())?.width).toBe(30);
      const layer = page.getByTestId("editor-tool-layer");
      const centreOf = async (id: string, n = 0) => { const b = (await layer.getByTestId(id).nth(n).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
      const centre = await screen(100, 120);

      // The knob dragged from above the centre to its right: a quarter turn clockwise, one write; undo restores.
      await expect(layer.getByTestId("editor-layout-rotate")).toHaveCount(1);
      let knob = await centreOf("editor-layout-rotate");
      const r = Math.hypot(knob.x - centre.x, knob.y - centre.y);
      let before = saves;
      const turned = waitForTrpc(page, "courseMap.saveLayout");
      await drag(page, knob, { x: centre.x + r, y: centre.y });
      await turned;
      // Within a few degrees: the press lands on the knob's pixel, not its exact centre.
      await expect.poll(async () => Math.abs(((await image()).rotationDeg ?? 0) - 90)).toBeLessThan(3);
      expect(saves - before).toBe(1);
      await page.keyboard.press("Control+z");
      await expect.poll(async () => "rotationDeg" in (await image())).toBe(false);

      // Shift snaps to 15°.
      knob = await centreOf("editor-layout-rotate");
      const snapped = waitForTrpc(page, "courseMap.saveLayout");
      await page.keyboard.down("Shift");
      await drag(page, knob, { x: centre.x + r * Math.sin(0.65), y: centre.y - r * Math.cos(0.65) });
      await page.keyboard.up("Shift");
      await snapped;
      await expect.poll(async () => (await image()).rotationDeg).toBeDefined();
      expect(((await image()).rotationDeg as number) % 15).toBe(0);
      await page.keyboard.press("Control+z");
      await expect.poll(async () => "rotationDeg" in (await image())).toBe(false);

      // Escape mid-drag: nothing written, the image still unturned and selected.
      knob = await centreOf("editor-layout-rotate");
      before = saves;
      await dragHold(page, knob, { x: centre.x + r, y: centre.y });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await page.waitForTimeout(300);
      expect(saves).toBe(before);
      expect("rotationDeg" in (await image())).toBe(false);

      // Crop mode: a double-click shows the four edges; the right edge dragged a quarter in crops and shrinks the box in one write.
      await page.mouse.dblclick(centre.x, centre.y);
      await expect(layer.getByTestId("editor-layout-crop-edge")).toHaveCount(4);
      await expect(layer.getByTestId("editor-layout-rotate")).toHaveCount(0);
      const right = await centreOf("editor-layout-crop-edge", 1);
      const left = await centreOf("editor-layout-crop-edge", 0);
      before = saves;
      const cropped = waitForTrpc(page, "courseMap.saveLayout");
      await drag(page, right, { x: right.x - (right.x - left.x) / 4, y: right.y });
      await cropped;
      await expect.poll(async () => (await image()).crop?.width).toBeCloseTo(0.75, 1);
      expect((await image()).width).toBeCloseTo(30 * (await image()).crop!.width, 6);
      expect(saves - before).toBe(1);
      await page.keyboard.press("Control+z");
      await expect.poll(async () => "crop" in (await image())).toBe(false);
      expect((await image()).width).toBe(30);
      // Escape leaves crop mode; the image stays selected.
      await page.keyboard.press("Escape");
      await expect(layer.getByTestId("editor-layout-crop-edge")).toHaveCount(0);
      await expect(page.getByTestId("editor-layout-selected")).toHaveAttribute("data-kind", "object");
      // Another selection leaves crop mode for good: reselected, the image shows its corners and knob, no edges.
      await page.mouse.dblclick(centre.x, centre.y);
      await expect(layer.getByTestId("editor-layout-crop-edge")).toHaveCount(4);
      await clickMap(page, await screen(150, 200));
      await expect(page.getByTestId("editor-layout-selected")).not.toHaveAttribute("data-object-id", String((await image()).id));
      await clickMap(page, centre);
      await expect(layer.getByTestId("editor-layout-handle")).toHaveCount(4);
      await expect(layer.getByTestId("editor-layout-crop-edge")).toHaveCount(0);

      // A line: Turn 90° and Flip ↔ each one write, baked into its points.
      await page.keyboard.press("Escape");
      await page.keyboard.press("l");
      const lined = waitForTrpc(page, "courseMap.saveLayout");
      await clickMap(page, await screen(60, 200));
      await lined;
      const line = async () => (await objects()).find((o) => o.kind === "path" || o.kind === "line") as Record<string, unknown>;
      await expect.poll(async () => (await line()) !== undefined).toBe(true);
      await expect(page.getByTestId("editor-layout-transform-rotate90")).toBeVisible();
      const shape0 = JSON.stringify(await line());
      const rot = waitForTrpc(page, "courseMap.saveLayout");
      await page.getByTestId("editor-layout-transform-rotate90").click();
      await rot;
      await expect.poll(async () => JSON.stringify(await line())).not.toBe(shape0);
      const shape1 = JSON.stringify(await line());
      const flip = waitForTrpc(page, "courseMap.saveLayout");
      await page.getByTestId("editor-layout-transform-flip-h").click();
      await flip;
      await expect.poll(async () => JSON.stringify(await line())).not.toBe(shape1);
    } finally {
      await drop();
      await cleanup("graphics.delete", { id: graphicId });
    }
  });

  test("J12: Ctrl+D duplicates a page object 3 mm down-right; copy, paste at the pointer, cut; a course object's entry is refused", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const courses = await trpcCall<{ id: number }[]>("course.list", undefined, false);
    const template = await probeTemplate("Layout clipboard", frame, 5);
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", {
      kind: "course", courseId: courses[0].id, templateId: template.seq, overrides: {},
      objects: [{ id: "j12-r", anchor: "page", kind: "rectangle", x: 120, y: 10, width: 20, height: 10, fillMode: "whiteout" }],
    });
    const drop = async () => { await cleanup("courseMap.delete", { id: sheet.seq }); await cleanup("mapTemplate.delete", { id: template.seq }); };
    const objects = async () => (await trpcCall<{ objects: Record<string, number | string>[] }>("courseMap.get", { seq: sheet.seq }, false)).objects;
    try {
      await page.goto(`/${nameId}/course-editor?mode=layout&sheet=${sheet.seq}`);
      await editorReady(page);
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq));
      const toPaperMm = await pageToPaperOf(page, frame);
      await expect.poll(async () => (await objects()).length).toBe(1);
      await clickMap(page, await toPage(page, toPaperMm({ x: 130, y: 15 })));
      await expect(page.getByTestId("editor-layout-selected")).toHaveAttribute("data-kind", "object");

      // Ctrl+D: one write, a copy 3 mm right and down on the page with its own id.
      const dup = waitForTrpc(page, "courseMap.saveLayout");
      await page.keyboard.press("Control+d");
      await dup;
      await expect.poll(async () => (await objects()).length).toBe(2);
      const copy = (await objects()).find((o) => o.id !== "j12-r")!;
      expect(copy.x).toBeCloseTo(123, 6);
      expect(copy.y).toBeCloseTo(13, 6);
      expect(copy.width).toBe(20);

      // Ctrl+C, the pointer at (60, 20) on the page, Ctrl+V: a third, centred there; Ctrl+X takes it out again.
      await page.keyboard.press("Control+c");
      const there = await toPage(page, toPaperMm({ x: 60, y: 20 }));
      await page.mouse.move(there.x - 1, there.y);
      await page.mouse.move(there.x, there.y);
      const pasted = waitForTrpc(page, "courseMap.saveLayout");
      await page.keyboard.press("Control+v");
      await pasted;
      await expect.poll(async () => (await objects()).length).toBe(3);
      const third = (await objects()).find((o) => o.id !== "j12-r" && o.id !== copy.id)!;
      expect(Math.abs(Number(third.x) + 10 - 60)).toBeLessThan(0.5);
      expect(Math.abs(Number(third.y) + 5 - 20)).toBeLessThan(0.5);
      const cut = waitForTrpc(page, "courseMap.saveLayout");
      await page.keyboard.press("Control+x");
      await cut;
      await expect.poll(async () => (await objects()).map((o) => o.id).sort()).toEqual([copy.id, "j12-r"].sort());

      // A course object on the clipboard does not paste in Layout mode: the reason shows, nothing is written.
      await page.evaluate(() => localStorage.setItem("oxygen.editor.clipboard", JSON.stringify({
        v: 1, type: "course", event: "x", object: { kind: "oob_area", geometry: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }], props: {}, scope: { all: true }, inCourses: null },
      })));
      await page.keyboard.press("Control+v");
      await expect(page.getByTestId("editor-error")).toBeVisible({ timeout: 10000 });
      expect((await objects()).length).toBe(2);
      // A page image whose graphic is neither the event's nor the club's is refused too.
      await page.evaluate(() => localStorage.setItem("oxygen.editor.clipboard", JSON.stringify({
        v: 1, type: "page", event: "x", object: { id: "img", anchor: "page", kind: "image", graphicId: 987654321, x: 20, y: 20, width: 10, height: 10 },
      })));
      await page.keyboard.press("Control+v");
      await expect(page.getByTestId("editor-error")).toContainText(/graphic/i, { timeout: 10000 });
      expect((await objects()).length).toBe(2);
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
