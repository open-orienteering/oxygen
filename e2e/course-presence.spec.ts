// Presence and live refresh in the new course editor (docs/course-editor.md
// §11; docs/course-layer.md §7; D11): two browser contexts on one event. A
// context with a course open shows in the other's top bar ("Someone · Course
// · Field"), and a control moved in one context moves in the other within the
// poll, with a one-line notice when the course itself changed.
import { devices, test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { coveredBy, drag, editorReady, legPieces, select, site, sitePoint, sites, toPage, viewSettled } from "./helpers/editor";
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

/**
 * Regular numeric-code controls whose page points are inside the viewer, clear of the chrome (as
 * `course-editor.spec.ts`) and of the course's own legs: a leg drawn across another control's centre takes the
 * click (the leg is selected, "Insert into course"), and whether one does depends on how the view settled.
 */
async function clearCodes(page: Page): Promise<string[]> {
  const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
  const inspector = await page.getByTestId("editor-inspector").boundingBox();
  const legs = await Promise.all((await legPieces(page)).map((l) => Promise.all(l.points.map((q) => toPage(page, q)))));
  const segDist = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  const out: string[] = [];
  for (const s of await sites(page)) {
    if (s.type !== "Control" || !/^\d+$/.test(s.code)) continue;
    const p = await toPage(page, s.mm);
    if (p.x < viewer.x + 30 || p.x > viewer.x + viewer.width - 120 || p.y < viewer.y + 30 || p.y > viewer.y + viewer.height - 80) continue;
    if (inspector && p.x < inspector.x + inspector.width + 40) continue;
    if (await coveredBy(page, p)) continue;
    // A leg ends at a circle's rim, so a leg within 6 px of a centre runs across someone else's circle.
    if (legs.some((pts) => pts.some((q, i) => i > 0 && segDist(p, pts[i - 1]!, q) < 6))) continue;
    out.push(s.code);
  }
  return out;
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
  // The seed is `vector` with the new editor on (docs/map-pipeline-switch.md §5).
  await reseed();
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
    // Points are read once the view has stopped (the editor fits after mounting), and the select retries.
    await viewSettled(a.page);
    const target = { code: (await clearCodes(a.page))[0]! };
    expect(target.code, "a control clear of the chrome and the legs").toBeTruthy();
    const before = await site(b.page, target.code);
    await select(a.page, target.code);
    const from = await sitePoint(a.page, target.code);
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
    await viewSettled(a.page);
    const last = (await clearCodes(a.page)).pop();
    expect(last, "a control clear of the chrome and the legs").toBeTruthy();
    await select(a.page, last!);
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
