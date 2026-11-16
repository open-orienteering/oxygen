/**
 * Map mode (docs/course-editor.md §13, rows G6, G7, G9, G12b): the event's map corrections in the editor — select, hide,
 * move, undo, the course overprint hidden, *Apply corrections*, the patch kept across a reload, the nodes tool `N`
 * (drag, insert, delete, undo; §13 "Nodes"), drawing and change symbol (§13 "Drawing", "Symbol picker": a path
 * with a document symbol, a point with a library symbol materialised on first use, a resymbol; each in `maps.pdf`,
 * whose page raster is `print-patch.test.ts`'s, user 2026-11-15), and promote (§13 "Promote"; 08 §7's smoke: hide an
 * object, add a path, save them to the club map), and the line and area operations (§13 "Line and area operations",
 * G10: reverse, split, join, cut and remove a hole on lines and areas the test draws). The fixture is the seed's `itest` event with `e2e/test.ocd` pinned;
 * every op is removed in `finally` (AGENTS.md §12), so no reseed — except promote's describe, which moves the pin and
 * makes a club series: it reseeds and removes the series.
 *
 * The target is a black line with no other black ink within 1 mm across it (the fixture draws its lines over a
 * yellow area), found on the canvas at a zoom where 1 mm is ≥ 16 px and checked against the document
 * (`mapObjectsAt`): the only point or line object within 0.5 mm, so hiding it leaves no black there.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { API_BASE } from "./helpers/api-base";
import { reseed } from "./helpers/reseed";
import { allControlsSheet, EDITOR_EVENT, editorReady, inflatedStreams, inkedAt, openEditor, paperToPageOf, plainMapAt, plainMapSpots, printed, sites, toPage, toPaper, toolShapes, trpcCall, viewSettled } from "./helpers/editor";
import { dropEventPatch, mapObjectsAt } from "./helpers/event-map-pin";
import { trpcProcedures, waitForTrpc } from "./helpers/trpc";

type Pt = { x: number; y: number };
type Delivery = { version: string; patch: { documentHash: string; enabled: boolean; ops: Record<string, unknown> } | null };

/** Every op of the event's patch removed and the toggle on: the seed's state. */
async function clearPatch(): Promise<void> {
  const { patch } = await trpcCall<Delivery>("mapPatch.get", undefined, false);
  if (patch && Object.keys(patch.ops).length > 0) await trpcCall("mapPatch.applyChange", { documentHash: patch.documentHash, remove: Object.keys(patch.ops) });
  if (patch && !patch.enabled) await trpcCall("mapPatch.setEnabled", { enabled: true });
}

const pxPerMm = async (page: Page) => Number(await page.getByTestId("map-viewer").getAttribute("data-px-per-um")) * 1000;

/** Wheel-zoom at the viewer's centre until 1 mm is at least `target` px. */
async function zoomTo(page: Page, target: number): Promise<void> {
  const box = (await page.getByTestId("map-viewer").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 30 && (await pxPerMm(page)) < target; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(80);
  }
  await viewSettled(page);
  expect(await pxPerMm(page)).toBeGreaterThanOrEqual(target);
}

/** The middle of the viewer that no editor chrome covers, page px. */
async function freeRegion(page: Page): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  const v = (await page.getByTestId("map-viewer").boundingBox())!;
  const insp = (await page.getByTestId("editor-inspector").boundingBox())!;
  const rail = (await page.getByTestId("editor-tool-rail").boundingBox())!;
  const x0 = Math.max(v.x + v.width * 0.2, rail.x + rail.width + 30, insp.x + insp.width + 30);
  return { x0, y0: v.y + v.height * 0.25, x1: v.x + v.width * 0.8, y1: v.y + v.height * 0.75 };
}

const STEP = 0.2;

/**
 * A lone black line: a dark pixel with no dark ink 0.6–1.0 mm on both sides across it (so a move of 0.8 mm across
 * lands where there was none), dark 0.4 mm along it, and the document's only point or line within 0.5 mm.
 */
async function findLine(page: Page): Promise<{ at: Pt; across: Pt; sourceIndex: number }> {
  const r = await freeRegion(page);
  const a = await toPaper(page, { x: r.x0, y: r.y0 }), b = await toPaper(page, { x: r.x1, y: r.y1 });
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  const toPagePt = await paperToPageOf(page);
  const grid: Pt[] = [];
  const nx = Math.floor((maxX - minX) / STEP), ny = Math.floor((maxY - minY) / STEP);
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= ny; j++) grid.push({ x: minX + i * STEP, y: minY + j * STEP });
  const key = (p: Pt) => `${Math.round((p.x - minX) / STEP)},${Math.round((p.y - minY) / STEP)}`;
  const dark = new Set((await inkedAt(page, grid, "dark")).map(key));
  const at = (i: number, j: number) => ({ x: minX + i * STEP, y: minY + j * STEP });
  const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const candidates: { at: Pt; across: Pt }[] = [];
  for (let i = 6; i <= nx - 6; i++) {
    for (let j = 6; j <= ny - 6; j++) {
      const p = at(i, j);
      if (!dark.has(key(p))) continue;
      const white = (di: number, dj: number) => [3, 4, 5].every((k) => !dark.has(key(at(i + di * k, j + dj * k))) && !dark.has(key(at(i - di * k, j - dj * k))));
      const along = (di: number, dj: number) => dark.has(key(at(i + di * 2, j + dj * 2))) && dark.has(key(at(i - di * 2, j - dj * 2)));
      if (white(0, 1) && along(1, 0)) candidates.push({ at: p, across: { x: 0, y: 0.8 } });
      else if (white(1, 0) && along(0, 1)) candidates.push({ at: p, across: { x: 0.8, y: 0 } });
    }
  }
  candidates.sort((u, w) => Math.hypot(u.at.x - centre.x, u.at.y - centre.y) - Math.hypot(w.at.x - centre.x, w.at.y - centre.y));
  for (const c of candidates.slice(0, 6)) {
    const near = mapObjectsAt(EDITOR_EVENT, c.at.x, c.at.y, 0.5).objects.filter((o) => o.type !== 3);
    if (near.length === 1 && near[0].type === 2) return { ...c, sourceIndex: near[0].sourceIndex };
  }
  throw new Error(`no lone black line in view (${candidates.length} candidates)`);
}

/** The line drawn at a paper point, within 0.05 mm: black, or highlighted while selected. */
const darkAt = async (page: Page, p: Pt) =>
  (await inkedAt(page, [p, { x: p.x, y: p.y - 0.05 }, { x: p.x, y: p.y + 0.05 }, { x: p.x - 0.05, y: p.y }, { x: p.x + 0.05, y: p.y }], "line")).length > 0;

const mapObject = (page: Page) => page.getByTestId("editor-map-object");
const correction = (page: Page, opId: string) => page.locator(`[data-testid="editor-correction-row"][data-op-id="${opId}"]`);

/** Counts `mapPatch.applyChange` requests from the page. */
function countWrites(page: Page): { readonly n: number } {
  const c = { n: 0 };
  page.on("request", (req: Request) => {
    if (req.method() === "POST" && trpcProcedures(req.url()).includes("mapPatch.applyChange")) c.n++;
  });
  return c;
}

test.describe("Map mode (docs/course-editor.md §13)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await clearPatch();
  });
  test.afterAll(async () => {
    await clearPatch();
  });

  test("the fourth mode, entered after the map loaded: course edits locked, H hides the overprint, F fits the map", async ({ page }) => {
    test.setTimeout(120_000);
    await openEditor(page);
    const before = await sites(page);
    expect(before.length).toBeGreaterThan(0);
    // The course layer's mirror (what the canvas draws, `course-site`) and the description sheet.
    await expect(page.getByTestId("course-site").first()).toBeAttached({ timeout: 15_000 });
    await expect(page.getByTestId("description-sheet")).toBeVisible();

    await page.getByTestId("editor-mode-map").click();
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
    await expect(page).toHaveURL(/[?&]mode=map(&|$)/);
    await expect(page.getByTestId("editor-mode-map")).toHaveAttribute("aria-pressed", "true");
    // The rail is V and N (V armed); Course mode's tool keys arm nothing; a click on a control selects no control.
    await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-tool-N")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("editor-tool-K")).toHaveCount(0);
    await expect(page.getByTestId("editor-inspector-map-object")).toBeVisible();
    await expect(page.getByTestId("editor-map-object-none")).toBeVisible();
    await page.keyboard.press("k");
    const s = before.find((x) => x.type === "Control") ?? before[0];
    const sp = await toPage(page, s.mm);
    await page.mouse.click(sp.x, sp.y);
    await expect(page.getByTestId("editor-selected-code")).toHaveCount(0);
    await expect(page.getByTestId("editor-hide-others")).toHaveCount(0);

    // H: the course overprint goes, and comes back.
    await page.keyboard.press("h");
    await expect(page.getByTestId("editor-hide-overprint")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-site")).toHaveCount(0);
    await expect(page.getByTestId("course-site")).toHaveCount(0);
    await expect(page.getByTestId("description-sheet")).toHaveCount(0);
    await page.getByTestId("editor-hide-overprint").click();
    await expect(page.getByTestId("editor-hide-overprint")).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("course-site").first()).toBeAttached({ timeout: 15_000 });
    await expect(page.getByTestId("description-sheet")).toBeVisible();

    // F fits the map: zoomed in, F zooms back out.
    const fitted = await pxPerMm(page);
    await zoomTo(page, fitted * 3);
    await page.keyboard.press("f");
    await expect.poll(() => pxPerMm(page), { timeout: 10_000 }).toBeLessThan(fitted * 2);

    // Back in Course mode nothing was selected by Map mode's clicks.
    await page.getByTestId("editor-mode-course").click();
    await expect(page).not.toHaveURL(/mode=/);
    await expect(page.getByTestId("editor-selected-code")).toHaveCount(0);
  });

  test("select, hide, undo, move, Apply corrections, reload keeps it, revert", async ({ page }) => {
    test.setTimeout(240_000);
    try {
      await openEditor(page, "?mode=map");
      await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
      const canvas = page.getByTestId("map-vector-layer");
      await expect(canvas).toHaveAttribute("data-patch-version", /.+/, { timeout: 30_000 });
      await page.keyboard.press("h");
      await zoomTo(page, 16);
      const { at, across, sourceIndex } = await findLine(page);
      const ref = `source:${sourceIndex}`;
      const moved = { x: at.x + across.x, y: at.y + across.y };
      expect(await darkAt(page, at), "ink on the line").toBe(true);
      expect(await darkAt(page, moved), "no black where it will be moved").toBe(false);
      const writes = countWrites(page);

      // Select: the click's topmost object, highlighted, named in the inspector; Tab / Shift+Tab step its stack.
      const p = await toPage(page, at);
      await page.mouse.click(p.x, p.y);
      await expect(mapObject(page)).toHaveAttribute("data-ref", ref);
      await expect(mapObject(page)).toHaveAttribute("data-hidden", "false");
      await expect(page.getByTestId("editor-map-object-symbol")).not.toBeEmpty();
      await expect(canvas).toHaveAttribute("data-selected-objects", "1");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(mapObject(page)).toHaveAttribute("data-ref", ref);

      // Delete hides it: one write, the op stored, the pixels gone.
      const hidden = waitForTrpc(page, "mapPatch.applyChange");
      await page.keyboard.press("Delete");
      await hidden;
      await expect(mapObject(page)).toHaveAttribute("data-hidden", "true");
      await expect(correction(page, `hide:${sourceIndex}`)).toBeVisible();
      await expect.poll(() => darkAt(page, at), { timeout: 15_000 }).toBe(false);
      expect(Object.keys((await trpcCall<Delivery>("mapPatch.get", undefined, false)).patch!.ops)).toEqual([`hide:${sourceIndex}`]);
      expect(writes.n).toBe(1);

      // Undo: the op goes and the line is back; redo hides it again; Restore brings it back (one entry each).
      await page.keyboard.press("Control+z");
      await expect(page.getByTestId("editor-corrections-none")).toBeVisible();
      await expect.poll(() => darkAt(page, at), { timeout: 15_000 }).toBe(true);
      await page.keyboard.press("Control+Shift+z");
      await expect(correction(page, `hide:${sourceIndex}`)).toBeVisible();
      await page.getByTestId("editor-map-object-restore").click();
      await expect(page.getByTestId("editor-corrections-none")).toBeVisible();
      await expect.poll(() => darkAt(page, at), { timeout: 15_000 }).toBe(true);
      expect(writes.n).toBe(4);

      // Move: a drag of the selected line writes one modify; the line is drawn where it was dropped.
      const q = await toPage(page, moved);
      await page.mouse.move(p.x, p.y);
      await page.mouse.down();
      await page.mouse.move(q.x, q.y, { steps: 8 });
      const modified = waitForTrpc(page, "mapPatch.applyChange");
      await page.mouse.up();
      const written = (await (await modified).json()) as { result: { data: { version: string } } }[] | { result: { data: { version: string } } };
      const version = (Array.isArray(written) ? written[0] : written).result.data.version;
      await expect(correction(page, `modify:${sourceIndex}`)).toBeVisible();
      await expect(canvas).toHaveAttribute("data-patch-version", version, { timeout: 15_000 });
      await expect.poll(async () => ({ old: await darkAt(page, at), now: await darkAt(page, moved) }), { timeout: 15_000 }).toEqual({ old: false, now: true });
      expect(writes.n).toBe(5);

      // Apply corrections off: the map as pinned, the list kept, hide and move disabled; on again.
      await page.getByTestId("editor-corrections-apply").uncheck();
      await expect(page.getByTestId("editor-map-disabled")).toBeVisible();
      await expect(correction(page, `modify:${sourceIndex}`)).toBeVisible();
      await expect.poll(async () => ({ old: await darkAt(page, at), now: await darkAt(page, moved) }), { timeout: 15_000 }).toEqual({ old: true, now: false });
      await expect(page.getByTestId("editor-map-object-hide")).toBeDisabled();
      await page.getByTestId("editor-corrections-apply").check();
      await expect(page.getByTestId("editor-map-disabled")).toHaveCount(0);
      await expect.poll(() => darkAt(page, moved), { timeout: 15_000 }).toBe(true);
      expect(writes.n).toBe(5);

      // Escape clears the selection.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-map-object-none")).toBeVisible();

      // A reload keeps the mode and the correction (the toggles moved the version on).
      const drawnBefore = (await canvas.getAttribute("data-patch-version"))!;
      expect(drawnBefore).not.toBe(version);
      await page.reload();
      await editorReady(page);
      await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
      await expect(correction(page, `modify:${sourceIndex}`)).toBeVisible();
      await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-patch-version", drawnBefore, { timeout: 30_000 });

      // The row locates its object; Revert removes the op.
      await correction(page, `modify:${sourceIndex}`).getByTestId("editor-correction-locate").click();
      await expect(mapObject(page)).toHaveAttribute("data-ref", ref);
      await correction(page, `modify:${sourceIndex}`).getByTestId("editor-correction-revert").click();
      await expect(page.getByTestId("editor-corrections-none")).toBeVisible();
      await expect.poll(async () => Object.keys((await trpcCall<Delivery>("mapPatch.get", undefined, false)).patch?.ops ?? {}), { timeout: 10_000 }).toEqual([]);
    } finally {
      await clearPatch();
    }
  });

  test("nodes (N): drag a node, live and written once; undo; insert on an edge; delete it; undo both", async ({ page }) => {
    test.setTimeout(240_000);
    try {
      await openEditor(page, "?mode=map");
      const canvas = page.getByTestId("map-vector-layer");
      await expect(canvas).toHaveAttribute("data-patch-version", /.+/, { timeout: 30_000 });
      await page.keyboard.press("h");
      await zoomTo(page, 16);
      const { at, sourceIndex } = await findLine(page);
      const ref = `source:${sourceIndex}`;
      const opsNow = async () => Object.keys((await trpcCall<Delivery>("mapPatch.get", undefined, false)).patch?.ops ?? {});
      const writes = countWrites(page);
      const p = await toPage(page, at);
      await page.mouse.click(p.x, p.y);
      await expect(mapObject(page)).toHaveAttribute("data-ref", ref);

      // N: the selected line's nodes, the gestures' hint; V is no longer armed.
      await page.keyboard.press("n");
      await expect(page.getByTestId("editor-tool-N")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByTestId("editor-map-nodes-hint")).toBeVisible();
      const nodes = () => toolShapes(page, "editor-map-node");
      await expect.poll(async () => (await nodes()).length).toBeGreaterThanOrEqual(2);
      const before = await nodes();
      const grips = await toolShapes(page, "editor-map-node-grip");
      const r = await freeRegion(page);
      const inView = async (q: Pt) => { const s = await toPage(page, q); return s.x > r.x0 && s.x < r.x1 && s.y > r.y0 && s.y < r.y1; };

      // Drag the node nearest the line's dark pixel 0.8 mm to where there is no ink (one of four directions).
      const visible: typeof before = [];
      for (const n of before) if (await inView(n)) visible.push(n);
      expect(visible.length, "a node in view").toBeGreaterThan(0);
      visible.sort((u, w) => Math.hypot(u.x - at.x, u.y - at.y) - Math.hypot(w.x - at.x, w.y - at.y));
      const node = visible[0];
      let target: Pt | null = null;
      for (const d of [{ x: 0, y: 0.8 }, { x: 0, y: -0.8 }, { x: 0.8, y: 0 }, { x: -0.8, y: 0 }]) {
        const q = { x: node.x + d.x, y: node.y + d.y };
        if ((await inView(q)) && !(await darkAt(page, q))) { target = q; break; }
      }
      expect(target, "an inkless spot 0.8 mm from the node").not.toBeNull();
      // The line through the node: ink within 1 mm of it along its edges (a path symbol is dashed, so the vertex itself
      // may fall in a gap).
      const ring = before.filter((n) => n.data.ring === node.data.ring);
      const k = ring.indexOf(node);
      const neighbours = [ring[k - 1], ring[k + 1]].filter((n): n is (typeof ring)[number] => !!n);
      const lineThrough = async (q: Pt, held = false) => {
        const probes: Pt[] = [];
        for (const nb of neighbours) {
          const len = Math.hypot(nb.x - q.x, nb.y - q.y);
          for (let d = 0; d <= Math.min(1, len); d += 0.1) probes.push({ x: q.x + ((nb.x - q.x) * d) / len, y: q.y + ((nb.y - q.y) * d) / len });
        }
        return (await inkedAt(page, probes, "line", held)).length > 0;
      };
      const from = await toPage(page, node), to = await toPage(page, target!);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      // Live: the line is drawn through the dragged node from the draft before anything is written (probed with the
      // overlays transparent, not hidden: a hidden one would make the pointer leave the viewer and cancel the drag).
      await expect.poll(() => lineThrough(target!, true), { timeout: 15_000 }).toBe(true);
      expect(writes.n).toBe(0);
      const dragged = waitForTrpc(page, "mapPatch.applyChange");
      await page.mouse.up();
      const written = (await (await dragged).json()) as { result: { data: { version: string } } }[] | { result: { data: { version: string } } };
      const version = (Array.isArray(written) ? written[0] : written).result.data.version;
      await expect(correction(page, `modify:${sourceIndex}`)).toBeVisible();
      await expect(canvas).toHaveAttribute("data-patch-version", version, { timeout: 15_000 });
      expect(await opsNow()).toEqual([`modify:${sourceIndex}`]);
      const moved = (await nodes()).find((n) => n.data.ring === node.data.ring && n.data.index === node.data.index)!;
      expect(Math.hypot(moved.x - target!.x, moved.y - target!.y)).toBeLessThan(0.1);
      expect(moved.data.focused).toBe("true");
      await expect.poll(() => lineThrough(moved), { timeout: 15_000 }).toBe(true);
      expect(writes.n).toBe(1);

      // Undo: no ops, the node back where it was.
      await page.keyboard.press("Control+z");
      await expect(page.getByTestId("editor-corrections-none")).toBeVisible();
      await expect.poll(async () => {
        const n = (await nodes()).find((x) => x.data.ring === node.data.ring && x.data.index === node.data.index)!;
        return Math.hypot(n.x - node.x, n.y - node.y) < 0.01;
      }, { timeout: 15_000 }).toBe(true);
      expect(writes.n).toBe(2);

      // Insert: a double-click on the middle of a straight edge (no grip on either side) adds a node there, focused.
      const curvedOut = new Set(grips.filter((g) => g.data.which === "out").map((g) => `${g.data.ring}:${g.data.index}`));
      const curvedIn = new Set(grips.filter((g) => g.data.which === "in").map((g) => `${g.data.ring}:${g.data.index}`));
      let mid: Pt | null = null, after = -1;
      for (let i = 0; i + 1 < before.length && !mid; i++) {
        const a = before[i], b = before[i + 1];
        if (a.data.ring !== b.data.ring || curvedOut.has(`${a.data.ring}:${a.data.index}`) || curvedIn.has(`${b.data.ring}:${b.data.index}`)) continue;
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (Math.hypot(b.x - a.x, b.y - a.y) >= 1.5 && (await inView(m))) { mid = m; after = Number(a.data.index); }
      }
      expect(mid, "a straight edge of 1.5 mm or more in view").not.toBeNull();
      const mp = await toPage(page, mid!);
      const inserted = waitForTrpc(page, "mapPatch.applyChange");
      await page.mouse.dblclick(mp.x, mp.y);
      await inserted;
      await expect.poll(async () => (await nodes()).length, { timeout: 15_000 }).toBe(before.length + 1);
      const focused = (await nodes()).filter((n) => n.data.focused === "true");
      expect(focused.map((n) => Number(n.data.index))).toEqual([after + 1]);
      expect(Math.hypot(focused[0].x - mid!.x, focused[0].y - mid!.y)).toBeLessThan(0.1);
      expect(await opsNow()).toEqual([`modify:${sourceIndex}`]);
      await expect(mapObject(page)).toHaveAttribute("data-ref", ref);
      expect(writes.n).toBe(3);

      // Delete removes the focused node (the object stays, not hidden).
      const deleted = waitForTrpc(page, "mapPatch.applyChange");
      await page.keyboard.press("Delete");
      await deleted;
      await expect.poll(async () => (await nodes()).length, { timeout: 15_000 }).toBe(before.length);
      await expect(mapObject(page)).toHaveAttribute("data-hidden", "false");
      expect(await opsNow()).toEqual([`modify:${sourceIndex}`]);
      expect(writes.n).toBe(4);

      // Undo twice: the inserted node back, then the document's line with no ops.
      await page.keyboard.press("Control+z");
      await expect.poll(async () => (await nodes()).length, { timeout: 15_000 }).toBe(before.length + 1);
      await page.keyboard.press("Control+z");
      await expect(page.getByTestId("editor-corrections-none")).toBeVisible();
      await expect.poll(async () => (await nodes()).length, { timeout: 15_000 }).toBe(before.length);
      expect(await opsNow()).toEqual([]);
      expect(writes.n).toBe(6);

      // Undo dropped the focus, so Escape takes N back to V: no nodes drawn, the line still selected.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-tool-layer").getByTestId("editor-map-node")).toHaveCount(0);
      await expect(mapObject(page)).toHaveAttribute("data-ref", ref);
    } finally {
      await clearPatch();
    }
  });
});

type Change = { put?: { op: string; id?: string; type?: number; sourceIndex?: number; symbol?: { doc?: number; patch?: string } }[]; remove?: string[]; putSymbols?: Record<string, unknown> };

/** Every `mapPatch.applyChange` input the page sends, in order (a batched request's own entry). */
function captureChanges(page: Page): Change[] {
  const out: Change[] = [];
  page.on("request", (req: Request) => {
    if (req.method() !== "POST") return;
    const procs = trpcProcedures(req.url());
    const k = procs.indexOf("mapPatch.applyChange");
    if (k < 0) return;
    const body = req.postDataJSON() as Record<string, unknown> | null;
    const entry = (body && (k.toString() in body ? body[k.toString()] : body)) as { json?: Change } & Change;
    out.push(entry?.json ?? entry);
  });
  return out;
}

/** Plain map spots (one colour within `clearMm`) in the free region, at least `apartMm` apart, nearest the middle first. */
async function plainSpots(page: Page, n: number, clearMm: number, apartMm: number): Promise<Pt[]> {
  const r = await freeRegion(page);
  const a = await toPaper(page, { x: r.x0 + 40, y: r.y0 + 40 }), b = await toPaper(page, { x: r.x1 - 40, y: r.y1 - 40 });
  const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x), minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
  const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const grid: Pt[] = [];
  for (let x = minX; x <= maxX; x += 1) for (let y = minY; y <= maxY; y += 1) grid.push({ x, y });
  grid.sort((u, w) => Math.hypot(u.x - centre.x, u.y - centre.y) - Math.hypot(w.x - centre.x, w.y - centre.y));
  const out: Pt[] = [];
  for (const p of await plainMapSpots(page, grid, clearMm)) {
    if (out.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < apartMm)) continue;
    out.push(p);
    if (out.length === n) return out;
  }
  throw new Error(`only ${out.length} of ${n} plain spots in view`);
}

const palette = (page: Page) => page.getByTestId("editor-map-palette");
const paletteItems = (page: Page, sel: string) => page.locator(`[data-testid="editor-map-palette-item"]${sel}:not([disabled])`);
const pressed = (page: Page, key: string) => expect(page.getByTestId(`editor-tool-${key}`)).toHaveAttribute("aria-pressed", "true");
/** What the event's print shows, as counts (`analysePdf`): an added object adds its strokes or curves. */
const printedCounts = async (page: Page) => {
  const p = await printed(page, EDITOR_EVENT, "allControls=1");
  return { strokes: p.strokes, curves: p.curves, curvedFills: p.curvedFills };
};
/**
 * The print's drawing: a hash of its inflated streams without the dates (the creation and modification dates sit in a
 * compressed object stream, so two prints a second apart differ there and nowhere else).
 */
const printedDrawing = async (page: Page): Promise<string> => {
  const res = await page.request.get(`/api/maps/${EDITOR_EVENT}/maps.pdf?allControls=1`);
  expect(res.ok()).toBe(true);
  const streams = inflatedStreams(await res.body()).map((x) => x.replace(/\/(CreationDate|ModDate) \(D:[^)]*\)/g, ""));
  return createHash("sha256").update(streams.join("\n")).digest("hex");
};

test.describe("Map mode drawing (docs/course-editor.md §13 \"Drawing\", \"Symbol picker\")", () => {
  test.describe.configure({ mode: "serial" });

  // A symbol's first use is only a first use on a patch without it, and patch symbols are never removed by a change.
  // The all-controls sheet is what `printedCounts` prints.
  let sheet: { drop: () => Promise<void> } | null = null;
  test.beforeAll(async () => {
    await dropEventPatch(EDITOR_EVENT);
    sheet = await allControlsSheet();
  });
  test.afterAll(async () => {
    await sheet?.drop();
    await dropEventPatch(EDITOR_EVENT);
  });

  async function open(page: Page): Promise<void> {
    await openEditor(page, "?mode=map");
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
    await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-patch-version", /.+/, { timeout: 30_000 });
    await page.keyboard.press("h");
    await zoomTo(page, 16);
  }

  test("L draws a path with a document line symbol: one add without putSymbols, drawn and printed; undo removes it", async ({ page }) => {
    test.setTimeout(240_000);
    try {
      await open(page);
      const [a] = await plainSpots(page, 1, 3, 0);
      const b = { x: a.x + 1.5, y: a.y + 0.8 }, c = { x: a.x + 2.5, y: a.y - 0.5 };
      const before = await printedCounts(page);
      const changes = captureChanges(page);

      // L: the picker for lines, nothing chosen yet; a click then draws nothing.
      await page.keyboard.press("l");
      await pressed(page, "L");
      await expect(palette(page)).toHaveAttribute("data-kind", "line");
      await expect(page.getByTestId("editor-map-palette-pick")).toBeVisible();
      const docLines = paletteItems(page, '[data-source="document"]');
      const paths = docLines.and(page.locator('[data-code^="505"], [data-code^="506"], [data-code^="507"]'));
      const item = (await paths.count()) > 0 ? paths.first() : docLines.first();
      const ref = (await item.getAttribute("data-ref"))!;
      await item.click();
      await expect(item).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-map-palette-hint")).toBeVisible();

      // Two clicks and a double-click: one write, the add with the document symbol, nothing to put.
      const pa = await toPage(page, a), pb = await toPage(page, b), pc = await toPage(page, c);
      await page.mouse.click(pa.x, pa.y);
      await page.mouse.click(pb.x, pb.y);
      const wrote = waitForTrpc(page, "mapPatch.applyChange");
      await page.mouse.dblclick(pc.x, pc.y);
      await wrote;
      expect(changes).toHaveLength(1);
      const add = changes[0].put![0];
      expect(add).toMatchObject({ op: "add", type: 2, symbol: { doc: Number(ref.slice(4)) } });
      expect(changes[0].putSymbols).toBeUndefined();

      // Back to V with the new path selected; its row; drawn through its nodes; in the print.
      await pressed(page, "V");
      await expect(mapObject(page)).toHaveAttribute("data-ref", `added:${add.id}`);
      await expect(correction(page, `add:${add.id}`)).toHaveAttribute("data-op", "add");
      await expect.poll(() => plainMapAt(page, b, 0.3), { timeout: 15_000 }).toBe(false);
      const after = await printedCounts(page);
      expect(after.strokes, "the path's strokes in maps.pdf").toBeGreaterThan(before.strokes);

      // Undo: the add goes, the map is plain there again.
      await page.keyboard.press("Control+z");
      await expect(page.getByTestId("editor-corrections-none")).toBeVisible();
      await expect.poll(() => plainMapAt(page, b, 0.3), { timeout: 15_000 }).toBe(true);
    } finally {
      await clearPatch();
    }
  });

  test("A closes an area on its first node; the choice survives a mode switch; drawing is off while corrections are off", async ({ page }) => {
    test.setTimeout(240_000);
    try {
      await open(page);
      const [a] = await plainSpots(page, 1, 3, 0);
      const b = { x: a.x + 2, y: a.y }, c = { x: a.x + 1, y: a.y + 1.8 };
      const changes = captureChanges(page);

      await page.keyboard.press("a");
      await pressed(page, "A");
      await expect(palette(page)).toHaveAttribute("data-kind", "area");
      const item = paletteItems(page, '[data-source="document"]').first();
      const ref = (await item.getAttribute("data-ref"))!;
      await item.click();

      // Leaving Map mode and coming back keeps the area tool's symbol (§13 "Drawing", "The symbol").
      await page.getByTestId("editor-mode-course").click();
      await page.getByTestId("editor-mode-map").click();
      await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
      await page.keyboard.press("a");
      await expect(page.locator(`[data-testid="editor-map-palette-item"][data-ref="${ref}"]`)).toHaveAttribute("aria-pressed", "true");

      // Three nodes, then a click on the first closes: one add of type 3 with the first point repeated at the end.
      const pa = await toPage(page, a), pb = await toPage(page, b), pc = await toPage(page, c);
      await page.mouse.click(pa.x, pa.y);
      await page.mouse.click(pb.x, pb.y);
      await page.mouse.click(pc.x, pc.y);
      const wrote = waitForTrpc(page, "mapPatch.applyChange");
      await page.mouse.click(pa.x, pa.y);
      await wrote;
      const add = changes[0].put![0] as { op: string; id: string; type: number; coords: number[][] };
      expect(add).toMatchObject({ op: "add", type: 3, symbol: { doc: Number(ref.slice(4)) } });
      expect(add.coords.at(-1)!.slice(0, 2)).toEqual(add.coords[0].slice(0, 2));
      await pressed(page, "V");
      await expect(mapObject(page)).toHaveAttribute("data-ref", `added:${add.id}`);

      // Apply corrections off: P, L, A disabled (their keys do nothing) and Change symbol too; on again.
      await page.getByTestId("editor-corrections-apply").uncheck();
      await expect(page.getByTestId("editor-map-disabled")).toBeVisible();
      for (const key of ["P", "L", "A"]) await expect(page.getByTestId(`editor-tool-${key}`)).toBeDisabled();
      await page.keyboard.press("p");
      await pressed(page, "V");
      await expect(page.getByTestId("editor-map-object-change-symbol")).toBeDisabled();
      await page.getByTestId("editor-corrections-apply").check();
      await expect(page.getByTestId("editor-tool-P")).toBeEnabled();
    } finally {
      await clearPatch();
    }
  });

  test("P places a point with a library symbol: materialised on first use, put once; the tool stays armed", async ({ page }) => {
    test.setTimeout(240_000);
    try {
      await open(page);
      const [s1, s2] = await plainSpots(page, 2, 1.5, 4);
      const before = await printedCounts(page);
      const changes = captureChanges(page);

      await page.keyboard.press("p");
      await pressed(page, "P");
      await expect(palette(page)).toHaveAttribute("data-kind", "point");
      const library = paletteItems(page, '[data-source="library"]');
      const boulder = library.and(page.locator('[data-code="204"]'));
      const item = (await boulder.count()) > 0 ? boulder.first() : library.first();
      const ref = (await item.getAttribute("data-ref"))!;
      expect(ref).toMatch(/^patch:/);
      const key = ref.slice(6);
      await item.click();

      // The first point: the add references the patch key and the change puts the materialised symbol.
      const p1 = await toPage(page, s1);
      let wrote = waitForTrpc(page, "mapPatch.applyChange");
      await page.mouse.click(p1.x, p1.y);
      await wrote;
      expect(changes[0].put![0]).toMatchObject({ op: "add", type: 1, symbol: { patch: key } });
      expect(Object.keys(changes[0].putSymbols ?? {})).toEqual([key]);
      // A probe wider than the symbol: one inside a 0.4 mm boulder reads as one plain colour.
      await expect.poll(() => plainMapAt(page, s1, 0.6), { timeout: 15_000 }).toBe(false);
      // Still armed, nothing selected; the item is the patch's own symbol now, still chosen.
      await pressed(page, "P");
      await expect(page.getByTestId("editor-map-object-none")).toBeVisible();
      await expect(page.locator(`[data-testid="editor-map-palette-item"][data-ref="${ref}"]`)).toHaveAttribute("data-source", "patch");
      await expect(page.locator(`[data-testid="editor-map-palette-item"][data-ref="${ref}"]`)).toHaveAttribute("aria-pressed", "true");

      // The second point puts no symbol again.
      const p2 = await toPage(page, s2);
      wrote = waitForTrpc(page, "mapPatch.applyChange");
      await page.mouse.click(p2.x, p2.y);
      await wrote;
      expect(changes).toHaveLength(2);
      expect(changes[1].put![0]).toMatchObject({ op: "add", type: 1, symbol: { patch: key } });
      expect(changes[1].putSymbols).toBeUndefined();
      await expect(page.locator('[data-testid="editor-correction-row"][data-op="add"]')).toHaveCount(2);
      const stored = (await trpcCall<{ patch: { symbols: Record<string, unknown> } | null }>("mapPatch.get", undefined, false)).patch;
      expect(Object.keys(stored?.symbols ?? {})).toEqual([key]);
      expect(await printedCounts(page), "the points in maps.pdf").not.toEqual(before);

      // Escape returns to V.
      await page.keyboard.press("Escape");
      await pressed(page, "V");
    } finally {
      await clearPatch();
    }
  });

  test("P with a turning symbol: a press-drag aims it (user 2026-11-15); Rotation turns it again", async ({ page }) => {
    test.setTimeout(240_000);
    try {
      await open(page);
      const [s1] = await plainSpots(page, 1, 2.5, 0);
      const changes = captureChanges(page);
      await page.keyboard.press("p");
      // A crossing point (519) or a small elongated knoll (110) turns with the object: orientation "object", a
      // rotatable glyph (ISOM 2017-2; the fixture's stack has black, not the brown point colour).
      const turning = paletteItems(page, "").and(page.locator('[data-code^="519"], [data-code^="110"]')).first();
      await expect(turning).toBeVisible();
      await turning.click();

      // Press at the spot, drag 2 mm up the paper (paper y is up): the knoll's x axis along the drag, 90°.
      const from = await toPage(page, s1), to = await toPage(page, { x: s1.x, y: s1.y + 2 });
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      await expect.poll(async () => (await toolShapes(page, "editor-map-point-direction")).length).toBe(1);
      let wrote = waitForTrpc(page, "mapPatch.applyChange");
      await page.mouse.up();
      const reply = (await (await wrote).json()) as { result: { data: { version: string } } }[] | { result: { data: { version: string } } };
      const version = (Array.isArray(reply) ? reply[0] : reply).result.data.version;
      const add = changes[0].put![0] as { op: string; id: string; angle?: number };
      expect(add).toMatchObject({ op: "add", type: 1 });
      expect(add.angle).toBe(900);

      // V, select it once the canvas draws it (the hit-test is over what is drawn): Rotation shows 90; 45 + Enter
      // rewrites the add with 450.
      await page.keyboard.press("Escape");
      await pressed(page, "V");
      await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-patch-version", version, { timeout: 15_000 });
      await page.mouse.click(from.x, from.y);
      await expect(mapObject(page)).toHaveAttribute("data-ref", `added:${add.id}`);
      const rotation = page.getByTestId("editor-map-object-rotation");
      await expect(rotation).toHaveValue("90");
      await rotation.fill("45");
      wrote = waitForTrpc(page, "mapPatch.applyChange");
      await rotation.press("Enter");
      await wrote;
      expect(changes[1].put).toEqual([{ ...add, angle: 450 }]);
      await expect(rotation).toHaveValue("45");
    } finally {
      await clearPatch();
    }
  });

  test("Change symbol on a document line: a resymbol, its own kind only, printed; Revert", async ({ page }) => {
    test.setTimeout(240_000);
    try {
      await open(page);
      const { at, sourceIndex } = await findLine(page);
      const p = await toPage(page, at);
      await page.mouse.click(p.x, p.y);
      await expect(mapObject(page)).toHaveAttribute("data-ref", `source:${sourceIndex}`);
      const before = await printedDrawing(page);
      expect(await printedDrawing(page), "the print's drawing is the same without a change").toBe(before);
      const changes = captureChanges(page);

      const change = page.getByTestId("editor-map-object-change-symbol");
      await change.click();
      await expect(change).toHaveAttribute("aria-expanded", "true");
      await expect(palette(page)).toHaveAttribute("data-kind", "line");
      expect(await page.locator('[data-testid="editor-map-palette-item"]:not([data-kind="line"])').count()).toBe(0);
      const own = page.locator('[data-testid="editor-map-palette-item"][aria-pressed="true"]');
      await expect(own).toHaveCount(1);
      const other = paletteItems(page, '[data-source="document"][aria-pressed="false"]').first();
      const ref = (await other.getAttribute("data-ref"))!;
      const wrote = waitForTrpc(page, "mapPatch.applyChange");
      await other.click();
      await wrote;
      expect(changes[0].put).toEqual([{ op: "resymbol", sourceIndex, symbol: { doc: Number(ref.slice(4)) } }]);
      await expect(change).toHaveAttribute("aria-expanded", "false");
      await expect(correction(page, `resymbol:${sourceIndex}`)).toHaveAttribute("data-op", "resymbol");
      await expect(mapObject(page)).toHaveAttribute("data-ref", `source:${sourceIndex}`);
      expect(await printedDrawing(page), "the resymbolled line in maps.pdf").not.toBe(before);

      // Revert: the op goes and the print draws the line as before.
      await correction(page, `resymbol:${sourceIndex}`).getByTestId("editor-correction-revert").click();
      await expect(page.getByTestId("editor-corrections-none")).toBeVisible();
      expect(await printedDrawing(page)).toBe(before);
    } finally {
      await clearPatch();
    }
  });
});

type Coord = number[];
type OpChange = { put?: { op: string; id?: string; type?: number; symbol?: { doc?: number; patch?: string }; coords?: Coord[] }[]; remove?: string[] };
/** The anchors of a coordinate list (the Bézier controls, flags 1 and 2, left out), as `[x, y]`. */
const anchorsOf = (coords: Coord[]) => coords.filter((c) => ((c[2] ?? 0) & 3) === 0).map((c) => [c[0], c[1]]);
const opsOf = async () => (await trpcCall<{ version: string; patch: { ops: Record<string, { coords?: Coord[] }> } | null }>("mapPatch.get", undefined, false)).patch?.ops ?? {};

test.describe("Map mode line and area operations (docs/course-editor.md §13 \"Line and area operations\", G10)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await dropEventPatch(EDITOR_EVENT);
  });
  test.afterAll(async () => {
    await dropEventPatch(EDITOR_EVENT);
  });

  async function open(page: Page): Promise<void> {
    await openEditor(page, "?mode=map");
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
    await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-patch-version", /.+/, { timeout: 30_000 });
    await page.keyboard.press("h");
    await zoomTo(page, 16);
  }

  /** Draws a line through `pts` with a document line symbol (`L`, Enter ends it): its add id, selected after. */
  async function drawLine(page: Page, pts: Pt[]): Promise<string> {
    await page.keyboard.press("l");
    await pressed(page, "L");
    const chosen = page.locator('[data-testid="editor-map-palette-item"][aria-pressed="true"]');
    if ((await chosen.count()) === 0) {
      const docLines = paletteItems(page, '[data-source="document"]');
      const paths = docLines.and(page.locator('[data-code^="505"], [data-code^="506"], [data-code^="507"]'));
      await ((await paths.count()) > 0 ? paths.first() : docLines.first()).click();
    }
    for (const p of pts) {
      const q = await toPage(page, p);
      await page.mouse.click(q.x, q.y);
    }
    const wrote = waitForTrpc(page, "mapPatch.applyChange");
    await page.keyboard.press("Enter");
    await wrote;
    await pressed(page, "V");
    await expect(mapObject(page)).toHaveAttribute("data-ref", /^added:/, { timeout: 15_000 });
    return (await mapObject(page).getAttribute("data-ref"))!.slice("added:".length);
  }

  test("Reverse and Split at node on a drawn line: one write each, the start part stays the object; undo", async ({ page }) => {
    test.setTimeout(240_000);
    try {
      await open(page);
      const [a] = await plainSpots(page, 1, 3, 0);
      const id = await drawLine(page, [{ x: a.x - 2, y: a.y }, { x: a.x, y: a.y + 0.8 }, { x: a.x + 2, y: a.y }]);
      const drawn = (await opsOf())[`add:${id}`].coords!;
      const changes = captureChanges(page) as OpChange[];

      // Reverse: the add rewritten with its nodes in the other order; one row still.
      await expect(page.getByTestId("editor-map-object-cut-hole")).toHaveCount(0);
      const reversed = waitForTrpc(page, "mapPatch.applyChange");
      await page.getByTestId("editor-map-object-reverse").click();
      await reversed;
      expect(changes).toHaveLength(1);
      expect(changes[0].put).toHaveLength(1);
      expect(changes[0].put![0]).toMatchObject({ op: "add", id, type: 2 });
      expect(anchorsOf(changes[0].put![0].coords!)).toEqual(anchorsOf(drawn).reverse());
      await expect(page.getByTestId("editor-correction-row")).toHaveCount(1);
      await page.keyboard.press("Control+z");
      await expect.poll(async () => JSON.stringify((await opsOf())[`add:${id}`]?.coords), { timeout: 15_000 }).toBe(JSON.stringify(drawn));

      // Split at node: needs a focused node between the ends (N).
      const split = page.getByTestId("editor-map-object-split");
      await expect(split).toHaveAttribute("data-reason", "no-node");
      await expect(split).toBeDisabled();
      await page.keyboard.press("n");
      await expect.poll(async () => (await toolShapes(page, "editor-map-node")).length).toBeGreaterThanOrEqual(3);
      const nodes = await toolShapes(page, "editor-map-node");
      const end = await toPage(page, nodes[0]);
      await page.mouse.click(end.x, end.y);
      await expect(split).toHaveAttribute("data-reason", "end-node");
      const middle = nodes[Math.floor(nodes.length / 2)];
      const mp = await toPage(page, middle);
      await page.mouse.click(mp.x, mp.y);
      await expect.poll(async () => (await toolShapes(page, "editor-map-node")).find((n) => n.data.focused === "true")?.data.index).toBe(middle.data.index);
      await expect(split).toBeEnabled();
      const wrote = waitForTrpc(page, "mapPatch.applyChange");
      await split.click();
      await wrote;
      const c = changes[changes.length - 1];
      expect(c.put).toHaveLength(2);
      expect(c.put![0]).toMatchObject({ op: "add", id, type: 2 });
      expect(c.put![1]).toMatchObject({ op: "add", type: 2, symbol: changes[0].put![0].symbol });
      expect(c.put![1].id).not.toBe(id);
      const head = anchorsOf(c.put![0].coords!), tail = anchorsOf(c.put![1].coords!);
      expect(head.at(-1)).toEqual(tail[0]);
      expect(head.length + tail.length - 1).toBe(anchorsOf(drawn).length);
      await expect(page.getByTestId("editor-correction-row")).toHaveCount(2);
      await expect(mapObject(page)).toHaveAttribute("data-ref", `added:${id}`);

      // Undo: one line of all its nodes again.
      await page.keyboard.press("Control+z");
      await expect(page.getByTestId("editor-correction-row")).toHaveCount(1);
      expect(JSON.stringify((await opsOf())[`add:${id}`].coords)).toBe(JSON.stringify(drawn));
    } finally {
      await clearPatch();
    }
  });

  test("Join: a one-shot pick that Escape drops; the picked line's add removed, a straight segment between the ends; undo", async ({ page }) => {
    test.setTimeout(240_000);
    try {
      await open(page);
      const [a] = await plainSpots(page, 1, 3, 0);
      // The picked line first, then the survivor (selected after drawing), their ends 2 mm apart around `a`.
      const picked = await drawLine(page, [{ x: a.x + 1, y: a.y }, { x: a.x + 2.8, y: a.y }]);
      const survivor = await drawLine(page, [{ x: a.x - 2.8, y: a.y }, { x: a.x - 1, y: a.y }]);
      expect(picked).not.toBe(survivor);
      await expect.poll(() => plainMapAt(page, a, 0.3), { timeout: 15_000 }).toBe(true);
      const changes = captureChanges(page) as OpChange[];

      const join = page.getByTestId("editor-map-object-join");
      await join.click();
      await expect(join).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-map-join-hint")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(join).toHaveAttribute("aria-pressed", "false");
      await expect(mapObject(page)).toHaveAttribute("data-ref", `added:${survivor}`);
      await join.click();
      await expect(join).toHaveAttribute("aria-pressed", "true");
      const q = await toPage(page, { x: a.x + 1.9, y: a.y });
      const wrote = waitForTrpc(page, "mapPatch.applyChange");
      await page.mouse.click(q.x, q.y);
      await wrote;
      expect(changes).toHaveLength(1);
      expect(changes[0].remove).toEqual([`add:${picked}`]);
      expect(changes[0].put).toHaveLength(1);
      expect(changes[0].put![0]).toMatchObject({ op: "add", id: survivor });
      expect(anchorsOf(changes[0].put![0].coords!)).toHaveLength(4);
      await expect(join).toHaveAttribute("aria-pressed", "false");
      await expect(page.getByTestId("editor-correction-row")).toHaveCount(1);
      await expect(mapObject(page)).toHaveAttribute("data-ref", `added:${survivor}`);
      // The straight segment between the ends is drawn.
      await expect.poll(() => plainMapAt(page, a, 0.3), { timeout: 15_000 }).toBe(false);

      // Undo: both lines again, nothing between them.
      await page.keyboard.press("Control+z");
      await expect(page.getByTestId("editor-correction-row")).toHaveCount(2);
      await expect.poll(() => plainMapAt(page, a, 0.3), { timeout: 15_000 }).toBe(true);
    } finally {
      await clearPatch();
    }
  });

  test("Cut hole with the area gesture, Remove hole from a focused node in N; undo; off while corrections are off", async ({ page }) => {
    test.setTimeout(240_000);
    try {
      await open(page);
      const [a] = await plainSpots(page, 1, 3, 0);
      await page.keyboard.press("a");
      await pressed(page, "A");
      await paletteItems(page, '[data-source="document"]').first().click();
      const outline = [{ x: a.x - 3, y: a.y - 2 }, { x: a.x + 3, y: a.y - 2 }, { x: a.x, y: a.y + 3 }];
      for (const p of outline) {
        const q = await toPage(page, p);
        await page.mouse.click(q.x, q.y);
      }
      let wrote = waitForTrpc(page, "mapPatch.applyChange");
      const first = await toPage(page, outline[0]);
      await page.mouse.click(first.x, first.y);
      await wrote;
      await pressed(page, "V");
      await expect(mapObject(page)).toHaveAttribute("data-ref", /^added:/);
      const id = (await mapObject(page).getAttribute("data-ref"))!.slice("added:".length);
      const changes = captureChanges(page) as OpChange[];

      // Cut hole: armed (pressed, its hint), the ring drawn with the area gesture, closed on its first node.
      const cut = page.getByTestId("editor-map-object-cut-hole");
      await expect(page.getByTestId("editor-map-object-remove-hole")).toHaveCount(0);
      await cut.click();
      await expect(cut).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-map-hole-hint")).toBeVisible();
      const ring = [{ x: a.x - 1, y: a.y - 1 }, { x: a.x + 1, y: a.y - 1 }, { x: a.x, y: a.y + 0.8 }];
      for (const p of ring) {
        const q = await toPage(page, p);
        await page.mouse.click(q.x, q.y);
      }
      wrote = waitForTrpc(page, "mapPatch.applyChange");
      const r0 = await toPage(page, ring[0]);
      await page.mouse.click(r0.x, r0.y);
      await wrote;
      expect(changes).toHaveLength(1);
      expect(changes[0].put).toHaveLength(1);
      expect(changes[0].put![0]).toMatchObject({ op: "add", id, type: 3 });
      expect(changes[0].put![0].coords!.filter((c) => ((c[2] ?? 0) & 16) !== 0)).toHaveLength(1);
      await expect(cut).toHaveAttribute("aria-pressed", "false");
      await expect(mapObject(page)).toHaveAttribute("data-ref", `added:${id}`);
      await expect(page.getByTestId("editor-correction-row")).toHaveCount(1);

      // Remove hole: in N, a node of the hole focused.
      const remove = page.getByTestId("editor-map-object-remove-hole");
      await expect(remove).toHaveAttribute("data-reason", "no-hole-node");
      await page.keyboard.press("n");
      await expect.poll(async () => (await toolShapes(page, "editor-map-node")).filter((n) => n.data.ring === "1").length, { timeout: 15_000 }).toBe(3);
      const holeNode = (await toolShapes(page, "editor-map-node")).find((n) => n.data.ring === "1")!;
      const hp = await toPage(page, holeNode);
      await page.mouse.click(hp.x, hp.y);
      await expect(remove).toBeEnabled();
      wrote = waitForTrpc(page, "mapPatch.applyChange");
      await remove.click();
      await wrote;
      const last = changes[changes.length - 1];
      expect(last.put![0]).toMatchObject({ op: "add", id, type: 3 });
      expect(last.put![0].coords!.filter((c) => ((c[2] ?? 0) & 16) !== 0)).toHaveLength(0);
      await expect.poll(async () => (await toolShapes(page, "editor-map-node")).filter((n) => n.data.ring === "1").length, { timeout: 15_000 }).toBe(0);
      await expect(remove).toHaveCount(0);

      // Undo: the hole back.
      await page.keyboard.press("Control+z");
      await expect.poll(async () => (await toolShapes(page, "editor-map-node")).filter((n) => n.data.ring === "1").length, { timeout: 15_000 }).toBe(3);

      // Apply corrections off: the operations are disabled.
      await page.getByTestId("editor-corrections-apply").uncheck();
      await expect(page.getByTestId("editor-map-disabled")).toBeVisible();
      await expect(cut).toBeDisabled();
      await expect(remove).toBeDisabled();
      await page.getByTestId("editor-corrections-apply").check();
      await expect(cut).toBeEnabled();
    } finally {
      await clearPatch();
    }
  });
});

/** `file` through the upload route (one chunk, finalised): its source hash, for `clubMap.addFromSource`. */
async function uploadSource(file: string, fileName: string): Promise<string> {
  const headers = { "x-event-id": EDITOR_EVENT, "x-competition-id": EDITOR_EVENT, "x-forwarded-email": "e2e-admin@oxygen.test" };
  const bytes = readFileSync(file);
  const init = await fetch(`${API_BASE}/api/map-uploads`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ fileName, bytes: bytes.byteLength, chunkBytes: bytes.byteLength }),
  });
  expect(init.status).toBe(201);
  const { uploadId } = (await init.json()) as { uploadId: string };
  const put = await fetch(`${API_BASE}/api/map-uploads/${uploadId}/chunks/0`, { method: "PUT", headers: { ...headers, "content-type": "application/octet-stream" }, body: bytes });
  expect(put.status).toBe(204);
  return ((await (await fetch(`${API_BASE}/api/map-uploads/${uploadId}/finalise`, { method: "POST", headers })).json()) as { fileHash: string }).fileHash;
}

type Meta = { documentHash: string | null; clubMapVersionId: string | null };

/**
 * `mapPatch.promoteStatus` answered as a running job (another session's promote, §13 "Promote"): the batched GET is
 * fetched and its slot for the procedure replaced. A real job on the fixture ends inside the 30 s hold.
 */
async function routePromoteRunning(page: Page): Promise<() => Promise<void>> {
  const running = { id: "00000000-0000-4000-8000-0000000000e2", state: "running", stage: "match", progress: 0.55, error: null };
  const matcher = (url: URL) => trpcProcedures(url.toString()).includes("mapPatch.promoteStatus");
  await page.route(matcher, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const k = trpcProcedures(route.request().url()).indexOf("mapPatch.promoteStatus");
    const res = await route.fetch();
    const body = (await res.json()) as unknown;
    const slot = { result: { data: running } };
    const json = Array.isArray(body) ? body.map((x, i) => (i === k ? slot : x)) : slot;
    await route.fulfill({ response: res, json });
  });
  return () => page.unroute(matcher);
}
type Card = { id: string; version: { id: string; seq: number; label: string; layers: number; corrections: number } | null; fileName: string | null };

test.describe("Map mode promote (docs/course-editor.md §13 \"Promote\"; 08 §7)", () => {
  test.describe.configure({ mode: "serial" });

  // The event's map is moved onto a club version and a series is made: reseeded before and after, the series removed.
  let clubMapId: string | null = null;
  test.beforeAll(reseed);
  test.afterAll(async () => {
    if (clubMapId) await trpcCall("clubMap.remove", { id: clubMapId }).catch(() => undefined);
    await reseed();
  });

  test("hide an object, add a path, save them to the club map: the next version, the event on it, its patch empty; the card; delete", async ({ page }) => {
    test.setTimeout(300_000);
    await openEditor(page, "?mode=map");
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
    await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-patch-version", /.+/, { timeout: 30_000 });
    // The seed's own upload is no club version: promote is not offered.
    expect((await trpcCall<Meta>("course.mapMetadata", undefined, false)).clubMapVersionId).toBeNull();
    await expect(page.getByTestId("editor-map-promote")).toHaveCount(0);

    // The same file into the club library (version 1, the same document by dedup), and the event onto it.
    const fileHash = await uploadSource("e2e/test.ocd", "test.ocd");
    const created = await trpcCall<{ id: string; importJob: { state: string } | null }>("clubMap.addFromSource", { fileHash, fileName: "test.ocd", name: "E2E promote" });
    clubMapId = created.id;
    expect(created.importJob?.state).toBe("done");
    await trpcCall("course.useClubMap", { clubMapId });
    await expect.poll(async () => (await trpcCall<Meta>("course.mapMetadata", undefined, false)).clubMapVersionId, { timeout: 60_000 }).not.toBeNull();
    const v1 = await trpcCall<Meta>("course.mapMetadata", undefined, false);
    expect(v1.documentHash).toMatch(/^[0-9a-f]{64}$/);

    // A promote running (as another session's would be): Map mode read-only, the progress shown.
    const unroute = await routePromoteRunning(page);
    await page.reload();
    await editorReady(page);
    await expect(page.getByTestId("editor-map-promoting")).toHaveAttribute("data-state", "running", { timeout: 30_000 });
    await expect(page.getByTestId("editor-map-promote")).toHaveAttribute("data-block", "running");
    await expect(page.getByTestId("editor-corrections-apply")).toBeDisabled();
    for (const key of ["P", "L", "A"]) await expect(page.getByTestId(`editor-tool-${key}`)).toBeDisabled();
    await unroute();

    await page.reload();
    await editorReady(page);
    await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-patch-version", /.+/, { timeout: 30_000 });
    await expect(page.getByTestId("editor-map-promoting")).toHaveCount(0);
    await page.keyboard.press("h");
    await zoomTo(page, 16);
    const promote = page.getByTestId("editor-map-promote");
    await expect(promote).toBeDisabled();
    await expect(page.getByTestId("editor-map-promote-reason")).toHaveAttribute("data-reason", "nothing");

    // Hide a lone line (UI).
    const { at, sourceIndex } = await findLine(page);
    const p = await toPage(page, at);
    await page.mouse.click(p.x, p.y);
    await expect(mapObject(page)).toHaveAttribute("data-ref", `source:${sourceIndex}`);
    const hidden = waitForTrpc(page, "mapPatch.applyChange");
    await page.keyboard.press("Delete");
    await hidden;
    await expect(correction(page, `hide:${sourceIndex}`)).toBeVisible();
    await page.keyboard.press("Escape");

    // Draw a path with a document line symbol (UI).
    const [a] = await plainSpots(page, 1, 3, 0);
    const b = { x: a.x + 1.5, y: a.y + 0.8 }, c = { x: a.x + 2.5, y: a.y - 0.5 };
    await page.keyboard.press("l");
    const docLines = paletteItems(page, '[data-source="document"]');
    const paths = docLines.and(page.locator('[data-code^="505"], [data-code^="506"], [data-code^="507"]'));
    await ((await paths.count()) > 0 ? paths.first() : docLines.first()).click();
    const pa = await toPage(page, a), pb = await toPage(page, b), pc = await toPage(page, c);
    await page.mouse.click(pa.x, pa.y);
    await page.mouse.click(pb.x, pb.y);
    const drew = waitForTrpc(page, "mapPatch.applyChange");
    await page.mouse.dblclick(pc.x, pc.y);
    await drew;
    await pressed(page, "V");
    await expect(page.getByTestId("editor-corrections-count")).toHaveAttribute("data-count", "2");
    await expect.poll(() => plainMapAt(page, b, 0.3), { timeout: 15_000 }).toBe(false);
    await page.keyboard.press("Escape");

    // Save corrections to the club map: a confirm with the label prefilled from the event; one promote.
    await expect(promote).toBeEnabled();
    await promote.click();
    const dialog = page.getByTestId("editor-map-promote-dialog");
    await expect(dialog).toBeVisible();
    const dashboard = await trpcCall<{ event: { name: string } }>("competition.dashboard", undefined, false);
    await expect.poll(() => page.getByTestId("editor-map-promote-label").inputValue()).toContain(dashboard.event.name);
    await page.getByTestId("editor-map-promote-label").fill("E2E promoted");
    const writes = countWrites(page);
    const promoted = waitForTrpc(page, "mapPatch.promote", { timeout: 60_000 });
    await page.getByTestId("editor-map-promote-confirm").click();
    await promoted;
    await expect(page.getByTestId("editor-map-promote-done")).toBeVisible({ timeout: 60_000 });

    // The event is on version 2, its baked document; the promoted ops left its patch; the drawing is the same.
    await expect.poll(async () => (await trpcCall<Meta>("course.mapMetadata", undefined, false)).documentHash, { timeout: 60_000 }).not.toBe(v1.documentHash);
    const v2 = await trpcCall<Meta>("course.mapMetadata", undefined, false);
    expect(v2.clubMapVersionId).not.toBe(v1.clubMapVersionId);
    expect(Object.keys((await trpcCall<Delivery>("mapPatch.get", undefined, false)).patch?.ops ?? {})).toEqual([]);
    await expect(page.getByTestId("editor-corrections-count")).toHaveAttribute("data-count", "0", { timeout: 30_000 });
    await expect.poll(async () => ({ line: await darkAt(page, at), path: !(await plainMapAt(page, b, 0.3)) }), { timeout: 30_000 }).toEqual({ line: false, path: true });
    // Not an undo entry, and Map mode's earlier entries went (answer 6): Ctrl+Z writes nothing.
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(1_000);
    expect(writes.n).toBe(0);

    // The Club maps card: version 2, its label, the corrections and the original-file note; the file is the source's.
    const card = (await trpcCall<Card[]>("clubMap.list", undefined, false)).find((m) => m.id === clubMapId)!;
    expect(card.version).toMatchObject({ seq: 2, label: "E2E promoted", layers: 1, corrections: 2 });
    expect(card.fileName).toBe("test.ocd");
    await page.goto("/settings");
    const row = page.getByTestId(`library-map-card-${clubMapId}`);
    await expect(row.getByTestId("library-map-version")).toHaveAttribute("data-seq", "2", { timeout: 15_000 });
    await expect(row.getByTestId("library-map-version-label")).toContainText("E2E promoted");
    await expect(row.getByTestId("library-map-corrections")).toBeVisible();
    await expect(row.getByTestId("library-map-version")).toHaveAttribute("data-corrections", "2");

    // Delete version 2: version 1 is the latest again; the event keeps its document but no longer has a version.
    await row.getByTestId("library-map-delete-version").click();
    await page.getByTestId("library-version-delete-confirm-btn").click();
    await expect(row.getByTestId("library-map-version")).toHaveAttribute("data-seq", "1", { timeout: 15_000 });
    await expect(row.getByTestId("library-map-delete-version")).toHaveCount(0);
    const after = await trpcCall<Meta>("course.mapMetadata", undefined, false);
    expect(after).toMatchObject({ documentHash: v2.documentHash, clubMapVersionId: null });
    await page.goto(`/${EDITOR_EVENT}/course-editor?mode=map`);
    await editorReady(page);
    await expect(page.getByTestId("editor-inspector-map-object")).toBeVisible();
    await expect(page.getByTestId("editor-map-promote")).toHaveCount(0);
  });
});
