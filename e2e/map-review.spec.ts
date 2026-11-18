/**
 * Import review UI (docs/map-symbols.md §8.7; research 06 §5.1) against
 * `e2e/test.ocd` (the colour layers panel, row I6: `e2e/colour-layers.ocd`): its 850.1 "Frame" rectangle is suggested as a library
 * symbol by geometry alone and is the row a reviewer keeps as drawn; its
 * 702.0 control ring is suggested as ISOM 703.
 *
 * Club symbol decisions are instance-wide and keyed by symbol geometry
 * (§8.5 "Scope"), so every decision written here is reset through the UI
 * before the test ends, and `reseed()` wipes the table on both sides.
 */
import { readFile } from "node:fs/promises";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { uploadEventMap } from "./helpers/map-upload";
import { waitForTrpc } from "./helpers/trpc";

const HASH = /[0-9a-f]{64}/;

function hashOf(url: string): string {
  return /\/map-review\/([0-9a-f]{64})/.exec(url)![1];
}

async function expectLoaded(img: Locator): Promise<void> {
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
}

/** Apply the pending decisions and wait for the review of the new document. */
async function applyDecisions(page: Page, from: string): Promise<string> {
  const decided = waitForTrpc(page, "mapImport.decide", { timeout: 60000 });
  await page.getByTestId("review-apply").click();
  await decided;
  await expect(page).not.toHaveURL(new RegExp(from), { timeout: 60000 });
  await expect(page.getByTestId("review-job-progress")).toHaveCount(0, { timeout: 60000 });
  await expect(page.getByTestId("review-rows")).toBeVisible({ timeout: 20000 });
  return hashOf(page.url());
}

async function finalise(page: Page): Promise<void> {
  const done = waitForTrpc(page, "mapImport.finalise");
  await page.getByTestId("review-finalise").click();
  await done;
  await expect(page.getByTestId("review-in-use")).toBeVisible({ timeout: 15000 });
}

test.describe("map import review", () => {
  test.beforeAll(reseed);
  test.afterAll(reseed);

  test("club map: review, keep a suggestion as drawn, finalise, CRT round trip, reset", async ({
    page,
  }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("library-tab-maps")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("library-map-upload").setInputFiles("e2e/test.ocd");
    const card = page.locator('[data-testid^="library-map-card-"]').first();
    await expect(card.getByTestId("club-map-preview")).toBeVisible({ timeout: 30000 });
    const seriesId = (await card.getAttribute("data-testid"))!.replace("library-map-card-", "");

    // Review is expected for club maps (06 §5.1): the card says so.
    const count = card.getByTestId("library-map-review-count");
    await expect(count).toBeVisible();
    const toReview = Number(await count.getAttribute("data-count"));
    expect(toReview).toBeGreaterThan(0);

    await card.getByTestId("library-map-review").click();
    await expect(page).toHaveURL(
      new RegExp(`/settings/map-review/${HASH.source}\\?clubMap=${seriesId}$`),
    );
    const original = hashOf(page.url());
    await expect(page.getByTestId("review-in-use")).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId("review-summary-suggested")).toHaveAttribute(
      "data-count",
      String(toReview),
    );

    // Rows by usage, most used first.
    const rows = page.getByTestId("review-rows").locator("[data-review-row]");
    await expect(rows.first()).toBeVisible();
    const objects = (await rows.evaluateAll((els) =>
      els.map((el) => Number(el.getAttribute("data-objects"))),
    )) as number[];
    expect(objects.length).toBeGreaterThan(1);
    expect(objects).toEqual([...objects].sort((a, b) => b - a));

    // Source swatch beside the library candidates, both reference-raster PNGs.
    const frame = page.getByTestId("review-row-850.1");
    await expect(frame).toHaveAttribute("data-outcome", "suggested");
    const source = frame.getByTestId("review-source-swatch");
    await expect(source).toHaveAttribute(
      "src",
      new RegExp(`^/api/map-documents/${original}/symbols/\\d+\\.png$`),
    );
    await expectLoaded(source);
    const candidates = frame.locator("[data-candidate]");
    expect(await candidates.count()).toBeGreaterThan(0);
    expect(await candidates.count()).toBeLessThanOrEqual(3);
    const first = candidates.first().getByTestId("review-candidate-swatch");
    await expect(first).toHaveAttribute("src", /^\/api\/library\/ISOM2017-2\/[^/]+\/[^/]+\.png$/);
    await expectLoaded(first);
    await expect(candidates.first()).toHaveAttribute("data-current", "true");

    // Keep the frame as drawn: one pending decision, applied as one decide.
    await frame.getByTestId("review-keep").click();
    await expect(frame).toHaveAttribute("data-pending", "unmatch");
    await expect(page.getByTestId("review-apply")).toContainText("1");
    const kept = await applyDecisions(page, original);
    expect(kept).not.toBe(original);
    await expect(page.getByTestId("review-row-850.1")).toHaveAttribute("data-outcome", "kept");
    await expect(page.getByTestId("review-not-in-use")).toBeVisible();

    // Finalise re-pins the club map's version in place (map-storage.md §6.4).
    await finalise(page);
    await page.goto("/settings");
    await expect(
      page.getByTestId(`library-map-card-${seriesId}`).getByTestId("club-map-preview"),
    ).toHaveAttribute("src", `/api/map-documents/${kept}/thumbnail.png`, { timeout: 15000 });
    await expect(
      page.getByTestId(`library-map-card-${seriesId}`).getByTestId("library-map-review-count"),
    ).toHaveAttribute("data-count", String(toReview - 1));
    await page.getByTestId(`library-map-card-${seriesId}`).getByTestId("library-map-review").click();
    await expect(page).toHaveURL(new RegExp(`/settings/map-review/${kept}`));

    // CRT export carries the decision (docs/map-symbols.md §8.6).
    const downloading = page.waitForEvent("download");
    await page.getByTestId("review-crt-export").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^test-ISOM2017-2\.crt$/);
    const crt = await readFile((await download.path())!, "utf8");
    expect(crt).toMatch(/^# keep 850\.1$/m);

    // CRT import previews before it records anything.
    await page.getByTestId("review-crt-file").setInputFiles({
      name: "ring.crt",
      mimeType: "text/plain",
      buffer: Buffer.from("703 702.0\nnot-a-rule\n"),
    });
    const preview = page.getByTestId("review-crt-preview");
    await expect(preview).toBeVisible({ timeout: 15000 });
    await expect(preview.getByTestId("review-crt-decision")).toHaveCount(1);
    await expect(preview.getByTestId("review-crt-decision")).toContainText("702.0");
    await expect(page.getByTestId("review-row-702.0")).toHaveAttribute("data-outcome", "suggested");
    const imported = waitForTrpc(page, "mapImport.importCrt", { timeout: 60000 });
    await preview.getByTestId("review-crt-confirm").click();
    await imported;
    await expect(page).not.toHaveURL(new RegExp(kept), { timeout: 60000 });
    await expect(page.getByTestId("review-row-702.0")).toHaveAttribute("data-outcome", "accepted", {
      timeout: 20000,
    });
    const ring = hashOf(page.url());

    // Reset both rows: no decisions left, so the matcher's own document
    // comes back (dedup), and finalising it restores the original pin.
    await page.getByTestId("review-row-702.0").getByTestId("review-reset").click();
    await page.getByTestId("review-row-850.1").getByTestId("review-reset").click();
    await expect(page.getByTestId("review-apply")).toContainText("2");
    const back = await applyDecisions(page, ring);
    expect(back).toBe(original);
    await expect(page.getByTestId("review-row-850.1")).toHaveAttribute("data-outcome", "suggested");
    await finalise(page);
  });

  test("club map: the colour layers panel, the switch to the map's own order and back, the picture (row I6)", async ({
    page,
  }) => {
    // e2e/colour-layers.ocd: a badly ordered table (docs/e2e-test-ocd-fixture.md), so the two orders differ.
    await page.goto("/settings");
    await expect(page.getByTestId("library-tab-maps")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("library-map-upload").setInputFiles("e2e/colour-layers.ocd");
    const card = page.locator('[data-testid^="library-map-card-"]').filter({ hasText: "colour-layers" }).first();
    await expect(card.getByTestId("club-map-preview")).toBeVisible({ timeout: 30000 });
    const seriesId = (await card.getAttribute("data-testid"))!.replace("library-map-card-", "");
    await card.getByTestId("library-map-review").click();
    await expect(page).toHaveURL(new RegExp(`/settings/map-review/${HASH.source}\\?clubMap=${seriesId}$`));
    const original = hashOf(page.url());
    await expect(page.getByTestId("review-in-use")).toBeVisible({ timeout: 20000 });

    // The panel: the layers top first, the split brown 50 %, every deviation with its default.
    const panel = page.getByTestId("review-colours");
    await expect(panel).toHaveAttribute("data-order", "iof");
    await expect(panel).toHaveAttribute("data-setting", "iof");
    const rows = panel.getByTestId("colour-layer-row");
    await expect(rows).toHaveCount(13);
    await expect(rows.first()).toHaveAttribute("data-role", "purple-upper");
    const split = panel.locator('[data-testid="colour-layer-row"][data-flags~="split"]');
    await expect(split).toHaveCount(2);
    expect((await split.evaluateAll((els) => els.map((el) => el.getAttribute("data-role")))).sort()).toEqual([
      "brown50-paved",
      "brown50-road",
    ]);
    const deviations = panel.getByTestId("colour-deviation");
    await expect(deviations).toHaveCount(9);
    await expect(panel.locator('[data-testid="colour-deviation"][data-kept="true"]')).toHaveCount(3);
    const road = panel.locator('[data-key="brown50-road>brown100-line"]');
    await expect(road).toHaveAttribute("data-kept", "true");
    await expect(road).toHaveAttribute("data-default", "keep");
    const implied = panel.locator('[data-key="black50-building>brown100-line"]');
    await expect(implied).toHaveAttribute("data-why", "implied");
    await expect(implied).toHaveAttribute("data-default", "drop");
    await expect(panel.locator('[data-key="brown50-paved>black50-building"]')).toHaveAttribute("data-kept", "false");

    // The before / after picture: both orders over the same window, and they differ.
    const iofPicture = panel.getByTestId("colour-picture-iof");
    const sourcePicture = panel.getByTestId("colour-picture-source");
    await expect(iofPicture).toHaveAttribute("src", `/api/map-documents/${original}/colour-order/iof.png`);
    await expectLoaded(iofPicture);
    await expectLoaded(sourcePicture);
    const [a, b] = await Promise.all(
      [iofPicture, sourcePicture].map(async (img) => (await page.request.get((await img.getAttribute("src"))!)).body()),
    );
    expect(a.equals(b)).toBe(false);

    // The switch: the map's own order is a new document, not used until "Use this version".
    await expect(panel.getByTestId("colour-order-iof")).toHaveAttribute("aria-pressed", "true");
    const switched = waitForTrpc(page, "mapImport.setColourOrder", { timeout: 60000 });
    await panel.getByTestId("colour-order-source").click();
    await switched;
    await expect(page).not.toHaveURL(new RegExp(original), { timeout: 60000 });
    const own = hashOf(page.url());
    await expect(page.getByTestId("review-colours")).toHaveAttribute("data-order", "source", { timeout: 20000 });
    await expect(page.getByTestId("review-colours")).toHaveAttribute("data-setting", "source");
    await expect(page.getByTestId("colour-order-source")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("colour-layers-none")).toBeVisible();
    await expect(page.getByTestId("review-not-in-use")).toBeVisible();
    await expect(page.getByTestId("review-outdated")).toHaveCount(0);
    await expectLoaded(page.getByTestId("colour-picture-source"));

    // And back: the IOF order is the original document again (dedup), still the one in use.
    const back = waitForTrpc(page, "mapImport.setColourOrder", { timeout: 60000 });
    await page.getByTestId("colour-order-iof").click();
    await back;
    await expect(page).not.toHaveURL(new RegExp(own), { timeout: 60000 });
    expect(hashOf(page.url())).toBe(original);
    await expect(page.getByTestId("review-colours")).toHaveAttribute("data-order", "iof", { timeout: 20000 });
    await expect(page.getByTestId("review-colours")).toHaveAttribute("data-setting", "iof");
    await expect(page.getByTestId("review-in-use")).toBeVisible();
    await expect(page.getByTestId("colour-layer-row")).toHaveCount(13);
  });

  test("club map: deviation overrides — keep a dropped one, drop a kept one, a no-op keep, reset (row I7)", async ({
    page,
  }) => {
    // The series the I6 test made, back in the IOF order with no overrides.
    await page.goto("/settings");
    await expect(page.getByTestId("library-tab-maps")).toBeVisible({ timeout: 15000 });
    const card = page.locator('[data-testid^="library-map-card-"]').filter({ hasText: "colour-layers" }).first();
    await expect(card.getByTestId("club-map-preview")).toBeVisible({ timeout: 30000 });
    await card.getByTestId("library-map-review").click();
    await expect(page.getByTestId("review-in-use")).toBeVisible({ timeout: 20000 });
    const original = hashOf(page.url());
    const panel = page.getByTestId("review-colours");
    const row = (key: string) => page.getByTestId("review-colours").locator(`[data-testid="colour-deviation"][data-key="${key}"]`);
    const PAVED_BUILDING = "brown50-paved>black50-building";
    const ROAD = "brown50-road>brown100-line";
    const BUILDING = "black50-building>brown100-line";
    const change = async (key: string, control: "keep" | "drop" | "reset") => {
      const done = waitForTrpc(page, "mapImport.setDeviation", { timeout: 60000 });
      await row(key).getByTestId(`colour-deviation-${control}`).click();
      await done;
      await expect(page.getByTestId("review-job-progress")).toHaveCount(0, { timeout: 60000 });
    };

    await expect(row(PAVED_BUILDING)).toHaveAttribute("data-choice", "drop");
    await expect(row(PAVED_BUILDING)).toHaveAttribute("data-overridden", "false");
    await expect(row(PAVED_BUILDING).getByTestId("colour-deviation-drop")).toBeDisabled();
    await expect(row(PAVED_BUILDING).getByTestId("colour-deviation-reset")).toHaveCount(0);
    const defaultsPicture = await (await page.request.get(`/api/map-documents/${original}/colour-order/iof.png`)).body();

    // Keep a deviation dropped by default: a new document, not in use until "Use this version".
    await change(PAVED_BUILDING, "keep");
    await expect(page).not.toHaveURL(new RegExp(original), { timeout: 60000 });
    const kept = hashOf(page.url());
    await expect(row(PAVED_BUILDING)).toHaveAttribute("data-kept", "true", { timeout: 20000 });
    await expect(row(PAVED_BUILDING)).toHaveAttribute("data-why", "override");
    await expect(row(PAVED_BUILDING)).toHaveAttribute("data-overridden", "true");
    await expect(row(PAVED_BUILDING).getByTestId("colour-deviation-keep")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("review-not-in-use")).toBeVisible();
    const keptPicture = panel.getByTestId("colour-picture-iof");
    await expectLoaded(keptPicture);
    expect((await (await page.request.get((await keptPicture.getAttribute("src"))!)).body()).equals(defaultsPicture)).toBe(false);

    // Drop a deviation kept by default, on top.
    await change(ROAD, "drop");
    await expect(page).not.toHaveURL(new RegExp(kept), { timeout: 60000 });
    const both = hashOf(page.url());
    await expect(row(ROAD)).toHaveAttribute("data-kept", "false", { timeout: 20000 });
    await expect(row(ROAD)).toHaveAttribute("data-choice", "drop");

    // Reset each: back to the original document by dedup, the one in use.
    await change(ROAD, "reset");
    await expect(page).not.toHaveURL(new RegExp(both), { timeout: 60000 });
    expect(hashOf(page.url())).toBe(kept);
    await change(PAVED_BUILDING, "reset");
    await expect(page).not.toHaveURL(new RegExp(kept), { timeout: 60000 });
    expect(hashOf(page.url())).toBe(original);
    await expect(page.getByTestId("review-in-use")).toBeVisible({ timeout: 20000 });
    await expect(row(PAVED_BUILDING)).toHaveAttribute("data-overridden", "false");

    // Keep a deviation already kept by implication: the same document, shown as changed, still in use and current.
    await change(BUILDING, "keep");
    await expect(row(BUILDING)).toHaveAttribute("data-overridden", "true", { timeout: 20000 });
    expect(hashOf(page.url())).toBe(original);
    await expect(row(BUILDING)).toHaveAttribute("data-why", "implied");
    await expect(row(BUILDING).getByTestId("colour-deviation-overridden")).toBeVisible();
    await expect(page.getByTestId("review-in-use")).toBeVisible();
    await expect(page.getByTestId("review-outdated")).toHaveCount(0);
    await change(BUILDING, "reset");
    await expect(row(BUILDING)).toHaveAttribute("data-overridden", "false", { timeout: 20000 });
    expect(hashOf(page.url())).toBe(original);
  });

  test("event map: the colour layers panel on the event route — pictures, the switch, an override (row I7)", async ({
    page,
  }) => {
    const stamp = Date.now();
    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(`E2E Colour ${stamp}`);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 15000 });
    const nameId = new URL(page.url()).pathname.split("/").filter(Boolean)[0];

    await uploadEventMap(page, "e2e/colour-layers.ocd");
    await expect(page.getByTestId("map-viewer").first()).toBeVisible({ timeout: 60000 });
    await page.goto(`/${nameId}/course-editor`);
    await expect(page.getByTestId("editor-page")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("editor-map-info").click();
    const link = page.getByTestId("editor-map-info-dialog").getByTestId("editor-map-info-review");
    await expect(link).toBeVisible({ timeout: 30000 });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${nameId}/map-review/${HASH.source}$`));
    await expect(page.getByTestId("review-in-use")).toBeVisible({ timeout: 20000 });
    const original = hashOf(page.url());

    const panel = page.getByTestId("review-colours");
    await expect(panel).toHaveAttribute("data-setting", "iof");
    await expect(panel.getByTestId("colour-deviation")).toHaveCount(9);
    for (const order of ["iof", "source"] as const) {
      const img = panel.getByTestId(`colour-picture-${order}`);
      await expect(img).toHaveAttribute("src", new RegExp(`/colour-order/${order}\\.png\\?event=${nameId}$`));
      await expectLoaded(img);
    }

    // An override with the event as target, then reset: back to the event's document.
    const row = panel.locator('[data-testid="colour-deviation"][data-key="brown50-paved>black50-building"]');
    let done = waitForTrpc(page, "mapImport.setDeviation", { timeout: 60000 });
    await row.getByTestId("colour-deviation-keep").click();
    await done;
    await expect(page).not.toHaveURL(new RegExp(original), { timeout: 60000 });
    const kept = hashOf(page.url());
    await expect(page.getByTestId("review-colours").locator('[data-key="brown50-paved>black50-building"]')).toHaveAttribute("data-overridden", "true", { timeout: 20000 });
    await expect(page.getByTestId("review-not-in-use")).toBeVisible();
    done = waitForTrpc(page, "mapImport.setDeviation", { timeout: 60000 });
    await page.getByTestId("review-colours").locator('[data-key="brown50-paved>black50-building"]').getByTestId("colour-deviation-reset").click();
    await done;
    await expect(page).not.toHaveURL(new RegExp(kept), { timeout: 60000 });
    expect(hashOf(page.url())).toBe(original);

    // The switch with the event as target, and back.
    done = waitForTrpc(page, "mapImport.setColourOrder", { timeout: 60000 });
    await page.getByTestId("colour-order-source").click();
    await done;
    await expect(page).not.toHaveURL(new RegExp(original), { timeout: 60000 });
    await expect(page.getByTestId("review-colours")).toHaveAttribute("data-order", "source", { timeout: 20000 });
    await expect(page.getByTestId("review-colours")).toHaveAttribute("data-setting", "source");
    done = waitForTrpc(page, "mapImport.setColourOrder", { timeout: 60000 });
    await page.getByTestId("colour-order-iof").click();
    await done;
    await expect(page).toHaveURL(new RegExp(original), { timeout: 60000 });
    await expect(page.getByTestId("review-in-use")).toBeVisible({ timeout: 20000 });
  });

  test("event map: optional review from the course editor, previews scoped to the event", async ({
    page,
  }) => {
    const stamp = Date.now();
    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(`E2E Review ${stamp}`);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 15000 });
    const nameId = new URL(page.url()).pathname.split("/").filter(Boolean)[0];

    await uploadEventMap(page);
    await expect(page.getByTestId("map-viewer").first()).toBeVisible({ timeout: 60000 });
    await page.goto(`/${nameId}/course-editor`);
    // The editor's map-info dialog carries the link (docs/course-editor.md §2, P6: the top bar's map icon).
    await expect(page.getByTestId("editor-page")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("editor-map-info").click();
    const link = page.getByTestId("editor-map-info-dialog").getByTestId("editor-map-info-review");
    await expect(link).toBeVisible({ timeout: 30000 });
    await link.click();

    await expect(page).toHaveURL(new RegExp(`/${nameId}/map-review/${HASH.source}$`));
    await expect(page.getByTestId("review-in-use")).toBeVisible({ timeout: 20000 });
    const source = page.getByTestId("review-row-850.1").getByTestId("review-source-swatch");
    await expect(source).toHaveAttribute(
      "src",
      new RegExp(`/symbols/\\d+\\.png\\?event=${nameId}$`),
    );
    await expectLoaded(source);
    // The matcher's output is what the event uses: nothing to finalise.
    await expect(page.getByTestId("review-finalise")).toHaveCount(0);
    // test.ocd has no contours: the terrain line says so (map-storage.md §4.7).
    await expect(page.getByTestId("review-terrain")).toHaveAttribute("data-terrain-state", "none");
    await expect(page.getByTestId("review-terrain")).toContainText(/no contours/);
    await page.getByTestId("review-back").click();
    await expect(page).toHaveURL(new RegExp(`/${nameId}/course-editor$`));
  });
});
