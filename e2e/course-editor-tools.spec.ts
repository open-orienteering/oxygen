// The editor's tools (docs/course-editor.md §6–§7): the tool chain, its keys and modifiers, the filter symbol picker.
// Split from the editor's one spec file along its describes (docs/e2e-sharding.md "CI"); the
// helpers they share are `helpers/course-editor-spec.ts`. It runs under the `chromium` project (desktop) only.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`, the fixture import idempotent per test
// (`openEditor` → `ensureCoursesAndMap`), courses a test creates carry a prefix and go with the
// next reseed, controls / objects / sheets it creates are deleted in `finally` (`cleanup`).

import { expect, test } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { allControlsSheet, arm, cleanup, clickMap, controlRows, coveredBy, drag, dragMm, editorReady, emptyPoint, geometryOf, inkIn, legMidpoint, legPieces, nameIdOf, objectRow, openEditor, place, pressInside, pressOnEdge, printed, probeTemplate, regularCodes, select, selectedCode, siteCuts, site, sitePoint, sites, toolShapes, toPage, toPaper, trpcCall, newCourse, mapScale, type Site } from "./helpers/editor";
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
