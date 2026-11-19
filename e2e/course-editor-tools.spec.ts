// The editor's tools (docs/course-editor.md §6–§7): the tool chain, its keys and modifiers, the filter symbol picker.
// Split from the editor's one spec file along its describes (docs/e2e-sharding.md "CI"); the
// helpers they share are `helpers/course-editor-spec.ts`. It runs under the `chromium` project (desktop) only.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`, the fixture import idempotent per test
// (`openEditor` → `ensureCoursesAndMap`), courses a test creates carry a prefix and go with the
// next reseed, controls / objects / sheets it creates are deleted in `finally` (`cleanup`).

import { expect, test } from "@playwright/test";
import { PNG } from "pngjs";
import { reseed } from "./helpers/reseed";
import { allControlsSheet, arm, cleanup, clickMap, controlRows, coveredBy, drag, dragHold, dragMm, editorReady, emptyPoint, geometryOf, inkIn, legMidpoint, legPieces, nameIdOf, objectRow, openEditor, place, pressInside, pressOnEdge, printed, probeTemplate, regularCodes, select, selectedCode, siteCuts, site, sitePoint, sites, toolShapes, toPage, toPaper, trpcCall, newCourse, mapScale, type Site } from "./helpers/editor";
import { waitForTrpc } from "./helpers/trpc";
import { type Pt, desktopOnly, dropSelection, dragTarget } from "./helpers/course-editor-spec";

test.beforeAll(async () => {
  await reseed();
});

test.setTimeout(120_000);

// docs/course-editor.md §6–§7 (D5, D12–D16): the tools.
test.describe("tools", () => {
  desktopOnly();

  test("ten controls in ten clicks with the armed K tool; Ctrl+Z steps back; Esc returns to V", async ({ page }) => {
    await openEditor(page);
    await newCourse(page, "D5 K");
    const before = (await sites(page)).length;

    await arm(page, "K");
    // The ghost: the next number and code (the layer draws its circle, P4); the pending leg from the start, its
    // length at the pointer.
    const first = await emptyPoint(page, 40);
    await page.mouse.move(first.x, first.y);
    await expect(page.getByTestId("editor-ghost-label")).toBeAttached({ timeout: 10000 });
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
    await expect(page.getByTestId("editor-ghost-label")).toHaveCount(0);
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
      await expect(page.getByTestId("editor-ghost-label")).toBeAttached({ timeout: 10000 });
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
    await expect(page.getByTestId("editor-ghost-label")).toHaveCount(0);
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
    // Alt held: corners (F18, docs/course-editor.md §6.4), so the stored edges are the chords `pressOnEdge` probes.
    await page.keyboard.down("Alt");
    for (const p of corners) await page.mouse.click(p.x, p.y);
    await expect(page.getByTestId("editor-polygon-vertex")).toHaveCount(3);
    const created = waitForTrpc(page, "courseObject.create");
    await page.mouse.click(a.x, a.y); // the first vertex closes
    await page.keyboard.up("Alt");
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
      // a and b with Alt held: corners (F18), so a → b stays a straight edge.
      await page.keyboard.down("Alt");
      await page.mouse.click(a.x, a.y);
      await page.mouse.click(b.x, b.y);
      await page.keyboard.up("Alt");
      // Click-drag: a curve vertex at c, its handles pulled out along the drag (docs/course-editor.md §6.4).
      const pullTo = { x: c.x - 25, y: c.y + 10 };
      await drag(page, c, pullTo);
      await expect(page.getByTestId("editor-polygon-vertex")).toHaveCount(3);
      await expect(page.getByTestId("editor-polygon-grip")).toHaveCount(2);
      const created = waitForTrpc(page, "courseObject.create");
      await page.mouse.click(a.x, a.y); // the first vertex closes (a keeps its press's kind: a corner)
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

      // Insert: a double-click on the straight edge a → b inserts a smooth vertex (§7 "Editing geometry", F18).
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
      // Its handles from its neighbours, (b − a) / 6: collinear with the edge, so the shape is unchanged.
      expect(added.hOut!.x).toBeCloseTo((mb.x - ma.x) / 6, 0);
      expect(added.hOut!.y).toBeCloseTo((mb.y - ma.y) / 6, 0);
      expect(added.hIn!.x).toBeCloseTo(-added.hOut!.x, 6);
      expect(added.hIn!.y).toBeCloseTo(-added.hOut!.y, 6);
      await expect(page.getByTestId("editor-object-grip")).toHaveCount(4);

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

      // Alt-click on the corner b makes it smooth (two more grips); Alt-click again makes it a corner (F18).
      await expect(page.getByTestId("editor-object-grip")).toHaveCount(4);
      const bAt = await toPage(page, (await stored())[2]);
      const smoothed = waitForTrpc(page, "courseObject.update");
      await page.keyboard.down("Alt");
      await page.mouse.click(bAt.x, bAt.y);
      await page.keyboard.up("Alt");
      await smoothed;
      await expect(page.getByTestId("editor-object-grip")).toHaveCount(6);
      await expect.poll(async () => (await stored())[2].hOut !== undefined, { timeout: 15000 }).toBe(true);
      const cornered = waitForTrpc(page, "courseObject.update");
      await page.keyboard.down("Alt");
      await page.mouse.click(bAt.x, bAt.y);
      await page.keyboard.up("Alt");
      await cornered;
      await expect(page.getByTestId("editor-object-grip")).toHaveCount(4);
      await expect.poll(async () => (await stored())[2].hOut, { timeout: 15000 }).toBeUndefined();

      await page.getByTestId("editor-object-delete").click();
      await expect(row).toHaveCount(0, { timeout: 15000 });
    } finally {
      await drop();
    }
  });

  test("A: plain clicks place smooth vertices, Alt at the third a corner; handles a sixth of the neighbours' chord, wrapped at close; one undo removes it", async ({ page }) => {
    await openEditor(page);
    await page.getByTestId("editor-tool-A").click();
    await page.getByTestId("editor-area-whiteout").click();
    const clear = await emptyPoint(page, 40);
    const a = { x: clear.x - 30, y: clear.y - 15 }, b = { x: a.x + 60, y: a.y }, c = { x: a.x + 60, y: a.y + 40 };
    // Smooth by default (F18, docs/course-editor.md §6.4): b has no next vertex yet, so no handles in the state.
    await page.mouse.click(a.x, a.y);
    await page.mouse.click(b.x, b.y);
    await expect(page.getByTestId("editor-polygon-vertex")).toHaveCount(2);
    await expect(page.getByTestId("editor-polygon-grip")).toHaveCount(0);
    // The next vertex lands (Alt held: a corner): b's handles follow its neighbours.
    await page.keyboard.down("Alt");
    await page.mouse.click(c.x, c.y);
    await page.keyboard.up("Alt");
    await expect(page.getByTestId("editor-polygon-grip")).toHaveCount(2);
    const created = waitForTrpc(page, "courseObject.create");
    await page.mouse.click(a.x, a.y); // the first vertex closes; a, smooth, wraps
    await created;
    await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-kind", "whiteout", { timeout: 15000 });
    const id = (await page.getByTestId("editor-object").getAttribute("data-object-id"))!;
    const row = objectRow(page, id);
    await expect(row).toHaveCount(1, { timeout: 15000 });
    const g = JSON.parse((await row.getAttribute("data-geometry-json")) ?? "[]") as { x: number; y: number; hIn?: Pt; hOut?: Pt }[];
    expect(g).toHaveLength(3);
    // Uniform Catmull-Rom: hOut = (next − prev) / 6, hIn its negation; the ring wraps at g0; the Alt corner keeps none;
    // no drawing flag stored.
    expect(g[1].hOut!.x).toBeCloseTo((g[2].x - g[0].x) / 6, 3);
    expect(g[1].hOut!.y).toBeCloseTo((g[2].y - g[0].y) / 6, 3);
    expect(g[1].hIn).toEqual({ x: -g[1].hOut!.x, y: -g[1].hOut!.y });
    expect(g[0].hOut!.x).toBeCloseTo((g[1].x - g[2].x) / 6, 3);
    expect(g[0].hOut!.y).toBeCloseTo((g[1].y - g[2].y) / 6, 3);
    expect(g[2].hIn ?? g[2].hOut).toBeUndefined();
    expect(g.some((v) => "smooth" in v || "corner" in v || "pulled" in v)).toBe(false);
    // The chord on screen agrees (paper mm of the clicks).
    const [pa, pc] = await Promise.all([toPaper(page, a), toPaper(page, c)]);
    expect(g[1].hOut!.x).toBeCloseTo((pc.x - pa.x) / 6, 0);
    expect(g[1].hOut!.y).toBeCloseTo((pc.y - pa.y) / 6, 0);
    await expect(page.getByTestId("editor-object-grip")).toHaveCount(4);
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

// docs/course-editor.md §5, §6, §7 (J7): the image tool, an image's hit rule and gestures, the style fields.
test.describe("I: image tool and style fields", () => {
  desktopOnly();

  test("I places a picked graphic at 30 mm; inside it a drag pans and a click selects; body and corner drags; style fields write", async ({ page }) => {
    test.setTimeout(180_000);
    // A 16 × 8 opaque PNG uploaded to the event.
    const png = new PNG({ width: 16, height: 8 });
    for (let i = 0; i < 128; i++) png.data.set([0, 160, 160, 255], i * 4);
    const { id: graphicId } = await trpcCall<{ id: number }>("graphics.upload", { name: `e2e-j7-${Date.now()}.png`, scope: "event", fileDataBase64: PNG.sync.write(png).toString("base64") });
    let objectId: string | null = null;
    try {
      await openEditor(page);
      const sheetToggle = page.getByTestId("map-toggle-descriptions");
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();

      // I: the tool is lit, the picker opens with its hint; nothing is placed before a graphic is picked.
      await page.keyboard.press("i");
      await expect(page.getByTestId("editor-tool-I")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-image-picker")).toBeVisible();
      await expect(page.getByTestId("editor-image-hint")).toBeVisible();
      await page.getByTestId(`editor-graphic-place-${graphicId}`).click();
      await expect(page.getByTestId("editor-image-hint")).toHaveCount(0);

      const clear = await emptyPoint(page, 80);
      await page.mouse.move(clear.x, clear.y);
      await expect(page.getByTestId("editor-image-ghost")).toBeAttached();
      const created = waitForTrpc(page, "courseObject.create");
      await page.mouse.click(clear.x, clear.y);
      await created;
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-kind", "image", { timeout: 15000 });
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-image-picker")).toHaveCount(0);
      objectId = (await page.getByTestId("editor-object").getAttribute("data-object-id"))!;
      const row = objectRow(page, objectId);
      await expect(row).toBeAttached({ timeout: 15000 });
      const placed = await geometryOf(row);
      expect(Math.abs(placed[1].x - placed[0].x)).toBeCloseTo(30, 1);
      expect(Math.abs(placed[1].y - placed[0].y)).toBeCloseTo(15, 1);
      await expect(page.getByTestId("editor-object-handle")).toHaveCount(4);

      // Unselected: a drag inside pans and leaves it alone; a click inside selects it.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-object")).toHaveCount(0);
      const stored = await row.getAttribute("data-geometry");
      await pressInside(page, await geometryOf(row));
      await expect(row).toHaveAttribute("data-geometry", stored!);
      await expect(page.getByTestId("editor-object")).toHaveCount(0);
      const g0 = await geometryOf(row);
      await clickMap(page, await toPage(page, { x: (g0[0].x + g0[1].x) / 2 + 5, y: (g0[0].y + g0[1].y) / 2 }));
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", objectId, { timeout: 5000 });

      // Selected: a body drag moves it in one write.
      const centre = await toPage(page, { x: (g0[0].x + g0[1].x) / 2 + 5, y: (g0[0].y + g0[1].y) / 2 });
      const moved = waitForTrpc(page, "courseObject.update");
      await drag(page, centre, { x: centre.x + 20, y: centre.y });
      await moved;
      await expect.poll(async () => (await row.getAttribute("data-geometry")) !== stored, { timeout: 15000 }).toBe(true);
      const g1 = await geometryOf(row);
      expect(Math.abs(g1[1].x - g1[0].x)).toBeCloseTo(30, 1);

      // A corner drag resizes with the lock: the 2 : 1 ratio is kept.
      const handle = (await page.getByTestId("editor-object-handle").nth(2).boundingBox())!;
      const corner = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      const resized = waitForTrpc(page, "courseObject.update");
      await drag(page, corner, { x: corner.x + 40, y: corner.y - 5 });
      await resized;
      await expect.poll(async () => Math.abs((await geometryOf(row))[1].x - (await geometryOf(row))[0].x) > 31, { timeout: 15000 }).toBe(true);
      const g2 = await geometryOf(row);
      expect(Math.abs(g2[1].x - g2[0].x) / Math.abs(g2[1].y - g2[0].y)).toBeCloseTo(2, 2);

      // Style fields: opacity 50 %, Multiply, rotation, a width typed with the lock; Ctrl+Z restores the width.
      const commit = async (testId: string, value: string) => {
        const w = waitForTrpc(page, "courseObject.update");
        await page.getByTestId(testId).fill(value);
        await page.getByTestId(testId).press("Enter");
        await w;
      };
      await commit("editor-style-opacity", "50");
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-props")) ?? "{}").opacity, { timeout: 15000 }).toBe(0.5);
      const blended = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-style-blend").selectOption("multiply");
      await blended;
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-props")) ?? "{}").blend, { timeout: 15000 }).toBe("multiply");
      // J15: "Cut out graphics below" writes `knockout: true`; unchecked, the key is removed.
      const knocked = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-style-knockout").check();
      await knocked;
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-props")) ?? "{}").knockout, { timeout: 15000 }).toBe(true);
      const unknocked = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-style-knockout").uncheck();
      await unknocked;
      await expect.poll(async () => "knockout" in JSON.parse((await row.getAttribute("data-props")) ?? "{}"), { timeout: 15000 }).toBe(false);
      await commit("editor-style-rotation", "30");
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-props")) ?? "{}").rotationDeg, { timeout: 15000 }).toBe(30);
      const before = await geometryOf(row);
      await commit("editor-style-width", "20");
      await expect.poll(async () => { const g = await geometryOf(row); return Math.round(Math.abs(g[1].x - g[0].x) * 10) / 10; }, { timeout: 15000 }).toBe(20);
      const g3 = await geometryOf(row);
      expect(Math.abs(g3[1].y - g3[0].y)).toBeCloseTo(10, 1);
      // The page's undo, not the field's: the focus leaves the field first.
      await page.getByTestId("editor-style-width").blur();
      await page.keyboard.press("Control+z");
      await expect.poll(async () => { const g = await geometryOf(row); return Math.abs(g[1].x - g[0].x); }, { timeout: 15000 }).toBeCloseTo(Math.abs(before[1].x - before[0].x), 1);

      // A crop writes geometry and props in one update: half the width shows half the graphic at the same scale;
      // one Ctrl+Z restores both.
      const uncropped = await geometryOf(row);
      const cropped = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-style-crop-w").fill("50");
      await page.getByTestId("editor-style-crop-w").press("Enter");
      await cropped;
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-props")) ?? "{}").crop?.width, { timeout: 15000 }).toBe(0.5);
      const half = await geometryOf(row);
      expect(Math.abs(half[1].x - half[0].x)).toBeCloseTo(Math.abs(uncropped[1].x - uncropped[0].x) / 2, 1);
      await page.getByTestId("editor-style-crop-w").blur();
      await page.keyboard.press("Control+z");
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-props")) ?? "{}").crop, { timeout: 15000 }).toBeUndefined();
      const restored = await geometryOf(row);
      expect(Math.abs(restored[1].x - restored[0].x)).toBeCloseTo(Math.abs(uncropped[1].x - uncropped[0].x), 1);

      // A control inside an image is still the control's (answer 1).
      await page.keyboard.press("Escape");
      const [code] = await regularCodes(page, 1);
      const control = await site(page, code);
      const around = await trpcCall<{ id: number }>("courseObject.create", {
        kind: "image", geometry: [{ x: control.mm.x - 8, y: control.mm.y - 8 }, { x: control.mm.x + 8, y: control.mm.y + 8 }], props: { graphicId }, scope: { all: true },
      });
      try {
        await page.reload();
        await editorReady(page);
        await expect(objectRow(page, around.id)).toBeAttached({ timeout: 15000 });
        await select(page, control.code);
        await expect(page.getByTestId("editor-object")).toHaveCount(0);
      } finally {
        await cleanup("courseObject.delete", { id: around.id });
      }
    } finally {
      if (objectId) await cleanup("courseObject.delete", { id: Number(objectId) });
      await cleanup("graphics.delete", { id: graphicId });
    }
  });
});

// docs/course-editor.md §7 "Attached objects", course-layer.md §8.1 (J10): an object follows its control.
test.describe("J10: attach to a control", () => {
  desktopOnly();

  test("attach to a picked control; the control dragged, the object follows with nothing written to it; centre, delete and undo, detach; the print draws it", async ({ page }) => {
    test.setTimeout(180_000);
    await openEditor(page);
    const nameId = nameIdOf(page);
    const [code] = await regularCodes(page, 1);
    const control = await site(page, code);
    const c0 = control.mm;
    // A 10 mm 709 square, unattached, on a clear spot (so its edges are clicked, not a control; after *Centre* its
    // edges are 5 mm from the control, outside the circle).
    const sheetToggle = page.getByTestId("map-toggle-descriptions");
    if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
    const f = await toPaper(page, await emptyPoint(page, 90));
    const square = [{ x: f.x - 5, y: f.y - 5 }, { x: f.x + 5, y: f.y - 5 }, { x: f.x + 5, y: f.y + 5 }, { x: f.x - 5, y: f.y + 5 }];
    const made = await trpcCall<{ id: number }>("courseObject.create", { kind: "oob_area", geometry: square, props: {}, scope: { all: true } });
    let objectMutations = 0;
    page.on("request", (r) => { if (/courseObject\.(update|create|delete)/.test(r.url())) objectMutations++; });
    const { drop } = await allControlsSheet();
    try {
      const hatchesBefore = (await printed(page, nameId, "allControls=1")).hatches;
      await page.reload();
      await editorReady(page);
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      const row = objectRow(page, made.id);
      await expect(row).toBeAttached({ timeout: 15000 });
      // Select it by its outline, then *Attach to a control I click* and click the control: one update, attached,
      // the object selected again. (*Attach to nearest* is `attach.test.ts`'s `nearestSite`.)
      await clickMap(page, await toPage(page, { x: f.x - 5, y: f.y }));
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(made.id), { timeout: 10000 });
      await expect(page.getByTestId("editor-object-attach-nearest")).toBeEnabled();
      const attached = waitForTrpc(page, "courseObject.update");
      let before = objectMutations;
      await page.getByTestId("editor-object-attach-pick").click();
      await expect(page.getByTestId("editor-object-attach-pick")).toHaveAttribute("aria-pressed", "true");
      await clickMap(page, await sitePoint(page, code));
      await attached;
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(made.id), { timeout: 10000 });
      expect(objectMutations - before).toBe(1);
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-attach")) || "null")?.controlId).toBe(Number(control.id));
      await expect(page.getByTestId("editor-object-attach")).toHaveAttribute("data-attached", code);

      // The control dragged 6 mm right: the object is drawn 6 mm right, and nothing is written to it.
      await page.keyboard.press("Escape");
      await select(page, code);
      before = objectMutations;
      const moved = waitForTrpc(page, "control.update");
      await dragMm(page, c0, { x: c0.x + 6, y: c0.y });
      await moved;
      const c1 = (await site(page, code)).mm;
      expect(c1.x - c0.x).toBeGreaterThan(3);
      await expect.poll(async () => { const d = (await row.getAttribute("data-drawn"))!.split(" ")[0].split(",").map(Number); return Math.round((d[0] - square[0].x) * 100) / 100; }, { timeout: 15000 })
        .toBeCloseTo(c1.x - c0.x, 1);
      expect(objectMutations - before).toBe(0);
      expect((await geometryOf(row))[0].x).toBeCloseTo(square[0].x, 6);
      // The print still draws it after its control moved (the same hatch count; the position is the layer's unit tests).
      expect(hatchesBefore).toBeGreaterThan(0);
      expect((await printed(page, nameId, "allControls=1")).hatches).toBe(hatchesBefore);

      // Centre on control: one write, its centre on the control.
      await page.keyboard.press("Escape");
      // Its left edge, drawn moved with the control.
      await clickMap(page, await toPage(page, { x: f.x - 5 + (c1.x - c0.x), y: f.y + (c1.y - c0.y) }));
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(made.id), { timeout: 10000 });
      // Its edge dragged 3 mm up after the control moved: drawn exactly 3 mm higher, `at` the control's position now
      // (the gesture starts from the drawn object, not the stored one with the old `at`).
      const drawnAt = async () => (await row.getAttribute("data-drawn"))!.split(" ")[0].split(",").map(Number);
      const [xBefore, yBefore] = await drawnAt();
      const edgeMoved = waitForTrpc(page, "courseObject.update");
      const edgeAt = { x: f.x - 5 + (c1.x - c0.x), y: f.y + (c1.y - c0.y) };
      await dragMm(page, edgeAt, { x: edgeAt.x, y: edgeAt.y + 3 });
      await edgeMoved;
      await expect.poll(async () => Math.abs((await drawnAt())[1] - yBefore - 3) < 0.3, { timeout: 15000 }).toBe(true);
      expect(Math.abs((await drawnAt())[0] - xBefore)).toBeLessThan(0.3);
      const at = JSON.parse((await row.getAttribute("data-attach")) || "null")?.at;
      expect(at.x).toBeCloseTo(c1.x, 3);
      expect(at.y).toBeCloseTo(c1.y, 3);
      const centred = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-object-centre").click();
      await centred;
      await expect.poll(async () => { const d = (await row.getAttribute("data-drawn"))!.split(" ").map((p) => p.split(",").map(Number)); return Math.abs((d[0][0] + d[1][0]) / 2 - c1.x) < 0.05; }, { timeout: 15000 }).toBe(true);

      // Delete the control: nothing is written to the object, which stays drawn, now detached; undo re-attaches.
      await page.keyboard.press("Escape");
      await select(page, code);
      before = objectMutations;
      page.once("dialog", (d) => void d.accept());
      const deleted = waitForTrpc(page, "control.delete");
      await page.keyboard.press("Delete");
      await deleted;
      await expect.poll(async () => (await row.getAttribute("data-attach")) ?? "", { timeout: 15000 }).toBe("");
      expect((await row.getAttribute("data-drawn")) ?? "").not.toBe("");
      expect(objectMutations - before).toBe(0);
      const restored = waitForTrpc(page, "control.restore");
      await page.keyboard.press("Control+z");
      await restored;
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-attach")) || "null")?.controlId, { timeout: 15000 }).toBe(Number(control.id));

      // Detach: one write; it stays where it is drawn.
      // The edge midpoint clearest of every other site and drawn number (they are hit targets and win).
      await page.keyboard.press("Escape");
      const others = [
        ...(await sites(page)).filter((x) => x.id !== control.id).map((x) => x.mm),
        ...(await page.getByTestId("course-label").evaluateAll((els) => els.map((el) => ({ x: Number(el.getAttribute("data-x")), y: Number(el.getAttribute("data-y")) })))),
      ];
      const clearest = [{ x: c1.x - 5, y: c1.y }, { x: c1.x + 5, y: c1.y }, { x: c1.x, y: c1.y - 5 }, { x: c1.x, y: c1.y + 5 }]
        .map((q) => ({ q, d: Math.min(Infinity, ...others.map((t) => Math.hypot(t.x - q.x, t.y - q.y))) }))
        .sort((a, b) => b.d - a.d)[0].q;
      await clickMap(page, await toPage(page, clearest));
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(made.id), { timeout: 10000 });
      const drawnBefore = await row.getAttribute("data-drawn");
      const detached = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-object-detach").click();
      await detached;
      await expect.poll(async () => (await row.getAttribute("data-attach")) ?? "", { timeout: 15000 }).toBe("");
      expect(await row.getAttribute("data-drawn")).toBe(drawnBefore);
    } finally {
      await cleanup("courseObject.delete", { id: made.id });
      await drop();
      await trpcCall("control.update", { id: Number(control.id), xpos: control.mm.x, ypos: control.mm.y }).catch(() => undefined);
    }
  });
});

// docs/course-editor.md §7 "Attached objects" (J18): an attached image hides its control's circle and number.
test.describe("J18: hide the attached control's circle and number", () => {
  desktopOnly();

  test("the checkboxes show on an attached image; the layer drops the circle and the number; the control stays clickable", async ({ page }) => {
    test.setTimeout(180_000);
    const png = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < 64; i++) png.data.set([0, 160, 160, 255], i * 4);
    const { id: graphicId } = await trpcCall<{ id: number }>("graphics.upload", { name: `e2e-j18-${Date.now()}.png`, scope: "event", fileDataBase64: PNG.sync.write(png).toString("base64") });
    let objectId: number | null = null;
    try {
      await openEditor(page);
      const sheetToggle = page.getByTestId("map-toggle-descriptions");
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      const [code] = await regularCodes(page, 1);
      const control = await site(page, code);
      // The image on a clear spot, attached where the control is: it covers nothing of the control.
      const f = await toPaper(page, await emptyPoint(page, 90));
      const made = await trpcCall<{ id: number }>("courseObject.create", {
        kind: "image", geometry: [{ x: f.x - 3, y: f.y - 3 }, { x: f.x + 3, y: f.y + 3 }], props: { graphicId }, scope: { all: true },
        attach: { controlId: Number(control.id), at: control.mm },
      });
      objectId = made.id;
      await page.reload();
      await editorReady(page);
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      const row = objectRow(page, made.id);
      await expect(row).toBeAttached({ timeout: 15000 });
      const ring = { minX: control.mm.x - 2.8, minY: control.mm.y - 2.8, maxX: control.mm.x + 2.8, maxY: control.mm.y + 2.8 };
      const label = page.locator(`[data-testid="course-label"][data-site-id="${control.id}"]`);
      await expect(label).toHaveCount(1, { timeout: 15000 });
      await expect.poll(() => inkIn(page, ring, "purple"), { timeout: 30000 }).toBeGreaterThan(10);
      const purpleBefore = await inkIn(page, ring, "purple");

      // Select the image (a click inside it); the attach block offers both checkboxes, off.
      await clickMap(page, await toPage(page, f));
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(made.id), { timeout: 10000 });
      await expect(page.getByTestId("editor-object-hide-circle")).not.toBeChecked();
      await expect(page.getByTestId("editor-object-hide-number")).not.toBeChecked();

      // Hide the circle: one write; the ring's purple goes, the number stays.
      let wrote = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-object-hide-circle").check();
      await wrote;
      await expect.poll(async () => JSON.parse((await row.getAttribute("data-props")) ?? "{}").hideControlCircle, { timeout: 15000 }).toBe(true);
      await expect.poll(() => inkIn(page, ring, "purple"), { timeout: 30000 }).toBeLessThan(purpleBefore * 0.6);
      await expect(label).toHaveCount(1);

      // Hide the number: the layer draws no label for the control.
      wrote = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-object-hide-number").check();
      await wrote;
      await expect(label).toHaveCount(0, { timeout: 15000 });

      // The control with neither is still a target: a click on it selects it.
      await page.keyboard.press("Escape");
      await select(page, code);

    } finally {
      if (objectId !== null) await cleanup("courseObject.delete", { id: objectId });
      await cleanup("graphics.delete", { id: graphicId });
    }
  });
});

// docs/map-rendering.md §4.11 "Knockout footprints" (J19): a knockout cuts along its graphic's outline.
test.describe("J19: cut along the graphic's outline", () => {
  desktopOnly();

  test("a round hatch cuts the overlay only under its disc: the overlay still shows in the box's corners", async ({ page }) => {
    test.setTimeout(180_000);
    const black = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < 64; i++) black.data.set([0, 0, 0, 255], i * 4);
    // A 64 px disc, red, on a transparent canvas: its outline is traced at the first knockout load.
    const disc = new PNG({ width: 64, height: 64 });
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) if ((x - 31.5) ** 2 + (y - 31.5) ** 2 < 30 ** 2) disc.data.set([220, 40, 40, 255], (y * 64 + x) * 4);
    const up = async (png: PNG, name: string) => (await trpcCall<{ id: number }>("graphics.upload", { name: `e2e-j19-${name}-${Date.now()}.png`, scope: "event", fileDataBase64: PNG.sync.write(png).toString("base64") })).id;
    const overlayGraphic = await up(black, "overlay"), discGraphic = await up(disc, "disc");
    const made: number[] = [];
    try {
      await openEditor(page);
      const sheetToggle = page.getByTestId("map-toggle-descriptions");
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      const f = await toPaper(page, await emptyPoint(page, 120));
      made.push((await trpcCall<{ id: number }>("courseObject.create", { kind: "image", geometry: [{ x: f.x - 8, y: f.y - 8 }, { x: f.x + 8, y: f.y + 8 }], props: { graphicId: overlayGraphic }, scope: { all: true } })).id);
      const hatch = await trpcCall<{ id: number; version: string }>("courseObject.create", { kind: "image", geometry: [{ x: f.x - 5, y: f.y - 5 }, { x: f.x + 5, y: f.y + 5 }], props: { graphicId: discGraphic }, scope: { all: true } });
      made.push(hatch.id);
      await page.reload();
      await editorReady(page);
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      // A corner of the hatch's box, outside its disc: the black overlay shows through the transparent corner.
      const corner = { minX: f.x - 4.9, minY: f.y - 4.9, maxX: f.x - 4.1, maxY: f.y - 4.1 };
      await expect.poll(() => inkIn(page, corner, "dark"), { timeout: 30000 }).toBeGreaterThan(3);
      const before = await inkIn(page, corner, "dark");
      // Knockout on: the box would cut the corner to the map; the outline leaves it black.
      await trpcCall("courseObject.update", { id: hatch.id, baseVersion: hatch.version, props: { graphicId: discGraphic, knockout: true } });
      await page.reload();
      await editorReady(page);
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      await expect.poll(async () => JSON.parse((await objectRow(page, hatch.id).getAttribute("data-props")) ?? "{}").knockout, { timeout: 15000 }).toBe(true);
      await expect.poll(() => inkIn(page, corner, "dark"), { timeout: 30000 }).toBeGreaterThanOrEqual(Math.floor(before * 0.8));
      // The disc's centre is the hatch's red, not the overlay's black, either way.
      expect(await inkIn(page, { minX: f.x - 0.5, minY: f.y - 0.5, maxX: f.x + 0.5, maxY: f.y + 0.5 }, "dark")).toBe(0);
    } finally {
      for (const id of made) await cleanup("courseObject.delete", { id });
      for (const id of [overlayGraphic, discGraphic]) await cleanup("graphics.delete", { id });
    }
  });
});

// docs/course-editor.md §7 "Multi-selection" (J16): Shift/Ctrl-click several objects, then act on them together.
test.describe("J16: object multi-selection", () => {
  desktopOnly();

  test("Ctrl-click adds an image; a drag moves both as one undo; a style field sets both; Ctrl+D and Delete act on the set", async ({ page }) => {
    test.setTimeout(180_000);
    const png = new PNG({ width: 8, height: 8 });
    for (let i = 0; i < 64; i++) png.data.set([0, 160, 160, 255], i * 4);
    const { id: graphicId } = await trpcCall<{ id: number }>("graphics.upload", { name: `e2e-j16-${Date.now()}.png`, scope: "event", fileDataBase64: PNG.sync.write(png).toString("base64") });
    const made: number[] = [];
    const ours = async () => (await page.getByTestId("editor-object-row").evaluateAll((els, g) => els
      .filter((el) => JSON.parse(el.getAttribute("data-props") ?? "{}").graphicId === g).map((el) => Number(el.getAttribute("data-object-id"))), graphicId));
    try {
      await openEditor(page);
      const sheetToggle = page.getByTestId("map-toggle-descriptions");
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      const centre = await emptyPoint(page, 120);
      const a = await toPaper(page, { x: centre.x - 45, y: centre.y });
      const b = await toPaper(page, { x: centre.x + 45, y: centre.y });
      for (const c of [a, b]) {
        const o = await trpcCall<{ id: number }>("courseObject.create", { kind: "image", geometry: [{ x: c.x - 2, y: c.y - 2 }, { x: c.x + 2, y: c.y + 2 }], props: { graphicId }, scope: { all: true } });
        made.push(o.id);
      }
      await page.reload();
      await editorReady(page);
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      const [rowA, rowB] = made.map((id) => objectRow(page, id));
      await expect(rowB).toBeAttached({ timeout: 15000 });

      // A click selects A; Ctrl-click adds B: the multi inspector, both outlined.
      await clickMap(page, await toPage(page, a));
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(made[0]), { timeout: 10000 });
      await page.keyboard.down("Control");
      await page.mouse.click(...Object.values(await toPage(page, b)) as [number, number]);
      await page.keyboard.up("Control");
      await expect(page.getByTestId("editor-object-multi")).toHaveAttribute("data-count", "2", { timeout: 10000 });
      await expect(page.getByTestId("editor-object-multi")).toHaveAttribute("data-kind", "image");
      await expect.poll(async () => (await toolShapes(page, "editor-object-multi-outline")).length).toBe(2);

      // A drag on B moves both 3 mm right: one batch; Ctrl+Z puts both back.
      const a0 = await geometryOf(rowA), b0 = await geometryOf(rowB);
      await dragMm(page, b, { x: b.x + 3, y: b.y });
      await expect.poll(async () => (await geometryOf(rowA))[0].x - a0[0].x, { timeout: 15000 }).toBeCloseTo(3, 0);
      await expect.poll(async () => (await geometryOf(rowB))[0].x - b0[0].x, { timeout: 15000 }).toBeCloseTo(3, 0);
      await expect(page.getByTestId("editor-object-multi")).toHaveAttribute("data-count", "2");
      await page.keyboard.press("Control+z");
      await expect.poll(async () => (await geometryOf(rowA))[0].x, { timeout: 15000 }).toBeCloseTo(a0[0].x, 3);
      await expect.poll(async () => (await geometryOf(rowB))[0].x, { timeout: 15000 }).toBeCloseTo(b0[0].x, 3);

      // Opacity 40 % in the multi inspector: both rows carry it.
      const opacity = page.getByTestId("editor-object-multi-style-opacity");
      await opacity.fill("40");
      await opacity.press("Enter");
      await opacity.blur();
      for (const row of [rowA, rowB]) {
        await expect.poll(async () => JSON.parse((await row.getAttribute("data-props")) ?? "{}").opacity, { timeout: 15000 }).toBeCloseTo(0.4, 3);
      }

      // Ctrl+D: two copies, selected together; Delete removes the copies; Escape ends the selection.
      await page.keyboard.press("Control+d");
      await expect.poll(async () => (await ours()).length, { timeout: 15000 }).toBe(4);
      await expect(page.getByTestId("editor-object-multi")).toHaveAttribute("data-count", "2");
      const copies = (await ours()).filter((id) => !made.includes(id));
      made.push(...copies);
      await page.keyboard.press("Delete");
      await expect.poll(async () => (await ours()).length, { timeout: 15000 }).toBe(2);
      // Shift-click toggles too: B out of {A, B} leaves A alone.
      await page.keyboard.press("Escape");
      await clickMap(page, await toPage(page, a));
      await page.keyboard.down("Shift");
      await page.mouse.click(...Object.values(await toPage(page, b)) as [number, number]);
      await expect(page.getByTestId("editor-object-multi")).toHaveAttribute("data-count", "2", { timeout: 10000 });
      await page.mouse.click(...Object.values(await toPage(page, b)) as [number, number]);
      await page.keyboard.up("Shift");
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(made[0]), { timeout: 10000 });
    } finally {
      for (const id of made) await cleanup("courseObject.delete", { id });
      await cleanup("graphics.delete", { id: graphicId });
    }
  });
});

// docs/course-editor.md §7 "Duplicate, copy, cut, paste" (J12): the app clipboard in Course mode.
test.describe("J12: duplicate, copy, cut, paste", () => {
  desktopOnly();

  test("Ctrl+D duplicates 3 mm down-right; copy and paste at the pointer; cut; a paste onto two controls is one undo; the clipboard survives a reload; a foreign graphic is refused", async ({ page }) => {
    test.setTimeout(180_000);
    await openEditor(page);
    const sheetToggle = page.getByTestId("map-toggle-descriptions");
    if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
    const f = await toPaper(page, await emptyPoint(page, 90));
    const square = [{ x: f.x - 5, y: f.y - 5 }, { x: f.x + 5, y: f.y - 5 }, { x: f.x + 5, y: f.y + 5 }, { x: f.x - 5, y: f.y + 5 }];
    const made = await trpcCall<{ id: number }>("courseObject.create", { kind: "oob_area", geometry: square, props: {}, scope: { all: true } });
    const ids = async () => (await page.getByTestId("editor-object-row").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-object-id")))));
    const centreOf = async (id: number) => { const g = await geometryOf(objectRow(page, id)); return { x: (Math.min(...g.map((v) => v.x)) + Math.max(...g.map((v) => v.x))) / 2, y: (Math.min(...g.map((v) => v.y)) + Math.max(...g.map((v) => v.y))) / 2 }; };
    const created: number[] = [];
    const newIds = async (before: number[], n: number) => {
      let fresh: number[] = [];
      await expect.poll(async () => { fresh = (await ids()).filter((id) => !before.includes(id)); return fresh.length; }, { timeout: 15000 }).toBe(n);
      created.push(...fresh);
      return fresh;
    };
    try {
      await page.reload();
      await editorReady(page);
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      await expect(objectRow(page, made.id)).toBeAttached({ timeout: 15000 });
      await clickMap(page, await toPage(page, { x: f.x - 5, y: f.y }));
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(made.id), { timeout: 10000 });

      // Ctrl+D: a copy 3 mm right and 3 mm down (paper y-up), selected; one create.
      let before = await ids();
      const dup = waitForTrpc(page, "courseObject.create");
      await page.keyboard.press("Control+d");
      await dup;
      const [d] = await newIds(before, 1);
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(d), { timeout: 10000 });
      const g = await geometryOf(objectRow(page, d));
      expect(g[0].x).toBeCloseTo(square[0].x + 3, 3);
      expect(g[0].y).toBeCloseTo(square[0].y - 3, 3);
      expect(JSON.parse((await objectRow(page, d).getAttribute("data-scope"))!)).toEqual({ all: true });

      // Ctrl+C, then Ctrl+V with the pointer on another clear spot: the copy's centre there, selected.
      await page.keyboard.press("Control+c");
      const there = await emptyPoint(page, 60, [await toPage(page, f)]);
      await page.mouse.move(there.x, there.y);
      await page.mouse.move(there.x + 1, there.y);
      const thereMm = await toPaper(page, { x: there.x + 1, y: there.y });
      before = await ids();
      const pasted = waitForTrpc(page, "courseObject.create");
      await page.keyboard.press("Control+v");
      await pasted;
      const [p] = await newIds(before, 1);
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(p), { timeout: 10000 });
      const c = await centreOf(p);
      expect(Math.hypot(c.x - thereMm.x, c.y - thereMm.y)).toBeLessThan(0.5);

      // Ctrl+X: the pasted copy goes (copied first).
      const cut = waitForTrpc(page, "courseObject.delete");
      await page.keyboard.press("Control+x");
      await cut;
      await expect(objectRow(page, p)).toHaveCount(0, { timeout: 15000 });
      // Undo of the cut brings it back (a new id), centred where it was.
      before = await ids();
      await page.keyboard.press("Control+z");
      const [back] = await newIds(before, 1);
      const cb = await centreOf(back);
      expect(Math.hypot(cb.x - thereMm.x, cb.y - thereMm.y)).toBeLessThan(0.5);

      // Two controls selected, Ctrl+V: one copy on each, attached and centred (the original was free); one undo removes both.
      await page.keyboard.press("Escape");
      const [a, ...rest] = await regularCodes(page, 6);
      await select(page, a);
      let second: string | null = null;
      for (const code of rest) {
        const q = await sitePoint(page, code);
        if (await coveredBy(page, q)) continue;
        await page.keyboard.down("Shift");
        try { await clickMap(page, q); } finally { await page.keyboard.up("Shift"); }
        second = code;
        break;
      }
      expect(second, "a Shift-clickable second control").not.toBeNull();
      await expect(page.getByTestId("editor-multi")).toHaveAttribute("data-count", "2", { timeout: 10000 });
      before = await ids();
      await page.keyboard.press("Control+v");
      const both = await newIds(before, 2);
      const controls = [await site(page, a), await site(page, second!)];
      for (const id of both) {
        const at = JSON.parse((await objectRow(page, id).getAttribute("data-attach")) || "null");
        const on = controls.find((k) => Number(k.id) === at?.controlId);
        expect(on, "attached to a selected control").toBeTruthy();
        const cc = await centreOf(id);
        expect(Math.hypot(cc.x - on!.mm.x, cc.y - on!.mm.y)).toBeLessThan(0.05);
      }
      await page.keyboard.press("Control+z");
      await expect.poll(async () => (await ids()).filter((id) => both.includes(id)).length, { timeout: 15000 }).toBe(0);
      // Redo makes both again (new ids), still one entry.
      before = await ids();
      await page.keyboard.press("Control+y");
      await newIds(before, 2);

      // The clipboard is in localStorage: a reload keeps it.
      await page.reload();
      await editorReady(page);
      await page.mouse.move(there.x, there.y);
      await page.mouse.move(there.x + 1, there.y);
      before = await ids();
      await page.keyboard.press("Control+v");
      await newIds(before, 1);

      // An image whose graphic is neither the event's nor the club's is refused, with the reason on the error line.
      await page.evaluate(() => localStorage.setItem("oxygen.editor.clipboard", JSON.stringify({
        v: 1, type: "course", event: "elsewhere",
        object: { kind: "image", geometry: [{ x: 0, y: 0 }, { x: 10, y: 10 }], props: { graphicId: 987654321 }, scope: { all: true }, inCourses: null },
      })));
      before = await ids();
      await page.keyboard.press("Control+v");
      await expect(page.getByTestId("editor-error")).toBeVisible({ timeout: 10000 });
      expect((await ids()).length).toBe(before.length);
    } finally {
      for (const id of [made.id, ...created]) await cleanup("courseObject.delete", { id });
    }
  });

  test("an attached object whose control moved: Ctrl+D keeps it on its control as drawn; pasted onto another control at the copied offset; undo and redo", async ({ page }) => {
    test.setTimeout(180_000);
    await openEditor(page);
    const sheetToggle = page.getByTestId("map-toggle-descriptions");
    if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
    const [codeA, ...rest] = await regularCodes(page, 6);
    const A = await site(page, codeA);
    const c = A.mm;
    // Stored 8 mm right of A with `at` 1 mm left of it: drawn 9 mm right (as if A had moved 1 mm since).
    const sq = [{ x: c.x + 3, y: c.y - 5 }, { x: c.x + 13, y: c.y - 5 }, { x: c.x + 13, y: c.y + 5 }, { x: c.x + 3, y: c.y + 5 }];
    const made = await trpcCall<{ id: number }>("courseObject.create", { kind: "oob_area", geometry: sq, props: {}, scope: { all: true }, attach: { controlId: Number(A.id), at: { x: c.x - 1, y: c.y } } });
    const ids = async () => (await page.getByTestId("editor-object-row").evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-object-id")))));
    const drawn = async (id: number) => (await objectRow(page, id).getAttribute("data-drawn"))!.split(" ").map((q) => { const [x, y] = q.split(",").map(Number); return { x, y }; });
    const attachOf = async (id: number) => JSON.parse((await objectRow(page, id).getAttribute("data-attach")) || "null");
    const created: number[] = [];
    const newIds = async (before: number[], n: number) => {
      let fresh: number[] = [];
      await expect.poll(async () => { fresh = (await ids()).filter((id) => !before.includes(id)); return fresh.length; }, { timeout: 15000 }).toBe(n);
      created.push(...fresh);
      return fresh;
    };
    try {
      await page.reload();
      await editorReady(page);
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      await expect(objectRow(page, made.id)).toBeAttached({ timeout: 15000 });
      // Its drawn edge midpoint clearest of every other site and number.
      const others = [
        ...(await sites(page)).filter((x) => x.id !== A.id).map((x) => x.mm),
        ...(await page.getByTestId("course-label").evaluateAll((els) => els.map((el) => ({ x: Number(el.getAttribute("data-x")), y: Number(el.getAttribute("data-y")) })))),
      ];
      const edge = [{ x: c.x + 4, y: c.y }, { x: c.x + 14, y: c.y }, { x: c.x + 9, y: c.y - 5 }, { x: c.x + 9, y: c.y + 5 }]
        .map((q) => ({ q, d: Math.min(Infinity, ...others.map((t) => Math.hypot(t.x - q.x, t.y - q.y))) }))
        .sort((a, b) => b.d - a.d)[0].q;
      await clickMap(page, await toPage(page, edge));
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(made.id), { timeout: 10000 });
      const d0 = (await drawn(made.id))[0];
      expect(d0.x).toBeCloseTo(c.x + 4, 3);

      // Ctrl+D: the copy 3 mm right and down of where it is drawn, attached to A with `at` A's position.
      let before = await ids();
      await page.keyboard.press("Control+d");
      const [dup] = await newIds(before, 1);
      await expect.poll(async () => (await attachOf(dup))?.controlId, { timeout: 15000 }).toBe(Number(A.id));
      const at = (await attachOf(dup)).at;
      expect(at.x).toBeCloseTo(c.x, 3);
      expect(at.y).toBeCloseTo(c.y, 3);
      const dd = (await drawn(dup))[0];
      expect(dd.x).toBeCloseTo(d0.x + 3, 3);
      expect(dd.y).toBeCloseTo(d0.y - 3, 3);

      // Ctrl+C the copy, select another control, Ctrl+V: one copy attached to it at the same offset; undo, redo.
      await page.keyboard.press("Control+c");
      await page.keyboard.press("Escape");
      let codeB: string | null = null;
      for (const code of rest) { if (!(await coveredBy(page, await sitePoint(page, code)))) { codeB = code; break; } }
      expect(codeB).not.toBeNull();
      const B = await site(page, codeB!);
      await select(page, codeB!);
      before = await ids();
      await page.keyboard.press("Control+v");
      const [onB] = await newIds(before, 1);
      await expect.poll(async () => (await attachOf(onB))?.controlId, { timeout: 15000 }).toBe(Number(B.id));
      const pb = (await drawn(onB))[0];
      expect(pb.x - B.mm.x).toBeCloseTo(dd.x - c.x, 3);
      expect(pb.y - B.mm.y).toBeCloseTo(dd.y - c.y, 3);
      await page.keyboard.press("Control+z");
      await expect(objectRow(page, onB)).toHaveCount(0, { timeout: 15000 });
      before = await ids();
      await page.keyboard.press("Control+y");
      const [again] = await newIds(before, 1);
      await expect.poll(async () => (await attachOf(again))?.controlId, { timeout: 15000 }).toBe(Number(B.id));
    } finally {
      for (const id of [made.id, ...created]) await cleanup("courseObject.delete", { id });
    }
  });
});

// docs/course-editor.md §7 "Transform handles" (J11): the knob, crop mode and the turn / flip buttons in Course mode.
test.describe("J11: transform handles in Course mode", () => {
  desktopOnly();

  test("the image knob turns it (Escape cancels), crop mode crops by an edge, a white-out turns and flips from the inspector", async ({ page }) => {
    test.setTimeout(180_000);
    const png = new PNG({ width: 16, height: 8 });
    for (let i = 0; i < 128; i++) png.data.set([250, 210, 0, 255], i * 4);
    const { id: graphicId } = await trpcCall<{ id: number }>("graphics.upload", { name: `e2e-j11-${Date.now()}.png`, scope: "event", fileDataBase64: PNG.sync.write(png).toString("base64") });
    const made: number[] = [];
    let updates = 0;
    page.on("request", (r) => { if (/courseObject\.update/.test(r.url())) updates++; });
    try {
      await openEditor(page);
      const sheetToggle = page.getByTestId("map-toggle-descriptions");
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      // A 20 × 10 mm image and a 10 mm white-out on clear spots, both attached to a control as if it had moved
      // 1 mm since they were written (J10): drawn 1 mm from where they are stored, so every write must send the drawn
      // geometry with the control's position now as `at` (J11 review (3)).
      const [code] = await regularCodes(page, 1);
      const control = await site(page, code);
      const c = control.mm;
      const f = await toPaper(page, await emptyPoint(page, 110));
      const img = await trpcCall<{ id: number }>("courseObject.create", {
        kind: "image", geometry: [{ x: f.x - 11, y: f.y - 5 }, { x: f.x + 9, y: f.y + 5 }], props: { graphicId }, scope: { all: true },
        attach: { controlId: Number(control.id), at: { x: c.x - 1, y: c.y } },
      });
      made.push(img.id);
      const w = await toPaper(page, await emptyPoint(page, 90, [await toPage(page, f)]));
      const whiteSquare = [{ x: w.x - 5, y: w.y - 6 }, { x: w.x + 5, y: w.y - 6 }, { x: w.x + 5, y: w.y + 4 }, { x: w.x - 5, y: w.y + 4 }];
      const white = await trpcCall<{ id: number }>("courseObject.create", {
        kind: "whiteout", geometry: whiteSquare, props: {}, scope: { all: true }, attach: { controlId: Number(control.id), at: { x: c.x, y: c.y - 1 } },
      });
      made.push(white.id);
      await page.reload();
      await editorReady(page);
      if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
      const row = objectRow(page, img.id);
      await expect(row).toBeAttached({ timeout: 15000 });
      const props = async () => JSON.parse((await row.getAttribute("data-props")) || "{}") as { rotationDeg?: number; crop?: { width: number } };
      const drawn = async (r = row) => ((await r.getAttribute("data-drawn")) ?? "").split(" ").filter(Boolean).map((q) => ({ x: Number(q.split(",")[0]), y: Number(q.split(",")[1]) }));
      const at = async (r = row) => (JSON.parse((await r.getAttribute("data-attach")) || "null") as { at: { x: number; y: number } } | null)?.at;
      const layer = page.getByTestId("editor-tool-layer");
      const centreOf = async (id: string, n = 0) => { const b = (await layer.getByTestId(id).nth(n).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
      const centre = await toPage(page, f);
      await clickMap(page, centre);
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(img.id), { timeout: 10000 });

      // The knob dragged from above the centre to its right: a quarter turn clockwise, one write; undo restores.
      await expect(layer.getByTestId("editor-object-rotate")).toHaveCount(1);
      let knob = await centreOf("editor-object-rotate");
      const r = Math.hypot(knob.x - centre.x, knob.y - centre.y);
      let before = updates;
      const turned = waitForTrpc(page, "courseObject.update");
      await drag(page, knob, { x: centre.x + r, y: centre.y });
      await turned;
      await expect.poll(async () => Math.abs(((await props()).rotationDeg ?? 0) - 90), { timeout: 15000 }).toBeLessThan(3);
      expect(updates - before).toBe(1);
      await page.keyboard.press("Control+z");
      await expect.poll(async () => "rotationDeg" in (await props()), { timeout: 15000 }).toBe(false);

      // Escape mid-drag (§3, F24): the drag is cancelled with nothing written, then the cascade clears the selection.
      knob = await centreOf("editor-object-rotate");
      before = updates;
      await dragHold(page, knob, { x: centre.x + r, y: centre.y });
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await page.waitForTimeout(300);
      expect(updates).toBe(before);
      expect("rotationDeg" in (await props())).toBe(false);
      await clickMap(page, centre);
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(img.id), { timeout: 10000 });

      // Crop mode: a double-click shows the edges; the right edge a quarter in crops and narrows the box in one write.
      await page.mouse.dblclick(centre.x, centre.y);
      await expect(layer.getByTestId("editor-object-crop-edge")).toHaveCount(4);
      await expect(layer.getByTestId("editor-object-rotate")).toHaveCount(0);
      await expect(page.getByTestId("editor-style-crop-mode")).toHaveAttribute("aria-pressed", "true");
      const right = await centreOf("editor-object-crop-edge", 1);
      const left = await centreOf("editor-object-crop-edge", 0);
      before = updates;
      const cropped = waitForTrpc(page, "courseObject.update");
      await drag(page, right, { x: right.x - (right.x - left.x) / 4, y: right.y });
      await cropped;
      await expect.poll(async () => (await props()).crop?.width, { timeout: 15000 }).toBeCloseTo(0.75, 1);
      const g = await geometryOf(row);
      expect(Math.abs(g[1].x - g[0].x)).toBeCloseTo(20 * (await props()).crop!.width, 3);
      expect(updates - before).toBe(1);
      // Attached: the left edge stays where it was drawn, `at` now the control's position.
      await expect.poll(async () => Math.abs((await drawn())[0].x - (f.x - 10)) < 0.01, { timeout: 15000 }).toBe(true);
      expect((await at())!.x).toBeCloseTo(c.x, 6);
      await page.keyboard.press("Control+z");
      await expect.poll(async () => "crop" in (await props()), { timeout: 15000 }).toBe(false);
      await expect.poll(async () => Math.abs((await drawn())[1].x - (f.x + 10)) < 0.01, { timeout: 15000 }).toBe(true);
      // Escape leaves crop mode; the image stays selected.
      await page.keyboard.press("Escape");
      await expect(layer.getByTestId("editor-object-crop-edge")).toHaveCount(0);
      await expect(layer.getByTestId("editor-object-rotate")).toHaveCount(1);
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(img.id));

      // Crop mode again; selecting another object leaves it.
      await page.mouse.dblclick(centre.x, centre.y);
      await expect(layer.getByTestId("editor-object-crop-edge")).toHaveCount(4);
      const whiteRow = objectRow(page, white.id);
      await clickMap(page, await toPage(page, { x: w.x - 5, y: w.y }));
      await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(white.id), { timeout: 10000 });
      await expect(layer.getByTestId("editor-object-crop-edge")).toHaveCount(0);

      // The white-out (drawn on w, attached): Turn 90° and Flip ↔ from the inspector, each one write, baked into the
      // vertices about its drawn centre, `at` the control's position.
      before = updates;
      const quarter = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-object-transform-rotate90").click();
      await quarter;
      // A quarter turn clockwise about the centre: the first corner (−5, −5) goes to (−5, +5).
      await expect.poll(async () => { const q = (await geometryOf(whiteRow))[0]; return [Math.round((q.x - w.x) * 100) / 100, Math.round((q.y - w.y) * 100) / 100]; }, { timeout: 15000 }).toEqual([-5, 5]);
      const flipped = waitForTrpc(page, "courseObject.update");
      await page.getByTestId("editor-object-transform-flip-h").click();
      await flipped;
      await expect.poll(async () => { const q = (await geometryOf(whiteRow))[0]; return [Math.round((q.x - w.x) * 100) / 100, Math.round((q.y - w.y) * 100) / 100]; }, { timeout: 15000 }).toEqual([5, 5]);
      expect(updates - before).toBe(2);
      // The drawn place is what the geometry shows: stored and drawn agree now that `at` is the control's position.
      expect((await at(whiteRow))!.y).toBeCloseTo(c.y, 6);
      expect((await drawn(whiteRow))[0].x).toBeCloseTo(w.x + 5, 2);
    } finally {
      for (const id of made) await cleanup("courseObject.delete", { id });
      await cleanup("graphics.delete", { id: graphicId });
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
