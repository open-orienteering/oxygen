/**
 * Control-number labels on the map under either pipeline
 * (docs/map-rendering.md §5.4 "Overlay"): `legacy` draws them as SVG
 * text; under `vector` the GL course layer draws them on the canvas and
 * the viewer mirrors each one as a hidden `course-label` element. Leg
 * pills and the description sheet stay SVG text under both.
 */
import { expect, type Locator } from "@playwright/test";
import type { MapPipeline } from "./map-pipeline";

export function courseLabels(scope: Locator, pipeline: MapPipeline): Locator {
  return pipeline === "vector" ? scope.locator('[data-testid="course-label"]') : scope.locator("svg text");
}

/** The label is on the map: visible SVG text, or (vector) a mirror entry of the drawn layer. */
export async function expectLabelShown(label: Locator, pipeline: MapPipeline, timeout = 10_000): Promise<void> {
  if (pipeline === "vector") await expect(label).toBeAttached({ timeout });
  else await expect(label).toBeVisible({ timeout });
}
