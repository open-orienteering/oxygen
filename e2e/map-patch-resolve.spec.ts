/**
 * Corrections the pin move could not carry over (docs/course-editor.md §13 "Unresolved"; docs/map-patches.md §4,
 * row G11). On the seed's `itest` (`e2e/test.ocd` pinned) two objects are hidden through the API; then the event's
 * map is replaced by another edition (`e2e/test.xmap`, through the upload route and `course.applyUploadedMap`, so the
 * import job's pin re-keys the patch on the server). Map mode lists both hides under *Not carried over*: a row click
 * centres the view on the entry's old place; *Drop* removes one (undo puts it back, redo drops it again, a reload
 * keeps it gone), *Attach* puts the other onto the object selected on the map (undo and redo likewise); a `symbol`
 * entry's *Attach* takes a symbol from the palette (row G12b). The spec changes the event's map, so it reseeds before
 * and after (AGENTS.md §12).
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import { API_BASE } from "./helpers/api-base";
import { EDITOR_EVENT, editorReady, nameIdOf, openEditor, toPaper, trpcCall, viewSettled } from "./helpers/editor";
import { reseed } from "./helpers/reseed";
import { trpcProcedures, waitForTrpc } from "./helpers/trpc";

type Unresolved = Record<string, { op: { op: string; sourceIndex?: number }; reason: string; from: string; target?: { centreMm: [number, number] } }>;
type Delivery = { version: string; patch: { documentHash: string; enabled: boolean; ops: Record<string, unknown>; unresolved?: Unresolved } | null };

const HEADERS = { "x-event-id": EDITOR_EVENT, "x-competition-id": EDITOR_EVENT, "x-forwarded-email": "e2e-admin@oxygen.test" };

/** The event's map replaced by `file` as the map panel does it: one chunk, finalise, `course.applyUploadedMap` (waits for the import). */
async function replaceEventMap(file: string, fileName: string): Promise<string> {
  const bytes = readFileSync(file);
  const init = await fetch(`${API_BASE}/api/map-uploads`, {
    method: "POST", headers: { ...HEADERS, "content-type": "application/json" }, body: JSON.stringify({ fileName, bytes: bytes.byteLength, chunkBytes: bytes.byteLength }),
  });
  expect(init.status).toBe(201);
  const { uploadId } = (await init.json()) as { uploadId: string };
  const put = await fetch(`${API_BASE}/api/map-uploads/${uploadId}/chunks/0`, { method: "PUT", headers: { ...HEADERS, "content-type": "application/octet-stream" }, body: bytes });
  expect(put.status).toBe(204);
  const { fileHash } = (await (await fetch(`${API_BASE}/api/map-uploads/${uploadId}/finalise`, { method: "POST", headers: HEADERS })).json()) as { fileHash: string };
  const applied = await trpcCall<{ documentHash: string | null }>("course.applyUploadedMap", { fileHash, fileName });
  expect(applied.documentHash).toMatch(/^[0-9a-f]{64}$/);
  return applied.documentHash!;
}

const unresolvedRows = (page: Page) => page.getByTestId("editor-correction-unresolved");

/** Every input the page sends to `procedure`, in order (a batched request's own entry). */
function captureCalls(page: Page, procedure: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  page.on("request", (req: Request) => {
    if (req.method() !== "POST") return;
    const k = trpcProcedures(req.url()).indexOf(procedure);
    if (k < 0) return;
    const body = req.postDataJSON() as Record<string, unknown> | null;
    const entry = (body && (k.toString() in body ? body[k.toString()] : body)) as { json?: Record<string, unknown> } & Record<string, unknown>;
    out.push(entry?.json ?? entry);
  });
  return out;
}

/** The paper point at the viewer's centre (where a locate puts its target). */
async function viewCentre(page: Page): Promise<{ x: number; y: number }> {
  const v = (await page.getByTestId("map-viewer").boundingBox())!;
  return toPaper(page, { x: v.x + v.width / 2, y: v.y + v.height / 2 });
}

test.describe("Corrections not carried over (docs/course-editor.md §13 \"Unresolved\")", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(reseed);
  test.afterAll(reseed);

  test("a new edition lists the hides it could not carry over; drop one, attach the other to the selection", async ({ page }) => {
    test.setTimeout(240_000);
    // The seed's event gets its courses and `test.ocd` on first open (`ensureCoursesAndMap`).
    await openEditor(page);
    const before = await trpcCall<Delivery>("mapPatch.get", undefined, false);
    const meta = await trpcCall<{ documentHash: string | null }>("course.mapMetadata", undefined, false);
    const ocdHash = meta.documentHash!;
    expect(before.patch).toBeNull();
    await trpcCall("mapPatch.applyChange", { documentHash: ocdHash, put: [{ op: "hide", sourceIndex: 0 }, { op: "hide", sourceIndex: 1 }] });

    const xmapHash = await replaceEventMap("e2e/test.xmap", "test.xmap");
    expect(xmapHash).not.toBe(ocdHash);
    const moved = await trpcCall<Delivery>("mapPatch.get", undefined, false);
    expect(moved.patch!.documentHash).toBe(xmapHash);
    const keys = Object.keys(moved.patch!.unresolved ?? {}).sort();
    expect(keys).toHaveLength(2);
    expect(Object.keys(moved.patch!.ops)).toEqual([]);

    await page.goto(`/${nameIdOf(page)}/course-editor?mode=map`);
    await editorReady(page);
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-mode", "map");
    const block = page.getByTestId("editor-corrections-unresolved");
    await expect(block).toHaveAttribute("data-count", "2", { timeout: 30_000 });
    await expect(page.getByTestId("editor-corrections-count")).toHaveAttribute("data-count", "0");
    await expect(unresolvedRows(page)).toHaveCount(2);
    for (const [i, key] of keys.entries()) {
      const row = unresolvedRows(page).nth(i);
      await expect(row).toHaveAttribute("data-key", key);
      await expect(row).toHaveAttribute("data-op", "hide");
      await expect(row).toHaveAttribute("data-reason", "target");
    }
    // Nothing selected: attach waits for a selection; drop is there.
    await expect(unresolvedRows(page).first().getByTestId("editor-correction-attach")).toBeDisabled();
    await expect(unresolvedRows(page).first().getByTestId("editor-correction-drop")).toBeEnabled();

    // A row click centres the view on the entry's old place (its target's box centre, paper mm; G12b).
    await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-patch-version", /.+/, { timeout: 30_000 });
    const centre = moved.patch!.unresolved![keys[1]].target!.centreMm;
    await unresolvedRows(page).nth(1).getByTestId("editor-correction-unresolved-locate").click();
    await viewSettled(page);
    const c = await viewCentre(page);
    expect(Math.hypot(c.x - centre[0], c.y - centre[1]), "the view centred on the entry").toBeLessThan(0.5);

    // Drop the first: one applyChange with removeUnresolved, the row gone.
    const changes = captureCalls(page, "mapPatch.applyChange");
    const dropped = waitForTrpc(page, "mapPatch.applyChange");
    await unresolvedRows(page).first().getByTestId("editor-correction-drop").click();
    await dropped;
    await expect(unresolvedRows(page)).toHaveCount(1);
    await expect(unresolvedRows(page).first()).toHaveAttribute("data-key", keys[1]);
    expect(Object.keys((await trpcCall<Delivery>("mapPatch.get", undefined, false)).patch!.unresolved ?? {})).toEqual([keys[1]]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ removeUnresolved: [keys[0]] });

    // Undo puts it back exactly (one applyChange with putUnresolved), redo drops it again (G12b: an undo entry).
    const undone = waitForTrpc(page, "mapPatch.applyChange");
    await page.keyboard.press("Control+z");
    await undone;
    await expect(unresolvedRows(page)).toHaveCount(2);
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({ putUnresolved: { [keys[0]]: moved.patch!.unresolved![keys[0]] } });
    expect((await trpcCall<Delivery>("mapPatch.get", undefined, false)).patch!.unresolved).toEqual(moved.patch!.unresolved);
    const redone = waitForTrpc(page, "mapPatch.applyChange");
    await page.keyboard.press("Control+Shift+z");
    await redone;
    await expect(unresolvedRows(page)).toHaveCount(1);
    expect(changes).toHaveLength(3);
    expect(changes[2]).toMatchObject({ removeUnresolved: [keys[0]] });

    // Gone after a reload.
    await page.reload();
    await expect(block).toHaveAttribute("data-count", "1", { timeout: 30_000 });

    // Select an object of the new edition: the overprint hidden (H), the map fitted (F), then the first click in the
    // part of the viewer no editor chrome covers whose topmost hit is a document object.
    await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-patch-version", /.+/, { timeout: 30_000 });
    await page.keyboard.press("h");
    await page.keyboard.press("f");
    await viewSettled(page);
    const object = page.getByTestId("editor-map-object");
    const v = (await page.getByTestId("map-viewer").boundingBox())!;
    const insp = (await page.getByTestId("editor-inspector").boundingBox())!;
    const x0 = Math.max(v.x + v.width * 0.2, insp.x + insp.width + 30), x1 = v.x + v.width * 0.9;
    const spots = [0.5, 0.3, 0.7, 0.1, 0.9].flatMap((fx) => [0.5, 0.3, 0.7].map((fy) => ({ x: x0 + (x1 - x0) * fx, y: v.y + v.height * fy })));
    for (const p of spots) {
      await page.mouse.click(p.x, p.y);
      if (await expect(object).toHaveAttribute("data-ref", /^source:\d+$/, { timeout: 2_000 }).then(() => true, () => false)) break;
    }
    await expect(object).toHaveAttribute("data-ref", /^source:\d+$/);
    const sourceIndex = Number((await object.getAttribute("data-ref"))!.slice("source:".length));
    const attach = unresolvedRows(page).first().getByTestId("editor-correction-attach");
    await expect(attach).toBeEnabled();
    const attached = waitForTrpc(page, "mapPatch.attachUnresolved");
    await attach.click();
    await attached;
    await expect(block).toHaveCount(0);
    await expect(page.locator(`[data-testid="editor-correction-row"][data-op-id="hide:${sourceIndex}"]`)).toBeVisible();
    await expect(object).toHaveAttribute("data-hidden", "true");
    const after = (await trpcCall<Delivery>("mapPatch.get", undefined, false)).patch!;
    expect(after.ops).toEqual({ [`hide:${sourceIndex}`]: { op: "hide", sourceIndex } });
    expect(after.unresolved).toBeUndefined();

    // Undo: the hide goes and the entry is back, through one applyChange; redo attaches again through the procedure.
    const changes2 = captureCalls(page, "mapPatch.applyChange");
    const undoAttach = waitForTrpc(page, "mapPatch.applyChange");
    await page.keyboard.press("Control+z");
    await undoAttach;
    await expect(block).toHaveAttribute("data-count", "1");
    await expect(page.locator(`[data-testid="editor-correction-row"][data-op-id="hide:${sourceIndex}"]`)).toHaveCount(0);
    await expect(object).toHaveAttribute("data-hidden", "false");
    expect(changes2[0]).toMatchObject({ remove: [`hide:${sourceIndex}`], putUnresolved: { [keys[1]]: moved.patch!.unresolved![keys[1]] } });
    const reattached = waitForTrpc(page, "mapPatch.attachUnresolved");
    await page.keyboard.press("Control+Shift+z");
    await reattached;
    await expect(block).toHaveCount(0);
    await expect(object).toHaveAttribute("data-hidden", "true");
    expect(changes2).toHaveLength(1);

    // A `symbol` entry (an add whose symbol is gone; planted with putUnresolved): Attach opens the palette in its kind,
    // a pick is one attachUnresolved with the symbol and no object; the add is drawn; undo puts the entry back.
    const addId = "019a7d2e-0000-7000-8000-00000000e2e1";
    const lostAdd = {
      op: { op: "add", id: addId, type: 1, symbol: { doc: 0 }, coords: [[Math.round(centre[0] * 1000), Math.round(centre[1] * 1000)]] },
      from: "ee".repeat(32), fromSource: "ff".repeat(32), unitsPerMm: 1000, reason: "symbol",
    };
    const addKey = `${"ee".repeat(8)}:add:${addId}`;
    await trpcCall("mapPatch.applyChange", { documentHash: xmapHash, putUnresolved: { [addKey]: lostAdd } });
    await page.reload();
    await expect(block).toHaveAttribute("data-count", "1", { timeout: 30_000 });
    const symbolRow = unresolvedRows(page).first();
    await expect(symbolRow).toHaveAttribute("data-reason", "symbol");
    await expect(symbolRow).toHaveAttribute("data-op", "add");
    await symbolRow.getByTestId("editor-correction-attach").click();
    const picker = symbolRow.getByTestId("editor-map-palette");
    await expect(picker).toHaveAttribute("data-kind", "point");
    const attaches = captureCalls(page, "mapPatch.attachUnresolved");
    const pickedSymbol = waitForTrpc(page, "mapPatch.attachUnresolved");
    await picker.locator('[data-testid="editor-map-palette-item"]:not([disabled])').first().click();
    await pickedSymbol;
    expect(attaches).toHaveLength(1);
    expect(attaches[0]).toMatchObject({ documentHash: xmapHash, key: addKey });
    expect(attaches[0].sourceIndex).toBeUndefined();
    expect(attaches[0].symbol).toBeTruthy();
    await expect(block).toHaveCount(0);
    await expect(page.locator(`[data-testid="editor-correction-row"][data-op-id="add:${addId}"]`)).toBeVisible();
    const undoSymbol = waitForTrpc(page, "mapPatch.applyChange");
    await page.keyboard.press("Control+z");
    await undoSymbol;
    await expect(block).toHaveAttribute("data-count", "1");
    await expect(page.locator(`[data-testid="editor-correction-row"][data-op-id="add:${addId}"]`)).toHaveCount(0);
  });
});
