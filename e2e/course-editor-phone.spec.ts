// The editor on a phone (docs/course-editor.md §10, Pixel 7): the touch subset in Course mode, the read-only Leg
// section (F3), and the variation block (F7).
// Split from the editor's one spec file along its describes (docs/e2e-sharding.md "CI"); the
// helpers they share are `helpers/course-editor-spec.ts`. It runs under the `mobile` project only.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`, the fixture import idempotent per test
// (`openEditor` → `ensureCoursesAndMap`), courses a test creates carry a prefix and go with the
// next reseed, controls / objects / sheets it creates are deleted in `finally` (`cleanup`).

import { expect, test, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { cleanup, controlRows, editorReady, ensureFixtureFromDesktop, legPieces, site, sites, toPage, trpcCall } from "./helpers/editor";
import { touchDrag, touchTap } from "./helpers/touch";
import { waitForTrpc } from "./helpers/trpc";
import { type Pt } from "./helpers/course-editor-spec";

test.beforeAll(async () => {
  await reseed();
});

test.setTimeout(120_000);

// docs/course-editor.md §10: the editor's touch subset in Course mode, run by the `mobile` project (Pixel 7). Field
// mode's own phone flows — the sheet, the long-press move and loupe, the area outline tap and pinch — are
// `field-mode.spec.ts`; the area-press rule's touch half (a tap on the outline selects, inside does not) is there.
test.describe("touch (mobile project; docs/course-editor.md §10)", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone's subset (the desktop flows are above)");
  let nameId = "";

  test.beforeEach(async ({ browser }, info) => {
    // The import dialog is a desktop flow: the fixture from a desktop context, idempotent.
    nameId = await ensureFixtureFromDesktop(browser, info);
  });

  async function courseMode(page: Page): Promise<string> {
    await page.goto(`/${nameId}/course-editor`);
    await editorReady(page);
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-layout", "phone");
    await page.getByTestId("editor-mode-course").click();
    await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
    const name = `D10 touch ${Date.now() % 100000}`;
    const { id } = await trpcCall<{ id: number }>("course.create", { name });
    await page.reload();
    await editorReady(page);
    await page.getByTestId("editor-mode-course").click();
    await page.getByTestId("editor-course-picker").selectOption(String(id));
    await expect(page.locator('[data-testid="editor-seq-row"][data-kind="start"]')).toBeAttached({ timeout: 15000 });
    return name;
  }

  /** A regular control in the band above the sheet, clear of its neighbours. */
  async function visibleControl(page: Page, exclude: string[] = []): Promise<{ code: string; at: Pt }> {
    const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
    const sheet = (await page.getByTestId("editor-sheet").boundingBox())!;
    const all = await sites(page);
    for (const s of all) {
      if (s.type !== "Control" || !/^\d+$/.test(s.code) || exclude.includes(s.code)) continue;
      const at = await toPage(page, s.mm);
      if (at.x < viewer.x + 60 || at.x > viewer.x + viewer.width - 60 || at.y < viewer.y + 110 || at.y > sheet.y - 90) continue;
      const others = await Promise.all(all.filter((o) => o.id !== s.id).map((o) => toPage(page, o.mm)));
      if (others.some((o) => Math.hypot(o.x - at.x, o.y - at.y) < 50)) continue;
      return { code: s.code, at };
    }
    throw new Error("no clear control in view");
  }

  test("Course mode on a phone: a tap selects, the peek row appends, one finger moves the selected control, the overflow undoes", async ({ page }) => {
    await courseMode(page);
    const c = await visibleControl(page);
    const start = (await site(page, c.code)).mm;
    try {
      await touchTap(page, c.at);
      await expect(page.getByTestId("editor-sheet-selection")).toContainText(c.code, { timeout: 10000 });
      // The action bar is the sheet's peek row (§10): ≥ 44 px targets, nothing at the selection on the map.
      const append = page.getByTestId("editor-sheet").getByTestId("editor-action-append");
      await expect(append).toBeVisible();
      expect((await append.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // The one action bar is the sheet's (`actionLayout: "host"`): the viewer draws none at the selection.
      await expect(page.getByTestId("editor-action-bar")).toHaveCount(1);
      await expect(page.getByTestId("editor-sheet").getByTestId("editor-action-bar")).toHaveCount(1);
      const appended = waitForTrpc(page, "course.setStructure");
      await append.click();
      await appended;
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
      await expect(controlRows(page).nth(0)).toHaveAttribute("data-control-id", c.code);

      // One finger on the selected control drags it at once (no long press), drawn above the finger.
      const moved = waitForTrpc(page, "control.update");
      await touchDrag(page, c.at, { x: c.at.x + 30, y: c.at.y - 20 }, { steps: 6 });
      await moved;
      await expect.poll(async () => {
        const now = (await site(page, c.code)).mm;
        return Math.hypot(now.x - start.x, now.y - start.y);
      }, { timeout: 15000 }).toBeGreaterThan(0.5);

      // The overflow's undo puts it back.
      await page.getByTestId("editor-overflow").click();
      const undone = waitForTrpc(page, "control.update");
      await page.getByTestId("editor-overflow-menu").getByTestId("editor-undo").click();
      await undone;
      await expect.poll(async () => {
        const now = (await site(page, c.code)).mm;
        return Math.hypot(now.x - start.x, now.y - start.y);
      }, { timeout: 15000 }).toBeLessThan(0.01);
    } finally {
      await cleanup("control.update", { id: Number(c.code), xpos: start.x, ypos: start.y });
    }
  });

  test("the pin-drop K flow in Course mode appends a placed control to the course and the layer draws its leg", async ({ page }) => {
    const name = await courseMode(page);
    const before = new Set((await sites(page)).map((s) => s.code));
    await page.getByTestId("editor-field-add").click();
    await page.getByTestId("editor-add-K").click();
    await expect(page.getByTestId("editor-touch-bar")).toBeVisible();
    const placed = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-touch-place").click();
    await placed;
    await page.getByTestId("editor-touch-done").click();
    await expect(page.getByTestId("editor-touch-bar")).toHaveCount(0);
    await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
    const code = (await controlRows(page).nth(0).getAttribute("data-control-id"))!;
    expect(before.has(code)).toBe(false);
    try {
      // The start → control leg ends at the new circle's rim.
      const mm = (await site(page, code)).mm;
      await expect.poll(async () => (await legPieces(page, name)).some((l) => {
        const end = l.points.at(-1)!;
        return Math.hypot(end.x - mm.x, end.y - mm.y) < 4;
      }), { timeout: 15000 }).toBe(true);
    } finally {
      await cleanup("control.delete", { id: Number(code) });
    }
  });
});

test.describe("F3 on a phone: the Leg section is read-only (docs/course-editor.md §6.7, §10)", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone's subset");

  test("a tapped leg shows its section, disabled, and says leg editing is for desktop and tablet", async ({ page, browser }, info) => {
    const nameId = await ensureFixtureFromDesktop(browser, info);
    await page.goto(`/${nameId}/course-editor`);
    await editorReady(page);
    await page.getByTestId("editor-mode-course").click();
    const name = `F3 phone ${Date.now() % 100000}`;
    const { id } = await trpcCall<{ id: number }>("course.create", { name });
    await page.reload();
    await editorReady(page);
    await page.getByTestId("editor-mode-course").click();
    await page.getByTestId("editor-course-picker").selectOption(String(id));
    await expect(page.locator('[data-testid="editor-seq-row"][data-kind="start"]')).toBeAttached({ timeout: 15000 });
    // The course's start → finish leg (no controls): tap its middle.
    await expect.poll(async () => (await legPieces(page, name)).length, { timeout: 15000 }).toBeGreaterThan(0);
    const piece = (await legPieces(page, name))[0].points;
    const mid = { x: (piece[0].x + piece.at(-1)!.x) / 2, y: (piece[0].y + piece.at(-1)!.y) / 2 };
    await expect(async () => {
      await touchTap(page, await toPage(page, mid));
      await expect(page.getByTestId("editor-leg")).toBeAttached({ timeout: 3000 });
    }).toPass({ timeout: 30000 });
    await expect(page.getByTestId("editor-leg")).toHaveAttribute("data-readonly", "true");
    await expect(page.getByTestId("editor-leg-style")).toBeDisabled();
    await expect(page.getByTestId("editor-leg-readonly")).toBeAttached();
    await expect(page.getByTestId("editor-action-add-bend")).toHaveCount(0);
  });
});

test.describe("F7 on a phone: the variation block switches alternatives only (docs/course-editor.md §12, §10)", () => {
  test.skip(({ isMobile }) => !isMobile, "the phone's subset");

  test("the tabs show the alternatives; adding, renaming, the loop are disabled and the block says so", async ({ page, browser }, info) => {
    const nameId = await ensureFixtureFromDesktop(browser, info);
    const [c1, c2, c3] = await regularCodesOver(4);
    const name = `F7 phone ${Date.now() % 100000}`;
    const { id } = await trpcCall<{ id: number }>("course.create", { name });
    await trpcCall("course.setStructure", {
      courseId: id,
      structure: {
        version: 1, id: "f7", orderMode: "ordered",
        items: [{ siteId: c1 }, { kind: "variation", id: "v1", alternatives: [{ label: "A", items: [{ siteId: c2 }] }, { label: "B", items: [] }] }, { siteId: c3 }],
      },
    });
    await page.goto(`/${nameId}/course-editor`);
    await editorReady(page);
    await page.getByTestId("editor-mode-course").click();
    await page.getByTestId("editor-course-picker").selectOption(String(id));
    const block = page.getByTestId("editor-variation");
    await expect(block).toBeAttached({ timeout: 15000 });
    await expect(page.getByTestId("editor-variation-readonly")).toBeAttached();
    await expect(page.getByTestId("editor-variation-add")).toBeDisabled();
    await expect(page.getByTestId("editor-variation-loop")).toBeDisabled();
    await expect(page.locator('[data-testid="editor-seq-row"][data-alternative="A"]')).toHaveCount(1);
    await page.getByTestId("editor-variation-tab-B").dispatchEvent("click");
    await expect(page.getByTestId("editor-variation-tab-B")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid="editor-seq-row"][data-alternative="A"]')).toHaveCount(0);
  });

  /** Regular controls of the fixture event, by public id. */
  async function regularCodesOver(n: number): Promise<number[]> {
    const list = await trpcCall<{ id: number; kind: string }[]>("control.list", undefined, false);
    return list.filter((c) => c.kind === "control").slice(0, n).map((c) => c.id);
  }
});
