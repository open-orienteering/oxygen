/**
 * Map viewer gesture / measure / rotation regressions from the
 * map-viewer-fixes bundle (ruler touch, undo HUD, two-finger rotate).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { uploadEventMap } from "./helpers/map-upload";

test.describe("map viewer gestures (touch)", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test.beforeAll(async () => {
    await reseed();
  });

  test("measure: pan does not leave phantom cursor; taps place points; undo works", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    await uploadEventMap(page);
    const viewer = page.getByTestId("map-viewer").first();
    await expect(viewer).toBeVisible({ timeout: 60000 });

    await viewer.getByTitle("Measure distance").tap();
    await expect(viewer.getByTitle("Measure distance")).toHaveClass(
      /bg-blue-500/,
    );

    const box = await viewer.boundingBox();
    if (!box) throw new Error("map viewer has no box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    // Pan must not place a point, and must not leave a sticky rubber-band.
    await oneFingerPan(page, viewer, {
      from: { x: cx - 40, y: cy },
      to: { x: cx + 40, y: cy + 30 },
    });
    await expect(viewer).toHaveAttribute("data-measure-points", "0");
    await expect(viewer).toHaveAttribute("data-measure-cursor", "0");

    await page.touchscreen.tap(cx, cy);
    await expect(viewer).toHaveAttribute("data-measure-points", "1");
    await expect(viewer).toHaveAttribute("data-measure-cursor", "0");

    // Rapid second tap must place another point (no double-tap clear on touch).
    await page.touchscreen.tap(cx + 30, cy - 20);
    await expect(viewer).toHaveAttribute("data-measure-points", "2");
    await expect(viewer).toHaveAttribute("data-measure-cursor", "0");

    const undo = viewer.getByTestId("measure-undo");
    await expect(undo).toBeVisible();
    await undo.tap();
    await expect(viewer).toHaveAttribute("data-measure-points", "1");
    await expect(viewer.getByTitle("Measure distance")).toHaveClass(
      /bg-blue-500/,
    );

    // Exit measure before rotate.
    await viewer.getByTitle("Measure distance").tap();

    // ── Two-finger rotate + compass reset ──
    await expect(viewer).toHaveAttribute("data-user-bearing", "0");
    await expect(viewer.getByTestId("compass-reset")).toHaveCount(0);

    await twoFingerRotate(page, viewer, {
      center: { x: cx, y: cy },
      radius: 60,
      fromDeg: 0,
      toDeg: 45,
    });

    await expect
      .poll(async () => Number(await viewer.getAttribute("data-user-bearing")))
      .not.toBe(0);

    await viewer.getByTestId("compass-reset").tap();
    await expect(viewer).toHaveAttribute("data-user-bearing", "0");
    await expect(viewer.getByTestId("compass-reset")).toHaveCount(0);
  });
});

test.describe("map viewer gestures (desktop)", () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    hasTouch: false,
  });

  test.beforeAll(async () => {
    await reseed();
  });

  test("measure undo click removes a point without placing another", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    await uploadEventMap(page);
    const viewer = page.getByTestId("map-viewer").first();
    await expect(viewer).toBeVisible({ timeout: 60000 });

    await viewer.getByTitle("Measure distance").click();
    const box = await viewer.boundingBox();
    if (!box) throw new Error("map viewer has no box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.click(cx - 20, cy);
    await page.mouse.click(cx + 20, cy - 15);
    await expect(viewer).toHaveAttribute("data-measure-points", "2");

    const undo = viewer.getByTestId("measure-undo");
    await undo.click();
    // Must remove exactly one point — not place a new one under the button.
    await expect(viewer).toHaveAttribute("data-measure-points", "1");
  });
});

async function oneFingerPan(
  page: Page,
  viewer: Locator,
  gesture: { from: { x: number; y: number }; to: { x: number; y: number } },
) {
  await viewer.evaluate((el, { from, to }) => {
    const touch = (point: { x: number; y: number }, id = 0) =>
      new Touch({
        identifier: id,
        target: el,
        clientX: point.x,
        clientY: point.y,
        pageX: point.x,
        pageY: point.y,
        screenX: point.x,
        screenY: point.y,
        radiusX: 1,
        radiusY: 1,
        rotationAngle: 0,
        force: 1,
      });
    const fire = (
      type: string,
      points: Array<{ x: number; y: number }>,
      changed: Array<{ x: number; y: number }>,
    ) => {
      const touches = points.map((p, i) => touch(p, i));
      const changedTouches = changed.map((p, i) => touch(p, i));
      el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches,
          targetTouches: touches,
          changedTouches,
        }),
      );
    };
    fire("touchstart", [from], [from]);
    fire("touchmove", [to], [to]);
    fire("touchend", [], [to]);
  }, gesture);
  await page.waitForTimeout(50);
}

async function twoFingerRotate(
  page: Page,
  viewer: Locator,
  opts: {
    center: { x: number; y: number };
    radius: number;
    fromDeg: number;
    toDeg: number;
  },
) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const pair = (deg: number) => {
    const a = rad(deg);
    const b = rad(deg + 180);
    return [
      {
        x: opts.center.x + opts.radius * Math.cos(a),
        y: opts.center.y + opts.radius * Math.sin(a),
      },
      {
        x: opts.center.x + opts.radius * Math.cos(b),
        y: opts.center.y + opts.radius * Math.sin(b),
      },
    ] as [{ x: number; y: number }, { x: number; y: number }];
  };
  const from = pair(opts.fromDeg);
  const to = pair(opts.toDeg);
  await viewer.evaluate(
    (el, { from, to }) => {
      const makeTouches = (points: Array<{ x: number; y: number }>) =>
        points.map(
          (point, identifier) =>
            new Touch({
              identifier,
              target: el,
              clientX: point.x,
              clientY: point.y,
              pageX: point.x,
              pageY: point.y,
              screenX: point.x,
              screenY: point.y,
              radiusX: 1,
              radiusY: 1,
              rotationAngle: 0,
              force: 1,
            }),
        );
      const dispatch = (
        type: string,
        points: Array<{ x: number; y: number }>,
      ) => {
        const touches = makeTouches(points);
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches,
            targetTouches: touches,
            changedTouches: touches,
          }),
        );
      };
      dispatch("touchstart", from);
      dispatch("touchmove", to);
      el.dispatchEvent(
        new TouchEvent("touchend", {
          bubbles: true,
          cancelable: true,
          touches: [],
          targetTouches: [],
          changedTouches: makeTouches(to),
        }),
      );
    },
    { from, to },
  );
  await page.waitForTimeout(50);
}
