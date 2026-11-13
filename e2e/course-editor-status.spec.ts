// The editor around the canvas (docs/course-editor.md §2, §3, §6.9): write conflicts between two contexts, the save
// state in the top bar (P2), the map-info dialog (P6), and map exchange (F5).
// Split from the editor's one spec file along its describes (docs/e2e-sharding.md "CI"); the
// helpers they share are `helpers/course-editor-spec.ts`. It runs under the `chromium` project (desktop) only.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`, the fixture import idempotent per test
// (`openEditor` → `ensureCoursesAndMap`), courses a test creates carry a prefix and go with the
// next reseed, controls / objects / sheets it creates are deleted in `finally` (`cleanup`).

import { readFile } from "node:fs/promises";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { analysePdf, arm, cleanup, clickMap, controlRows, desktopContext, drag, editorReady, emptyPoint, freezeExternalPoll, nameIdOf, openEditor, pageToPaperOf, place, probeTemplate, regularCodes, select, selectCompetition, selectedCode, site, sitePoint, toPage, trpcCall, newCourse, statsRow, type Frame } from "./helpers/editor";
import { isTrpcResponse, waitForTrpc } from "./helpers/trpc";
import { type Pt, desktopOnly, act, appendClear, dropSelection, dragTarget } from "./helpers/course-editor-spec";

test.beforeAll(async () => {
  await reseed();
});

test.setTimeout(120_000);

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

    // The button opens the popover: the course's control count and its length (the map scale is the map-info
    // dialog's since P6); a second click closes it.
    const button = top.getByTestId("editor-stats");
    await expect(button).toHaveAttribute("aria-expanded", "false");
    await button.click();
    const popover = page.getByTestId("editor-stats-popover");
    await expect(popover).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    for (const row of ["controls", "length"]) await expect(popover.getByTestId(`editor-stats-${row}`)).toBeVisible();
    await expect(popover.getByTestId("editor-stats-controls")).toHaveAttribute("data-count", "0");
    await expect(popover.getByTestId("editor-stats-scale")).toHaveCount(0);
    await button.click();
    await expect(popover).toHaveCount(0);

    // A placed control counts; an outside click closes the popover too.
    await arm(page, "K");
    await place(page, await emptyPoint(page, 40));
    await page.keyboard.press("Escape");
    await expect.poll(() => statsRow(page, "controls", "count"), { timeout: 15000 }).toBe("1");
    await button.click();
    await expect(popover).toBeVisible();
    // The inspector's bottom-right corner: when the top bar wraps (F27's magnifier at 1280 px) the popover hangs
    // over the inspector's top-left, and a click there would land on the popover.
    const ib = (await page.getByTestId("editor-inspector").boundingBox())!;
    await page.getByTestId("editor-inspector").click({ position: { x: ib.width - 4, y: ib.height - 4 } });
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

  test("on a 1280 × 720 laptop screen the indicator and the button add a dot and an icon to the top bar", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openEditor(page);
    await newCourse(page, "P2 row");
    await expect(page.getByTestId("editor-save-state")).toHaveAttribute("data-state", "saved", { timeout: 15000 });
    // Saved is the dot alone: its words are the title, not on the bar.
    expect((await page.getByTestId("editor-save-state-text").boundingBox())!.width).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("editor-save-state")).toHaveAttribute("title", /\S/);
    // P2's footprint on the row: a dot and an icon button. Whether the row wraps depends on the course names (the
    // picker is as wide as the longest) and presence chips, not on P2.
    expect((await page.getByTestId("editor-save-state").boundingBox())!.width).toBeLessThanOrEqual(16);
    expect((await page.getByTestId("editor-stats").boundingBox())!.width).toBeLessThanOrEqual(32);
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

// P6 (feedback-2026-11-07 item 3): docs/course-editor.md §2. The map footer is gone; its contents and the map scale
// are a dialog behind a map icon in the top bar.
test.describe("P6: the map footer out; the map-info dialog", () => {
  desktopOnly();

  test("no footer under the map; the map icon after Export opens the dialog with the map's rows and actions", async ({ page }) => {
    await openEditor(page);
    const panel = page.getByTestId("editor-page").getByTestId("map-panel");
    await expect(panel.getByTestId("map-viewer")).toBeVisible();
    // Nothing under the map: the viewer reaches the panel's bottom, and none of the footer's actions is in the panel.
    const panelBox = (await panel.boundingBox())!;
    const viewerBox = (await panel.getByTestId("map-viewer").boundingBox())!;
    expect(panelBox.y + panelBox.height - (viewerBox.y + viewerBox.height)).toBeLessThan(4);
    await expect(panel.getByTestId("map-review-link")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Replace map" })).toHaveCount(0);
    await expect(panel.getByTestId("use-club-map")).toHaveCount(0);

    // The icon sits right after Export ▾.
    const icon = page.getByTestId("editor-top-bar").getByTestId("editor-map-info");
    await expect(icon).toHaveAttribute("aria-expanded", "false");
    const afterExport = await page.getByTestId("editor-export").evaluate((exp) => {
      const next = document.querySelector('[data-testid="editor-map-info"]');
      return !!next && !!(exp.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(afterExport).toBe(true);
    await expect(icon.locator("svg")).toBeVisible();

    await icon.click();
    const dialog = page.getByTestId("editor-map-info-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("role", "dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(icon).toHaveAttribute("aria-expanded", "true");
    await expect(dialog.getByTestId("editor-map-info-name")).toHaveText(/\.ocd$/);
    await expect(dialog.getByTestId("editor-map-info-scale")).toHaveAttribute("data-scale", /^\d+$/);
    await expect(dialog.getByTestId("editor-map-info-scale")).toContainText("1:");
    await expect(dialog.getByTestId("editor-map-info-north")).toBeVisible();
    await expect(dialog.getByTestId("editor-map-info-file")).toHaveAttribute("data-bytes", /^[1-9]\d*$/);
    const doc = dialog.getByTestId("editor-map-info-document");
    await expect(doc).toHaveAttribute("data-source", "ocad", { timeout: 30000 });
    expect(Number(await doc.getAttribute("data-objects"))).toBeGreaterThan(0);
    expect(Number(await doc.getAttribute("data-symbols"))).toBeGreaterThan(0);
    await expect(doc.getByTestId("editor-map-info-importer")).toHaveAttribute("data-importer", /^ocad-\d+$/);
    // The actions: Review symbols (the document's review page), Replace map, and the library only when it lists a map.
    await expect(dialog.getByTestId("editor-map-info-review")).toHaveAttribute("href", /\/map-review\/[0-9a-f]{64}$/);
    await expect(dialog.getByTestId("editor-map-info-replace")).toHaveText("Replace map");
    expect(await dialog.getByTestId("editor-map-info-library").count()).toBeLessThanOrEqual(1);
    // A modal: focus starts on the close button and Tab / Shift+Tab cycle inside the dialog.
    const focusInDialog = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="editor-map-info-dialog"]'));
    expect(await focusInDialog()).toBe(true);
    for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
      await page.keyboard.press(key);
      expect(await focusInDialog(), `focus after ${key}`).toBe(true);
    }
    await test.info().attach("map-info-dialog", { body: await page.screenshot(), contentType: "image/png" });

    // The close button closes it; the course-info popover no longer has the scale (it is here).
    await dialog.getByTestId("editor-map-info-close").click();
    await expect(dialog).toHaveCount(0);
    await expect(icon).toHaveAttribute("aria-expanded", "false");
    await page.getByTestId("editor-stats").click();
    await expect(page.getByTestId("editor-stats-popover")).toBeVisible();
    await expect(page.getByTestId("editor-stats-scale")).toHaveCount(0);
    await page.getByTestId("editor-stats").click();

    // The backdrop covers the whole page, the shell's header included (the dialog is portalled out of the top bar's
    // stacking context); a click on it closes the dialog.
    await icon.click();
    await expect(dialog).toBeVisible();
    expect(await page.evaluate(() => document.elementFromPoint(5, 5)?.getAttribute("data-testid"))).toBe("editor-map-info-backdrop");
    await page.mouse.click(5, 5);
    await expect(dialog).toHaveCount(0);
  });

  test("Replace map opens an .ocd file chooser and changes nothing until a file is picked", async ({ page }) => {
    await openEditor(page);
    await page.getByTestId("editor-map-info").click();
    const dialog = page.getByTestId("editor-map-info-dialog");
    const name = await dialog.getByTestId("editor-map-info-name").getAttribute("data-name");
    const chooser = page.waitForEvent("filechooser");
    await dialog.getByTestId("editor-map-info-replace").click();
    const fc = await chooser;
    expect(await fc.element().getAttribute("accept")).toBe(".ocd");
    expect(fc.isMultiple()).toBe(false);
    await expect(dialog.getByTestId("editor-map-info-name")).toHaveAttribute("data-name", name!);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("Escape closes only the dialog: the armed tool and the selection stay; the tools' letters are inert while it is open", async ({ page }) => {
    await openEditor(page);
    await newCourse(page, "P6 escape");
    const dialog = page.getByTestId("editor-map-info-dialog");

    // An armed tool: a letter does not switch it while the dialog is open; Escape closes the dialog, and the
    // editor's cascade (§3) steps only on the next press.
    await arm(page, "K");
    await page.getByTestId("editor-map-info").click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("a");
    await expect(page.getByTestId("editor-tool-K")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("editor-tool-K")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");

    // A selection stays through the dialog's Escape; the course too.
    const [code] = await regularCodes(page, 1);
    await select(page, code);
    await page.getByTestId("editor-map-info").click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(selectedCode(page)).toContainText(code);
    await expect(page.getByTestId("editor-course-picker").locator("option:checked")).toHaveText(/^P6 escape /);
  });

  test("an event with no map: the dialog says so and offers Upload map, no review", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(`E2E Map info no map ${Date.now()}`);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 15000 });
    await page.goto(`/${new URL(page.url()).pathname.split("/")[1]}/course-editor`);
    await expect(page.getByTestId("editor-page")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("editor-map-info").click();
    const dialog = page.getByTestId("editor-map-info-dialog");
    await expect(dialog.getByTestId("editor-map-info-none")).toBeVisible();
    await expect(dialog.getByTestId("editor-map-info-scale")).toHaveCount(0);
    await expect(dialog.getByTestId("editor-map-info-review")).toHaveCount(0);
    await expect(dialog.getByTestId("editor-map-info-replace")).toHaveText("Upload map");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});

// F5 (docs/course-editor.md §6.9): the exchange tool X in the chain, the parts in the sequence, one page per part
// on Export ▾ this course, the derived 13.5 row, and EXCHANGE_WITHOUT_SHEET once a part's sheet is deleted.
test.describe("F5: map exchange (docs/course-editor.md §6.9)", () => {
  desktopOnly();

  test("X between two controls: two parts, two pages with different windows, 13.5; deleting part 2's sheet raises the check", async ({ page }) => {
    await openEditor(page);
    const name = await newCourse(page, "F5 exchange");
    const a = await appendClear(page);
    const b = await appendClear(page, [a]);
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    const courses = await trpcCall<{ id: number; name: string }[]>("course.list", undefined, false);
    const courseId = courses.find((c) => c.name === name)!.id;

    // X after a: the ghost is the next number and code, as K's; the click inserts an exchange between a and b.
    await select(page, a);
    await arm(page, "X");
    const spot = await emptyPoint(page, 40);
    await page.mouse.move(spot.x, spot.y);
    await expect(page.getByTestId("editor-ghost-label")).toHaveText(/^2 · \d+$/, { timeout: 10000 });
    const saved = waitForTrpc(page, "course.setStructure");
    const x = await place(page, spot);
    await saved;
    // The chain stays armed (X is a control in it); V ends it.
    await expect(page.getByTestId("editor-tool-X")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("v");
    await expect(controlRows(page)).toHaveCount(3, { timeout: 15000 });
    await expect(controlRows(page).nth(1)).toHaveAttribute("data-exchange", "true");
    await expect(controlRows(page).nth(1)).toHaveAttribute("data-control-id", x.id);
    const parts = page.getByTestId("editor-seq-part");
    await expect(parts).toHaveCount(2);
    await expect(parts.nth(1)).toHaveAttribute("data-part", "2");
    // Numbering continues: the exchange is 2, b is 3 (answer 2).
    await expect(page.locator(`[data-testid="course-label"][data-site-id="${x.id}"]`)).toHaveAttribute("data-text", "2", { timeout: 15000 });
    await expect(page.getByTestId("description-sheet").locator('[data-testid="desc-row-wide"][data-symbol-key="13.5"]')).toHaveCount(1, { timeout: 15000 });

    // Export ▾ this course: the part sheets are created first, then one page per part.
    await page.getByTestId("editor-export").click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("editor-export-course").click()]);
    expect((await analysePdf(await readFile((await download.path())!))).pages).toBe(2);
    type Listed = { seq: number; courseId: number | null; class: unknown; sectionIndex: number; resolved: { window: { minX: number; minY: number; width: number; height: number } } | null };
    const own = (await trpcCall<Listed[]>("courseMap.list", undefined, false)).filter((s) => s.courseId === courseId && s.class === null);
    expect(own.map((s) => s.sectionIndex)).toEqual([0, 1]);
    const centre = (s: Listed) => ({ x: s.resolved!.window.minX + s.resolved!.window.width / 2, y: s.resolved!.window.minY + s.resolved!.window.height / 2 });
    const [c1, c2] = own.map(centre);
    expect(Math.hypot(c1.x - c2.x, c1.y - c2.y)).toBeGreaterThan(1);

    // Layout mode lists the parts; part 2's sheet deleted → the check in Course mode.
    await page.getByTestId("editor-mode-layout").click();
    await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(own[0].seq), { timeout: 30_000 });
    await page.getByTestId("editor-layout-sheet-picker").selectOption(String(own[1].seq));
    await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-section", "1", { timeout: 30_000 });
    page.once("dialog", (d) => void d.accept());
    const deleted = waitForTrpc(page, "courseMap.delete");
    await page.getByTestId("editor-layout-delete-sheet").click();
    await deleted;
    await page.getByTestId("editor-mode-course").click();
    await page.getByTestId("editor-checks-toggle").click();
    const row = page.locator('[data-testid="editor-check-row"][data-code="EXCHANGE_WITHOUT_SHEET"]');
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText("Part 2");
  });
});
