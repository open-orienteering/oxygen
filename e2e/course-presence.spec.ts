// Presence and live refresh in the new course editor (docs/course-editor.md
// §11; docs/course-layer.md §7; D11): two browser contexts on one event. A
// context with a course open shows in the other's top bar ("Someone · Course
// · Field"), and a control moved in one context moves in the other within the
// poll, with a one-line notice when the course itself changed.
import { devices, test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { setEditorVector, setMapPipeline } from "./helpers/map-pipeline";
import { reseed } from "./helpers/reseed";
import { clickMap, drag, editorReady, site, sitePoint, sites } from "./helpers/editor";
import { waitForTrpc } from "./helpers/trpc";

let nameId = "";
let courseSeq = "";
let courseName = "";

test.setTimeout(150_000);

async function open(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the browser type is the project's
  const { defaultBrowserType: _, ...desktop } = devices["Desktop Chrome"];
  const ctx = await browser.newContext({ ...desktop, baseURL: test.info().project.use.baseURL, extraHTTPHeaders: test.info().project.use.extraHTTPHeaders });
  return { ctx, page: await ctx.newPage() };
}

/** A fresh context has no event selected: pick it, then open the editor on the course. */
async function enter(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
  await page.goto(`/${nameId}/course-editor?course=${courseSeq}`);
  await editorReady(page);
}

test.beforeAll(async ({ browser }) => {
  await reseed();
  await setMapPipeline("vector");
  await setEditorVector(true);
  const { ctx, page } = await open(browser);
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
  nameId = new URL(page.url()).pathname.split("/")[1];
  await page.goto(`/${nameId}/courses`);
  const uploadButton = page.getByRole("button", { name: "Upload map" });
  await expect(uploadButton.or(page.getByTestId("map-viewer")).first()).toBeVisible({ timeout: 60000 });
  if (await uploadButton.isVisible()) {
    await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Import courses" }).click();
    const importChooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Browse files" }).click();
    await (await importChooser).setFiles("e2e/test.ocd");
    await expect(page.getByText("Courses and Class Assignments")).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "Öppen 1" }).click();
    await page.getByRole("row", { name: /^E / }).getByRole("button", { name: "— Skip —", exact: true }).click();
    await page.getByTestId("course-import-replace-all").uncheck();
    await page.getByRole("button", { name: "Import 5 courses" }).click();
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: "Done" }).click();
    const mapChooser = page.waitForEvent("filechooser");
    await page.getByTestId("map-panel").getByRole("button", { name: "Upload map" }).click();
    await (await mapChooser).setFiles("e2e/test.ocd");
    await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
  }
  await page.goto(`/${nameId}/course-editor`);
  await editorReady(page);
  const option = page.getByTestId("editor-course-picker").locator("option").nth(1);
  courseSeq = (await option.getAttribute("value"))!;
  courseName = (await option.textContent())!;
  await ctx.close();
});

test.afterAll(async () => {
  await setEditorVector(null);
  await setMapPipeline("legacy");
});

test("two contexts: presence appears and expires; a move shows in the other within the poll", async ({ browser }) => {
  const a = await open(browser);
  const b = await open(browser);
  try {
    for (const { page } of [a, b]) {
      await enter(page);
    }

    // Presence: B switches to Field mode; A shows "<who> · <course> · Field" within a heartbeat or two.
    await b.page.getByTestId("editor-mode-field").click();
    const aEntries = a.page.getByTestId("editor-presence-entry");
    await expect(aEntries.filter({ hasText: `${courseName} · Field` })).toHaveCount(1, { timeout: 20_000 });
    await expect(aEntries.filter({ hasText: `${courseName} · Field` })).toHaveAttribute("data-here", "true");
    // B sees A in Course mode.
    await expect(b.page.getByTestId("editor-presence-entry").filter({ hasText: `${courseName} · Course` })).toHaveCount(1, { timeout: 20_000 });
    await b.page.getByTestId("editor-mode-course").click();

    // A move in A shows in B within the poll.
    const regular = (await sites(a.page)).filter((s) => s.type === "Control" && /^\d+$/.test(s.code));
    const target = regular[0];
    const before = await site(b.page, target.code);
    const from = await sitePoint(a.page, target.code);
    await clickMap(a.page, from);
    await expect(a.page.getByTestId("editor-selected-code")).toContainText(target.code, { timeout: 10_000 });
    const saved = waitForTrpc(a.page, "control.update");
    await drag(a.page, from, { x: from.x + 40, y: from.y + 30 });
    await saved;
    await expect.poll(async () => (await site(b.page, target.code)).mm.x, { timeout: 20_000 }).not.toBe(before.mm.x);

    // A closes the editor: its row ages out of B's bar after the TTL.
    await a.page.goto(`/${nameId}/courses`);
    await expect(b.page.getByTestId("editor-presence-entry")).toHaveCount(0, { timeout: 60_000 });
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});

test("a course changed in another context re-renders with a one-line notice", async ({ browser }) => {
  const a = await open(browser);
  const b = await open(browser);
  try {
    for (const { page } of [a, b]) {
      await enter(page);
    }
    const rows = (p: Page) => p.locator('[data-testid="editor-seq-row"][data-kind="control"]');
    const count = await rows(b.page).count();
    // A appends a control at an empty spot (create-and-append).
    const regular = (await sites(a.page)).filter((s) => s.type === "Control" && /^\d+$/.test(s.code));
    await clickMap(a.page, await sitePoint(a.page, regular[regular.length - 1].code));
    await expect(a.page.getByTestId("editor-selected-code")).toContainText(regular[regular.length - 1].code, { timeout: 10_000 });
    const saved = waitForTrpc(a.page, "course.setStructure");
    await a.page.getByTestId("editor-action-bar").getByTestId("editor-action-append").click();
    await saved;
    await expect(rows(b.page)).toHaveCount(count + 1, { timeout: 20_000 });
    await expect(b.page.getByTestId("editor-external-change")).toBeVisible();
    await expect(a.page.getByTestId("editor-external-change")).toHaveCount(0);
  } finally {
    await a.ctx.close();
    await b.ctx.close();
  }
});
