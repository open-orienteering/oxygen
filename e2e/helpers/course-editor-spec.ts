// Helpers shared by the course editor's spec files (e2e/course-editor*.spec.ts): the editor's spec was one file
// until it was split along its describes for the CI shards (docs/e2e-sharding.md "CI").
import { expect, test, type Page } from "@playwright/test";
import { coveredBy, drag, emptyPoint, labelOf, regularCodes, select, sites, toPage, viewSettled } from "./editor";
import { waitForTrpc } from "./trpc";

export type Pt = { x: number; y: number };

/** The desktop flows: skipped on the phone (it opens in Field mode with no rail or inspector, §10). */
export const desktopOnly = () => test.skip(({ isMobile }) => !!isMobile, "desktop flow (the phone's subset is the touch describe)");

/** Every option's `value` of the course picker by its label. */
export async function courseIdByName(page: Page, name: string): Promise<string> {
  const option = page.getByTestId("editor-course-picker").locator("option", { hasText: new RegExp(`^${name}$`) });
  return (await option.getAttribute("value"))!;
}

/** Select a site, then the action bar's `editor-action-<id>`; waits for the write. */
export async function act(page: Page, code: string, action: string, procedure: string): Promise<void> {
  await select(page, code);
  const saved = waitForTrpc(page, procedure);
  await page.getByTestId("editor-action-bar").getByTestId(`editor-action-${action}`).click();
  await saved;
}

/** Append a regular control picked now, clear of the drawn legs and of `exclude`; returns its code. */
export async function appendClear(page: Page, exclude: string[] = []): Promise<string> {
  const [code] = await regularCodes(page, 1, exclude);
  expect(code, "a regular control clear of the drawn legs").toBeTruthy();
  await act(page, code, "append", "course.setStructure");
  await dropSelection(page);
  return code;
}

/** Drop the selection's action bar (Escape only when there is one: with nothing selected, Escape drops the course). */
export async function dropSelection(page: Page): Promise<void> {
  if ((await page.getByTestId("editor-action-bar").count()) > 0) await page.keyboard.press("Escape");
  await expect(page.getByTestId("editor-action-bar")).toHaveCount(0);
}

/**
 * A page point near `from` for a drag target, above it if that is clear: the selection's action bar lays out
 * under the selected control (above it only near the viewer's bottom, §2), so a drag that ends above it rarely
 * ends on the bar, and a point the bar covers is skipped (D10 flake: "the action bar covered the map").
 */
/**
 * Drags control `code`'s number off its automatic place and waits for the write; returns where the label
 * was before. Read once the view has stopped (the editor fits after a course is picked), and dragged
 * towards the viewer's middle so the drop never lands off the map or under the toolbar.
 */
export async function dragNumber(page: Page, code: string): Promise<Pt> {
  await viewSettled(page);
  await expect.poll(async () => (await labelOf(page, code)) !== null, { timeout: 15000 }).toBe(true);
  const label = (await labelOf(page, code))!;
  const from = await toPage(page, label);
  const box = (await page.getByTestId("map-viewer").boundingBox())!;
  const to = { x: from.x + (from.x < box.x + box.width / 2 ? 48 : -48), y: from.y + (from.y < box.y + box.height / 2 ? 24 : -24) };
  const saved = waitForTrpc(page, "course.setControlLabelOffset");
  await drag(page, from, to);
  await saved;
  return label;
}

export async function dragTarget(page: Page, from: Pt, avoid: Pt[] = [], clearPx = 45): Promise<Pt> {
  const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
  const marks = [...(await Promise.all((await sites(page)).map((s) => toPage(page, s.mm)))), ...avoid];
  // Above first (the action bar lays out below), then sideways; then any empty point (D10: a crowded view).
  const offsets = [-80, -110, -140].flatMap((dy) => [0, 60, -60].map((dx) => [dx, dy])).concat([[90, 0], [-90, 0], [120, -40], [-120, -40]]);
  for (const [dx, dy] of offsets) {
    const p = { x: from.x + dx, y: from.y + dy };
    if (p.y < viewer.y + 40 || p.y > viewer.y + viewer.height - 40 || p.x < viewer.x + 40 || p.x > viewer.x + viewer.width - 90) continue;
    if (marks.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < clearPx && Math.hypot(q.x - from.x, q.y - from.y) > 1)) continue;
    if (await coveredBy(page, p)) continue;
    return p;
  }
  return emptyPoint(page, 40, [from, ...avoid]);
}
