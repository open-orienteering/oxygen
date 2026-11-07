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
 * Where sheets and templates are managed since E-pages (docs/course-maps.md
 * "Where sheets and templates are managed"): the Courses page's print
 * overview (template picker with the club library and New template…, auto /
 * extra badge, print status, Edit layout, the course's and the event's PDFs,
 * bulk apply) and Layout mode's sheet, template and club actions; the
 * retired /maps and /map-templates links redirect. Layout mode's drawing is
 * the Layout describe of `course-editor.spec.ts`.
 *
 * The event map goes through the chunked upload and
 * `course.applyUploadedMap`, as the map panel uploads it: the file is
 * stored and its document pinned, so every print goes through the
 * composer (docs/course-print.md §8.1).
 */
async function seedBaseMap() {
  await reseed();
  const bytes = await readFile("e2e/test.ocd");
  const headers = { "x-competition-id": "itest", "x-forwarded-email": "e2e-admin@oxygen.test" };
  const init = await fetch(`${API_BASE}/api/map-uploads`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ fileName: "test.ocd", bytes: bytes.byteLength, chunkBytes: bytes.byteLength }),
  });
  expect(init.status, await init.clone().text()).toBe(201);
  const { uploadId } = (await init.json()) as { uploadId: string };
  const chunk = await fetch(`${API_BASE}/api/map-uploads/${uploadId}/chunks/0`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/octet-stream" },
    body: bytes,
  });
  expect(chunk.status, await chunk.clone().text()).toBe(204);
  const fin = await fetch(`${API_BASE}/api/map-uploads/${uploadId}/finalise`, { method: "POST", headers });
  expect(fin.status, await fin.clone().text()).toBe(200);
  const { fileHash } = (await fin.json()) as { fileHash: string };
  const res = await fetch(`${API_BASE}/trpc/course.applyUploadedMap`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ fileHash, fileName: "test.ocd" }),
  });
  expect(res.ok, await res.text()).toBe(true);
}

/** A downloaded maps.pdf: its page count (exact, or at least `{ min }`) and every page A4 (05 §7). */
async function expectA4Pages(download: Download, pages: number | { min: number }) {
  const pdf = await PDFDocument.load(await readFile((await download.path())!));
  if (typeof pages === "number") expect(pdf.getPageCount()).toBe(pages);
  else expect(pdf.getPageCount()).toBeGreaterThanOrEqual(pages.min);
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

/** Layout mode is up: the editor mounted, the map drawn, the sheet or template read (Course mode's site mirrors are off here). */
async function layoutReady(page: Page) {
  await expect(page.getByTestId("editor-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("editor-mode-layout")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("map-vector-layer")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await expect(page.getByTestId("editor-layout-scope")).toBeVisible({ timeout: 30_000 });
}

/** The Courses page's template pickers, one per course row (the badges share the prefix). */
const pickers = (page: Page) => page.locator("select[data-testid^='course-template-']");

/** The course ids of the Courses page's rows, in table order. */
async function courseIds(page: Page): Promise<number[]> {
  await expect(pickers(page).first()).toBeVisible();
  const ids = await pickers(page).evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-testid")!.replace("course-template-", ""))));
  return ids;
}

/** The row of a course on the Courses page. */
const rowOf = (page: Page, courseId: number) => page.locator("tbody tr").filter({ has: page.getByTestId(`course-template-${courseId}`) });

async function download(page: Page, click: () => Promise<void>): Promise<Download> {
  const [file] = await Promise.all([page.waitForEvent("download"), click()]);
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  return file;
}

test.describe("the Courses page and Layout mode (E-pages)", () => {
  test.describe.configure({ mode: "serial" });
  test.beforeAll(seedBaseMap);
  let templateSeq = 0;

  test("a template from the Courses page; sheets, templates and the club library in Layout mode; this sheet's PDF", async ({ page }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await selectEvent(page);
    await openTab(page, "Courses");
    const [courseId] = await courseIds(page);
    await expect(page.getByTestId(`course-print-status-${courseId}`)).toHaveAttribute("data-status", "noMap");
    await expect(page.getByTestId(`course-template-badge-${courseId}`)).toHaveCount(0);

    // New template… in the course's picker: the dialog creates the template and applies it.
    await page.getByTestId(`course-template-${courseId}`).selectOption("new");
    const dialog = page.getByTestId("new-template-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("new-template-name").fill("E2E A4 1:7500");
    await dialog.getByTestId("new-template-paper").selectOption("A4");
    await dialog.getByTestId("new-template-scale").fill("7500");
    const applied = waitForTrpc(page, "mapTemplate.applyToCourses");
    await dialog.getByTestId("new-template-submit").click();
    await applied;
    await expect(dialog).toHaveCount(0);
    const picker = page.getByTestId(`course-template-${courseId}`);
    await expect(picker.locator("option:checked")).toHaveText("E2E A4 1:7500");
    templateSeq = Number(await picker.inputValue());
    // The first template of its key is the key's auto template (docs/course-layout.md §5).
    await expect(page.getByTestId(`course-template-badge-${courseId}`)).toHaveAttribute("data-extra", "false");
    await expect(page.getByTestId(`course-print-status-${courseId}`)).toHaveAttribute("data-status", /^(ready|issues)$/);

    // Edit layout: the course's sheet in Layout mode.
    const edit = rowOf(page, courseId).locator("[data-testid^='edit-course-map-']");
    const sheetSeq = Number((await edit.getAttribute("data-testid"))!.replace("edit-course-map-", ""));
    await edit.click();
    await expect(page).toHaveURL(new RegExp(`course-editor\\?mode=layout&sheet=${sheetSeq}&course=${courseId}`));
    await layoutReady(page);
    const scope = page.getByTestId("editor-layout-scope");
    await expect(scope).toHaveAttribute("data-sheet", String(sheetSeq), { timeout: 30_000 });

    // Rename the sheet: one courseMap.update with the sheet's token.
    const renamed = waitForTrpc(page, "courseMap.update");
    await page.getByTestId("editor-layout-sheet-name").fill("E2E sheet");
    await page.getByTestId("editor-layout-sheet-name").press("Enter");
    await renamed;
    await expect(page.getByTestId("editor-layout-sheet").getByText("E2E sheet").first()).toBeVisible();

    // Add a second sheet on the same template: it opens; the picker lists both.
    const added = waitForTrpc(page, "courseMap.create");
    await page.getByTestId("editor-layout-add-sheet").click();
    await added;
    await expect(scope).not.toHaveAttribute("data-sheet", String(sheetSeq));
    await expect(page.getByTestId("editor-layout-sheet-picker").locator("option")).toHaveCount(2);
    await expect(scope).toHaveAttribute("data-template", String(templateSeq));

    // Export ▾ This sheet: one A4 page.
    await page.getByTestId("editor-export").click();
    await expectA4Pages(await download(page, () => page.getByTestId("editor-export-sheet").click()), 1);

    // Delete the second sheet: back on the course's first.
    page.once("dialog", (d) => void d.accept());
    const deleted = waitForTrpc(page, "courseMap.delete");
    await page.getByTestId("editor-layout-delete-sheet").click();
    await deleted;
    await expect(scope).toHaveAttribute("data-sheet", String(sheetSeq));
    await expect(page.getByTestId("editor-layout-sheet-picker")).toHaveCount(0);

    // The template: its name is part of the snapshot (mapTemplate.update).
    await page.getByTestId("editor-layout-edit-template").click();
    await expect(scope).toHaveAttribute("data-scope", "template");
    const named = waitForTrpc(page, "mapTemplate.update");
    await page.getByTestId("editor-layout-template-name").fill("E2E A4 renamed");
    await page.getByTestId("editor-layout-template-name").press("Enter");
    await named;
    const back = waitForTrpc(page, "mapTemplate.update");
    await page.getByTestId("editor-layout-template-name").fill("E2E A4 1:7500");
    await page.getByTestId("editor-layout-template-name").press("Enter");
    await back;

    // The club library: save this template, bring it back in as a new event template.
    await page.getByTestId("editor-layout-club-toggle").click();
    page.once("dialog", (d) => void d.accept("E2E shared map template"));
    const saved = waitForTrpc(page, "mapTemplate.saveToClub");
    await page.getByTestId("editor-layout-save-to-club").click();
    await saved;
    const clubRow = page.locator("[data-testid^='editor-layout-club-row-']").filter({ hasText: "E2E shared map template" });
    await expect(clubRow).toBeVisible();
    const clubId = (await clubRow.getAttribute("data-testid"))!.replace("editor-layout-club-row-", "");
    const loaded = waitForTrpc(page, "mapTemplate.loadFromClub");
    await page.getByTestId(`editor-layout-club-import-${clubId}`).click();
    await loaded;
    await expect(scope).toHaveAttribute("data-scope", "template");
    await expect(scope).not.toHaveAttribute("data-template", String(templateSeq));
    // A template without map-anchored objects loses none.
    await expect(page.getByTestId("editor-layout-club-notice")).toHaveCount(0);

    // New template from Layout mode opens it; Delete this template returns to the course's sheet.
    await page.getByTestId("editor-layout-new-template").click();
    await page.getByTestId("new-template-paper").selectOption("A5");
    const createdTpl = waitForTrpc(page, "mapTemplate.create");
    await page.getByTestId("new-template-submit").click();
    await createdTpl;
    await expect(page.getByTestId("editor-layout-template-name")).toHaveValue(/^A5 portrait 1:7500$/);
    page.once("dialog", (d) => void d.accept());
    const removed = waitForTrpc(page, "mapTemplate.delete");
    await page.getByTestId("editor-layout-delete-template").click();
    await removed;
    await expect(scope).toHaveAttribute("data-sheet", String(sheetSeq));

    // View All without an all-controls sheet: Create the all-controls sheet.
    await page.getByTestId("editor-view-all").click();
    await expect(page.getByTestId("editor-layout-no-all-controls")).toBeVisible();
    const ensured = waitForTrpc(page, "layout.autoSheets");
    await page.getByTestId("editor-layout-create-all-controls").click();
    await ensured;
    await expect(scope).toHaveAttribute("data-sheet", /^\d+$/);
    const sheets = (await (await page.request.get("/trpc/courseMap.list", { headers: { "x-competition-id": "itest" } })).json()) as { result: { data: { kind: string; seq: number }[] } };
    const all = sheets.result.data.filter((m) => m.kind === "all_controls");
    expect(all).toHaveLength(1);
    await expect(scope).toHaveAttribute("data-sheet", String(all[0].seq));
  });

  test("the Courses page's overview: bulk apply, the club library in the picker, status, the PDFs", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    expect(templateSeq).toBeGreaterThan(0);
    await selectEvent(page);
    await openTab(page, "Courses");
    const ids = await courseIds(page);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const [, second, third] = ids;

    // Bulk: the template field's value is the same picker.
    for (const id of [second, third]) await rowOf(page, id).locator("td").first().locator("input[type=checkbox]").check();
    await page.getByTestId("bulk-field-select").selectOption("template");
    await page.getByTestId("bulk-value-input").selectOption(String(templateSeq));
    const applied = waitForTrpc(page, "mapTemplate.applyToCourses");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await applied;
    for (const id of [second, third]) {
      await expect(page.getByTestId(`course-template-${id}`)).toHaveValue(String(templateSeq));
      await expect(page.getByTestId(`course-template-badge-${id}`)).toHaveAttribute("data-extra", "false");
    }

    // The club library in a course's picker: brought into the event under a free name, then applied.
    const clubOption = page.getByTestId(`course-template-${third}`).locator("optgroup option").filter({ hasText: "E2E shared map template" });
    const clubValue = await clubOption.getAttribute("value");
    expect(clubValue).toMatch(/^club:\d+$/);
    const fromClub = waitForTrpc(page, "mapTemplate.applyToCourses");
    await page.getByTestId(`course-template-${third}`).selectOption(clubValue!);
    await fromClub;
    await expect(page.getByTestId(`course-template-${third}`).locator("option:checked")).toHaveText(/^E2E shared map template( \(\d+\))?$/);

    // The course's PDF, the all-controls PDF, every map.
    await expectA4Pages(await download(page, () => page.getByTestId(`export-course-${second}`).click()), 1);
    await page.getByTestId("course-export-menu").click();
    await expectA4Pages(await download(page, () => page.getByTestId("course-export-all-controls").click()), 1);
    await page.getByTestId("course-export-menu").click();
    await expectA4Pages(await download(page, () => page.getByTestId("course-export-all-maps").click()), { min: 3 });
    // Every course has a sheet now (the export ensured them).
    for (const id of ids) await expect(page.getByTestId(`course-print-status-${id}`)).not.toHaveAttribute("data-status", "noMap");
    // The composer drew it (the map is pinned); no pipeline header since E3.
    const all = await page.request.get("/api/maps/itest/maps.pdf");
    expect(all.ok()).toBe(true);
    expect(all.headers()["content-type"]).toContain("application/pdf");
    expect(all.headers()["x-print-pipeline"]).toBeUndefined();

    // Tables use the standard horizontal-scroll wrapper for narrow screens.
    await expect(page.locator("div.overflow-x-auto table")).toBeVisible();

    // Layout mode's club section deletes a club template (confirmed); the row goes.
    await rowOf(page, ids[0]).locator("[data-testid^='edit-course-map-']").click();
    await layoutReady(page);
    await page.getByTestId("editor-layout-club-toggle").click();
    const clubRow = page.locator("[data-testid^='editor-layout-club-row-']").filter({ hasText: "E2E shared map template" });
    await expect(clubRow).toHaveCount(1);
    const clubId = (await clubRow.getAttribute("data-testid"))!.replace("editor-layout-club-row-", "");
    page.once("dialog", (d) => void d.accept());
    const deletedClub = waitForTrpc(page, "mapTemplate.deleteClub");
    await page.getByTestId(`editor-layout-club-delete-${clubId}`).click();
    await deletedClub;
    await expect(page.getByTestId(`editor-layout-club-row-${clubId}`)).toHaveCount(0);
  });
});

test.describe("auto templates (docs/course-layout.md §5–§7)", () => {
  test.beforeAll(seedBaseMap);

  test("export a course that has no template yet", async ({ page }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    await selectEvent(page);
    await openTab(page, "Courses");
    const [courseId, other] = await courseIds(page);
    await expect(page.getByTestId(`course-template-badge-${courseId}`)).toHaveCount(0);

    // The course has no sheet: the export creates its first one on the auto template of its key.
    await expectA4Pages(await download(page, () => page.getByTestId(`export-course-${courseId}`).click()), 1);
    const badge = page.getByTestId(`course-template-badge-${courseId}`);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("data-extra", "false");
    await expect(badge).toHaveAttribute("title", /^A4-(portrait|landscape)-\d+$/);
    const printed = await page.request.get(`/api/maps/itest/maps.pdf?courses=${courseId}`);
    expect(printed.ok()).toBe(true);
    expect(printed.headers()["content-type"]).toContain("application/pdf");

    // The template is named after its key and shows the key as a badge in Layout mode.
    await rowOf(page, courseId).locator("[data-testid^='edit-course-map-']").click();
    await layoutReady(page);
    await expect(page.getByTestId("editor-layout-template-badge")).toHaveAttribute("data-auto-key", /^A4-(portrait|landscape)-\d+$/, { timeout: 30_000 });
    await page.getByTestId("editor-layout-edit-template").click();
    await expect(page.getByTestId("editor-layout-template-name")).toHaveValue(/^A4 (portrait|landscape) 1:\d+$/);

    // A course without a sheet in Layout mode: Create sheet makes its first one (autoSheets { courseId }) and shows it.
    await page.goto(`/itest/course-editor?mode=layout&course=${other}`);
    await expect(page.getByTestId("editor-layout-no-sheet")).toBeVisible({ timeout: 30_000 });
    const created = waitForTrpc(page, "layout.autoSheets");
    await page.getByTestId("editor-layout-create-sheet").click();
    await created;
    await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", /^\d+$/, { timeout: 30_000 });
    await expect(page.getByTestId("editor-layout-template-badge")).toHaveAttribute("data-extra", "false");
  });
});

test("the retired Maps and Map templates pages redirect, their query kept", async ({ page }) => {
  await selectEvent(page);
  await page.goto("/itest/maps?course=1");
  await expect(page).toHaveURL(/\/itest\/courses\?course=1$/);
  await page.goto("/itest/map-templates");
  await expect(page).toHaveURL(/\/itest\/course-editor\?mode=layout/);
  expect(page.url()).not.toContain("template=");
  // No tab for either.
  await expect(page.locator("nav[aria-label='Tabs']").getByRole("link", { name: "Maps", exact: true })).toHaveCount(0);
  await expect(page.locator("nav[aria-label='Tabs']").getByRole("link", { name: "Map templates", exact: true })).toHaveCount(0);
});
