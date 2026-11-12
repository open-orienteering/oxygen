// Placing (docs/course-editor.md §4, §6): the circles while placing (P1, P4), the pending leg (P5), crossing and
// map-issue points (F4), and the placement loupe (F27).
// Split from the editor's one spec file along its describes (docs/e2e-sharding.md "CI"); the
// helpers they share are `helpers/course-editor-spec.ts`. It runs under the `chromium` project (desktop) only.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`, the fixture import idempotent per test
// (`openEditor` → `ensureCoursesAndMap`), courses a test creates carry a prefix and go with the
// next reseed, controls / objects / sheets it creates are deleted in `finally` (`cleanup`).

import { expect, test, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { allControlsSheet, arm, canvasInCircle, cleanup, clickMap, controlRows, dragHold, editorReady, emptyPoint, inkIn, legBetween, legMidpoint, legPieces, nameIdOf, openEditor, pageToPaperOf, place, placeOneShot, printed, probeTemplate, regularCodes, site, sitePoint, sites, toolShapes, toPage, toPaper, trpcCall, viewCentre, viewSettled, newCourse, nextFrames, type Frame, type Site } from "./helpers/editor";
import { waitForTrpc } from "./helpers/trpc";
import { type Pt, desktopOnly, appendClear, dropSelection, dragTarget } from "./helpers/course-editor-spec";

test.beforeAll(async () => {
  await reseed();
});

test.setTimeout(120_000);

// P1 (feedback-2026-11-06 items 1 and 2): its own describe, so the parallel rows' edits above merge cleanly.
test.describe("P1: no blue circle on placing; the toner saver covers everything outside it", () => {
  desktopOnly();

  test("no blue circle beside a placed control while K is armed, in Layout and Field (D12)", async ({ page }) => {
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
      await expect(page.getByTestId("editor-ghost-label")).toBeAttached({ timeout: 10000 });
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
      // V's Add control: the P4 describe (the ring is back there, feedback 2026-11-07 item 1).
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

// P5 (feedback-2026-11-07 item 2): its own describe, so the parallel rows' edits above merge cleanly.
test.describe("P5: the pending leg from a just-placed start", () => {
  desktopOnly();
  // A start placed with `S` has no code, so its public id is its seq (`publicControlId`). After the rest of this
  // file has created controls the event's seq reaches the seed's punch codes (80 in a full run), and the new start
  // then shares its id with control 80: the mirror sees no new site and the course reads the start as 80. A
  // reseed puts the seq back at the seed's. The collision itself is a server issue outside P5
  // (docs/bugfix-first-leg-from-start.md, "Found on the way").
  test.beforeAll(async () => {
    await reseed();
  });

  const near = (p: Pt | undefined, q: Pt, mm: number) => !!p && Math.hypot(p.x - q.x, p.y - q.y) < mm;
  /**
   * A drawn leg of the course from (the rim of) `from` to (the rim of) `to`: 7 mm covers a start triangle, 4 mm a
   * circle. A leg passing another circle or a boulder is cut into several pieces (course-layer.md §3.2, §3.4), so the
   * pieces are grouped by `data-leg`: the first piece starts at `from`, the last ends at `to`.
   */
  const legFrom = async (page: Page, course: string, from: Pt, to: Pt) => {
    const pieces = await legPieces(page, course);
    return [...new Set(pieces.map((l) => l.leg))].some((leg) => {
      const ps = pieces.filter((l) => l.leg === leg);
      return near(ps[0].points[0], from, 7) && near(ps[ps.length - 1].points.at(-1), to, 4);
    });
  };

  test("S places a start and arms K; the hover draws the leg from the start with its length, and the click keeps it", async ({ page }) => {
    await openEditor(page);
    const name = await newCourse(page, "P5 start");
    const made: string[] = [];
    try {
      // A fresh course has no controls and no explicit start: the event's default start already joins the hover.
      const startId = (await page.locator('[data-testid="editor-seq-row"][data-kind="start"]').getAttribute("data-control-id"))!;
      const defaultStart = (await sites(page)).find((s) => s.id === startId)!.mm;
      await arm(page, "K");
      const h = await emptyPoint(page, 60);
      await page.mouse.move(h.x, h.y);
      await expect(page.getByTestId("editor-leg-length")).toHaveText(/^\d+ m$/, { timeout: 10000 });
      const hPaper = await toPaper(page, h);
      await expect.poll(() => legFrom(page, name, defaultStart, hPaper), { timeout: 15000 }).toBe(true);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");

      // S: a new start, the course's own; the tool goes on to K (§6.1).
      await arm(page, "S");
      const a = await emptyPoint(page, 60);
      const wrote = waitForTrpc(page, "course.setStructure");
      const start = await place(page, a);
      await wrote;
      made.push(start.id);
      expect(start.type).toBe("Start");
      await expect(page.getByTestId("editor-tool-K")).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator('[data-testid="editor-seq-row"][data-kind="start"]')).toHaveAttribute("data-control-id", start.id, { timeout: 15000 });
      await expect(controlRows(page)).toHaveCount(0);

      // The hover: the length label and the layer's pending leg from the new start to the cursor (the reported bug:
      // the label showed, the line did not).
      const b = await emptyPoint(page, 60, [a]);
      await page.mouse.move(b.x, b.y);
      await expect(page.getByTestId("editor-leg-length")).toHaveText(/^\d+ m$/, { timeout: 10000 });
      const cursor = await toPaper(page, b);
      await expect.poll(() => legFrom(page, name, start.mm, cursor), { timeout: 15000 }).toBe(true);

      // The click: the control joins the course and the stored leg start → 1 stays once the tool is put away.
      const ctl = await place(page, b);
      made.push(ctl.id);
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-leg-length")).toHaveCount(0);
      await expect.poll(() => legFrom(page, name, start.mm, ctl.mm), { timeout: 15000 }).toBe(true);
    } finally {
      for (const id of made) await cleanup("control.delete", { id: Number(id) });
    }
  });
});

// docs/course-editor.md §4, §6.1 (P4, feedback 2026-11-07 item 1; corrects P1): the thin circle the user saw beside
// the purple one was the armed tool's UI-layer ghost circle, concentric with the layer's provisional circle. It is
// drawn only where the layer draws no provisional visit (no course, a reuse); V's dashed ring is back on a control
// placed from the phantom's Add control.
test.describe("P4: the dashed ring back after placing; the ghost circle only without a provisional visit", () => {
  desktopOnly();

  test("K armed: no ghost circle over the layer's provisional one, the label stays; V's Add control has the ring and the action bar", async ({ page }) => {
    await openEditor(page);
    const ghost = page.getByTestId("editor-ghost");
    const label = page.getByTestId("editor-ghost-label");
    const ring = page.getByTestId("editor-selection-ring");
    const made: string[] = [];
    try {
      // No course: the layer draws no provisional visit, so the UI layer's circle is the only mark.
      await page.getByTestId("editor-course-picker").selectOption("");
      await arm(page, "K");
      const loose = await emptyPoint(page, 60);
      await page.mouse.move(loose.x, loose.y);
      await expect(label).toBeAttached({ timeout: 10000 });
      await expect(ghost).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");

      // A course: the layer's provisional circle is the one circle; no ring, no action bar while armed (D12).
      await newCourse(page, "P4 ring");
      await arm(page, "K");
      const a = await emptyPoint(page, 60);
      await page.mouse.move(a.x, a.y);
      await expect(label).toHaveText(/^1 · \d+$/, { timeout: 10000 });
      await expect(ghost).toHaveCount(0);
      await expect(ring).toHaveCount(0);
      await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
      const first = await place(page, a);
      made.push(first.id);
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
      const b = await emptyPoint(page, 60, [a]);
      await page.mouse.move(b.x, b.y);
      await expect(label).toHaveText(/^2 · \d+$/, { timeout: 10000 });
      await expect(ghost).toHaveCount(0);
      await expect(ring).toHaveCount(0);

      // Over an existing control the layer splices that site and adds none: the ghost circle sits on it.
      const [code] = await regularCodes(page, 1, [first.code]);
      const over = await sitePoint(page, code);
      await page.mouse.move(over.x, over.y);
      await expect(label).toHaveText(`Add ${code}`, { timeout: 10000 });
      await expect(ghost).toHaveCount(1);

      // V: Add control selects the new control with its dashed ring and the action bar.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
      await dropSelection(page);
      const added = await placeOneShot(page);
      made.push((await site(page, added)).id);
      await expect(ring).toHaveCount(1, { timeout: 10000 });
      await expect(page.getByTestId("editor-action-bar")).toBeVisible();
      await expect(ghost).toHaveCount(0);
    } finally {
      for (const id of made) await cleanup("control.delete", { id: Number(id) });
    }
  });
});

// F4 (docs/course-editor.md §6.8): the crossing tool C on a selected leg, the derived 13.3 / 13.4 rows, the map-issue
// point only in setter views. Its own describe, so the parallel rows' edits above merge cleanly.
test.describe("F4: crossing and map-issue points (docs/course-editor.md §6.8)", () => {
  desktopOnly();

  async function twoControlCourse(page: Page, prefix: string): Promise<{ name: string; a: Site; b: Site }> {
    await openEditor(page);
    const name = await newCourse(page, prefix);
    const a = await appendClear(page);
    const b = await appendClear(page, [a]);
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    return { name, a: await site(page, a), b: await site(page, b) };
  }

  /** Click the leg a → b at `at` (paper mm, on the leg) until the Leg section shows. */
  async function selectLegAt(page: Page, at: Pt): Promise<void> {
    await viewSettled(page);
    await expect(async () => {
      await dropSelection(page);
      await clickMap(page, await toPage(page, at));
      await expect(page.getByTestId("editor-leg")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });
  }

  const wideRows = (page: Page, key: string) => page.getByTestId("description-sheet").locator(`[data-testid="desc-row-wide"][data-symbol-key="${key}"]`);

  test("C on a selected leg: a 710 site the leg bends through, 13.3 on the sheet; a section is 13.4; undo removes both", async ({ page }) => {
    const { name, a, b } = await twoControlCourse(page, "F4 crossing");
    await legMidpoint(page, name, a.mm, b.mm);
    // A third of the way along the leg: the leg's midpoint stays clear of the new site for the second click.
    const along = (t: number): Pt => ({ x: a.mm.x + (b.mm.x - a.mm.x) * t, y: a.mm.y + (b.mm.y - a.mm.y) * t });
    await selectLegAt(page, along(0.5));
    await expect(page.getByTestId("editor-leg-crossing-none")).toBeVisible();

    await page.keyboard.press("c");
    await expect(page.getByTestId("editor-tool-C")).toHaveAttribute("aria-pressed", "true");
    const target = await toPage(page, along(0.35));
    await page.mouse.move(target.x, target.y);
    await expect.poll(async () => (await toolShapes(page, "editor-ghost"))[0]?.data.role ?? null, { timeout: 10000 }).toBe("crossing_point");
    const routed = waitForTrpc(page, "course.setStructure");
    await clickMap(page, target);
    await routed;
    // One crossing per leg: the tool hands back to V.
    await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");

    const crossing = page.locator('[data-testid="course-site"][data-role="crossing_point"]');
    await expect(crossing).toHaveCount(1, { timeout: 15000 });
    const p = { x: Number(await crossing.getAttribute("data-x")), y: Number(await crossing.getAttribute("data-y")) };
    // Turned along the leg: the chord a → b (the site sits on the straight leg).
    const legDeg = (Math.atan2(b.mm.y - a.mm.y, b.mm.x - a.mm.x) * 180) / Math.PI;
    // (The site draws north–south first, as an unreferenced one, until the course list carries the route.)
    await expect.poll(async () => Math.abs(Number(await crossing.getAttribute("data-angle")) - legDeg), { timeout: 15000 }).toBeLessThan(0.5);
    // The leg runs through it: a vertex of its drawn piece at the site.
    await expect.poll(async () => (await legBetween(page, name, a.mm, b.mm)).some((piece) => piece.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 0.3)), { timeout: 15000 }).toBe(true);
    await expect(wideRows(page, "13.3")).toHaveCount(1, { timeout: 15000 });

    // The Leg section names it; the section form turns the row into 13.4 (one more write).
    await selectLegAt(page, along(0.65));
    await expect(page.getByTestId("editor-leg-crossing-code")).toBeVisible();
    const sectioned = waitForTrpc(page, "course.setStructure");
    // The box shows the stored value, so it flips once the write is back (a click, not `check()`).
    await page.getByTestId("editor-leg-crossing-section").click();
    await sectioned;
    await expect(page.getByTestId("editor-leg-crossing-section")).toBeChecked({ timeout: 15000 });
    await expect(wideRows(page, "13.4")).toHaveCount(1, { timeout: 15000 });
    await expect(wideRows(page, "13.3")).toHaveCount(0);
    await expect(crossing).toHaveAttribute("data-section", "true", { timeout: 15000 });

    // Undo: the section, then the crossing (site and route in one entry). The page owns the keys: out of the checkbox first.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Control+z");
    await expect(wideRows(page, "13.3")).toHaveCount(1, { timeout: 15000 });
    await page.keyboard.press("Control+z");
    await expect(crossing).toHaveCount(0, { timeout: 15000 });
    await expect(wideRows(page, "13.3")).toHaveCount(0);
  });

  test("Add map-issue point: drawn in Course view, absent from the course's print, present on the all-controls print", async ({ page }) => {
    const { name } = await twoControlCourse(page, "F4 map issue");
    const nameId = nameIdOf(page);
    const courses = await trpcCall<{ id: number; name: string }[]>("course.list", undefined, false);
    const courseId = courses.find((c) => c.name === name)!.id;
    const template = await probeTemplate("F4 map issue");
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId, templateId: template.seq, overrides: {}, objects: [] });
    const all = await allControlsSheet();
    let created: number | null = null;
    try {
      const courseBefore = await printed(page, nameId, `maps=${sheet.seq}`);
      const allBefore = await printed(page, nameId, "allControls=1");

      await viewSettled(page);
      const spot = await emptyPoint(page);
      await dropSelection(page);
      await clickMap(page, spot);
      const made = waitForTrpc(page, "control.create");
      await page.getByTestId("editor-action-bar").getByTestId("editor-action-add-map-issue").click();
      await made;
      await expect(page.locator('[data-testid="course-site"][data-role="map_issue"]')).toHaveCount(1, { timeout: 15000 });
      const list = await trpcCall<{ id: number; kind: string }[]>("control.list", undefined, false);
      created = Math.max(...list.filter((c) => c.kind === "map_issue").map((c) => c.id));
      // Its action bar is Delete only.
      await expect(page.getByTestId("editor-selected-kind")).toHaveValue("map_issue", { timeout: 15000 });

      // 702 renders only in setter views (08 §4.2): the course sheet is unchanged, the all-controls sheet has its bar.
      expect((await printed(page, nameId, `maps=${sheet.seq}`)).strokes).toBe(courseBefore.strokes);
      expect((await printed(page, nameId, "allControls=1")).strokes).toBeGreaterThan(allBefore.strokes);
    } finally {
      if (created !== null) await cleanup("control.delete", { id: created });
      await all.drop();
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
    }
  });
});

// F27 (§6 key table, §10 "Loupe"; user 2026-11-11, feedback-2026-11-11.md): the placement loupe toggle — a top-bar
// magnifier and `L`. On, with a placing tool armed, the loupe magnifies the point a click would place (the
// provisional point: a reused site's centre over a control), 16 px above the cursor; a left drag still pans and places
// nothing, a click still places; gone on leaving the map, on disarm, on toggle off; remembered across a reload.
test.describe("F27: the placement loupe toggle (docs/course-editor.md §6, §10 \"Loupe\")", () => {
  desktopOnly();

  test("K armed: on → the loupe at the hover over the point a click places; a drag pans and places nothing; off → none; remembered", async ({ page }) => {
    await openEditor(page);
    await newCourse(page, "F27 loupe");
    const toggle = page.getByTestId("editor-placement-loupe");
    const loupe = page.getByTestId("editor-loupe");
    const writes: string[] = [];
    // Every control or course write (a placement is `control.create` + `course.setStructure`); not the presence heartbeat.
    page.on("request", (r) => { if (r.method() === "POST" && /\/trpc\/[^?]*\b(control|course)\.(?!presence)/.test(r.url())) writes.push(r.url()); });
    /** The hover loupe: the mouse's, 120 px, its bottom 16 px above `cursor` (top 16 px below at the map's top), centred over it within the box. */
    const hoverLoupeAt = async (cursor: Pt) => {
      await expect(loupe).toBeVisible();
      await expect(loupe).toHaveAttribute("data-mode", "hover");
      await expect(loupe).toHaveAttribute("data-pointer", "mouse");
      await expect(loupe).toHaveAttribute("data-scale", "2.5");
      const lb = (await loupe.boundingBox())!;
      const vb = (await page.getByTestId("map-viewer").boundingBox())!;
      expect(Math.abs(lb.width - 120)).toBeLessThanOrEqual(1);
      // 1.5 px: the loupe follows `mousemove`'s clientX / clientY, whole CSS px in Chrome, while `cursor` and the
      // viewer's box are fractional — up to 1 px apart before the box's own rounding (F29 moved the viewer and met it).
      const tol = 1.5;
      if (cursor.y - vb.y - 16 - 120 < 0) expect(Math.abs(lb.y - (cursor.y + 16))).toBeLessThanOrEqual(tol);
      else expect(Math.abs(lb.y + lb.height - (cursor.y - 16))).toBeLessThanOrEqual(tol);
      const cx = Math.min(Math.max(cursor.x, vb.x + 64), vb.x + vb.width - 64);
      expect(Math.abs(lb.x + lb.width / 2 - cx)).toBeLessThanOrEqual(tol);
      return lb;
    };
    const loupePoint = async (): Promise<Pt> => ({ x: Number(await loupe.getAttribute("data-x")), y: Number(await loupe.getAttribute("data-y")) });

    // Off by default: K armed, a hover shows the ghost and no loupe.
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await arm(page, "K");
    const p = await emptyPoint(page);
    await page.mouse.move(p.x, p.y, { steps: 2 });
    await expect(page.getByTestId("editor-ghost-label")).toBeAttached({ timeout: 10000 });
    await expect(loupe).toHaveCount(0);

    // The magnifier turns it on (stored per browser); back over the map the loupe hangs above the cursor.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => localStorage.getItem("oxygen.editor.placementLoupe"))).toBe("true");
    await expect(page.getByTestId("editor-tool-K")).toHaveAttribute("aria-pressed", "true");
    await page.mouse.move(p.x, p.y, { steps: 2 });
    const lb = await hoverLoupeAt(p);
    // The GL inset: the map magnified (the provisional visit's purple in it) — differs from the same circle at 1×.
    await nextFrames(page);
    await expect.poll(async () => (await canvasInCircle(page, lb, 4, true)).purple, { timeout: 15000 }).toBeGreaterThan(0);
    const magnified = await canvasInCircle(page, lb, 4, true);

    // `L` toggles it: off → gone with the pointer still; the 1× circle differs; on → back at once, no move needed.
    await page.keyboard.press("l");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(loupe).toHaveCount(0);
    await nextFrames(page);
    const plain = await canvasInCircle(page, lb, 4, true);
    expect(plain.rgb.length).toBe(magnified.rgb.length);
    let differing = 0;
    for (let i = 0; i < plain.rgb.length; i += 3) {
      if (Math.abs(plain.rgb[i] - magnified.rgb[i]) + Math.abs(plain.rgb[i + 1] - magnified.rgb[i + 1]) + Math.abs(plain.rgb[i + 2] - magnified.rgb[i + 2]) > 60) differing++;
    }
    expect(differing / (plain.rgb.length / 3), "the loupe is the magnified map, not the 1× one").toBeGreaterThan(0.1);
    await page.keyboard.press("l");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await hoverLoupeAt(p);

    // A left drag pans and places nothing (§6.1 "Drag pans"; answer 1); the loupe follows the cursor.
    const sent = writes.length;
    const count = (await sites(page)).length;
    const centre = await viewCentre(page);
    const to = { x: p.x - 60, y: p.y + 40 };
    await dragHold(page, p, to);
    await hoverLoupeAt(to);
    await page.mouse.up();
    await expect.poll(async () => JSON.stringify(await viewCentre(page))).not.toBe(JSON.stringify(centre));
    await page.waitForTimeout(500);
    expect(writes.length, "a drag with K armed writes nothing").toBe(sent);
    expect((await sites(page)).length).toBe(count);

    // A click still places (one site), with the loupe on.
    await viewSettled(page);
    const placed = await place(page, await emptyPoint(page));
    expect((await sites(page)).length).toBe(count + 1);

    // Over an existing control the click reuses it: the loupe magnifies the site's centre, not the raw cursor.
    await viewSettled(page);
    const [code] = await regularCodes(page, 1, [placed.code]);
    const sp = await sitePoint(page, code);
    const off = { x: sp.x + 3, y: sp.y + 2 };
    await page.mouse.move(off.x, off.y, { steps: 2 });
    await expect(page.getByTestId("editor-ghost-label")).toHaveText(`Add ${code}`, { timeout: 10000 });
    await hoverLoupeAt(off);
    const centreOf = (await site(page, code)).mm;
    await expect.poll(async () => { const q = await loupePoint(); return Math.hypot(q.x - centreOf.x, q.y - centreOf.y); }).toBeLessThan(0.01);
    const raw = await toPaper(page, off);
    expect(Math.hypot(raw.x - centreOf.x, raw.y - centreOf.y), "the cursor is off the centre").toBeGreaterThan(0.1);

    // Gone when the pointer leaves the map.
    const vb = (await page.getByTestId("map-viewer").boundingBox())!;
    await page.mouse.move(vb.x + vb.width + 20, off.y, { steps: 2 });
    await expect(loupe).toHaveCount(0);

    // T (map text) is a placing tool too; V is not (disarmed: no loupe on a hover).
    await page.keyboard.press("Escape");
    await arm(page, "T");
    const q = await emptyPoint(page);
    await page.mouse.move(q.x, q.y, { steps: 2 });
    await hoverLoupeAt(q);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
    await page.mouse.move(q.x + 5, q.y + 5, { steps: 2 });
    await expect(loupe).toHaveCount(0);

    // Remembered: after a reload the toggle is on and K's hover shows the loupe.
    await page.reload();
    await editorReady(page);
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await arm(page, "K");
    const r = await emptyPoint(page);
    await page.mouse.move(r.x, r.y, { steps: 2 });
    await hoverLoupeAt(r);
    // Off (the button): none on a hover.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.mouse.move(r.x + 4, r.y + 4, { steps: 2 });
    await expect(page.getByTestId("editor-ghost-label")).toBeAttached({ timeout: 10000 });
    await expect(loupe).toHaveCount(0);
  });

  test("a mouse drag keeps F24's loupe with the toggle on", async ({ page }) => {
    await openEditor(page);
    await newCourse(page, "F27 drag");
    await page.getByTestId("editor-placement-loupe").click();
    await expect(page.getByTestId("editor-placement-loupe")).toHaveAttribute("aria-pressed", "true");
    await viewSettled(page);
    const [code] = await regularCodes(page, 1);
    const from = await sitePoint(page, code);
    const to = await dragTarget(page, from);
    await dragHold(page, from, to);
    const loupe = page.getByTestId("editor-loupe");
    await expect(loupe).toHaveAttribute("data-mode", "drag");
    await expect(loupe).toHaveAttribute("data-pointer", "mouse");
    // Escape cancels the drag (F24): the loupe goes, nothing is written.
    await page.keyboard.press("Escape");
    await expect(loupe).toHaveCount(0);
    await page.mouse.up();
  });
});
