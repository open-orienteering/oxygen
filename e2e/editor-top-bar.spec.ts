// The editor's top bar collapses to icons when its row is short (docs/course-editor.md §2 "Top bar", F29).
// `map-toolbar` is a CSS container; below TIER1_PX the labels of Hide other controls, Auto slits, Hide
// descriptions and Export and the course picker's "Course" word go, below TIER2_PX the mode switch shows its
// icons alone. The view group stays text and every control keeps its test id and accessible name.
//
// The toolbar's width at a given viewport depends on the shell's container (F28 widens the editor's), so each
// step reads the row's width and asserts the band it is in, then that band's look: the test holds before and
// after F28.
import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { clickTab, editorReady, ensureCoursesAndMap, selectCompetition } from "./helpers/editor";
import { TIER1_PX, TIER2_PX } from "../packages/web/src/components/top-bar-collapse";

test.beforeAll(reseed);
test.setTimeout(120_000);

/** The row's content width, inside its padding: what the container query measures. */
const toolbarWidth = (page: Page) =>
  page.getByTestId("map-toolbar").evaluate((bar) => {
    const cs = getComputedStyle(bar);
    return bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  });

/** Every shown item of the toolbar row (the top bar's items and MapPanel's own group) on one line. */
async function expectOneRow(page: Page) {
  const tops = await page.getByTestId("map-toolbar").evaluate((bar) => {
    const tb = bar.querySelector('[data-testid="editor-top-bar"]')!;
    const items = [...tb.children, ...[...bar.children].filter((e) => e !== tb)].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    return items.map((e) => {
      const r = e.getBoundingClientRect();
      return r.top + r.height / 2;
    });
  });
  expect(tops.length).toBeGreaterThan(8);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(6);
}

/** The labels tier 1 hides, by the control that carries them. */
const tier1Labels = (page: Page) => [
  page.getByTestId("editor-hide-others").locator("[data-toolbar-label]"),
  page.getByTestId("editor-toggle-cuts").locator("[data-toolbar-label]"),
  page.getByTestId("map-toggle-descriptions").locator("[data-toolbar-label]"),
  page.getByTestId("editor-export").getByText("Export", { exact: true }),
  page.getByTestId("editor-top-bar").locator("label").getByText("Course", { exact: true }),
];

const MODES = [
  ["course", "Course"],
  ["layout", "Layout"],
  ["field", "Field"],
] as const;

/** The names that hold at every width (the hidden words live on in `aria-label`). */
async function expectNames(page: Page) {
  const bar = page.getByTestId("map-toolbar");
  await expect(bar.getByRole("combobox", { name: "Course", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Hide other controls" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Auto slits" })).toBeVisible();
  await expect(bar.getByRole("button", { name: /^(Hide )?descriptions$/i })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Export ▾" })).toBeVisible();
  const modes = bar.getByRole("group", { name: "Mode" });
  for (const [mode, word] of MODES) {
    const b = modes.getByRole("button", { name: word, exact: true });
    await expect(b).toHaveAttribute("data-testid", `editor-mode-${mode}`);
    await expect(b).toHaveAttribute("title", word);
  }
  // The view group stays text.
  await expect(page.getByTestId("editor-view-course")).toHaveText("Course");
  await expect(page.getByTestId("editor-view-all")).toHaveText("All controls");
}

async function expectTier(page: Page, tier: 0 | 1 | 2) {
  for (const l of tier1Labels(page)) {
    if (tier === 0) await expect(l).toBeVisible();
    else await expect(l).toBeHidden();
  }
  for (const [mode, word] of MODES) {
    const b = page.getByTestId(`editor-mode-${mode}`);
    if (tier === 2) {
      await expect(b.getByText(word, { exact: true })).toBeHidden();
      await expect(b.locator("svg")).toBeVisible();
    } else {
      await expect(b.getByText(word, { exact: true })).toBeVisible();
      await expect(b.locator("svg")).toBeHidden();
    }
  }
}

const tierOf = (w: number): 0 | 1 | 2 => (w >= TIER1_PX ? 0 : w >= TIER2_PX ? 1 : 2);

test("F29: the top bar fits one row at 1840 × 1090 and collapses by the row's width", async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1090 });
  await selectCompetition(page);
  await ensureCoursesAndMap(page);
  await clickTab(page, "Course Editor");
  await editorReady(page);
  // Bana 1 has classes, so the view group carries its Class ▾ (the widest seeded row).
  const picker = page.getByTestId("editor-course-picker");
  await picker.selectOption({ label: "Bana 1" });
  await expect(page.getByTestId("editor-sequence")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("editor-view-class")).toBeVisible();

  // The user's laptop: one row, whichever tier the row's width gives.
  await expectOneRow(page);
  await expectTier(page, tierOf(await toolbarWidth(page)));
  await expectNames(page);

  // Each band at a viewport that lands in it, before and after F28's wider editor.
  for (const [width, tier] of [
    [2400, 0],
    [1500, 1],
    [1100, 2],
  ] as const) {
    await page.setViewportSize({ width, height: 1090 });
    await expect.poll(() => toolbarWidth(page).then(tierOf), { message: `toolbar band at ${width}px` }).toBe(tier);
    await expectTier(page, tier);
    await expectOneRow(page);
    await expectNames(page);
    if (tier === 2) {
      // A collapsed control still works: the icon-only mode button switches, the icon-only Export opens its menu.
      await page.getByTestId("editor-mode-layout").click();
      await expect(page.getByTestId("editor-mode-layout")).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("editor-mode-course").click();
      await expect(page.getByTestId("editor-mode-course")).toHaveAttribute("aria-pressed", "true");
      await page.getByTestId("editor-export").click();
      await expect(page.getByRole("menu")).toBeVisible();
      await page.getByTestId("editor-export").click();
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
  }
});
