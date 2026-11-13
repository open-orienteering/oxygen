// Legs (docs/course-editor.md §6.7, course-layer.md §10.1): the Leg section, styles, bends and corridors (F3), Bézier
// bends (F13), and bend drags on a tablet (F23).
// Split from the editor's one spec file along its describes (docs/e2e-sharding.md "CI"); the
// helpers they share are `helpers/course-editor-spec.ts`. It runs under the `chromium` project (desktop) only.
//
// Hygiene (AGENTS §12): `reseed()` once in `beforeAll`, the fixture import idempotent per test
// (`openEditor` → `ensureCoursesAndMap`), courses a test creates carry a prefix and go with the
// next reseed, controls / objects / sheets it creates are deleted in `finally` (`cleanup`).

import { expect, test, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { canvasInCircle, cleanup, clickMap, controlRows, coveredBy, drag, dragHold, editorReady, emptyPoint, geometryOf, inkAt, labelOf, legBetween, legMidpoint, legPieces, nameIdOf, objectRow, plainMapAt, openEditor, pressOnEdge, printed, probeTemplate, regularCodes, select, site, sites, toolShapes, toPage, toPaper, trpcCall, viewSettled, newCourse, mapScale, nextFrames, loupeCircleAt, paperToPageOf, dragEndOnMap, turned, inkedAt, hideOthersPresence, type Site } from "./helpers/editor";
import { touchEnd, touchMove, touchStart, touchTap } from "./helpers/touch";
import { trpcProcedures, waitForTrpc } from "./helpers/trpc";
import { type Pt, desktopOnly, appendClear, dropSelection, dragTarget } from "./helpers/course-editor-spec";

test.beforeAll(async () => {
  await reseed();
});

// No presence chips: the rows earlier tests' pages leave for 30 s wrap the top bar to a second row mid-test and move
// the map viewer 36 px under computed page points (docs/bugfix-course-editor-legs-flakes.md).
test.beforeEach(async ({ page }) => {
  await hideOthersPresence(page);
});

test.setTimeout(120_000);

// F3 (docs/course-editor.md §6.7): the Leg section, bend handles, Add bend here, Corridor on selected leg. Its own
// describe, so the parallel rows' edits above merge cleanly.
test.describe("F3: legs — styles, bends, corridors (docs/course-editor.md §6.7)", () => {
  desktopOnly();

  /**
   * A new course of two regular controls clear of each other's legs; the leg a → b is the one under test. A b whose
   * leg a → b has no point clear of the course's other legs is undone and another picked: with the start, a, b and
   * the finish in one row of the fixture's controls, the leg b → finish runs back over a → b and a click on a → b
   * selects the leg drawn on top (F21 flake: "Leg 72 → Mål 1" took the bend, the metres under test never moved).
   */
  async function twoControlCourse(page: Page, prefix: string): Promise<{ name: string; a: Site; b: Site }> {
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
      if ((await legClickPoint(page, name, sa, sb)).legClear > 2) return { name, a: sa, b: sb };
      tried.push(b);
      const undone = waitForTrpc(page, "course.setStructure");
      await page.getByTestId("editor-undo").click();
      await undone;
      await expect(controlRows(page)).toHaveCount(1, { timeout: 15000 });
    }
    throw new Error(`no control b whose leg from ${a} is clear of the course's other legs (tried ${tried.slice(1).join(", ")})`);
  }

  /**
   * The point along the leg a → b farthest from every site. A leg without a line (`none`, or inside a corridor,
   * F14) hits after the UI layer's off-course controls (§5), so a click at the plain midpoint can select a faded
   * control lying on the leg instead (F14 run: control 79 on the leg's middle).
   */
  async function legClickPoint(page: Page, name: string, a: Site, b: Site): Promise<{ at: Pt; legClear: number }> {
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
  async function selectLeg(page: Page, name: string, a: Site, b: Site): Promise<Pt> {
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

  const styleOf = async (page: Page, name: string, a: Site, b: Site) => (await legBetween(page, name, a.mm, b.mm))[0]?.style ?? null;

  test("a leg made a marked route: the layer's piece changes symbol; none keeps it selectable; undo", async ({ page }) => {
    const { name, a, b } = await twoControlCourse(page, "F3 style");
    const mid = await selectLeg(page, name, a, b);
    await expect(page.getByTestId("editor-leg-style")).toHaveValue("line");
    await expect.poll(() => styleOf(page, name, a, b), { timeout: 15000 }).toBe("line");

    const saved = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-leg-style").selectOption("marked_route");
    await saved;
    await expect.poll(() => styleOf(page, name, a, b), { timeout: 15000 }).toBe("marked_route");
    await expect(page.getByTestId("editor-leg-style")).toHaveValue("marked_route");

    // No line: the layer has no object for it, yet a click on it selects it (the derivation's pieces, §5).
    const none = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-leg-style").selectOption("none");
    await none;
    await expect.poll(() => styleOf(page, name, a, b), { timeout: 15000 }).toBe("none");
    await expect(async () => {
      await dropSelection(page);
      await clickMap(page, await toPage(page, mid));
      await expect(page.getByTestId("editor-leg-style")).toHaveValue("none", { timeout: 3000 });
    }).toPass({ timeout: 30000 });

    // Each change is one undo entry.
    await page.keyboard.press("Control+z");
    await expect.poll(() => styleOf(page, name, a, b), { timeout: 15000 }).toBe("marked_route");
    await page.keyboard.press("Control+z");
    await expect.poll(() => styleOf(page, name, a, b), { timeout: 15000 }).toBe("line");
  });

  test("Add bend here, a dragged bend handle: the leg passes through it and its metres grow; Delete removes it", async ({ page }) => {
    const { name, a, b } = await twoControlCourse(page, "F3 bend");
    const legRow = () => controlRows(page).nth(1).getByTestId("editor-leg-meters");
    const metres = async () => Number(((await legRow().textContent()) ?? "").replace(/[^\d]/g, ""));
    const before = await metres();
    expect(before).toBeGreaterThan(0);
    await selectLeg(page, name, a, b);

    const added = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-add-bend").click();
    await added;
    await expect.poll(async () => (await toolShapes(page, "editor-bend-handle")).length, { timeout: 15000 }).toBe(1);
    await expect(page.getByTestId("editor-leg-bend")).toHaveCount(1);

    // Drag it off the leg, perpendicular and upwards on screen (the action bar lays out below the phantom) — or the
    // nearest direction off the leg whose drag stays on the map (a leg along the viewer's top or the inspector's edge).
    const handle = (await toolShapes(page, "editor-bend-handle"))[0];
    const from = await toPage(page, handle);
    const pa = await toPage(page, a.mm), pb = await toPage(page, b.mm);
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    let n = { x: -(pb.y - pa.y) / len, y: (pb.x - pa.x) / len };
    if (n.y > 0) n = { x: -n.x, y: -n.y };
    const off = (v: Pt) => [v, turned(v, 30), turned(v, -30)];
    const moved = waitForTrpc(page, "course.setStructure");
    await drag(page, from, await dragEndOnMap(page, from, [...off(n), ...off({ x: -n.x, y: -n.y })], 60));
    await moved;

    // The handle and the bends list follow the write; the drawn leg has a vertex at the bend.
    await expect.poll(async () => {
      const h = (await toolShapes(page, "editor-bend-handle"))[0];
      return h ? Math.hypot(h.x - handle.x, h.y - handle.y) : 0;
    }, { timeout: 15000 }).toBeGreaterThan(1);
    const bend = (await toolShapes(page, "editor-bend-handle"))[0];
    await expect.poll(async () => {
      const pieces = await legBetween(page, name, a.mm, b.mm);
      return pieces.some((p) => p.points.some((q) => Math.hypot(q.x - bend.x, q.y - bend.y) < 0.3));
    }, { timeout: 15000 }).toBe(true);
    await expect.poll(metres, { timeout: 15000 }).toBeGreaterThan(before);

    // The handle is focused by the drag; Delete takes the bend out (one write), the leg is straight again.
    await expect(page.getByTestId("editor-leg-bend").first()).toHaveAttribute("data-focused", "true");
    const removed = waitForTrpc(page, "course.setStructure");
    await page.keyboard.press("Delete");
    await removed;
    await expect.poll(async () => (await toolShapes(page, "editor-bend-handle")).length, { timeout: 15000 }).toBe(0);
    await expect(page.getByTestId("editor-leg-bends-empty")).toBeVisible();
    await expect.poll(metres, { timeout: 15000 }).toBe(before);
    // Both controls are still on the course (Delete took the bend, not a control).
    await expect(controlRows(page)).toHaveCount(2);
  });

  // F16 (§6.7, §7; user answer Q2): bends follow F18's convention — smooth by default, Alt for sharp.
  /** The stored bends of the course's one leg with props (a → b), from `course.list`. */
  async function storedBends(courseId: string): Promise<{ x: number; y: number; hIn?: Pt; hOut?: Pt }[]> {
    const summary = (await trpcCall<{ id: number; legs?: Record<string, { bends?: { x: number; y: number; hIn?: Pt; hOut?: Pt }[] }> }[]>("course.list", undefined, false))
      .find((c) => c.id === Number(courseId))!;
    return Object.values(summary.legs ?? {})[0]?.bends ?? [];
  }
  const outlinePoints = async (page: Page) => (await toolShapes(page, "editor-leg-outline"))[0]?.data.points?.split(" ").length ?? 0;

  test("F16: Add bend here is smooth (two grips, the leg unchanged); a grip curves it mirrored, Alt breaks the pair; Alt-click a corner; Smooth; undo; one page", async ({ page }) => {
    const { name, a, b } = await twoControlCourse(page, "F16 smooth");
    const courseId = await page.getByTestId("editor-course-picker").inputValue();
    const nameId = nameIdOf(page);
    const legRow = () => controlRows(page).nth(1).getByTestId("editor-leg-meters");
    const metres = async () => Number(((await legRow().textContent()) ?? "").replace(/[^\d]/g, ""));
    const before = await metres();
    await selectLeg(page, name, a, b);

    // Add bend here: one write; the bend is smooth, its handles from its neighbours (the sites): hOut = (b − a) / 6.
    const added = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-add-bend").click();
    await added;
    await expect.poll(async () => (await storedBends(courseId)).length, { timeout: 15000 }).toBe(1);
    const [bend] = await storedBends(courseId);
    const h = { x: (b.mm.x - a.mm.x) / 6, y: (b.mm.y - a.mm.y) / 6 };
    expect(bend.hOut!.x).toBeCloseTo(h.x, 1);
    expect(bend.hOut!.y).toBeCloseTo(h.y, 1);
    expect(bend.hIn).toEqual({ x: -bend.hOut!.x, y: -bend.hOut!.y });
    await expect(page.getByTestId("editor-leg-bend")).toHaveAttribute("data-curve", "smooth");
    await expect.poll(async () => (await toolShapes(page, "editor-bend-grip")).map((g) => g.data.which).sort(), { timeout: 15000 }).toEqual(["in", "out"]);
    // Collinear handles: the leg's shape and metres are as before (the outline straight: from, bend, to).
    expect(await outlinePoints(page)).toBe(3);
    expect(await metres()).toBe(before);

    // Drag the grip that lies higher on screen (the action bar lays out below the phantom) perpendicular to the leg,
    // upwards: one write, the pair mirrored, the outline a curve, the metres grow.
    const grips = await toolShapes(page, "editor-bend-grip");
    const onScreen = await Promise.all(grips.map((g) => toPage(page, g)));
    const k = onScreen[0].y <= onScreen[1].y ? 0 : 1;
    const which = grips[k].data.which as "in" | "out";
    const other = which === "out" ? "hIn" : "hOut";
    const mine = which === "out" ? "hOut" : "hIn";
    const gripAt = async () => toPage(page, (await toolShapes(page, "editor-bend-grip")).find((g) => g.data.which === which)!);
    const pa = await toPage(page, a.mm), pb = await toPage(page, b.mm);
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    let n = { x: -(pb.y - pa.y) / len, y: (pb.x - pa.x) / len };
    if (n.y > 0) n = { x: -n.x, y: -n.y };
    const start = await gripAt();
    const handleAt = await toPage(page, (await toolShapes(page, "editor-bend-handle"))[0]);
    expect(Math.hypot(start.x - handleAt.x, start.y - handleAt.y), "the grip clear of the bend's handle").toBeGreaterThan(16);
    // Perpendicular, upwards first; else the nearest direction off the leg whose drag stays on the map (a drag that
    // leaves the viewer — under the inspector, above its top — is the viewer's mouseleave: a cancel, no write).
    const off = (v: Pt) => [v, turned(v, 30), turned(v, -30)];
    const across = [...off(n), ...off({ x: -n.x, y: -n.y })];
    // Its end is where the Alt drag below presses: never on the action bar, which stops a press (past it if need be).
    const pulled = waitForTrpc(page, "course.setStructure");
    await drag(page, start, await dragEndOnMap(page, start, across, [60, 90, 120], { endOnBar: false }));
    await pulled;
    await expect.poll(async () => JSON.stringify((await storedBends(courseId))[0]?.[mine]), { timeout: 15000 }).not.toBe(JSON.stringify(bend[mine]));
    const curved = (await storedBends(courseId))[0];
    expect(curved[other]).toEqual({ x: -curved[mine]!.x, y: -curved[mine]!.y });
    await expect.poll(() => outlinePoints(page), { timeout: 15000 }).toBeGreaterThan(3);
    await expect.poll(metres, { timeout: 15000 }).toBeGreaterThan(before);

    // Alt held on the same grip: only that handle moves, the pair broken.
    const again = await gripAt();
    expect(await coveredBy(page, again), "the pulled grip on the map, clear of the action bar").toBeNull();
    const broken = waitForTrpc(page, "course.setStructure");
    const againTo = await dragEndOnMap(page, again, across, 30);
    await page.keyboard.down("Alt");
    await drag(page, again, againTo);
    await page.keyboard.up("Alt");
    await broken;
    await expect.poll(async () => JSON.stringify((await storedBends(courseId))[0]?.[mine]), { timeout: 15000 }).not.toBe(JSON.stringify(curved[mine]));
    const pair = (await storedBends(courseId))[0];
    expect(pair[other]).toEqual(curved[other]);

    // Alt-click the bend: a corner (no handles stored, no grips); the row says so and offers Smooth.
    const bendAt = await toPage(page, (await toolShapes(page, "editor-bend-handle"))[0]);
    const cornered = waitForTrpc(page, "course.setStructure");
    await page.keyboard.down("Alt");
    await page.mouse.click(bendAt.x, bendAt.y);
    await page.keyboard.up("Alt");
    await cornered;
    await expect.poll(async () => (await storedBends(courseId))[0]?.hOut ?? null, { timeout: 15000 }).toBeNull();
    expect((await storedBends(courseId))[0].hIn).toBeUndefined();
    await expect(page.getByTestId("editor-leg-bend")).toHaveAttribute("data-curve", "corner");
    await expect.poll(async () => (await toolShapes(page, "editor-bend-grip")).length, { timeout: 15000 }).toBe(0);
    await expect(page.getByTestId("editor-leg-bend")).toHaveAttribute("data-focused", "true");
    await expect(page.getByTestId("editor-leg-bend-corner")).toBeDisabled();

    // Smooth (the tablet's Alt-click): handles from its neighbours again, two grips.
    const smoothed = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-leg-bend-smooth").click();
    await smoothed;
    await expect(page.getByTestId("editor-leg-bend")).toHaveAttribute("data-curve", "smooth");
    await expect.poll(async () => (await toolShapes(page, "editor-bend-grip")).length, { timeout: 15000 }).toBe(2);

    // Each gesture is one undo entry: back to the corner, then to the broken pair.
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await storedBends(courseId))[0]?.hOut ?? null, { timeout: 15000 }).toBeNull();
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await storedBends(courseId))[0]?.[mine] ?? null, { timeout: 15000 }).toEqual(pair[mine]);

    // The course's map prints as one page with the curved leg.
    const template = await probeTemplate("F16 curve");
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId: Number(courseId), templateId: template.seq, overrides: {}, objects: [] });
    try {
      expect((await printed(page, nameId, `maps=${sheet.seq}`)).pages).toBe(1);
    } finally {
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
    }
  });

  test("F16: Alt held on Add bend here inserts a corner: no handles, no grips, Smooth offered", async ({ page }) => {
    const { name, a, b } = await twoControlCourse(page, "F16 corner");
    const courseId = await page.getByTestId("editor-course-picker").inputValue();
    await selectLeg(page, name, a, b);
    const added = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-add-bend").click({ modifiers: ["Alt"] });
    await added;
    await expect.poll(async () => (await storedBends(courseId)).length, { timeout: 15000 }).toBe(1);
    const [bend] = await storedBends(courseId);
    expect(bend.hIn).toBeUndefined();
    expect(bend.hOut).toBeUndefined();
    await expect(page.getByTestId("editor-leg-bend")).toHaveAttribute("data-curve", "corner");
    await expect.poll(async () => (await toolShapes(page, "editor-bend-handle")).length, { timeout: 15000 }).toBe(1);
    expect(await toolShapes(page, "editor-bend-grip")).toHaveLength(0);
    await expect(page.getByTestId("editor-leg-bend-corner")).toBeDisabled();
    await expect(page.getByTestId("editor-leg-bend-smooth")).toBeEnabled();
  });

  test("Corridor on selected leg: the map is white in the band beside the edge, no centre line, a guide; the print stays one page; Remove", async ({ page }) => {
    const { name, a, b } = await twoControlCourse(page, "F3 corridor");
    const nameId = nameIdOf(page);
    const scale = await mapScale(page);
    // F19: the drawn circle's centre-line radius, from the gap tool's target (G on a selected control).
    await select(page, b.code);
    await page.keyboard.press("g");
    const R = Number((await toolShapes(page, "editor-gap-target"))[0].data.r);
    expect(R).toBeGreaterThan(1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // The default corridor (decision log, F3): 50 m wide, a 5 mm white band beyond the edge.
    const halfMm = (50 * 1000) / scale / 2;
    const ax = a.mm, bx = b.mm, len = Math.hypot(bx.x - ax.x, bx.y - ax.y);
    const u = { x: (bx.x - ax.x) / len, y: (bx.y - ax.y) / len }, n = { x: -u.y, y: u.x };
    /** Points in the band, both sides, along the leg's middle (clear of the circles and the edge line's width). */
    const marks = (await sites(page)).map((x) => x.mm);
    const band: Pt[] = [];
    for (let t = 0.3; t <= 0.7; t += 0.02) {
      for (let d = halfMm + 0.8; d <= halfMm + 4.2; d += 0.2) {
        for (const side of [1, -1]) band.push({ x: ax.x + u.x * len * t + n.x * d * side, y: ax.y + u.y * len * t + n.y * d * side });
      }
    }
    // The course is never cut (§10.2): keep the probe off every control's circle and number.
    const clear = band.filter((q) => marks.every((m) => Math.hypot(q.x - m.x, q.y - m.y) > 6));
    band.length = 0;
    band.push(...clear);
    // F14 (course-layer.md §10.2): the leg's own line along its middle, and the edge `halfMm` beside it.
    const along = (offsets: readonly number[]) => {
      const out: Pt[] = [];
      for (let t = 0.3; t <= 0.7; t += 0.02) {
        for (const d of offsets) out.push({ x: ax.x + u.x * len * t + n.x * d, y: ax.y + u.y * len * t + n.y * d });
      }
      return out.filter((q) => marks.every((m) => Math.hypot(q.x - m.x, q.y - m.y) > 6));
    };
    const centre = along([-0.1, 0, 0.1]);
    const edge = along([halfMm - 0.1, halfMm, halfMm + 0.1, -halfMm - 0.1, -halfMm, -halfMm + 0.1]);
    // F19 (course-layer.md §10.2): the circles at the leg's ends open where a corridor narrower than them meets
    // them. The default 50 m may be as wide as the circle on the fixture map (h ≥ R: the circle inside, answer 1),
    // so the openings are probed at a width of about 1.2 R (h ≈ 0.6 R).
    const narrowM = Math.max(1, Math.round((1.2 * R * scale) / 1000));
    const narrowHalf = (narrowM * 1000) / scale / 2;
    expect(narrowHalf).toBeLessThan(R);
    const delta = Math.asin(narrowHalf / R);
    const rim = (c: Pt, toward: Pt, from: number, to: number) => {
      const t0 = Math.atan2(toward.y - c.y, toward.x - c.x);
      const out: Pt[] = [];
      for (let a = from; a <= to + 1e-9; a += (to - from) / 24 || 1) {
        for (const r of [R - 0.05, R, R + 0.05]) out.push({ x: c.x + r * Math.cos(t0 + a), y: c.y + r * Math.sin(t0 + a) });
      }
      return out;
    };
    const deg = Math.PI / 180;
    // The opening's middle half (its ends lie under the edge's round caps, a pixel or two of anti-aliasing), the far
    // side, and the junctions.
    const mouth = [...rim(ax, bx, -delta / 2, delta / 2), ...rim(bx, ax, -delta / 2, delta / 2)];
    const far = [...rim(ax, bx, Math.PI - 30 * deg, Math.PI + 30 * deg), ...rim(bx, ax, Math.PI - 30 * deg, Math.PI + 30 * deg)];
    const junctions = (c: Pt, toward: Pt) => {
      const t0 = Math.atan2(toward.y - c.y, toward.x - c.x);
      return [1, -1].map((side) => {
        const j = { x: c.x + R * Math.cos(t0 + side * delta), y: c.y + R * Math.sin(t0 + side * delta) };
        const out: Pt[] = [];
        for (let dx = -0.3; dx <= 0.3; dx += 0.1) for (let dy = -0.3; dy <= 0.3; dy += 0.1) out.push({ x: j.x + dx, y: j.y + dy });
        return out;
      });
    };
    const junctionProbes = [...junctions(ax, bx), ...junctions(bx, ax)];
    // F22 (course-layer.md §10.2 "Ends"): each control is the corridor's only end there, so the band stops on the line
    // through its centre; behind it — within the pre-F22 wrap (R + whiteMm), beyond the inside's round end — the map
    // shows. Kept off the other controls' circles and numbers.
    const behind: Pt[] = [];
    for (const [c, toward] of [[ax, bx], [bx, ax]] as const) {
      const t0 = Math.atan2(c.y - toward.y, c.x - toward.x);
      for (let d = R + 0.5; d <= R + 4 + 1e-9; d += 0.25) {
        for (const k of [-1, 0, 1]) behind.push({ x: c.x + d * Math.cos(t0) - k * Math.sin(t0), y: c.y + d * Math.sin(t0) + k * Math.cos(t0) });
      }
    }
    const own = (m: Pt) => [ax, bx].some((c) => Math.hypot(m.x - c.x, m.y - c.y) < 0.01);
    const behindClear = behind.filter((q) => marks.every((m) => own(m) || Math.hypot(q.x - m.x, q.y - m.y) > 6));
    expect(behindClear.length).toBeGreaterThan(20);
    const guides = async () => (await toolShapes(page, "editor-corridor-guide")).length;
    const courses = await trpcCall<{ id: number; name: string }[]>("course.list", undefined, false);
    const courseId = courses.find((c) => c.name === name)!.id;
    const template = await probeTemplate("F3 corridor");
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId, templateId: template.seq, overrides: {}, objects: [] });
    try {
      await selectLeg(page, name, a, b);
      await viewSettled(page);
      const mapBefore = await inkAt(page, band, "map");
      expect(mapBefore, "the fixture map has colour beside the leg").toBeGreaterThan(0);
      expect(await inkAt(page, behindClear, "map"), "the fixture map has colour behind the controls").toBeGreaterThan(0);
      expect(await inkAt(page, centre, "purple"), "the leg's line before the corridor").toBeGreaterThan(0);
      expect(await guides()).toBe(0);
      // F19: before the corridor both circles are whole where the corridor will meet them (and R is right).
      for (const c of [ax, bx]) expect(await inkAt(page, rim(c, c === ax ? bx : ax, -delta / 2, delta / 2), "purple"), "a whole circle").toBeGreaterThan(0);

      // The A menu's entry (key C while it is open); disabled once the leg has a corridor.
      await page.keyboard.press("a");
      await expect(page.getByTestId("editor-area-corridor")).toBeEnabled();
      const saved = waitForTrpc(page, "course.setStructure");
      await page.keyboard.press("c");
      await saved;
      await expect(page.getByTestId("editor-leg-corridor-width")).toHaveValue("50");
      await expect(page.getByTestId("editor-leg-corridor-white")).toHaveValue("5");
      await expect(page.getByTestId("editor-leg-corridor-edge")).toBeChecked();
      await expect.poll(() => inkAt(page, band, "map"), { timeout: 30000 }).toBe(0);
      // F22: the band stops at each circle's centre line; the map shows behind it (the band along the middle above).
      expect(await inkAt(page, behindClear, "map"), "the map behind the corridor's ends").toBeGreaterThan(0);
      await page.keyboard.press("a");
      await expect(page.getByTestId("editor-area-corridor")).toBeDisabled();
      // A again closes the menu (Escape would step the selection back too, §3).
      await page.keyboard.press("a");
      await expect(page.getByTestId("editor-area-menu")).toHaveCount(0);

      // F14: inside the corridor the leg's line is gone, the edge is drawn; the Style note says so.
      await expect.poll(() => inkAt(page, centre, "purple"), { timeout: 30000 }).toBe(0);
      expect(await inkAt(page, edge, "purple"), "the corridor's edge").toBeGreaterThan(0);
      await expect(page.getByTestId("editor-leg-style-corridor-note")).toBeVisible();
      // F19: narrowed below the circles' width, each circle opens towards the leg, drawn on its far side; the edge
      // meets it at both junctions.
      const narrowed = waitForTrpc(page, "course.setStructure");
      await page.getByTestId("editor-leg-corridor-width").fill(String(narrowM));
      await page.getByTestId("editor-leg-corridor-width").press("Enter");
      await narrowed;
      await expect.poll(() => inkAt(page, mouth, "purple"), { timeout: 30000 }).toBe(0);
      expect(await inkAt(page, far, "purple"), "the circles' far sides").toBeGreaterThan(0);
      for (const [i, j] of junctionProbes.entries()) expect(await inkAt(page, j, "purple"), `junction ${i}`).toBeGreaterThan(0);
      // An opened control is still selected by a click at its centre (the UI circle, course-editor.md §5).
      await dropSelection(page);
      await select(page, b.code);
      await selectLeg(page, name, a, b);
      // The selected leg's outline stands in for its guide; deselected, the guide marks the leg, and a click on it selects it.
      expect(await guides()).toBe(0);
      await dropSelection(page);
      await expect.poll(guides, { timeout: 15000 }).toBe(1);
      expect((await toolShapes(page, "editor-corridor-guide"))[0].data).toMatchObject({ course: name });
      const mid = (await legClickPoint(page, name, a, b)).at;
      await expect(async () => {
        await dropSelection(page);
        await clickMap(page, await toPage(page, mid));
        await expect(page.getByTestId("editor-leg-corridor-remove")).toBeVisible({ timeout: 3000 });
      }).toPass({ timeout: 30000 });
      expect(await guides()).toBe(0);
      // Never outside the views where legs are clickable: All controls draws none; back in Course view it is there.
      await dropSelection(page);
      await expect.poll(guides, { timeout: 15000 }).toBe(1);
      await page.getByTestId("editor-view-all").click();
      await expect.poll(guides, { timeout: 15000 }).toBe(0);
      await page.getByTestId("editor-view-course").click();
      await expect.poll(guides, { timeout: 15000 }).toBe(1);
      await selectLeg(page, name, a, b);

      expect((await printed(page, nameId, `maps=${sheet.seq}`)).pages).toBe(1);

      // F25: no White opacity field until the band can draw translucency (F26).
      await expect(page.getByTestId("editor-leg-corridor-opacity")).toHaveCount(0);
      // Values outside their ranges are not written: the fields show the stored ones again.
      for (const [field, bad, stored] of [["width", "0", String(narrowM)], ["white", "-1", "5"]] as const) {
        await page.getByTestId(`editor-leg-corridor-${field}`).fill(bad);
        await page.getByTestId(`editor-leg-corridor-${field}`).press("Tab");
        await expect(page.getByTestId(`editor-leg-corridor-${field}`)).toHaveValue(stored);
      }
      // A valid width is written (one more undo entry).
      const widened = waitForTrpc(page, "course.setStructure");
      await page.getByTestId("editor-leg-corridor-width").fill("80");
      await page.getByTestId("editor-leg-corridor-width").press("Enter");
      await widened;
      await expect(page.getByTestId("editor-leg-corridor-width")).toHaveValue("80");
      // F25: the hidden White opacity rides along on the write (the stored corridor, spread).
      const courseId = Number(await page.getByTestId("editor-course-picker").inputValue());
      const storedCorridor = async () => Object.values((await trpcCall<{ id: number; legs?: Record<string, { corridor?: { widthM: number; whiteOpacity: number } }> }[]>("course.list", undefined, false))
        .find((c) => c.id === courseId)?.legs ?? {})[0]?.corridor;
      await expect.poll(async () => (await storedCorridor())?.widthM, { timeout: 15000 }).toBe(80);
      expect((await storedCorridor())?.whiteOpacity).toBe(1);

      const removed = waitForTrpc(page, "course.setStructure");
      await page.getByTestId("editor-leg-corridor-remove").click();
      await removed;
      await expect(page.getByTestId("editor-leg-corridor-add")).toBeVisible();
      await expect.poll(() => inkAt(page, band, "map"), { timeout: 30000 }).toBeGreaterThan(0);
      // F14: the line is back, the note and the guide gone; F19: the circles are whole again.
      await expect.poll(() => inkAt(page, centre, "purple"), { timeout: 30000 }).toBeGreaterThan(0);
      expect(await inkAt(page, mouth, "purple"), "the circles closed again").toBeGreaterThan(0);
      await expect(page.getByTestId("editor-leg-style-corridor-note")).toHaveCount(0);
      await dropSelection(page);
      await expect.poll(guides, { timeout: 15000 }).toBe(0);
      await selectLeg(page, name, a, b);
      // Undo brings the corridor back.
      await page.keyboard.press("Control+z");
      await expect(page.getByTestId("editor-leg-corridor-remove")).toBeVisible({ timeout: 15000 });
    } finally {
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
    }
  });

  test("F21: a held bend drag redraws the course live — the purple line, then the corridor's band follow the handle; one write on release; undo", async ({ page }) => {
    const { name, a, b } = await twoControlCourse(page, "F21 live");
    const courseId = await page.getByTestId("editor-course-picker").inputValue();
    const scale = await mapScale(page);
    // Every structure write this page sends: none may go out while the handle is held (§6.7 "Writes").
    const writes: string[] = [];
    page.on("request", (r) => { if (r.url().includes("course.setStructure")) writes.push(r.url()); });
    await selectLeg(page, name, a, b);
    const added = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-add-bend").click();
    await added;
    await expect.poll(async () => (await storedBends(courseId)).length, { timeout: 15000 }).toBe(1);
    await viewSettled(page);
    const p0 = (await toolShapes(page, "editor-bend-handle"))[0];
    // F25 (§6.7 "Readouts follow the bends"): leg b's metres in the inspector, the bend on the chord.
    const metres = async () => Number(((await controlRows(page).nth(1).getByTestId("editor-leg-meters").textContent()) ?? "").replace(/[^\d]/g, ""));
    const chordM = await metres();
    expect(chordM).toBeGreaterThan(0);
    // The default corridor (F3): 50 m wide, a 5 mm band.
    const halfMm = (50 * 1000) / scale / 2;
    const len = Math.hypot(b.mm.x - a.mm.x, b.mm.y - a.mm.y);
    const u = { x: (b.mm.x - a.mm.x) / len, y: (b.mm.y - a.mm.y) / len };
    // The perpendicular that points up the screen: the action bar lays out below the phantom.
    const up = (await toPage(page, { x: p0.x - u.y, y: p0.y + u.x })).y < (await toPage(page, p0)).y ? 1 : -1;
    const n = { x: -u.y * up, y: u.x * up };
    const box = (await page.getByTestId("map-viewer").boundingBox())!;
    const marks = (await sites(page)).map((x) => x.mm);
    const clearOfSites = (pts: Pt[]) => pts.filter((q) => marks.every((m) => Math.hypot(q.x - m.x, q.y - m.y) > 6));
    /** Points at `offsets` from `c` along n, `-reach..reach` along u. */
    const strip = (c: Pt, offsets: readonly number[], reach: number) => {
      const out: Pt[] = [];
      for (let t = -reach; t <= reach + 1e-9; t += 0.1) for (const d of offsets) out.push({ x: c.x + u.x * t + n.x * d, y: c.y + u.y * t + n.y * d });
      return out;
    };
    const bandOffsets: number[] = [];
    for (let d = halfMm + 0.8; d <= halfMm + 4.2; d += 0.2) bandOffsets.push(d);
    // The chord's band, both sides; the leg's line at the held apex; the band beyond the apex (its outer side, where
    // the apex is the nearest point of the leg).
    // Every band probe keeps only the points with map under them now, before any corridor: the fixture map has white
    // paper beyond its mapped area (and the GL canvas nothing outside the viewer), where "white once the band is
    // there" proves nothing (F21 flake: a leg near the map's top, its apex's band on the paper above the map).
    const chordBand = await inkedAt(page, clearOfSites(strip(p0, [...bandOffsets, ...bandOffsets.map((d) => -d)], 2)), "map");
    expect(chordBand.length, "the chord's band clear of the sites, on the map").toBeGreaterThanOrEqual(20);
    // The apex at least 2h + 12 mm off the chord (the moved corridor and band clear the chord's band on both sides), on
    // the perpendicular through the bend or slid a little along the chord (the handles stay along u, so the leg's
    // tangent at the apex is u either way): the first candidate whose drag stays on the map and whose probes are clear
    // of the sites (the course's controls are picked from what earlier tests left). Held there, the mouse loupe (F24)
    // covers part of the canvas 16 px above the cursor with the magnified map, so the held reads probe only what lies
    // clear of it: the line at the apex whole, at least 20 of each band's probes — up the screen first; down when the
    // loupe would cover the band beyond the apex (it lies above the cursor).
    // The apex's line is probed for purple that is not there before the drag and is after it, so it keeps clear of the
    // course's other purple: its other legs (start → a, b → finish) and its drawn numbers, and on the canvas of any
    // purple at all (F21 flake: a near-vertical a → b, the apex beside it on the leg start → a, 3 purple pixels).
    const legOf = new Set((await legBetween(page, name, a.mm, b.mm)).map((l) => l.leg));
    const otherLegs = (await legPieces(page, name)).filter((l) => !legOf.has(l.leg)).map((l) => l.points);
    const numbers = await page.getByTestId("course-label").evaluateAll((els) => els.map((el) => ({ x: Number(el.getAttribute("data-x")), y: Number(el.getAttribute("data-y")) })));
    const segDist = (p: Pt, v: Pt, w: Pt) => {
      const dx = w.x - v.x, dy = w.y - v.y, l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - v.x) * dx + (p.y - v.y) * dy) / l2));
      return Math.hypot(p.x - (v.x + t * dx), p.y - (v.y + t * dy));
    };
    const clearOfCourse = (pts: Pt[]) => pts.every((q) =>
      otherLegs.every((poly) => poly.slice(1).every((w, i) => segDist(q, poly[i], w) > 1.5))
      && numbers.every((m) => Math.hypot(q.x - m.x, q.y - m.y) > 5));
    let p1: Pt | null = null;
    let apexLine: Pt[] = [], apexBand: Pt[] = [], chordBandHeld: Pt[] = [];
    const pageOf = await paperToPageOf(page);
    const from0 = pageOf(p0);
    search: for (const side of [1, -1]) {
      const nn = { x: n.x * side, y: n.y * side };
      for (const slide of [0, 3, -3, 6, -6]) {
        for (let D = 2 * halfMm + 12; D <= 2 * halfMm + 60; D += 2) {
          const at = { x: p0.x + u.x * slide + nn.x * D, y: p0.y + u.y * slide + nn.y * D };
          const line = strip(at, [-0.1, 0, 0.1], 1);
          const bandAt: Pt[] = [];
          for (let t = -2; t <= 2 + 1e-9; t += 0.1) for (const d of bandOffsets) bandAt.push({ x: at.x + u.x * t + nn.x * d, y: at.y + u.y * t + nn.y * d });
          const atPage = pageOf(at);
          if (atPage.x < box.x + 20 || atPage.x > box.x + box.width - 20 || atPage.y < box.y + 20 || atPage.y > box.y + box.height - 20) continue;
          if (clearOfSites(line).length !== line.length || !clearOfCourse(line)) continue;
          const lc = await loupeCircleAt(page, atPage);
          const clearOfLoupe = (pts: Pt[]) => pts.filter((q) => { const pq = pageOf(q); return Math.hypot(pq.x - lc.x, pq.y - lc.y) > lc.r + 3; });
          const chordClear = clearOfLoupe(chordBand);
          if (clearOfLoupe(line).length !== line.length || chordClear.length < 20) continue;
          if (clearOfLoupe(clearOfSites(bandAt)).length < 20) continue;
          // The drag from the bend to the apex never leaves the viewer (its mouseleave is a cancel).
          const dir = { x: atPage.x - from0.x, y: atPage.y - from0.y }, dist = Math.hypot(dir.x, dir.y);
          const end = await dragEndOnMap(page, from0, [{ x: dir.x / dist, y: dir.y / dist }], dist).catch(() => null);
          if (!end) continue;
          if ((await inkAt(page, line, "purple")) > 0) continue;
          const bandClear = await inkedAt(page, clearOfLoupe(clearOfSites(bandAt)), "map");
          if (bandClear.length < 20) continue;
          p1 = at;
          apexLine = line;
          apexBand = bandClear;
          chordBandHeld = chordClear;
          break search;
        }
      }
    }
    if (!p1) throw new Error("no apex clear of the sites, the course's other purple and the held loupe, with map under its band");
    // F25: a leg through the held apex is at least the two straight pieces long (a curve through p1 is no shorter).
    const throughApexM = Math.round(((Math.hypot(p1.x - a.mm.x, p1.y - a.mm.y) + Math.hypot(b.mm.x - p1.x, b.mm.y - p1.y)) * scale) / 1000);
    expect(throughApexM, "the apex lengthens the leg").toBeGreaterThan(chordM + 2);
    const from = await toPage(page, p0), to = await toPage(page, p1);
    expect(await inkAt(page, apexLine, "purple"), "no line where the handle goes").toBe(0);

    // A plain leg: held, the layer draws the line through the handle; no write until the release, then one. Read held
    // (`inkAt(…, true)`): a hidden overlay would send the viewer a mouseleave, its cancel.
    /** How far the UI handle is from the held apex (the gesture took the press). */
    const heldAt = async () => { const h = (await toolShapes(page, "editor-bend-handle"))[0]; return h ? Math.hypot(h.x - p1!.x, h.y - p1!.y) : Infinity; };
    let sent = writes.length;
    await dragHold(page, from, to);
    await expect.poll(heldAt, { timeout: 5000 }).toBeLessThan(0.5);
    await expect.poll(() => inkAt(page, apexLine, "purple", true), { timeout: 15000 }).toBeGreaterThan(0);
    expect(await heldAt(), "still held").toBeLessThan(0.5);
    expect(writes.length, "no write while the handle is held").toBe(sent);
    // F25: held, the inspector's metres follow the drafted bend, before any write.
    await expect.poll(metres, { timeout: 5000 }).toBeGreaterThanOrEqual(throughApexM - 1);
    const heldM = await metres();
    expect(writes.length, "no write while the handle is held").toBe(sent);
    let released = waitForTrpc(page, "course.setStructure");
    await page.mouse.up();
    expect(await metres(), "the released metres while the write is in flight").toBe(heldM);
    await released;
    expect(writes.length, "one write on release").toBe(sent + 1);
    await expect.poll(async () => Math.hypot((await storedBends(courseId))[0].x - p1.x, (await storedBends(courseId))[0].y - p1.y), { timeout: 15000 }).toBeLessThan(0.5);
    expect(await inkAt(page, apexLine, "purple"), "the line stays at the written bend").toBeGreaterThan(0);
    expect(await metres(), "the written bend's metres").toBe(heldM);
    // Undo: the bend back on the chord.
    await page.keyboard.press("Control+z");
    await expect.poll(async () => Math.hypot((await storedBends(courseId))[0].x - p0.x, (await storedBends(courseId))[0].y - p0.y), { timeout: 15000 }).toBeLessThan(0.01);
    await expect.poll(() => inkAt(page, apexLine, "purple"), { timeout: 30000 }).toBe(0);
    await expect.poll(metres, { timeout: 15000 }).toBe(chordM);

    // The default corridor on the leg (A, then C): the chord's band white.
    await page.keyboard.press("a");
    const cut = waitForTrpc(page, "course.setStructure");
    await page.keyboard.press("c");
    await cut;
    await expect(page.getByTestId("editor-leg-corridor-width")).toHaveValue("50");
    await expect.poll(() => inkAt(page, chordBand, "map"), { timeout: 30000 }).toBe(0);
    expect(await inkAt(page, apexBand, "map"), "the fixture map has colour where the band goes").toBeGreaterThan(0);

    // Held: the band follows the handle (white beyond the apex) and the map shows again beside the chord; no write.
    await viewSettled(page);
    sent = writes.length;
    await dragHold(page, await toPage(page, p0), await toPage(page, p1));
    await expect.poll(heldAt, { timeout: 5000 }).toBeLessThan(0.5);
    await expect.poll(() => inkAt(page, apexBand, "map", true), { timeout: 30000 }).toBe(0);
    await expect.poll(() => inkAt(page, chordBandHeld, "map", true), { timeout: 30000 }).toBeGreaterThan(0);
    expect(await heldAt(), "still held").toBeLessThan(0.5);
    expect(writes.length, "no write while the handle is held").toBe(sent);
    released = waitForTrpc(page, "course.setStructure");
    await page.mouse.up();
    await released;
    expect(writes.length, "one write on release").toBe(sent + 1);
    // Through the write and the list's refetch, the band stays where it was released (no jump back).
    await expect.poll(async () => Math.hypot((await storedBends(courseId))[0].x - p1.x, (await storedBends(courseId))[0].y - p1.y), { timeout: 15000 }).toBeLessThan(0.5);
    expect(await inkAt(page, apexBand, "map"), "the band at the written bend").toBe(0);
    expect(await inkAt(page, chordBand, "map"), "the map beside the chord").toBeGreaterThan(0);

    // Undo restores the chord's band.
    await page.keyboard.press("Control+z");
    await expect.poll(() => inkAt(page, chordBand, "map"), { timeout: 30000 }).toBe(0);
    await expect.poll(async () => Math.hypot((await storedBends(courseId))[0].x - p0.x, (await storedBends(courseId))[0].y - p0.y), { timeout: 15000 }).toBeLessThan(0.01);

    // Escape ends a held drag: the release writes nothing, the bend stays on the chord.
    await viewSettled(page);
    sent = writes.length;
    await dragHold(page, await toPage(page, p0), await toPage(page, p1));
    await expect.poll(heldAt, { timeout: 5000 }).toBeLessThan(0.5);
    // F25: the metres follow the held bend, and Escape puts the stored ones back.
    await expect.poll(metres, { timeout: 5000 }).toBeGreaterThanOrEqual(throughApexM - 1);
    await page.keyboard.press("Escape");
    await expect.poll(metres, { timeout: 5000 }).toBe(chordM);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    expect(writes.length, "no write after Escape").toBe(sent);
    expect(await metres(), "the stored metres after Escape").toBe(chordM);
    expect(Math.hypot((await storedBends(courseId))[0].x - p0.x, (await storedBends(courseId))[0].y - p0.y)).toBeLessThan(0.01);
  });

  // F24 (§10 "Loupe"; user answer 2026-11-10): the D9b loupe on mouse drags — 120 px at ×2.5 about the dragged point,
  // 16 px above the cursor (below it at the map's top), no stem; gone on release and on the viewer's mouseleave cancel.
  test("F24: the loupe on mouse drags — a control, a bend; none on a number (F30) or a click; gone on release, cancel and Escape (which writes nothing)", async ({ page }) => {
    const { name, a, b } = await twoControlCourse(page, "F24 loupe");
    const courseId = await page.getByTestId("editor-course-picker").inputValue();
    const loupe = page.getByTestId("editor-loupe");
    const writes: string[] = [];
    // Every control or course write this page sends (a move is `control.update`); not the presence heartbeat (D11).
    page.on("request", (r) => { if (r.method() === "POST" && /\/trpc\/[^?]*\b(control|course)\.(?!presence)/.test(r.url())) writes.push(r.url()); });
    /** Escape's §3 cascade drops the course when nothing else is selected: pick it again. */
    const repick = async () => {
      if ((await page.getByTestId("editor-course-picker").inputValue()) !== courseId) await page.getByTestId("editor-course-picker").selectOption(courseId);
      await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
      await viewSettled(page);
    };
    /** The loupe is the mouse's, 120 px, its bottom 16 px above `cursor` (its top 16 px below at the map's top), centred over it within the box. */
    const mouseLoupeAt = async (cursor: Pt) => {
      await expect(loupe).toBeVisible();
      await expect(loupe).toHaveAttribute("data-pointer", "mouse");
      await expect(loupe).toHaveAttribute("data-scale", "2.5");
      await expect(page.getByTestId("editor-touch-handle"), "no stem on a mouse drag").toHaveCount(0);
      const lb = (await loupe.boundingBox())!;
      const vb = (await page.getByTestId("map-viewer").boundingBox())!;
      expect(Math.abs(lb.width - 120)).toBeLessThanOrEqual(1);
      expect(Math.abs(lb.height - 120)).toBeLessThanOrEqual(1);
      if (cursor.y - vb.y - 16 - 120 < 0) expect(Math.abs(lb.y - (cursor.y + 16))).toBeLessThanOrEqual(1);
      else expect(Math.abs(lb.y + lb.height - (cursor.y - 16))).toBeLessThanOrEqual(1);
      const cx = Math.min(Math.max(cursor.x, vb.x + 64), vb.x + vb.width - 64);
      expect(Math.abs(lb.x + lb.width / 2 - cx)).toBeLessThanOrEqual(1);
      return lb;
    };

    // A control: held, the loupe magnifies the map about it (the canvas in the circle has purple and differs from the
    // same circle at 1× after the drag); the pointer leaving the viewer cancels the drag — no loupe, no move.
    await viewSettled(page);
    const fromA = await toPage(page, a.mm);
    const toA = await dragTarget(page, fromA, [await toPage(page, b.mm)]);
    const sent = writes.length;
    await dragHold(page, fromA, toA);
    const lb = await mouseLoupeAt(toA);
    // Read held: transparent overlays, so the pointer stays over the viewer (a hidden one would be its mouseleave).
    await nextFrames(page);
    await expect.poll(async () => (await canvasInCircle(page, lb, 4, true)).purple, { timeout: 15000 }).toBeGreaterThan(0);
    const magnified = await canvasInCircle(page, lb, 4, true);
    const vb = (await page.getByTestId("map-viewer").boundingBox())!;
    await page.mouse.move(vb.x + vb.width + 20, toA.y, { steps: 2 });
    await expect(loupe).toHaveCount(0);
    await page.mouse.up();
    await nextFrames(page);
    const plain = await canvasInCircle(page, lb);
    expect(plain.rgb.length).toBe(magnified.rgb.length);
    let differing = 0;
    for (let i = 0; i < plain.rgb.length; i += 3) {
      if (Math.abs(plain.rgb[i] - magnified.rgb[i]) + Math.abs(plain.rgb[i + 1] - magnified.rgb[i + 1]) + Math.abs(plain.rgb[i + 2] - magnified.rgb[i + 2]) > 60) differing++;
    }
    expect(differing / (plain.rgb.length / 3), "the loupe is the magnified map, not the 1× one").toBeGreaterThan(0.1);
    await page.waitForTimeout(500);
    expect(writes.length, "a cancelled control drag writes nothing").toBe(sent);
    expect((await site(page, a.code)).mm).toEqual(a.mm);

    // Escape cancels a control's mouse drag (§3; user 2026-11-11): the loupe goes while the button is still down, the
    // release writes nothing (no move, no structure write), the control stays where it is stored.
    await viewSettled(page);
    const toA2 = await dragTarget(page, await toPage(page, a.mm), [await toPage(page, b.mm)]);
    await dragHold(page, await toPage(page, a.mm), toA2);
    await mouseLoupeAt(toA2);
    await page.keyboard.press("Escape");
    await expect(loupe).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    expect(writes.slice(sent), "Escape: a control drag writes nothing").toEqual([]);
    expect((await site(page, a.code)).mm).toEqual(a.mm);
    await repick();

    // A number (F30; user 2026-11-11, replacing F24's "a number"): held, no loupe — it is a label, not a point to place;
    // Escape cancels it with no write; the release writes the offset once.
    await expect.poll(async () => (await labelOf(page, b.code)) !== null, { timeout: 15000 }).toBe(true);
    const fromN = await toPage(page, (await labelOf(page, b.code))!);
    const toN = { x: fromN.x + (fromN.x < vb.x + vb.width / 2 ? 48 : -48), y: fromN.y + (fromN.y < vb.y + vb.height / 2 ? 24 : -24) };
    const labelBefore = (await labelOf(page, b.code))!;
    // Escape cancels it: no loupe while held, no write on release, the number where it was.
    await dragHold(page, fromN, toN);
    await nextFrames(page);
    await expect(loupe, "no loupe on a number drag").toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(loupe).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    expect(writes.slice(sent), "Escape: a number drag writes nothing").toEqual([]);
    await repick();
    const labelAfter = (await labelOf(page, b.code))!;
    expect(Math.hypot(labelAfter.x - labelBefore.x, labelAfter.y - labelBefore.y), "the number where it was").toBeLessThan(0.01);
    // Held again and released: the offset written.
    const fromN2 = await toPage(page, labelAfter);
    const toN2 = { x: fromN2.x + toN.x - fromN.x, y: fromN2.y + toN.y - fromN.y };
    await dragHold(page, fromN2, toN2);
    await nextFrames(page);
    await expect(loupe, "no loupe on a number drag").toHaveCount(0);
    const labelWrites = writes.length;
    const offset = waitForTrpc(page, "course.setControlLabelOffset");
    await page.mouse.up();
    await offset;
    await expect(loupe).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(writes.length - labelWrites, "the release sends exactly one write").toBe(1);

    // A bend of the selected leg (the point the tool's drag places, F23): held, the loupe about the snapped bend under
    // the cursor; one write on release, then none.
    await selectLeg(page, name, a, b);
    const added = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-add-bend").click();
    await added;
    await expect.poll(async () => (await storedBends(courseId)).length, { timeout: 15000 }).toBe(1);
    await viewSettled(page);
    const handle = (await toolShapes(page, "editor-bend-handle"))[0];
    const fromB = await toPage(page, handle);
    const pa = await toPage(page, a.mm), pb = await toPage(page, b.mm);
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    let nrm = { x: -(pb.y - pa.y) / len, y: (pb.x - pa.x) / len };
    if (nrm.y > 0) nrm = { x: -nrm.x, y: -nrm.y };
    // Off the leg and on the map, its end clear of the action bar: the press without a drag below is at the moved handle,
    // and the bar stops a press (in-order run: a leg along the bottom row, the bar flipped above it over the handle).
    const off = (v: Pt) => [v, turned(v, 30), turned(v, -30)];
    const toB = await dragEndOnMap(page, fromB, [...off(nrm), ...off({ x: -nrm.x, y: -nrm.y })], [60, 90, 120], { endOnBar: false });
    await dragHold(page, fromB, toB);
    await mouseLoupeAt(toB);
    const cursorMm = await toPaper(page, toB);
    await expect.poll(async () => {
      const h = (await toolShapes(page, "editor-bend-handle"))[0];
      return h ? Math.hypot(h.x - cursorMm.x, h.y - cursorMm.y) : Infinity;
    }, { timeout: 5000 }).toBeLessThan(0.5);
    const moved = waitForTrpc(page, "course.setStructure");
    await page.mouse.up();
    await expect(loupe).toHaveCount(0);
    await moved;
    await expect.poll(async () => Math.hypot((await storedBends(courseId))[0].x - cursorMm.x, (await storedBends(courseId))[0].y - cursorMm.y), { timeout: 15000 }).toBeLessThan(0.5);

    // A press without a drag (a click on the handle) shows none.
    await viewSettled(page);
    const at = await toPage(page, (await toolShapes(page, "editor-bend-handle"))[0]);
    expect(await coveredBy(page, at), "the moved handle on the map, clear of the action bar").toBeNull();
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x + 1, at.y);
    await page.waitForTimeout(300);
    await expect(loupe).toHaveCount(0);
    await page.mouse.up();
    await expect(loupe).toHaveCount(0);

    // Escape cancels a bend drag too (F21's rule, now the viewer's for every mouse drag): the loupe goes while held,
    // the release writes nothing, the stored bend stays.
    const storedBend = (await storedBends(courseId))[0];
    const sentB = writes.length;
    // Back towards the leg (or any way off it that stays on the map: a drag that leaves the viewer is cancelled).
    const toE = await dragEndOnMap(page, at, [...off({ x: -nrm.x, y: -nrm.y }), ...off(nrm)], 40);
    await dragHold(page, at, toE);
    await mouseLoupeAt(toE);
    await page.keyboard.press("Escape");
    await expect(loupe).toHaveCount(0);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    expect(writes.slice(sentB), "Escape: a bend drag writes nothing").toEqual([]);
    expect(Math.hypot((await storedBends(courseId))[0].x - storedBend.x, (await storedBends(courseId))[0].y - storedBend.y)).toBeLessThan(0.01);
  });

  // F24 on a course object (§7 "Editing geometry", §10 "Loupe"): a vertex dragged with the mouse shows the loupe about
  // the dragged vertex; Escape cancels the drag (§3) — no loupe, no `courseObject.update`, the geometry as stored.
  test("F24: the loupe on an object's vertex drag; Escape cancels it with no write", async ({ page }) => {
    await openEditor(page);
    const sheetToggle = page.getByTestId("map-toggle-descriptions");
    if (/hide/i.test((await sheetToggle.textContent()) ?? "")) await sheetToggle.click();
    const clear = await emptyPoint(page, 60);
    const geometry = await Promise.all([[-35, -35], [35, -35], [35, 35], [-35, 35]].map(([dx, dy]) => toPaper(page, { x: clear.x + dx, y: clear.y + dy })));
    const { id } = await trpcCall<{ id: number }>("courseObject.create", { kind: "oob_area", geometry, props: {}, scope: { all: true } });
    try {
      await page.reload();
      await editorReady(page);
      const row = objectRow(page, id);
      await expect(row).toBeAttached({ timeout: 15000 });
      const stored = await row.getAttribute("data-geometry");
      await expect(async () => {
        await dropSelection(page);
        await clickMap(page, await pressOnEdge(page, await geometryOf(row)));
        await expect(page.getByTestId("editor-object")).toHaveAttribute("data-object-id", String(id), { timeout: 2000 });
      }).toPass({ timeout: 20000 });
      await expect.poll(async () => (await toolShapes(page, "editor-object-handle")).length, { timeout: 15000 }).toBe(4);
      await viewSettled(page);
      const writes: string[] = [];
      page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("courseObject.update")) writes.push(r.url()); });

      // Held: the loupe (the mouse's, 16 px above the cursor or below it at the map's top), the vertex under the cursor.
      const vertex = (await toolShapes(page, "editor-object-handle"))[0];
      const from = await toPage(page, vertex);
      const centre = await toPage(page, { x: (geometry[0].x + geometry[2].x) / 2, y: (geometry[0].y + geometry[2].y) / 2 });
      const to = { x: from.x + (centre.x - from.x) * 0.5, y: from.y + (centre.y - from.y) * 0.5 };
      await dragHold(page, from, to);
      const loupe = page.getByTestId("editor-loupe");
      await expect(loupe).toBeVisible();
      await expect(loupe).toHaveAttribute("data-pointer", "mouse");
      await expect(page.getByTestId("editor-touch-handle")).toHaveCount(0);
      const lb = (await loupe.boundingBox())!;
      const vb = (await page.getByTestId("map-viewer").boundingBox())!;
      if (to.y - vb.y - 16 - 120 < 0) expect(Math.abs(lb.y - (to.y + 16))).toBeLessThanOrEqual(1);
      else expect(Math.abs(lb.y + lb.height - (to.y - 16))).toBeLessThanOrEqual(1);
      const cursorMm = await toPaper(page, to);
      await expect.poll(async () => {
        const vs = await toolShapes(page, "editor-object-handle");
        return Math.min(...vs.map((h) => Math.hypot(h.x - cursorMm.x, h.y - cursorMm.y)));
      }, { timeout: 5000 }).toBeLessThan(0.5);

      // Escape: gone while the button is down; the release writes nothing, the geometry as stored.
      await page.keyboard.press("Escape");
      await expect(loupe).toHaveCount(0);
      await page.mouse.up();
      await page.waitForTimeout(1000);
      expect(writes, "Escape: an object's vertex drag writes nothing").toEqual([]);
      await expect(row).toHaveAttribute("data-geometry", stored!);
    } finally {
      await cleanup("courseObject.delete", { id });
    }
  });
});

// F13 (docs/course-layer.md §10.1): a leg's bends are path vertices with optional handles, drawn and measured along
// the curve flattened at 5 µm. No editor gesture writes handles yet (F16), so the curve is written over tRPC. Its own
// describe, so the parallel rows' edits above merge cleanly.
test.describe("F13: Bézier bends (docs/course-layer.md §10.1)", () => {
  desktopOnly();

  test("a curved leg written over tRPC draws purple at the curve's apex, not at the chord's midpoint; the print is one page", async ({ page }) => {
    await openEditor(page);
    const nameId = nameIdOf(page);
    const controls = await trpcCall<{ id: number; codes: string }[]>("control.list", undefined, false);
    const idOf = (code: string) => controls.find((c) => c.codes.split(";").includes(code))!.id;

    // One smooth bend off the chord's midpoint by a fraction of the leg, its handles along the chord: an arch through
    // it. The pair, the side and the fraction are chosen so the apex and the chord's midpoint lie in view, 6 mm clear of
    // every site (legs are clipped at the sites) and of the default start's and finish's legs into the pair, and the
    // apex on plain map: a black or brown line under it sorts above the leg's lower purple and hides it at the one
    // pixel the probe reads (docs/bugfix-e2e-apex-probe-pixel.md). Which pair passes depends on the editor's first
    // view and the event's state, so in the full suite it is not always the same one.
    const all = await sites(page);
    const ends = all.filter((s) => s.type !== "Control").map((s) => s.mm);
    const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
    const segDist = (p: Pt, a: Pt, b: Pt) => {
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    };
    const clear = async (p: Pt, a: Pt, b: Pt) => {
      const q = await toPage(page, p);
      const inView = q.x > viewer.x + 60 && q.x < viewer.x + viewer.width - 100 && q.y > viewer.y + 60 && q.y < viewer.y + viewer.height - 120;
      return inView && all.every((s) => Math.hypot(s.mm.x - p.x, s.mm.y - p.y) > 6) && ends.every((e) => segDist(p, e, a) > 3 && segDist(p, b, e) > 3);
    };
    // 16 candidates and five arch heights a side: 6 and four left no pair in some full-suite contexts (the controls
    // clear of the legs drawn when the editor opens depend on the earlier tests' courses).
    const codes = await regularCodes(page, 16);
    let pick: { a: Site; b: Site; apex: Pt; chordMid: Pt; u: Pt; len: number } | null = null;
    search: for (let i = 0; i < codes.length; i++) {
      for (let j = 0; j < codes.length; j++) {
        if (i === j) continue;
        const sa = await site(page, codes[i]), sb = await site(page, codes[j]);
        const len = Math.hypot(sb.mm.x - sa.mm.x, sb.mm.y - sa.mm.y);
        if (len < 15) continue;
        const u = { x: (sb.mm.x - sa.mm.x) / len, y: (sb.mm.y - sa.mm.y) / len };
        const chordMid = { x: (sa.mm.x + sb.mm.x) / 2, y: (sa.mm.y + sb.mm.y) / 2 };
        if (!(await clear(chordMid, sa.mm, sb.mm))) continue;
        for (const k of [0.3, -0.3, 0.2, -0.2, 0.25, -0.25, 0.35, -0.35, 0.15, -0.15]) {
          const apex = { x: chordMid.x - u.y * k * len, y: chordMid.y + u.x * k * len };
          if ((await clear(apex, sa.mm, sb.mm)) && (await plainMapAt(page, apex, 0.5))) {
            pick = { a: sa, b: sb, apex, chordMid, u, len };
            break search;
          }
        }
      }
    }
    expect(pick, "a pair of regular controls with a clear apex and chord midpoint").not.toBeNull();
    const { a, b, chordMid, u, len } = pick!;
    const codeA = a.code, codeB = b.code;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const apex = { x: r2(pick!.apex.x), y: r2(pick!.apex.y) };
    const h = { x: r2(u.x * 0.25 * len), y: r2(u.y * 0.25 * len) };
    const bend = { ...apex, hIn: { x: -h.x, y: -h.y }, hOut: h };

    const name = `F13 curve ${Date.now() % 100000}`;
    const { id } = await trpcCall<{ id: number }>("course.create", { name });
    await trpcCall("course.setStructure", {
      courseId: id,
      structure: { version: 1, id: "f13", orderMode: "ordered", items: [{ siteId: idOf(codeA) }, { siteId: idOf(codeB), leg: { bends: [bend] } }] },
    });
    // The stored leg reads back whole, handles included.
    const summary = (await trpcCall<{ id: number; legs?: Record<string, unknown> }[]>("course.list", undefined, false)).find((c) => c.id === id)!;
    expect(summary.legs).toEqual({ [`${idOf(codeA)}>${idOf(codeB)}`]: { bends: [bend] } });

    const template = await probeTemplate("F13 curve");
    const sheet = await trpcCall<{ seq: number }>("courseMap.create", { kind: "course", courseId: id, templateId: template.seq, overrides: {}, objects: [] });
    try {
      await page.goto(`/${nameId}/course-editor?course=${id}`);
      await editorReady(page);
      await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
      await viewSettled(page);

      // The drawn leg is the flattened curve: many points, through the bend.
      await expect.poll(async () => (await legPieces(page, name)).reduce((k, p) => k + p.points.length, 0), { timeout: 30000 }).toBeGreaterThan(10);
      const pieces = await legPieces(page, name);
      expect(pieces.some((p) => p.points.some((q) => Math.hypot(q.x - apex.x, q.y - apex.y) < 0.05))).toBe(true);

      // Purple at the apex, none at the chord's midpoint (both well clear of the circles).
      await expect.poll(() => inkAt(page, [apex], "purple"), { timeout: 30000 }).toBeGreaterThan(0);
      expect(await inkAt(page, [chordMid], "purple")).toBe(0);

      // The leg's metres in the sequence follow the curve: longer than the chord.
      const chordM = (len * (await mapScale(page))) / 1000;
      const metres = async () => Number(((await controlRows(page).nth(1).getByTestId("editor-leg-meters").textContent()) ?? "").replace(/[^\d]/g, ""));
      await expect.poll(metres, { timeout: 15000 }).toBeGreaterThan(Math.round(chordM) + 1);

      expect((await printed(page, nameId, `maps=${sheet.seq}`)).pages).toBe(1);
    } finally {
      await cleanup("courseMap.delete", { id: sheet.seq });
      await cleanup("mapTemplate.delete", { id: template.seq });
      await cleanup("course.delete", { id });
    }
  });
});

// F23 (docs/course-editor.md §6.7, §10; user 2026-11-10 answer 1): a tablet — a coarse pointer with the desktop
// layout — drags the selected leg's bend handle and grip with one finger, lifted above it with the loupe. Its own
// describe at the end of the file, so the parallel rows' edits above merge cleanly.
test.describe("F23: bend drags on a tablet (docs/course-editor.md §6.7, §10)", () => {
  // eslint-disable-next-line no-empty-pattern -- the project's name only
  test.beforeEach(({}, info) => test.skip(info.project.name !== "chromium", "a tablet in the desktop project (the phone stays read-only)"));
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 1024, height: 768 } });

  /** The stored bends of the course's one leg with props (a → b), from `course.list`. */
  async function storedBends(courseId: string): Promise<{ x: number; y: number; hIn?: Pt; hOut?: Pt }[]> {
    const summary = (await trpcCall<{ id: number; legs?: Record<string, { bends?: { x: number; y: number; hIn?: Pt; hOut?: Pt }[] }> }[]>("course.list", undefined, false))
      .find((c) => c.id === Number(courseId))!;
    return Object.values(summary.legs ?? {})[0]?.bends ?? [];
  }

  /** The point along the leg a → b farthest from every site (a tap there is the leg's, not a faded control's). */
  async function legTapPoint(page: Page, name: string, a: Site, b: Site): Promise<Pt> {
    const marks = (await sites(page)).map((x) => x.mm);
    const clearance = (q: Pt) => Math.min(...marks.map((m) => Math.hypot(q.x - m.x, q.y - m.y)));
    let best = await legMidpoint(page, name, a.mm, b.mm), bestD = clearance(best);
    for (const piece of await legBetween(page, name, a.mm, b.mm)) {
      piece.points.slice(1).forEach((q, i) => {
        const p0 = piece.points[i];
        for (let t = 0.05; t < 1; t += 0.05) {
          const c = { x: p0.x + (q.x - p0.x) * t, y: p0.y + (q.y - p0.y) * t };
          if (clearance(c) > bestD) { best = c; bestD = clearance(c); }
        }
      });
    }
    return best;
  }

  /** One finger from `from` to `to` in `steps` moves, held (no lift). */
  async function fingerTo(page: Page, from: Pt, to: Pt, steps = 6): Promise<void> {
    await touchStart(page, [from]);
    for (let i = 1; i <= steps; i++) await touchMove(page, [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
  }

  test("a finger drags the bend lifted 48 px on the stem with the loupe, one write on lift; then a grip, mirrored", async ({ page }) => {
    await openEditor(page);
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-layout", "desktop");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), "a coarse pointer").toBe(true);
    const name = await newCourse(page, "F23 tablet");
    const courseId = await page.getByTestId("editor-course-picker").inputValue();
    const ca = await appendClear(page);
    const cb = await appendClear(page, [ca]);
    await expect(controlRows(page)).toHaveCount(2, { timeout: 15000 });
    const a = await site(page, ca), b = await site(page, cb);

    // A tap on the leg selects it (the viewer's leg target on touch); Add bend here: smooth, two grips.
    await viewSettled(page);
    const mid = await legTapPoint(page, name, a, b);
    await expect(async () => {
      await dropSelection(page);
      await touchTap(page, await toPage(page, mid));
      await expect(page.getByTestId("editor-leg")).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30000 });
    await expect(page.getByTestId("editor-leg")).not.toHaveAttribute("data-readonly", "true");
    const added = waitForTrpc(page, "course.setStructure");
    await page.getByTestId("editor-action-bar").getByTestId("editor-action-add-bend").click();
    await added;
    await expect.poll(async () => (await storedBends(courseId)).length, { timeout: 15000 }).toBe(1);
    await expect.poll(async () => (await toolShapes(page, "editor-bend-grip")).length, { timeout: 15000 }).toBe(2);
    const bend0 = (await storedBends(courseId))[0];

    let writes = 0;
    page.on("request", (r) => { if (trpcProcedures(r.url()).includes("course.setStructure")) writes++; });

    // The finger lands 10 px beside the handle — beyond the mouse's 7 px, within a finger's 14 px — and moves
    // down-right: the bend rides 48 px above the finger, on the stem, the loupe above it.
    const handle = await toPage(page, (await toolShapes(page, "editor-bend-handle"))[0]);
    const press = { x: handle.x + 10, y: handle.y };
    const finger = { x: press.x + 24, y: press.y + 30 };
    await fingerTo(page, press, finger);
    await expect(page.getByTestId("editor-touch-handle")).toBeVisible();
    await expect(page.getByTestId("editor-loupe")).toBeVisible();
    const lifted = await toPaper(page, { x: finger.x, y: finger.y - 48 });
    await expect.poll(async () => {
      const h = (await toolShapes(page, "editor-bend-handle"))[0];
      return Math.hypot(h.x - lifted.x, h.y - lifted.y);
    }, { timeout: 5000 }).toBeLessThan(0.6);
    // The loupe: its bottom 16 px above the lifted bend, centred over the finger (as field-mode.spec.ts pins it) —
    // flipped to 16 px below the finger when that would leave the map box at the top (§10 "Loupe"); nothing
    // written yet (the layer follows the draft, F21).
    const loupe = (await page.getByTestId("editor-loupe").boundingBox())!;
    const viewer = (await page.getByTestId("map-viewer").boundingBox())!;
    const flipped = finger.y - 48 - 16 - 120 < viewer.y;
    if (flipped) expect(Math.abs(loupe.y - (finger.y + 16))).toBeLessThanOrEqual(1);
    else expect(Math.abs(loupe.y + loupe.height - (finger.y - 48 - 16))).toBeLessThanOrEqual(1);
    expect(Math.abs(loupe.x + loupe.width / 2 - finger.x)).toBeLessThanOrEqual(1);
    expect(writes).toBe(0);

    const moved = waitForTrpc(page, "course.setStructure");
    await touchEnd(page, [finger]);
    await moved;
    await expect(page.getByTestId("editor-touch-handle")).toHaveCount(0);
    await expect(page.getByTestId("editor-loupe")).toHaveCount(0);
    await expect.poll(async () => {
      const [s] = await storedBends(courseId);
      return s ? Math.hypot(s.x - lifted.x, s.y - lifted.y) : Infinity;
    }, { timeout: 15000 }).toBeLessThan(0.6);
    const bend1 = (await storedBends(courseId))[0];
    // The bend moved with its handles (F18): the pair unchanged; one write for the gesture; the bend focused.
    expect(bend1.hOut).toEqual(bend0.hOut);
    expect(writes).toBe(1);
    await expect(page.getByTestId("editor-leg-bend").first()).toHaveAttribute("data-focused", "true");

    // A grip: the finger beside it on the side away from the bend, dragged; the handle moves by the lifted
    // finger's offset and its pair stays mirrored.
    await expect.poll(async () => {
      const h = (await toolShapes(page, "editor-bend-handle"))[0];
      return h ? Math.hypot(h.x - bend1.x, h.y - bend1.y) : Infinity;
    }, { timeout: 15000 }).toBeLessThan(0.05);
    const grips = await toolShapes(page, "editor-bend-grip");
    const onScreen = await Promise.all(grips.map((g) => toPage(page, g)));
    const k = onScreen[0].y <= onScreen[1].y ? 0 : 1;
    const mine = grips[k].data.which === "out" ? "hOut" : "hIn";
    const other = mine === "hOut" ? "hIn" : "hOut";
    const centre = await toPage(page, bend1);
    const away = { x: onScreen[k].x - centre.x, y: onScreen[k].y - centre.y };
    const d = Math.hypot(away.x, away.y);
    const gripPress = { x: onScreen[k].x + (away.x / d) * 6, y: onScreen[k].y + (away.y / d) * 6 };
    const gripFinger = { x: gripPress.x - 20, y: gripPress.y + 20 };
    const pulled = waitForTrpc(page, "course.setStructure");
    await fingerTo(page, gripPress, gripFinger);
    await expect(page.getByTestId("editor-loupe")).toBeVisible();
    await touchEnd(page, [gripFinger]);
    await pulled;
    await expect.poll(async () => JSON.stringify((await storedBends(courseId))[0]?.[mine]), { timeout: 15000 }).not.toBe(JSON.stringify(bend1[mine]));
    const curved = (await storedBends(courseId))[0];
    expect(curved[other]).toEqual({ x: -curved[mine]!.x, y: -curved[mine]!.y });
    expect({ x: curved.x, y: curved.y }).toEqual({ x: bend1.x, y: bend1.y });
    expect(writes).toBe(2);

    // A second finger cancels a bend drag: no write, the bend where it was.
    const at = await toPage(page, (await toolShapes(page, "editor-bend-handle"))[0]);
    await fingerTo(page, at, { x: at.x + 20, y: at.y + 20 });
    await touchStart(page, [{ x: at.x + 20, y: at.y + 20 }, { x: at.x + 120, y: at.y + 60 }]);
    await touchEnd(page, [{ x: at.x + 20, y: at.y + 20 }, { x: at.x + 120, y: at.y + 60 }]);
    await expect(page.getByTestId("editor-loupe")).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(writes).toBe(2);
    expect((await storedBends(courseId))[0]).toEqual(curved);

    // A tap on the handle focuses the bend with no write: undo first (it unfocuses and puts the grip back), then
    // tap the handle where it is drawn — at the press, not 48 px above it.
    const undone = waitForTrpc(page, "course.setStructure");
    await page.keyboard.press("Control+z");
    await undone;
    await expect(page.getByTestId("editor-leg-bend").first()).toHaveAttribute("data-focused", "false");
    await expect.poll(async () => JSON.stringify((await storedBends(courseId))[0]?.[mine]), { timeout: 15000 }).toBe(JSON.stringify(bend1[mine]));
    await expect.poll(async () => {
      const h = (await toolShapes(page, "editor-bend-handle"))[0];
      return h ? Math.hypot(h.x - bend1.x, h.y - bend1.y) : Infinity;
    }, { timeout: 15000 }).toBeLessThan(0.05);
    const before = writes;
    await touchTap(page, await toPage(page, (await toolShapes(page, "editor-bend-handle"))[0]));
    await expect(page.getByTestId("editor-leg-bend").first()).toHaveAttribute("data-focused", "true");
    await expect(page.getByTestId("editor-leg")).toBeVisible();
    await page.waitForTimeout(500);
    expect(writes).toBe(before);
    expect((await storedBends(courseId))[0]).toEqual(bend1);
  });
});
