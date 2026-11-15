/**
 * Corrections the pin move could not carry over (docs/course-editor.md §13 "Unresolved"; docs/map-patches.md §4,
 * row G11). On the seed's `itest` (`e2e/test.ocd` pinned) two objects are hidden through the API; then the event's
 * map is replaced by another edition (`e2e/test.xmap`, through the upload route and `course.applyUploadedMap`, so the
 * import job's pin re-keys the patch on the server). Map mode lists both hides under *Not carried over*: *Drop*
 * removes one (a reload keeps it gone), *Attach* puts the other onto the object selected on the map. The spec
 * changes the event's map, so it reseeds before and after (AGENTS.md §12).
 */
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { API_BASE } from "./helpers/api-base";
import { EDITOR_EVENT, editorReady, nameIdOf, openEditor, trpcCall, viewSettled } from "./helpers/editor";
import { reseed } from "./helpers/reseed";
import { waitForTrpc } from "./helpers/trpc";

type Unresolved = Record<string, { op: { op: string; sourceIndex?: number }; reason: string; from: string }>;
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

    // Drop the first: one applyChange with removeUnresolved, the row gone, and gone after a reload.
    const dropped = waitForTrpc(page, "mapPatch.applyChange");
    await unresolvedRows(page).first().getByTestId("editor-correction-drop").click();
    await dropped;
    await expect(unresolvedRows(page)).toHaveCount(1);
    await expect(unresolvedRows(page).first()).toHaveAttribute("data-key", keys[1]);
    expect(Object.keys((await trpcCall<Delivery>("mapPatch.get", undefined, false)).patch!.unresolved ?? {})).toEqual([keys[1]]);
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
  });
});
