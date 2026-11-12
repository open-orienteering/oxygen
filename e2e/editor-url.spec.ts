// The editor's URL follows its state (docs/course-editor.md §1 "URL"; F31,
// feedback-2026-11-11-merge.md item 4 with the user's answers 1–2): the
// course, the mode, the view with its class, Layout's sheet, always written
// with history `replace`, defaults left out. A reload restores the state,
// Back leaves the editor in one step, an invalid param falls back to its
// default and leaves the URL, and `control=` is an inbound link only.
import { test, expect, devices, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { cleanup, clickTab, editorReady, ensureCoursesAndMap, ensureFixtureFromDesktop, nameIdOf, openEditor, probeTemplate, selectCompetition, selectedCode, trpcCall } from "./helpers/editor";

test.beforeAll(reseed);
test.setTimeout(120_000);

/** The editor's query string, without `?`. */
const query = (page: Page): string => new URL(page.url()).search.replace(/^\?/, "");

/** A fixture course with classes (Class view) and no sheet of its own. */
async function courseWithClasses(): Promise<{ id: number; cls: { seq: number; name: string } }> {
  const courses = await trpcCall<{ id: number; name: string }[]>("course.list", undefined, false);
  const sheets = await trpcCall<{ courseId: number | null }[]>("courseMap.list", undefined, false);
  for (const c of courses) {
    if (sheets.some((s) => s.courseId === c.id)) continue;
    const classes = await trpcCall<{ seq: number; name: string }[]>("layout.classOverrides", { courseId: c.id }, false);
    if (classes.length) return { id: c.id, cls: classes[0] };
  }
  throw new Error("no fixture course with classes and no sheet");
}

test.describe("Editor URL (F31)", () => {
  test.skip(({ isMobile }) => !!isMobile, "desktop flows; the phone's are below");

  test("the URL follows course, mode, view and sheet by replace; a reload restores them; Back leaves in one step", async ({ page }) => {
    await selectCompetition(page);
    await ensureCoursesAndMap(page);
    const nameId = nameIdOf(page);
    const { id: courseId, cls } = await courseWithClasses();
    const template = await probeTemplate("URL probe");
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId, templateId: template.seq, overrides: {}, objects: [] });
    try {
      // From the Courses page, so Back has somewhere to go.
      await page.goto(`/${nameId}/courses`);
      await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60_000 });
      await clickTab(page, "Course Editor");
      await editorReady(page);
      expect(query(page)).toBe("");
      const historyAtEntry = await page.evaluate(() => history.length);

      // Course: `course=`.
      await page.getByTestId("editor-course-picker").selectOption(String(courseId));
      await expect.poll(() => query(page)).toBe(`course=${courseId}`);

      // Class view: `view=class&class=`.
      await page.getByTestId("editor-view-class").selectOption(String(cls.seq));
      await expect.poll(() => query(page)).toBe(`course=${courseId}&view=class&class=${cls.seq}`);
      await page.getByTestId("editor-view-course").click();
      await expect.poll(() => query(page)).toBe(`course=${courseId}`);

      // Layout: `mode=layout&sheet=` (the course's sheet).
      await page.getByTestId("editor-mode-layout").click();
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq), { timeout: 30_000 });
      await expect.poll(() => query(page)).toBe(`course=${courseId}&mode=layout&sheet=${sheet.seq}`);

      // A reload restores the course, the mode and the sheet.
      await page.reload();
      await editorReady(page);
      await expect(page.getByTestId("editor-mode-layout")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("editor-course-picker")).toHaveValue(String(courseId));
      await expect(page.getByTestId("editor-layout-scope")).toHaveAttribute("data-sheet", String(sheet.seq), { timeout: 30_000 });
      expect(query(page)).toBe(`course=${courseId}&mode=layout&sheet=${sheet.seq}`);

      // Back in Course mode, Class view survives a reload too.
      await page.getByTestId("editor-mode-course").click();
      await page.getByTestId("editor-view-class").selectOption(String(cls.seq));
      await expect.poll(() => query(page)).toBe(`course=${courseId}&view=class&class=${cls.seq}`);
      await page.reload();
      await editorReady(page);
      await expect(page.getByTestId("editor-view-class")).toHaveValue(String(cls.seq), { timeout: 15_000 });
      await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
      expect(query(page)).toBe(`course=${courseId}&view=class&class=${cls.seq}`);

      // Field mode: `mode=field`; the view picker's All controls: `view=all`.
      await page.getByTestId("editor-view-all").click();
      await page.getByTestId("editor-mode-field").click();
      await expect.poll(() => query(page)).toBe(`course=${courseId}&mode=field&view=all`);

      // Every change replaced the entry: no history was pushed, and one Back leaves the editor.
      expect(await page.evaluate(() => history.length)).toBe(historyAtEntry);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/${nameId}/courses$`));
    } finally {
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
    }
  });

  test("an invalid param falls back to its default and leaves the URL; a deleted course selects none", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const { id: courseId } = await courseWithClasses();

    // An unknown mode and view: Course mode, Course view, both params gone; the valid course stays.
    await page.goto(`/${nameId}/course-editor?course=${courseId}&mode=bogus&view=nope`);
    await editorReady(page);
    await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("editor-course-picker")).toHaveValue(String(courseId));
    await expect.poll(() => query(page)).toBe(`course=${courseId}`);

    // A class that is not the course's: Course view, `view` and `class` gone.
    await page.goto(`/${nameId}/course-editor?course=${courseId}&view=class&class=99999`);
    await editorReady(page);
    await expect.poll(() => query(page)).toBe(`course=${courseId}`);
    await expect(page.getByTestId("editor-view-course")).toHaveAttribute("aria-pressed", "true");

    // A sheet that does not exist: Layout's default, and the param gone.
    await page.goto(`/${nameId}/course-editor?mode=layout&sheet=99999`);
    await editorReady(page);
    await expect(page.getByTestId("editor-mode-layout")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => query(page)).not.toContain("sheet=99999");
    expect(query(page)).toMatch(/^mode=layout(&|$)/);

    // A deleted course: no course, and the param gone.
    const gone = await trpcCall<{ id: number }>("course.create", { name: `URL gone ${Date.now() % 100000}` });
    await trpcCall("course.delete", { id: gone.id });
    await page.goto(`/${nameId}/course-editor?course=${gone.id}`);
    await editorReady(page);
    await expect.poll(() => query(page)).toBe("");
    await expect(page.getByTestId("editor-course-picker")).toHaveValue("");
  });

  test("the Courses and Controls pages' links land, and control= is gone once used", async ({ page }) => {
    await openEditor(page);

    await clickTab(page, "Courses");
    const courseLink = page.getByTestId("course-edit-link").first();
    await expect(courseLink).toBeVisible({ timeout: 10_000 });
    const linked = new URL((await courseLink.getAttribute("href"))!, page.url()).searchParams.get("course");
    await courseLink.click();
    await editorReady(page);
    await expect(page.getByTestId("editor-course-picker")).toHaveValue(linked!);
    expect(query(page)).toBe(`course=${linked}`);

    await clickTab(page, "Controls");
    const controlLink = page.getByTestId("control-edit-link").first();
    await expect(controlLink).toBeVisible({ timeout: 10_000 });
    expect(await controlLink.getAttribute("href")).toMatch(/[?&]control=\d+/);
    await controlLink.click();
    await editorReady(page);
    await expect(selectedCode(page)).toBeVisible({ timeout: 30_000 });
    // The selection is not in the URL (answer 2): the inbound param is dropped once used.
    await expect.poll(() => query(page)).toBe("");
    await expect(selectedCode(page)).toBeVisible();
  });
});

// A phone: no `mode` opens Field, the URL's mode wins (§1 "URL", §10).
test.describe("Editor URL on a phone (F31)", () => {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the browser type is the project's
  const { defaultBrowserType: _, ...phone } = devices["Pixel 7"];
  test.use(phone);

  test("no mode opens Field and writes it; the URL's Course mode wins", async ({ page, browser }) => {
    const nameId = await ensureFixtureFromDesktop(browser, test.info());
    await page.goto(`/${nameId}/course-editor`);
    await editorReady(page);
    await expect(page.getByTestId("editor-mode-field")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => query(page)).toBe("mode=field");

    await page.goto(`/${nameId}/course-editor?mode=course`);
    await editorReady(page);
    await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
  });
});
