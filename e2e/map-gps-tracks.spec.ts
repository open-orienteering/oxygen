/**
 * GPS tracks in Map mode (docs/course-editor.md §13 "GPS tracks"; docs/map-gps-tracks.md §5.1; row G25): import a
 * GPX by the file picker, the list's rows, the reference layer drawn where the fixture's points project, locate,
 * hide (kept on the device across a reload), rename, delete and its undo, and a reload keeping the tracks.
 *
 * The fixture `e2e/fixtures/gps-tracks.gpx` is synthetic, generated from the frame of `e2e/test.ocd` — the map the
 * seed's `itest` event pins — by `packages/api/scripts/generate-test-gpx.ts`, which also writes the paper mm the
 * editor must draw (`gps-tracks.json`). Every track of the event is removed before and in `finally` (AGENTS.md §12),
 * so no reseed.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { editorReady, openEditor, toPage, trpcCall, viewSettled } from "./helpers/editor";
import { waitForTrpc } from "./helpers/trpc";

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
      await expect(pathOf(page, idB)).toHaveCount(1);
      await expect(pathOf(page, idA)).toHaveCount(0);
      await rowNamed(page, inside.name).getByTestId("editor-track-visible").click();
      await expect(pathOf(page, idA)).toHaveCount(1);
      // The trimmed range is what is counted and drawn; the converted mark shows.
      const bTrimmed = rowNamed(page, outside.name);
      await expect(bTrimmed).toHaveAttribute("data-points", "3");
      await expect(bTrimmed).toHaveAttribute("data-converted", "true");
      await expect(bTrimmed.getByTestId("editor-track-converted")).toBeVisible();

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
