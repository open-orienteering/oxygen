/**
 * GPS tracks in Map mode (docs/course-editor.md §13 "GPS tracks"; docs/map-gps-tracks.md §5.1; row G25): import a
 * GPX by the file picker, the list's rows, the reference layer drawn where the fixture's points project, locate,
 * hide (kept on the device across a reload), rename, delete and its undo, and a reload keeping the tracks. Row G26
 * (§13 "GPS tracks: convert"; docs/map-gps-tracks.md §6): a converted track hidden unless *Show converted*, and the
 * fixture track converted into a ski-O track line — the op, the canvas, `maps.pdf`, undo and redo, a second
 * conversion moving the mark, and the settings and symbol remembered across a reload.
 *
 * The fixture `e2e/fixtures/gps-tracks.gpx` is synthetic, generated from the frame of `e2e/test.ocd` — the map the
 * seed's `itest` event pins — by `packages/api/scripts/generate-test-gpx.ts`, which also writes the paper mm the
 * editor must draw (`gps-tracks.json`). Every track of the event is removed before and in `finally` (AGENTS.md §12),
 * so no reseed.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page, type Request } from "@playwright/test";
import { allControlsSheet, EDITOR_EVENT, editorReady, openEditor, printed, toPage, trpcCall, viewSettled } from "./helpers/editor";
import { dropEventPatch } from "./helpers/event-map-pin";
import { trpcProcedures, waitForTrpc } from "./helpers/trpc";

type Pt = { x: number; y: number };
type Expected = { name: string; points: number; lengthM: number; outside: number; mm: [number, number][]; recordedAt: number | null };
const FIXTURE = "e2e/fixtures/gps-tracks.gpx";
const expected = (JSON.parse(readFileSync("e2e/fixtures/gps-tracks.json", "utf8")) as { tracks: Expected[] }).tracks;
const [inside, outside] = expected;
const KML = '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>';
/** The fixture's first track alone, renamed: the file dropped on the panel. */
const DROPPED = readFileSync(FIXTURE, "utf8").replace(/\s*<trk><name>E2E outside<\/name>[\s\S]*?<\/trk>/, "").replace("E2E inside", "Dropped");
const CONVERTED = "add:00000000-0000-7000-8000-0000000000c1";

async function clearTracks(): Promise<void> {
  const { tracks } = await trpcCall<{ tracks: { id: string }[] }>("mapTrack.list", undefined, false);
  if (tracks.length > 0) await trpcCall("mapTrack.remove", { ids: tracks.map((t) => t.id) });
}

const rows = (page: Page) => page.getByTestId("editor-track-row");
const rowNamed = (page: Page, name: string) => rows(page).filter({ has: page.getByTestId("editor-track-name").getByText(name, { exact: true }) });
const paths = (page: Page) => page.getByTestId("editor-gps-track");
const pathOf = (page: Page, id: string) => page.locator(`[data-testid="editor-gps-track"][data-track-id="${id}"]`);

type Change = { put?: { op: string; id: string; type: number; symbol: Record<string, unknown>; coords: number[][] }[]; remove?: string[]; putSymbols?: Record<string, unknown> };
type Listed = { id: string; convertedOp: string | null };
/** The ski-O track symbol converted to: ISSkiOM 801.1, on every map since G21 (the Ski-O green in the stack). */
const SKI_TRACK = "ISSkiOM2019:801.1";

/** The `mapPatch.applyChange` bodies the page sends. */
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

/**
 * The canvas's colour around paper points (the mean of 3 × 3 canvas pixels each), from one screenshot of the canvas
 * alone: the UI layer — the reference tracks — is not in it.
 */
async function canvasAt(page: Page, pts: readonly Pt[]): Promise<number[][]> {
  const { PNG } = await import("pngjs");
  const canvas = page.getByTestId("map-vector-layer");
  const png = PNG.sync.read(await canvas.screenshot({ style: "body * { visibility: hidden !important } [data-testid='map-vector-layer'] { visibility: visible !important }" }));
  const cb = (await canvas.boundingBox())!;
  const k = png.width / cb.width;
  const out: number[][] = [];
  for (const pt of pts) {
    const q = await toPage(page, pt);
    const px = Math.floor((q.x - cb.x) * k), py = Math.floor((q.y - cb.y) * k);
    const sum = [0, 0, 0];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const i = ((py + dy) * png.width + (px + dx)) * 4;
      for (let c = 0; c < 3; c++) sum[c] += png.data[i + c];
    }
    out.push(sum.map((v) => v / 9));
  }
  return out;
}
const colourDiff = (a: number[][], b: number[][]): number => Math.min(...a.map((p, i) => p.reduce((s, v, c) => s + Math.abs(v - b[i][c]), 0)));

/** A path's drawn vertices, paper mm (`data-points`). */
async function drawn(page: Page, id: string): Promise<Pt[]> {
  const raw = (await pathOf(page, id).getAttribute("data-points"))!;
  return raw.split(" ").map((p) => {
    const [x, y] = p.split(",").map(Number);
    return { x, y };
  });
}

test.describe("GPS tracks in Map mode (docs/course-editor.md §13)", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(clearTracks);
  test.afterAll(clearTracks);

  test("import, drawn where the points project, locate, hide, rename, delete and undo, reload keeps them", async ({ page }) => {
    test.setTimeout(180_000);
    try {
      await openEditor(page, "?mode=map");
      await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
      const section = page.getByTestId("editor-tracks");
      await expect(section).toBeVisible();
      await expect(page.getByTestId("editor-tracks-disabled")).toHaveCount(0);
      await expect(page.getByTestId("editor-tracks-none")).toBeVisible({ timeout: 15_000 });

      // ─── Import two files by the picker: the fixture, and a KML that is no GPX ──
      const imported = waitForTrpc(page, "mapTrack.import");
      await page.getByTestId("editor-tracks-file").setInputFiles([
        { name: "gps-tracks.gpx", mimeType: "application/gpx+xml", buffer: readFileSync(FIXTURE) },
        { name: "not-a-track.gpx", mimeType: "application/gpx+xml", buffer: Buffer.from(KML) },
      ]);
      await imported;
      await expect(page.getByTestId("editor-tracks-import-result")).toHaveAttribute("data-imported", "2");
      const error = page.getByTestId("editor-tracks-import-error");
      await expect(error).toHaveCount(1);
      await expect(error).toHaveAttribute("data-file", "not-a-track.gpx");
      await expect(error).toHaveAttribute("data-code", "not-gpx");

      // ─── The rows: file order, points, ground length, outside, date ──
      await expect(rows(page)).toHaveCount(2);
      await expect(rows(page).nth(0).getByTestId("editor-track-name")).toHaveText(inside.name);
      await expect(rows(page).nth(1).getByTestId("editor-track-name")).toHaveText(outside.name);
      const a = rowNamed(page, inside.name), b = rowNamed(page, outside.name);
      for (const [row, e] of [[a, inside], [b, outside]] as const) {
        await expect(row).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
        await expect(row).toHaveAttribute("data-points", String(e.points));
        expect(Math.abs(Number(await row.getAttribute("data-length-m")) - e.lengthM)).toBeLessThanOrEqual(0.2);
        await expect(row).toHaveAttribute("data-outside", String(e.outside));
        await expect(row).toHaveAttribute("data-visible", "true");
        await expect(row).toHaveAttribute("data-converted", "false");
      }
      await expect(b.getByTestId("editor-track-outside")).toBeVisible();
      await expect(a.getByTestId("editor-track-outside")).toHaveCount(0);
      await expect(b.getByTestId("editor-track-date")).toHaveText("—");
      await expect(a.getByTestId("editor-track-date")).not.toHaveText("—");
      const idA = (await a.getAttribute("data-track-id"))!, idB = (await b.getAttribute("data-track-id"))!;
      const colour = await a.getByTestId("editor-track-swatch").getAttribute("data-colour");
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);

      // ─── The layer: two paths in the track colours, at the fixture's paper mm ──
      await expect(paths(page)).toHaveCount(2);
      await expect(pathOf(page, idA)).toHaveAttribute("stroke", colour!);
      const pts = await drawn(page, idA);
      // An L of five points: decimation keeps the ends and the corner whatever the zoom.
      const corner = inside.mm[2];
      for (const want of [inside.mm[0], corner, inside.mm[4]]) {
        expect(pts.some((p) => Math.abs(p.x - want[0]) <= 0.01 && Math.abs(p.y - want[1]) <= 0.01), `vertex ${want}`).toBe(true);
      }
      expect(pts[0].x).toBeCloseTo(inside.mm[0][0], 2);
      expect(pts[pts.length - 1].x).toBeCloseTo(inside.mm[4][0], 2);
      // Points past the map's edge are drawn too (§3.2): the straight track is its two ends, the last 50 mm outside.
      const far = (await drawn(page, idB)).at(-1)!;
      expect(far.x).toBeCloseTo(outside.mm[outside.mm.length - 1][0], 2);
      expect(far.y).toBeCloseTo(outside.mm[outside.mm.length - 1][1], 2);

      // ─── Locate: the view fits the track (its box centred) and the path lies where its points project ──
      await a.getByTestId("editor-track-name").click();
      await viewSettled(page);
      const viewer = page.getByTestId("map-viewer");
      const cx = (Math.min(...inside.mm.map((p) => p[0])) + Math.max(...inside.mm.map((p) => p[0]))) / 2;
      const cy = (Math.min(...inside.mm.map((p) => p[1])) + Math.max(...inside.mm.map((p) => p[1]))) / 2;
      expect(Math.abs(Number(await viewer.getAttribute("data-centre-x")) / 1000 - cx)).toBeLessThan(0.5);
      expect(Math.abs(Number(await viewer.getAttribute("data-centre-y")) / 1000 - cy)).toBeLessThan(0.5);
      const box = (await pathOf(page, idA).boundingBox())!;
      const ends = await Promise.all([inside.mm[0], inside.mm[4]].map(([x, y]) => toPage(page, { x, y })));
      const cornerPx = await toPage(page, { x: corner[0], y: corner[1] });
      const xs = [ends[0].x, ends[1].x, cornerPx.x], ys = [ends[0].y, ends[1].y, cornerPx.y];
      expect(Math.abs(box.x - Math.min(...xs))).toBeLessThanOrEqual(3);
      expect(Math.abs(box.x + box.width - Math.max(...xs))).toBeLessThanOrEqual(3);
      expect(Math.abs(box.y - Math.min(...ys))).toBeLessThanOrEqual(3);
      expect(Math.abs(box.y + box.height - Math.max(...ys))).toBeLessThanOrEqual(3);

      // ─── Elsewhere (G26 / G27 to come) the second track was trimmed and converted: the reload below shows both ──
      await trpcCall("mapTrack.update", { id: idB, trim: { start: 0, end: 3 } });
      await trpcCall("mapTrack.markConverted", { marks: [{ id: idB, opId: CONVERTED }] });

      // ─── Hide: gone from the layer, kept on this device across a reload; show again ──
      await a.getByTestId("editor-track-visible").click();
      await expect(a).toHaveAttribute("data-visible", "false");
      await expect(a.getByTestId("editor-track-visible")).toHaveAttribute("aria-pressed", "false");
      await expect(pathOf(page, idA)).toHaveCount(0);
      await expect(pathOf(page, idB)).toHaveCount(1);
      await page.reload();
      await editorReady(page);
      await expect(rowNamed(page, inside.name)).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
      await expect(rowNamed(page, inside.name)).toHaveAttribute("data-visible", "false");
      // B is converted now (G26, docs/map-gps-tracks.md §6 answer 1): hidden by default, kept in the list with its mark.
      const bTrimmed = rowNamed(page, outside.name);
      await expect(bTrimmed).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
      await expect(bTrimmed).toHaveAttribute("data-visible", "false");
      await expect(pathOf(page, idB)).toHaveCount(0);
      await expect(pathOf(page, idA)).toHaveCount(0);
      await rowNamed(page, inside.name).getByTestId("editor-track-visible").click();
      await expect(pathOf(page, idA)).toHaveCount(1);
      // The trimmed range is what is counted and drawn; the converted mark shows.
      await expect(bTrimmed).toHaveAttribute("data-points", "3");
      await expect(bTrimmed).toHaveAttribute("data-converted", "true");
      await expect(bTrimmed.getByTestId("editor-track-converted")).toBeVisible();
      // Show converted brings it back (per device), the eye still wins: shown here, B's own eye hides it again.
      await page.getByTestId("editor-tracks-show-converted").check();
      await expect(bTrimmed).toHaveAttribute("data-visible", "true");
      await expect(pathOf(page, idB)).toHaveCount(1);
      await bTrimmed.getByTestId("editor-track-visible").click();
      await expect(pathOf(page, idB)).toHaveCount(0);
      await bTrimmed.getByTestId("editor-track-visible").click();
      await expect(pathOf(page, idB)).toHaveCount(1);

      // ─── Rename ──
      await rowNamed(page, inside.name).getByTestId("editor-track-rename").click();
      const input = page.getByTestId("editor-track-name-input");
      await input.fill("Morning loop");
      const updated = waitForTrpc(page, "mapTrack.update");
      await input.press("Enter");
      await updated;
      await expect(rows(page).nth(0).getByTestId("editor-track-name")).toHaveText("Morning loop");
      // Rename is one undo entry: undo, redo.
      let named = waitForTrpc(page, "mapTrack.update");
      await page.keyboard.press("Control+z");
      await named;
      await expect(rows(page).nth(0).getByTestId("editor-track-name")).toHaveText(inside.name);
      named = waitForTrpc(page, "mapTrack.update");
      await page.keyboard.press("Control+Shift+z");
      await named;
      await expect(rows(page).nth(0).getByTestId("editor-track-name")).toHaveText("Morning loop");

      // ─── Delete, then undo it: back under the same id ──
      const removed = waitForTrpc(page, "mapTrack.remove");
      await rowNamed(page, outside.name).getByTestId("editor-track-delete").click();
      await removed;
      await expect(rows(page)).toHaveCount(1);
      await expect(pathOf(page, idB)).toHaveCount(0);
      expect((await trpcCall<{ tracks: { id: string }[] }>("mapTrack.list", undefined, false)).tracks.map((t) => t.id)).toEqual([idA]);
      const restored = waitForTrpc(page, "mapTrack.import");
      await page.keyboard.press("Control+z");
      await restored;
      await expect(rows(page)).toHaveCount(2);
      const back = page.locator(`[data-testid="editor-track-row"][data-track-id="${idB}"]`);
      await expect(back).toHaveAttribute("data-state", "ready");
      await expect(pathOf(page, idB)).toHaveCount(1);
      // Its trim and converted mark came back with it.
      await expect(back).toHaveAttribute("data-points", "3");
      await expect(back).toHaveAttribute("data-converted", "true");
      const again = (await trpcCall<{ tracks: { id: string; trim: { start: number; end: number }; convertedOp: string | null }[] }>("mapTrack.list", undefined, false)).tracks;
      expect(again.find((t) => t.id === idB)).toMatchObject({ trim: { start: 0, end: 3 }, convertedOp: CONVERTED });

      // ─── Import by a drop on the panel ──
      const dropped = await page.evaluateHandle((text) => {
        const dt = new DataTransfer();
        dt.items.add(new File([text], "dropped.gpx", { type: "application/gpx+xml" }));
        return dt;
      }, DROPPED);
      const zone = page.getByTestId("editor-tracks-drop");
      await zone.dispatchEvent("dragover", { dataTransfer: dropped });
      await expect(zone).toHaveAttribute("data-drag-over", "true");
      const droppedIn = waitForTrpc(page, "mapTrack.import");
      await zone.dispatchEvent("drop", { dataTransfer: dropped });
      await droppedIn;
      await expect(zone).not.toHaveAttribute("data-drag-over", "true");
      await expect(page.getByTestId("editor-tracks-import-result")).toHaveAttribute("data-imported", "1");
      await expect(rows(page)).toHaveCount(3);
      await expect(rowNamed(page, "Dropped")).toHaveAttribute("data-state", "ready");
      const idC = (await rowNamed(page, "Dropped").getAttribute("data-track-id"))!;

      // ─── A reload keeps them: both rows, the new name, both paths ──
      await page.reload();
      await editorReady(page);
      await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
      await expect(rows(page)).toHaveCount(3);
      await expect(rows(page).nth(0).getByTestId("editor-track-name")).toHaveText("Morning loop");
      await expect(paths(page)).toHaveCount(3, { timeout: 15_000 });
      const stored = (await trpcCall<{ tracks: { id: string; name: string | null; pointCount: number }[] }>("mapTrack.list", undefined, false)).tracks;
      expect(stored.map((t) => [t.id, t.name, t.pointCount])).toEqual([
        [idA, "Morning loop", inside.points], [idB, outside.name, outside.points], [idC, "Dropped", inside.points],
      ]);
    } finally {
      await clearTracks().catch(() => undefined);
    }
  });

  test("convert the fixture track into a ski-O track line: preview, one add, in the frame and maps.pdf, undo, redo, again, remembered", async ({ page }) => {
    test.setTimeout(240_000);
    // A symbol's first use is a first use only on a patch without it (patch symbols are never removed by a change).
    await dropEventPatch(EDITOR_EVENT);
    const sheet = await allControlsSheet();
    try {
      await openEditor(page, "?mode=map");
      await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
      await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-patch-version", /.+/, { timeout: 30_000 });
      await page.keyboard.press("h"); // the course overprint hidden: the canvas shows the map alone
      await expect(page.getByTestId("editor-tracks-none")).toBeVisible({ timeout: 15_000 });
      const imported = waitForTrpc(page, "mapTrack.import");
      await page.getByTestId("editor-tracks-file").setInputFiles([{ name: "gps-tracks.gpx", mimeType: "application/gpx+xml", buffer: readFileSync(FIXTURE) }]);
      await imported;
      const a = rowNamed(page, inside.name);
      await expect(a).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
      const idA = (await a.getAttribute("data-track-id"))!;
      await a.getByTestId("editor-track-name").click();
      await viewSettled(page);

      // The legs' middles (the ends are pinned, the corner is cut by smoothing): the canvas there before.
      const legs: Pt[] = [{ x: inside.mm[1][0], y: inside.mm[1][1] }, { x: inside.mm[3][0], y: inside.mm[3][1] }];
      const plain = await canvasAt(page, legs);
      const before = await printed(page, EDITOR_EVENT, "allControls=1");

      // Convert is off until a track is selected; the panel opens on V with nothing chosen.
      const convertButton = page.getByTestId("editor-tracks-convert");
      await expect(convertButton).toBeDisabled();
      await a.getByTestId("editor-track-select").check();
      await expect(convertButton).toBeEnabled();
      await convertButton.click();
      const panel = page.getByTestId("editor-tracks-convert-panel");
      await expect(panel).toBeVisible();
      await expect(page.getByTestId("editor-tool-V")).toHaveAttribute("aria-pressed", "true");
      await expect(panel.getByTestId("editor-map-palette")).toHaveAttribute("data-kind", "line");
      await expect(panel.getByTestId("editor-map-palette-group").first()).toHaveAttribute("data-group", "ISSkiOM2019");
      await expect(panel.getByTestId("editor-map-palette-pick")).toBeVisible();
      await expect(panel.locator('[data-testid="editor-map-palette-item"][aria-pressed="true"]')).toHaveCount(0);
      await expect(page.getByTestId("editor-tracks-convert-apply")).toBeDisabled();
      // The defaults (§6 answer 3) and a live node count.
      await expect(page.getByTestId("editor-tracks-convert-smoothing")).toHaveValue("10");
      await expect(page.getByTestId("editor-tracks-convert-tolerance")).toHaveValue("0.1");
      const nodes = page.getByTestId("editor-tracks-convert-nodes");
      expect(Number(await nodes.getAttribute("data-nodes"))).toBeGreaterThanOrEqual(3);
      await expect(page.getByTestId("editor-tracks-convert-warning")).toHaveCount(0);
      // No smoothing: the L's three corners (the two near-collinear points within 0.1 mm dropped).
      await page.getByTestId("editor-tracks-convert-smoothing").fill("0");
      await expect(nodes).toHaveAttribute("data-nodes", "3");

      // Pick the ski track: the preview is drawn in it on the canvas before anything is written.
      const writes = captureChanges(page);
      const ski = panel.locator(`[data-testid="editor-map-palette-item"][data-ref="patch:${SKI_TRACK}"]:not([disabled])`);
      await ski.click();
      await expect(ski).toHaveAttribute("aria-pressed", "true");
      await expect.poll(async () => colourDiff(await canvasAt(page, legs), plain), { timeout: 15_000 }).toBeGreaterThan(30);
      expect(writes).toHaveLength(0);

      // Convert: one change with the add and the symbol's first use, then the mark; the track hidden, kept, marked.
      const wrote = waitForTrpc(page, "mapPatch.applyChange");
      let marked = waitForTrpc(page, "mapTrack.markConverted");
      await page.getByTestId("editor-tracks-convert-apply").click();
      await wrote;
      await marked;
      expect(writes).toHaveLength(1);
      const add = writes[0].put![0];
      expect(writes[0].put).toHaveLength(1);
      expect(add).toMatchObject({ op: "add", type: 2, symbol: { patch: SKI_TRACK } });
      expect(Object.keys(writes[0].putSymbols ?? {})).toEqual([SKI_TRACK]);
      // e2e/test.ocd: 100 units per mm; the fixture's corners, rounded.
      expect(add.coords).toEqual([[-1500, 1000], [-1500, -1000], [1500, -1000]]);
      const opId = `add:${add.id}`;
      await expect(panel).toHaveCount(0);
      await expect(a).toHaveAttribute("data-converted", "true");
      await expect(a).toHaveAttribute("data-visible", "false");
      await expect(a.getByTestId("editor-track-select")).not.toBeChecked();
      await expect(pathOf(page, idA)).toHaveCount(0);
      await expect(page.locator(`[data-testid="editor-correction-row"][data-op-id="${opId}"]`)).toHaveAttribute("data-op", "add");
      const listed = async () => (await trpcCall<{ tracks: Listed[] }>("mapTrack.list", undefined, false)).tracks.find((t) => t.id === idA)?.convertedOp;
      expect(await listed()).toBe(opId);
      // In the frame and in maps.pdf.
      await expect.poll(async () => colourDiff(await canvasAt(page, legs), plain), { timeout: 15_000 }).toBeGreaterThan(30);
      const after = await printed(page, EDITOR_EVENT, "allControls=1");
      expect(after.strokes, "the line's strokes in maps.pdf").toBeGreaterThan(before.strokes);

      // Show converted: the reference is drawn again over the line; off again.
      const show = page.getByTestId("editor-tracks-show-converted");
      await show.check();
      await expect(pathOf(page, idA)).toHaveCount(1);
      await show.uncheck();
      await expect(pathOf(page, idA)).toHaveCount(0);

      // Undo: the add goes and the mark is cleared — one entry; the frame and the print as before.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      let unmarked = waitForTrpc(page, "mapTrack.markConverted");
      await page.keyboard.press("Control+z");
      await unmarked;
      await expect(page.getByTestId("editor-corrections-none")).toBeVisible();
      await expect(a).toHaveAttribute("data-converted", "false");
      await expect(a).toHaveAttribute("data-visible", "true");
      await expect(pathOf(page, idA)).toHaveCount(1);
      expect(await listed()).toBeNull();
      await expect.poll(async () => colourDiff(await canvasAt(page, legs), plain), { timeout: 15_000 }).toBeLessThan(12);
      expect((await printed(page, EDITOR_EVENT, "allControls=1")).strokes).toBe(before.strokes);

      // Redo: the line and the mark again.
      marked = waitForTrpc(page, "mapTrack.markConverted");
      await page.keyboard.press("Control+Shift+z");
      await marked;
      await expect(a).toHaveAttribute("data-converted", "true");
      expect(await listed()).toBe(opId);

      // Convert again (it stays available on a converted track): a new line, the mark moves to it; its undo moves it
      // back to the first line's op (§6 answer 1). The symbol is remembered: Convert is ready at once.
      await a.getByTestId("editor-track-select").check();
      await convertButton.click();
      await expect(ski).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-tracks-convert-smoothing")).toHaveValue("0");
      const again = waitForTrpc(page, "mapTrack.markConverted");
      await page.getByTestId("editor-tracks-convert-apply").click();
      await again;
      expect(writes.length).toBe(4); // the first, its undo (a remove), its redo, this one
      const second = writes.at(-1)!.put![0];
      expect(second.id).not.toBe(add.id);
      expect(writes.at(-1)!.putSymbols).toBeUndefined(); // the patch holds the symbol now
      expect(await listed()).toBe(`add:${second.id}`);
      await expect(page.getByTestId("editor-correction-row")).toHaveCount(2);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      unmarked = waitForTrpc(page, "mapTrack.markConverted");
      await page.keyboard.press("Control+z");
      await unmarked;
      await expect(page.getByTestId("editor-correction-row")).toHaveCount(1);
      expect(await listed()).toBe(opId);

      // Settings and symbol remembered on the device: a reload opens the panel at 0.3 mm with the ski track chosen;
      // Cancel and Escape close it without a write.
      await a.getByTestId("editor-track-select").check();
      await convertButton.click();
      await page.getByTestId("editor-tracks-convert-tolerance").fill("0.3");
      await expect(page.getByTestId("editor-tracks-convert-tolerance")).toHaveValue("0.3");
      await page.getByTestId("editor-tracks-convert-cancel").click();
      await expect(panel).toHaveCount(0);
      await page.reload();
      await editorReady(page);
      await expect(a).toHaveAttribute("data-state", "ready", { timeout: 15_000 });
      await a.getByTestId("editor-track-select").check();
      await convertButton.click();
      await expect(page.getByTestId("editor-tracks-convert-tolerance")).toHaveValue("0.3");
      await expect(page.getByTestId("editor-tracks-convert-smoothing")).toHaveValue("0");
      await expect(panel.locator(`[data-testid="editor-map-palette-item"][data-ref="patch:${SKI_TRACK}"]`)).toHaveAttribute("aria-pressed", "true");
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const count = writes.length;
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      expect(writes.length).toBe(count);
    } finally {
      await sheet.drop().catch(() => undefined);
      await dropEventPatch(EDITOR_EVENT).catch(() => undefined);
      await clearTracks().catch(() => undefined);
    }
  });

  test("off on a venue node: the reason, no import, no mapTrack request", async ({ page }) => {
    test.setTimeout(120_000);
    // The node answers as a venue box (`lease.status.nodeRole`, docs/map-gps-tracks.md §1.3, §5.1).
    await page.route(/\/trpc\/[^?]*lease\.status/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, body: (await res.text()).replace(/"nodeRole":"[a-z]+"/g, '"nodeRole":"venue"') });
    });
    const trackCalls: string[] = [];
    page.on("request", (r) => { if (/\/trpc\/[^?]*mapTrack\./.test(r.url())) trackCalls.push(r.url()); });
    await openEditor(page, "?mode=map");
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
    const off = page.getByTestId("editor-tracks-disabled");
    await expect(off).toBeVisible({ timeout: 15_000 });
    await expect(off).toHaveAttribute("data-reason", "venue");
    await expect(page.getByTestId("editor-tracks-import")).toHaveCount(0);
    await expect(page.getByTestId("editor-tracks-file")).toHaveCount(0);
    // The rest of Map mode is unchanged: the corrections section is there.
    await expect(page.getByTestId("editor-corrections")).toBeVisible();
    await page.waitForTimeout(1000);
    expect(trackCalls).toEqual([]);
  });
});
