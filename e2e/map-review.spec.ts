/**
 * Import review UI (docs/map-symbols.md §8.7; research 06 §5.1) against
 * `e2e/test.ocd`: its 850.1 "Frame" rectangle is suggested as a library
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
    await expect(page.getByTestId("course-editor-page")).toBeVisible({ timeout: 15000 });
    const link = page.getByTestId("map-panel").first().getByTestId("map-review-link");
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
    await page.getByTestId("review-back").click();
    await expect(page).toHaveURL(new RegExp(`/${nameId}/course-editor$`));
  });
});
