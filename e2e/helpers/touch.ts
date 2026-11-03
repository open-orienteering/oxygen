/**
 * Touch gestures in E2E (docs/course-editor.md §10): synthetic `TouchEvent`s
 * dispatched on the element under the first finger — the viewer listens on
 * its container, as `mobile-layout.spec.ts` drives it — with one call per
 * phase, so a test can hold a finger still (a long press) between them.
 * Every later event of a gesture goes to the element the gesture started on,
 * as a real touch does.
 */
import type { Page } from "@playwright/test";

type Pt = { x: number; y: number };

async function dispatch(page: Page, type: "touchstart" | "touchmove" | "touchend", touches: Pt[], changed: Pt[]): Promise<void> {
  await page.evaluate(({ type, touches, changed }) => {
    const w = window as unknown as { __touchTarget?: Element | null };
    if (type === "touchstart" && (touches.length === 1 || !w.__touchTarget)) w.__touchTarget = document.elementFromPoint(touches[0].x, touches[0].y);
    const target = w.__touchTarget;
    if (!target) throw new Error("no touch target");
    const make = (pts: Pt[], from = 0) => pts.map((p, i) => new Touch({
      identifier: from + i + 1, target, clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y, screenX: p.x, screenY: p.y,
      radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1,
    }));
    const list = make(touches);
    target.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true, touches: list, targetTouches: list,
      changedTouches: type === "touchend" ? make(changed, touches.length) : list,
    }));
    if (type === "touchend" && touches.length === 0) w.__touchTarget = null;
  }, { type, touches, changed });
}

/** Fingers down at `pts` (one, or two for a pinch). */
export const touchStart = (page: Page, pts: Pt[]) => dispatch(page, "touchstart", pts, pts);

/** The fingers moved to `pts`. */
export const touchMove = (page: Page, pts: Pt[]) => dispatch(page, "touchmove", pts, pts);

/** Every finger lifted, the last ones at `pts`. */
export const touchEnd = (page: Page, pts: Pt[]) => dispatch(page, "touchend", [], pts);

/** One finger from `from` to `to` in `steps` moves, optionally held still for `holdMs` first (a long press). */
export async function touchDrag(page: Page, from: Pt, to: Pt, opts: { holdMs?: number; steps?: number } = {}): Promise<void> {
  const steps = opts.steps ?? 8;
  await touchStart(page, [from]);
  if (opts.holdMs) await page.waitForTimeout(opts.holdMs);
  for (let i = 1; i <= steps; i++) {
    await touchMove(page, [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }]);
  }
  await touchEnd(page, [to]);
}

/** A tap: down and up at the same point. */
export async function touchTap(page: Page, p: Pt): Promise<void> {
  await touchStart(page, [p]);
  await touchEnd(page, [p]);
}
