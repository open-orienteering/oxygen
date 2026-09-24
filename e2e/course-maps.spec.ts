import { readFile } from "node:fs/promises";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { Client } from "pg";
import { reseed } from "./helpers/reseed";

const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgresql://oxygen:oxygen@localhost:5433/${process.env.E2E_DB_NAME ?? "oxygen_e2e"}?schema=oxygen`;

async function seedBaseMap() {
  await reseed();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const bytes = await readFile("e2e/test.ocd");
    await client.query(
      `INSERT INTO oxygen.map_files
         (event_id, file_name, file_data, scale)
       SELECT id, 'test.ocd', $1, 7500
       FROM oxygen.events WHERE name_id = 'itest'`,
      [bytes],
    );
  } finally {
    await client.end();
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

async function placeObject(page: Page, toolTestId: string) {
  await page.getByTestId(toolTestId).click();
  const paper = page.getByTestId("map-paper");
  const box = await paper.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(
    box!.x + box!.width * 0.55,
    box!.y + box!.height * 0.55,
  );
}

test.beforeAll(seedBaseMap);

test("creates templates, lays out several maps and exports PDFs", async ({
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
  await page.getByTestId(`edit-template-layout-${templateSeq}`).click();
  await expect(page.getByTestId("map-layout-editor")).toBeVisible();
  expect((await page.getByTestId("map-paper").boundingBox())?.width).toBeGreaterThan(
    1100,
  );
  await placeObject(page, "map-tool-text");
  await page.getByTestId("map-variable-event").click();
  await page.getByTestId("map-text-font").selectOption("serif");
  await placeObject(page, "map-tool-line");
  await expect(page.getByTestId("map-resize-vertex-0")).toBeVisible();
  const vertex = await page.getByTestId("map-resize-vertex-0").boundingBox();
  expect(vertex).not.toBeNull();
  await page.mouse.move(
    vertex!.x + vertex!.width / 2,
    vertex!.y + vertex!.height / 2,
  );
  await page.keyboard.down("Alt");
  await page.mouse.down();
  await page.mouse.move(vertex!.x + 25, vertex!.y + 18);
  await page.mouse.up();
  await page.keyboard.up("Alt");
  const path = page.locator('path[data-object-id]').last();
  const pathPoint = await path.evaluate((element) => {
    const pathElement = element as SVGPathElement;
    const point = pathElement.getPointAtLength(pathElement.getTotalLength() / 2);
    const screen = point.matrixTransform(pathElement.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(pathPoint.x, pathPoint.y);
  await expect(page.getByTestId("map-resize-vertex-0")).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByTestId("map-resize-handle-out-0")).toBeVisible();
  await page.getByTestId("map-add-vertex-0").click();
  await expect(page.getByTestId("map-resize-vertex-2")).toBeVisible();
  await page.getByTestId("map-resize-vertex-1").click();
  await page.getByTestId("map-remove-vertex").click();
  await expect(page.getByTestId("map-resize-vertex-2")).toHaveCount(0);
  await expect(page.getByTestId("map-layout-save-status")).toHaveText("Saved", { timeout: 5_000 });
  await page.getByTestId("map-editor-close").click();

  page.once("dialog", (dialog) =>
    dialog.accept("E2E shared map template"),
  );
  await page.getByTestId(`save-template-to-club-${templateSeq}`).click();
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
  await page.getByTestId("apply-map-template").click();

  const courseRow = page.getByTestId(`course-map-row-${courseSeq}`);
  await courseRow.locator("td").nth(1).click();
  const group = page.getByTestId(`course-map-group-${courseSeq}`);
  await expect(group).toBeVisible();
  await expect(group.locator("[data-testid^='course-map-']")).toHaveCount(1);

  await group.locator("[data-testid^='edit-course-map-']").click();
  await expect(page.getByTestId("map-layout-editor")).toBeVisible();
  const paper = page.getByTestId("map-paper");
  await expect(paper).toBeVisible();
  await expect(
    page
      .getByTestId("map-course-overlay")
      .locator('[data-map-layer="course-overlay-upper"]'),
  ).toBeVisible();
  await expect(
    page
      .getByTestId("map-course-overlay-lower")
      .locator('[data-map-layer="course-overlay-lower"]'),
  ).toBeVisible();
  await expect(page.getByTestId("map-preview-ink")).toBeVisible();
  await expect(page.getByTestId("map-print-margin")).toHaveCount(0);
  await page.getByTestId("map-panel-properties-toggle").click();
  await expect(page.getByText("Template objects are locked")).toBeVisible();
  await page.getByTestId("map-panel-page-toggle").click();
  await expect(page.getByTestId("map-print-scale")).toBeVisible();
  await paper.hover();
  await page.mouse.wheel(0, -500);
  await page.mouse.wheel(0, -500);
  await page.mouse.wheel(0, -500);
  await expect(page.getByTestId("map-print-scale")).toHaveValue("7500");
  const previewImage = page.getByTestId("map-preview-image");
  await expect(previewImage).toHaveAttribute("href", /dpi=(?!120)/);
  const previewHref = await previewImage.getAttribute("href");
  await page.mouse.wheel(0, -500);
  await expect(previewImage).toHaveAttribute("href", previewHref!);
  const viewBoxBefore = await paper.getAttribute("viewBox");
  const paperBox = await paper.boundingBox();
  await page.mouse.move(
    paperBox!.x + paperBox!.width / 2,
    paperBox!.y + paperBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    paperBox!.x + paperBox!.width / 2 + 30,
    paperBox!.y + paperBox!.height / 2 + 20,
  );
  await page.mouse.up();
  expect(await paper.getAttribute("viewBox")).not.toBe(viewBoxBefore);
  await page.getByTestId("map-zoom-reset").click();

  await placeObject(page, "map-tool-text");
  await expect(page.getByTestId("map-object-properties")).toBeVisible();
  await page.getByTestId("map-variable-event").click();
  await expect(page.getByTestId("map-object-text")).toHaveValue(
    "{course}{event}",
  );
  await page.getByTestId("map-text-font").selectOption("serif");
  await page.getByTestId("map-editor-undo").click();
  await expect(page.getByTestId("map-text-font")).toHaveValue("sans");
  await page.getByTestId("map-editor-redo").click();
  await expect(page.getByTestId("map-text-font")).toHaveValue("serif");
  await placeObject(page, "map-tool-rectangle");
  await page.getByTestId("map-object-fill-mode").selectOption("solid");
  await expect(page.getByTestId("map-object-fill-mode")).toHaveValue("solid");
  await page.getByTestId("map-object-fill-mode").selectOption("outOfBounds");
  await expect(page.getByTestId("map-object-fill-mode")).toHaveValue(
    "outOfBounds",
  );
  const rectangle = page.locator("[data-object-id]").last();
  const beforeResize = await rectangle.boundingBox();
  const resizeHandle = page.getByTestId("map-resize-se");
  const handleBox = await resizeHandle.boundingBox();
  expect(beforeResize).not.toBeNull();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2,
    handleBox!.y + handleBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + 35, handleBox!.y + 25);
  await page.mouse.up();
  const afterResize = await rectangle.boundingBox();
  expect(afterResize!.width).toBeGreaterThan(beforeResize!.width);

  const rectangleBox = await rectangle.boundingBox();
  const printableBox = await page.getByTestId("map-printable-area").boundingBox();
  await page.mouse.move(
    rectangleBox!.x + rectangleBox!.width / 2,
    rectangleBox!.y + rectangleBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(0, 0);
  await page.mouse.up();
  const constrainedBox = await rectangle.boundingBox();
  expect(constrainedBox!.x).toBeGreaterThanOrEqual(printableBox!.x - 1);

  await page.getByTestId("map-print-scale").fill("8000");
  await expect(page.getByTestId("map-layout-save-status")).toHaveText("Saved", { timeout: 5_000 });
  await page.getByTestId("map-editor-close").click();

  await group.getByTitle("Add map").click();
  await page
    .getByTestId("add-course-map-form")
    .getByRole("combobox")
    .selectOption(String(templateSeq));
  await page.getByTestId("add-course-map-submit").click();
  await expect(group.locator("[data-testid^='course-map-']")).toHaveCount(2);

  await group.locator("[data-testid^='edit-course-map-']").nth(1).click();
  await expect(page.locator("[data-object-id]")).toHaveCount(2);
  await page.getByTestId("map-editor-close").click();

  await page.getByTestId("add-all-controls-map").click();
  await expect(page.getByTestId("course-map-group-all")).toBeVisible();

  const firstMap = group.locator("[data-testid^='course-map-']").first();
  const [singleDownload] = await Promise.all([
    page.waitForEvent("download"),
    firstMap.getByTitle("Selected map").click(),
  ]);
  expect(singleDownload.suggestedFilename()).toMatch(/\.pdf$/);

  const [courseDownload] = await Promise.all([
    page.waitForEvent("download"),
    courseRow.getByTitle("All maps for this course").click(),
  ]);
  expect(courseDownload.suggestedFilename()).toMatch(/_maps\.pdf$/);

  await page.getByTestId("maps-export-menu").click();
  const [allControlsDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "All controls", exact: true }).click(),
  ]);
  expect(allControlsDownload.suggestedFilename()).toMatch(/\.pdf$/);

  // Tables use the standard horizontal-scroll wrapper for narrow screens.
  await expect(
    page.locator("[data-testid='maps-page'] div.overflow-x-auto table"),
  ).toBeVisible();

  // Panels, object list, description preview and the graphics library.
  await group.locator("[data-testid^='edit-course-map-']").first().click();
  await expect(page.getByTestId("map-layout-editor")).toBeVisible();

  // The description block previews the real rows of the course, not a
  // placeholder: title row plus one grid row per control.
  const descriptionBlock = page.getByTestId("map-description-block");
  await expect(descriptionBlock).toBeVisible();
  // Real rows: 7 column separators per control row plus the header line,
  // and a code/sequence text per row beyond the title.
  expect(await descriptionBlock.locator("line").count()).toBeGreaterThan(7);
  expect(await descriptionBlock.locator("text").count()).toBeGreaterThan(1);

  // Cards collapse to header bars and expand again.
  await expect(page.getByTestId("map-tool-select")).toBeVisible();
  await page.getByTestId("map-panel-tools-toggle").click();
  await expect(page.getByTestId("map-tool-select")).toHaveCount(0);
  await page.getByTestId("map-panel-tools-toggle").click();
  await expect(page.getByTestId("map-tool-select")).toBeVisible();

  // The object list selects stacked or hidden objects.
  await page.getByTestId("map-panel-objects-toggle").click();
  const objectItems = page.locator("[data-testid^='map-object-list-item-']");
  const objectCountBefore = await objectItems.count();
  expect(objectCountBefore).toBeGreaterThan(0);
  await objectItems.first().click();
  await expect(page.getByTestId("map-object-properties")).toBeVisible();

  // Upload an SVG graphic, place it on the paper, then delete it from the
  // object list.
  await page.getByTestId("map-panel-graphics-toggle").click();
  await page.getByTestId("map-graphic-upload").setInputFiles({
    name: "e2e-logo.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#336699"/></svg>`,
    ),
  });
  const placeGraphic = page
    .locator("[data-testid^='map-graphic-place-']")
    .first();
  await expect(placeGraphic).toBeVisible();
  await placeGraphic.click();
  const graphicPaper = await page.getByTestId("map-paper").boundingBox();
  await page.mouse.click(
    graphicPaper!.x + graphicPaper!.width * 0.6,
    graphicPaper!.y + graphicPaper!.height * 0.6,
  );
  await expect(objectItems).toHaveCount(objectCountBefore + 1);
  await page
    .locator("[data-testid^='map-object-list-delete-']")
    .last()
    .click();
  await expect(objectItems).toHaveCount(objectCountBefore);
  await page.getByTestId("map-editor-close").click();
});

test.describe("course-map editor touch gestures", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test("pans with the intended finger count and drags objects exactly", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await selectEvent(page);
    await openTab(page, "Map templates");
    await page.getByTestId("new-map-template").tap();
    await page.getByTestId("map-template-name").fill("E2E Mobile touch");
    await page.getByTestId("map-template-paper").selectOption("A4");
    await page.getByTestId("map-template-scale").fill("7500");
    await page.getByTestId("map-template-submit").tap();
    const mobileTemplateRow = page
      .locator("[data-testid^='map-template-']")
      .filter({ hasText: "E2E Mobile touch" });
    const mobileTemplateTestId =
      await mobileTemplateRow.getAttribute("data-testid");
    if (!mobileTemplateTestId) throw new Error("mobile template was not created");
    const mobileTemplateSeq = mobileTemplateTestId.replace(
      "map-template-",
      "",
    );
    await page
      .getByTestId(`edit-template-layout-${mobileTemplateSeq}`)
      .tap();
    const templatePaper = page.getByTestId("map-paper");
    await expect(templatePaper).toBeVisible();
    const templatePaperBox = await templatePaper.boundingBox();
    if (!templatePaperBox) throw new Error("template paper has no box");

    await page.getByTestId("map-panel-tools-toggle").tap();
    await page.getByTestId("map-tool-rectangle").tap();
    await page.getByTestId("map-panel-tools-toggle").tap();
    await page.touchscreen.tap(
      templatePaperBox.x + templatePaperBox.width * 0.6,
      templatePaperBox.y + templatePaperBox.height * 0.5,
    );
    const templateRectangle = page.locator("rect[data-object-id]").last();
    await expect(templateRectangle).toBeVisible();
    await page.getByTestId("map-panel-properties-toggle").tap();
    await expect(page.getByTestId("map-object-properties")).toHaveCount(0);
    const templateRectangleBox = await templateRectangle.boundingBox();
    if (!templateRectangleBox) throw new Error("template rectangle has no box");
    await touchPointerDrag(
      templateRectangle,
      templateRectangleBox.x + templateRectangleBox.width / 2,
      templateRectangleBox.y + templateRectangleBox.height / 2,
      35,
      15,
    );
    await expect(page.getByTestId("map-object-properties")).toHaveCount(0);
    const movedTemplateRectangleBox = await templateRectangle.boundingBox();
    if (!movedTemplateRectangleBox) {
      throw new Error("moved template rectangle has no box");
    }
    await touchPointerDrag(
      templateRectangle,
      movedTemplateRectangleBox.x + movedTemplateRectangleBox.width / 2,
      movedTemplateRectangleBox.y + movedTemplateRectangleBox.height / 2,
      0,
      0,
    );
    await expect(page.getByTestId("map-object-properties")).toBeVisible();
    await page.getByTestId("map-panel-properties-toggle").tap();

    await dispatchTouchGesture(templatePaper, [
      {
        from: {
          x: templatePaperBox.x + templatePaperBox.width * 0.35,
          y: templatePaperBox.y + templatePaperBox.height * 0.5,
        },
        to: {
          x: templatePaperBox.x + templatePaperBox.width * 0.25,
          y: templatePaperBox.y + templatePaperBox.height * 0.55,
        },
      },
      {
        from: {
          x: templatePaperBox.x + templatePaperBox.width * 0.65,
          y: templatePaperBox.y + templatePaperBox.height * 0.5,
        },
        to: {
          x: templatePaperBox.x + templatePaperBox.width * 0.78,
          y: templatePaperBox.y + templatePaperBox.height * 0.55,
        },
      },
    ]);
    await page.waitForTimeout(550);
    await page.getByTestId("map-editor-fullscreen").tap();
    await expect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(true);
    await page.getByTestId("map-panel-tools-toggle").tap();
    await page.getByTestId("map-tool-pan").tap();
    await page.getByTestId("map-panel-tools-toggle").tap();
    const viewBoxBeforeAlign = await templatePaper.getAttribute("viewBox");
    const previewImage = page.getByTestId("map-preview-image");
    await expect(previewImage).toBeVisible();
    const previewBeforeAlign = await previewImage.getAttribute("href");
    const fullscreenTemplateBox = await templatePaper.boundingBox();
    if (!fullscreenTemplateBox) {
      throw new Error("fullscreen template paper has no box");
    }
    await touchPointerDrag(
      templatePaper,
      fullscreenTemplateBox.x + fullscreenTemplateBox.width * 0.75,
      fullscreenTemplateBox.y + fullscreenTemplateBox.height * 0.7,
      40,
      20,
    );
    await expect(templatePaper).toHaveAttribute("viewBox", viewBoxBeforeAlign!);
    await expect
      .poll(() => previewImage.getAttribute("href"))
      .not.toBe(previewBeforeAlign);
    await page.getByTestId("map-editor-fullscreen").tap();
    await page.getByTestId("map-editor-close").tap();

    await openTab(page, "Maps");
    const firstCourseCheckbox = page
      .locator("[data-testid^='select-map-course-']")
      .first();
    await firstCourseCheckbox.check();
    await page
      .getByTestId("apply-map-template")
      .locator("..")
      .getByRole("combobox")
      .selectOption(mobileTemplateSeq);
    await page.getByTestId("apply-map-template").tap();
    const courseRow = page.locator("[data-testid^='course-map-row-']").first();
    await courseRow.locator("td").nth(1).tap();
    const group = page.locator("[data-testid^='course-map-group-']").first();
    await group.locator("[data-testid^='edit-course-map-']").first().tap();

    const paper = page.getByTestId("map-paper");
    await expect(paper).toBeVisible();
    await expect(paper).toHaveCSS("touch-action", "pan-y");
    const box = await paper.boundingBox();
    if (!box) throw new Error("map paper has no box");

    const initialViewBox = await paper.getAttribute("viewBox");
    await dispatchTouchGesture(paper, [
      {
        from: { x: box.x + box.width * 0.8, y: box.y + box.height * 0.7 },
        to: { x: box.x + box.width * 0.65, y: box.y + box.height * 0.6 },
      },
    ]);
    await expect(paper).toHaveAttribute("viewBox", initialViewBox!);

    await dispatchTouchGesture(paper, [
      {
        from: { x: box.x + box.width * 0.35, y: box.y + box.height * 0.5 },
        to: { x: box.x + box.width * 0.25, y: box.y + box.height * 0.55 },
      },
      {
        from: { x: box.x + box.width * 0.65, y: box.y + box.height * 0.5 },
        to: { x: box.x + box.width * 0.78, y: box.y + box.height * 0.55 },
      },
    ]);
    await expect
      .poll(() => paper.getAttribute("viewBox"))
      .not.toBe(initialViewBox);
    await page.waitForTimeout(550);

    await page.getByTestId("map-panel-tools-toggle").tap();
    await page.getByTestId("map-tool-rectangle").tap();
    await page.getByTestId("map-panel-tools-toggle").tap();
    await page.touchscreen.tap(
      box.x + box.width * 0.55,
      box.y + box.height * 0.5,
    );
    const rectangle = page.locator("rect[data-object-id]").last();
    await expect(rectangle).toBeVisible();
    const beforeDrag = await rectangle.boundingBox();
    if (!beforeDrag) throw new Error("rectangle has no box");
    const viewBoxBeforeDrag = await paper.getAttribute("viewBox");
    await touchPointerDrag(
      rectangle,
      beforeDrag.x + beforeDrag.width / 2,
      beforeDrag.y + beforeDrag.height / 2,
      40,
      20,
    );
    const afterDrag = await rectangle.boundingBox();
    expect(afterDrag).not.toBeNull();
    expect(Math.abs(afterDrag!.x - beforeDrag.x)).toBeGreaterThan(20);
    await expect(paper).toHaveAttribute("viewBox", viewBoxBeforeDrag!);

    const handle = page.getByTestId("map-resize-se");
    const handleBox = await handle.boundingBox();
    if (!handleBox) throw new Error("resize handle has no box");
    const beforeResize = await rectangle.boundingBox();
    await touchPointerDrag(
      handle,
      handleBox.x + handleBox.width / 2,
      handleBox.y + handleBox.height / 2,
      30,
      20,
    );
    const afterResize = await rectangle.boundingBox();
    expect(afterResize!.width).toBeGreaterThan(beforeResize!.width);

    await page.getByTestId("map-editor-fullscreen").tap();
    await expect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(true);
    await expect(paper).toHaveCSS("touch-action", "none");
    const fullscreenBox = await paper.boundingBox();
    if (!fullscreenBox) throw new Error("fullscreen paper has no box");
    const fullscreenViewBox = await paper.getAttribute("viewBox");
    await dispatchTouchGesture(paper, [
      {
        from: {
          x: fullscreenBox.x + fullscreenBox.width * 0.8,
          y: fullscreenBox.y + fullscreenBox.height * 0.75,
        },
        to: {
          x: fullscreenBox.x + fullscreenBox.width * 0.65,
          y: fullscreenBox.y + fullscreenBox.height * 0.65,
        },
      },
    ]);
    await expect
      .poll(() => paper.getAttribute("viewBox"))
      .not.toBe(fullscreenViewBox);
  });
});

async function dispatchTouchGesture(
  target: Locator,
  fingers: Array<{
    from: { x: number; y: number };
    to: { x: number; y: number };
  }>,
) {
  await target.evaluate((element, gesture) => {
    const touches = (
      points: Array<{ x: number; y: number }>,
    ): Touch[] =>
      points.map(
        (point, identifier) =>
          new Touch({
            identifier,
            target: element,
            clientX: point.x,
            clientY: point.y,
            pageX: point.x,
            pageY: point.y,
            screenX: point.x,
            screenY: point.y,
            radiusX: 1,
            radiusY: 1,
            rotationAngle: 0,
            force: 1,
          }),
      );
    const fire = (
      type: "touchstart" | "touchmove" | "touchend",
      points: Array<{ x: number; y: number }>,
      changed: Array<{ x: number; y: number }>,
    ) => {
      const active = touches(points);
      element.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: active,
          targetTouches: active,
          changedTouches: touches(changed),
        }),
      );
    };
    fire("touchstart", gesture.map((finger) => finger.from), gesture.map((finger) => finger.from));
    fire("touchmove", gesture.map((finger) => finger.to), gesture.map((finger) => finger.to));
    fire("touchend", [], gesture.map((finger) => finger.to));
  }, fingers);
  await target.page().waitForTimeout(50);
}

async function touchPointerDrag(
  target: Locator,
  x: number,
  y: number,
  dx: number,
  dy: number,
) {
  await target.evaluate(
    (element, gesture) => {
      // Synthetic pointer capture is not backed by an active browser
      // pointer, so make capture a no-op while exercising the same React
      // touch-pointer path used by a physical device.
      const svgElement = element as SVGElement;
      const originalCapture = svgElement.setPointerCapture;
      svgElement.setPointerCapture = () => {};
      const fire = (
        type: "pointerdown" | "pointermove" | "pointerup",
        clientX: number,
        clientY: number,
      ) =>
        element.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId: 7,
            pointerType: "touch",
            isPrimary: true,
            clientX,
            clientY,
            buttons: type === "pointerup" ? 0 : 1,
          }),
        );
      fire("pointerdown", gesture.x, gesture.y);
      fire("pointermove", gesture.x + gesture.dx, gesture.y + gesture.dy);
      fire("pointerup", gesture.x + gesture.dx, gesture.y + gesture.dy);
      svgElement.setPointerCapture = originalCapture;
    },
    { x, y, dx, dy },
  );
  await target.page().waitForTimeout(50);
}
