/**
 * Control-number labels on the map (docs/map-rendering.md §5.4 "Overlay"):
 * the GL course layer draws them on the canvas and the viewer mirrors each
 * one as a hidden `course-label` element. Leg pills and the description
 * sheet stay SVG text.
 */
import { expect, type Locator } from "@playwright/test";

export function courseLabels(scope: Locator): Locator {
  return scope.locator('[data-testid="course-label"]');
}

/** The label is on the map: a mirror entry of the drawn layer. */
export async function expectLabelShown(label: Locator, timeout = 10_000): Promise<void> {
  await expect(label).toBeAttached({ timeout });
}
