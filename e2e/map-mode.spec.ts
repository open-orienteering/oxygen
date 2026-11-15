/**
 * Map mode (docs/course-editor.md §13, rows G6, G7): the event's map corrections in the editor — select, hide, move,
 * undo, the course overprint hidden, *Apply corrections*, the patch kept across a reload, and the nodes tool `N`
 * (drag, insert, delete, undo; §13 "Nodes"). The fixture is the
 * seed's `itest` event with `e2e/test.ocd` pinned; every op is removed in `finally` (AGENTS.md §12), so no reseed.
 *
 * The target is a black line with no other black ink within 1 mm across it (the fixture draws its lines over a
 * yellow area), found on the canvas at a zoom where 1 mm is ≥ 16 px and checked against the document
 * (`mapObjectsAt`): the only point or line object within 0.5 mm, so hiding it leaves no black there.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import { EDITOR_EVENT, editorReady, inkedAt, openEditor, paperToPageOf, sites, toPage, toPaper, toolShapes, trpcCall, viewSettled } from "./helpers/editor";
import { mapObjectsAt } from "./helpers/event-map-pin";
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
      const from = await toPage(page, node), to = await toPage(page, target!);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 8 });
      // Live: the line is drawn through the dragged node from the draft before anything is written.
      await expect.poll(() => darkAt(page, target!), { timeout: 15_000 }).toBe(true);
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
      await expect.poll(() => darkAt(page, target!), { timeout: 15_000 }).toBe(true);
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
