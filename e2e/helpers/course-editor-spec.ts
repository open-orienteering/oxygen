// Helpers shared by the course editor's spec files (e2e/course-editor*.spec.ts): the editor's spec was one file
// until it was split along its describes for the CI shards (docs/dev/e2e-sharding.md "CI").
import { expect, test, type Page } from "@playwright/test";
import { clickMap, controlRows, coveredBy, drag, emptyPoint, labelOf, legBetween, legMidpoint, legPieces, newCourse, openEditor, regularCodes, select, site, sites, toPage, viewSettled, type Site } from "./editor";
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

// ─── Two-control courses and their leg a → b (F3 and F7: the leg under test, not one drawn over it) ─────────

/**
 * A new course of two regular controls clear of each other's legs; the leg a → b is the one under test. A b whose
 * leg a → b has no point clear of the course's other legs is undone and another picked: with the start, a, b and
 * the finish in one row of the fixture's controls, the leg b → finish runs back over a → b and a click on a → b
 * selects the leg drawn on top (F21 flake: "Leg 72 → Mål 1" took the bend, the metres under test never moved).
 * `minChordPx`: a b whose leg is shorter on screen is undone too (F16: a smooth bend's grips are a sixth of the
 * chord from it, and an 88 px leg put them 14.6 px from the bend's handle, docs/bugfixes/course-editor-legs-flakes.md).
 */
export async function twoControlCourse(page: Page, prefix: string, opts: { minChordPx?: number } = {}): Promise<{ name: string; a: Site; b: Site }> {
  await openEditor(page);
  const name = await newCourse(page, prefix);
  const a = await appendClear(page);
  const tried = [a];
  for (let attempt = 0; attempt < 6; attempt++) {
    const b = await appendClear(page, tried);
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    const sa = await site(page, a), sb = await site(page, b);
    await legMidpoint(page, name, sa.mm, sb.mm); // the leg a → b drawn (the mirror lags the write)
    // Every leg of the course drawn: from the start, a → b and to the finish.
    await expect.poll(async () => new Set((await legPieces(page, name)).map((l) => l.leg)).size, { timeout: 15000 }).toBeGreaterThanOrEqual(3);
    const pa = await toPage(page, sa.mm), pb = await toPage(page, sb.mm);
    const longEnough = Math.hypot(pb.x - pa.x, pb.y - pa.y) >= (opts.minChordPx ?? 0);
    if (longEnough && (await legClickPoint(page, name, sa, sb)).legClear > 2) return { name, a: sa, b: sb };
    tried.push(b);
    const undone = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-undo").click();
    await undone;
    await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
  }
  throw new Error(`no control b whose leg from ${a} is clear of the course's other legs${opts.minChordPx ? ` and ${opts.minChordPx} px long` : ""} (tried ${tried.slice(1).join(", ")})`);
}

/**
 * The point along the leg a → b farthest from every site. A leg without a line (`none`, or inside a corridor,
 * F14) hits after the UI layer's off-course controls (§5), so a click at the plain midpoint can select a faded
 * control lying on the leg instead (F14 run: control 79 on the leg's middle).
 */
export async function legClickPoint(page: Page, name: string, a: Site, b: Site): Promise<{ at: Pt; legClear: number }> {
  const mid = await legMidpoint(page, name, a.mm, b.mm);
  const marks = (await sites(page)).map((x) => x.mm);
  const pieces = await legBetween(page, name, a.mm, b.mm);
  const mine = new Set(pieces.map((l) => l.leg));
  // The course's other legs: a click as near one of them as a → b may select it (the leg drawn on top wins).
  const others = (await legPieces(page, name)).filter((l) => !mine.has(l.leg)).map((l) => l.points);
  const seg = (p: Pt, u: Pt, v: Pt) => {
    const dx = v.x - u.x, dy = v.y - u.y, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / l2));
    return Math.hypot(p.x - (u.x + t * dx), p.y - (u.y + t * dy));
  };
  const legClearance = (q: Pt) => Math.min(Infinity, ...others.flatMap((poly) => poly.slice(1).map((v, i) => seg(q, poly[i], v))));
  // Sites in paper mm; another leg within 2 mm counts as a site at 0 (never pick a point it shares).
  const clearance = (q: Pt) => Math.min(...marks.map((m) => Math.hypot(q.x - m.x, q.y - m.y)), legClearance(q) > 2 ? Infinity : 0);
  // The middle half of the leg only: Add bend here puts the bend where the leg was clicked, and a smooth bend's
  // handles are a sixth of the chord (F16), so a bend nearer an end than that has a handle reaching past the control
  // and the leg's outline is no longer the straight three points (in-order run: a bend at 12 % of 86 → 61).
  const ab2 = (b.mm.x - a.mm.x) ** 2 + (b.mm.y - a.mm.y) ** 2;
  const along = (c: Pt) => ((c.x - a.mm.x) * (b.mm.x - a.mm.x) + (c.y - a.mm.y) * (b.mm.y - a.mm.y)) / ab2;
  let best = mid, bestD = clearance(mid);
  for (const piece of pieces) {
    piece.points.slice(1).forEach((q, i) => {
      const p0 = piece.points[i];
      for (let t = 0.05; t < 1; t += 0.05) {
        const c = { x: p0.x + (q.x - p0.x) * t, y: p0.y + (q.y - p0.y) * t };
        if (along(c) < 0.25 || along(c) > 0.75) continue;
        const d = clearance(c);
        if (d > bestD) { best = c; bestD = d; }
      }
    });
  }
  return { at: best, legClear: legClearance(best) };
}

/** Click the leg a → b where it is clearest of other sites until the Leg section shows (the hit index lags the mirror by a round trip). */
export async function selectLeg(page: Page, name: string, a: Site, b: Site): Promise<Pt> {
  await viewSettled(page);
  const mid = (await legClickPoint(page, name, a, b)).at;
  await expect(async () => {
    await dropSelection(page);
    await clickMap(page, await toPage(page, mid));
    await expect(page.getByTestId("editor-leg")).toBeVisible({ timeout: 3000 });
    // The leg under test, not another one drawn over it.
    await expect(page.getByTestId("editor-leg")).toContainText(`${a.code} → ${b.code}`, { timeout: 1000 });
  }).toPass({ timeout: 30000 });
  return mid;
}
