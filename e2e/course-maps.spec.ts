import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type Download, type Page } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";
import { reseed } from "./helpers/reseed";
import { waitForTrpc } from "./helpers/trpc";

// pdf-lib is the API's dependency; load it from there.
const { PDFDocument } = createRequire(resolve(process.cwd(), "packages/api/package.json"))("pdf-lib") as {
  PDFDocument: { load(bytes: Uint8Array): Promise<{ getPageCount(): number; getPages(): { getSize(): { width: number; height: number } }[] }> };
};

/**
 * The Maps and Map templates pages (docs/course-maps.md): templates,
 * sheets per course, bulk apply and the PDF exports. *Edit layout* opens
 * the course editor's Layout mode, whose own spec is the Layout describe
 * of `course-editor.spec.ts` (E3: the legacy `MapLayoutEditor` sections of
 * this spec went with the switch).
 *
 * The event map goes through `course.uploadMap`, as the map panel uploads
 * it: the file is stored and its document pinned, so every print goes
 * through the composer (docs/course-print.md §8.1).
 */
async function seedBaseMap() {
  await reseed();
  const bytes = await readFile("e2e/test.ocd");
  const res = await fetch(`${API_BASE}/trpc/course.uploadMap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-competition-id": "itest",
      "x-forwarded-email": "e2e-admin@oxygen.test",
    },
    body: JSON.stringify({ fileName: "test.ocd", fileDataBase64: bytes.toString("base64") }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

/** A downloaded maps.pdf: its page count and every page A4 (05 §7). */
async function expectA4Pages(download: Download, pages: number) {
  const pdf = await PDFDocument.load(await readFile((await download.path())!));
  expect(pdf.getPageCount()).toBe(pages);
  for (const page of pdf.getPages()) {
    const { width, height } = page.getSize();
    const mm = [width, height].map((pt) => Math.round((pt * 25.4) / 72)).sort((a, b) => a - b);
    expect(mm).toEqual([210, 297]);
  }
}

async function selectEvent(page: Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10_000,
  });
}

async function openTab(page: Page, name: string) {
  const primary = page
    .locator("nav[aria-label='Tabs']")
    .getByRole("link", { name, exact: true });
  if (await primary.isVisible()) {
    await primary.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page
      .getByTestId("more-menu-content")
      .getByRole("link", { name, exact: true })
      .click();
  }
}

test.beforeAll(seedBaseMap);

test("creates templates, applies them to courses and exports PDFs", async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  await selectEvent(page);
  await openTab(page, "Map templates");
  await expect(page.getByTestId("map-templates-page")).toBeVisible();

  await page.getByTestId("new-map-template").click();
  await page.getByTestId("map-template-name").fill("E2E A4 1:7500");
  await page.getByTestId("map-template-paper").selectOption("A4");
  await page.getByTestId("map-template-scale").fill("7500");
  await page.getByTestId("map-template-submit").click();
  const templateSearch = page.getByPlaceholder("Search map templates…");
  await templateSearch.fill("E2E A4");
  await templateSearch.press("Enter");
  await expect(
    page.locator("[data-testid^='map-template-']").filter({
      hasText: "E2E A4 1:7500",
    }),
  ).toBeVisible();

  const templateRow = page
    .locator("[data-testid^='map-template-']")
    .filter({ hasText: "E2E A4 1:7500" });
  const templateTestId = await templateRow.getAttribute("data-testid");
  expect(templateTestId).not.toBeNull();
  const templateSeq = Number(templateTestId!.replace("map-template-", ""));

  page.once("dialog", (dialog) =>
    dialog.accept("E2E shared map template"),
  );
  // The save is fire-and-forget in the page; the dialog lists what the
  // club-template query holds when it opens, so let the write settle first.
  const savedToClub = waitForTrpc(page, "mapTemplate.saveToClub");
  await page.getByTestId(`save-template-to-club-${templateSeq}`).click();
  await savedToClub;
  await page.getByTestId("import-club-templates").click();
  const importDialog = page.getByTestId("club-template-import-dialog");
  const clubRow = importDialog.getByRole("row", {
    name: /E2E shared map template/,
  });
  await expect(clubRow).toBeVisible();
  await clubRow.getByTitle("Copy to event").click();

  await openTab(page, "Maps");
  await expect(page.getByTestId("maps-page")).toBeVisible();
  const allCourseRows = page.locator("[data-testid^='course-map-row-']");
  const firstCourseName = await allCourseRows.first().locator("td").nth(1).innerText();
  const mapSearch = page.getByPlaceholder("Search courses and maps…");
  await mapSearch.fill(firstCourseName);
  await mapSearch.press("Enter");
  await expect(
    page.locator("[data-testid^='course-map-row-']"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Remove filter" }).click();
  const firstCourse = page.locator("[data-testid^='select-map-course-']").first();
  const testId = await firstCourse.getAttribute("data-testid");
  expect(testId).not.toBeNull();
  const courseSeq = Number(testId!.replace("select-map-course-", ""));
  await firstCourse.check();
  await page
    .getByTestId("apply-map-template")
    .locator("..")
    .getByRole("combobox")
    .selectOption(String(templateSeq));
  const applied = waitForTrpc(page, "mapTemplate.applyToCourses");
  await page.getByTestId("apply-map-template").click();
  await applied;

  const courseRow = page.getByTestId(`course-map-row-${courseSeq}`);
  await courseRow.locator("td").nth(1).click();
  const group = page.getByTestId(`course-map-group-${courseSeq}`);
  await expect(group).toBeVisible();
  await expect(group.locator("[data-testid^='course-map-']")).toHaveCount(1);

  await group.getByTitle("Add map").click();
  await page
    .getByTestId("add-course-map-form")
    .getByRole("combobox")
    .selectOption(String(templateSeq));
  await page.getByTestId("add-course-map-submit").click();
  await expect(group.locator("[data-testid^='course-map-']")).toHaveCount(2);

  await page.getByTestId("add-all-controls-map").click();
  await expect(page.getByTestId("course-map-group-all")).toBeVisible();

  const firstMap = group.locator("[data-testid^='course-map-']").first();
  const [singleDownload] = await Promise.all([
    page.waitForEvent("download"),
    firstMap.getByTitle("Selected map").click(),
  ]);
  expect(singleDownload.suggestedFilename()).toMatch(/\.pdf$/);
  await expectA4Pages(singleDownload, 1);

  const [courseDownload] = await Promise.all([
    page.waitForEvent("download"),
    courseRow.getByTitle("All maps for this course").click(),
  ]);
  expect(courseDownload.suggestedFilename()).toMatch(/_maps\.pdf$/);
  await expectA4Pages(courseDownload, 2);

  await page.getByTestId("maps-export-menu").click();
  const [allControlsDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "All controls", exact: true }).click(),
  ]);
  expect(allControlsDownload.suggestedFilename()).toMatch(/\.pdf$/);
  await expectA4Pages(allControlsDownload, 1);
  // The composer drew it (the map is pinned); no pipeline header since E3.
  const all = await page.request.get("/api/maps/itest/maps.pdf");
  expect(all.ok()).toBe(true);
  expect(all.headers()["content-type"]).toContain("application/pdf");
  expect(all.headers()["x-print-pipeline"]).toBeUndefined();

  // Tables use the standard horizontal-scroll wrapper for narrow screens.
  await expect(
    page.locator("[data-testid='maps-page'] div.overflow-x-auto table"),
  ).toBeVisible();
});

test.describe("auto templates (docs/course-layout.md §5–§7)", () => {
  test.beforeAll(seedBaseMap);

  test("export a course that has no template yet", async ({ page }) => {
    test.setTimeout(90_000);
    page.setDefaultTimeout(10_000);
    await selectEvent(page);
    await openTab(page, "Maps");
    await expect(page.getByTestId("maps-page")).toBeVisible();
    const row = page.locator("[data-testid^='course-map-row-']").first();
    await expect(row).toBeVisible();
    const courseId = Number((await row.getAttribute("data-testid"))!.replace("course-map-row-", ""));
    await expect(page.getByTestId(`course-template-badge-${courseId}`)).toHaveCount(0);

    // The course has no sheet: the export creates its first one on the auto template of its key.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId(`export-course-${courseId}`).click(),
    ]);
    await expectA4Pages(download, 1);
    const badge = page.getByTestId(`course-template-badge-${courseId}`);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("data-extra", "false");
    const printed = await page.request.get(`/api/maps/itest/maps.pdf?courses=${courseId}`);
    expect(printed.ok()).toBe(true);
    expect(printed.headers()["content-type"]).toContain("application/pdf");

    // The template is named after its key and shows the key as a badge.
    await openTab(page, "Map templates");
    const key = page.locator("[data-testid^='map-template-key-']");
    await expect(key).toHaveCount(1);
    await expect(key).toHaveAttribute("data-extra", "false");
    await expect(key).toHaveAttribute("title", /^A4-(portrait|landscape)-\d+$/);
    await expect(page.locator("[data-testid^='map-template-']").filter({ hasText: /A4 (portrait|landscape) 1:\d+/ }).first()).toBeVisible();
  });
});
