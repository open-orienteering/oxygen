/**
 * Mobile layout and touch gesture regressions.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";
import { uploadEventMap } from "./helpers/map-upload";

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test.describe.serial("mobile layout", () => {
  test.beforeAll(async () => {
    await reseed();
  });

  test("compact header, map footer gating, editor dismiss", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    const kiosk = page.getByTestId("kiosk-launcher");
    await expect(kiosk).toBeVisible();
    // Icon-only below sm — label span is in the DOM but not visible.
    await expect(kiosk.getByText("Kiosk", { exact: true })).toBeHidden();
    await expect(page.getByTestId("event-header-link")).toBeVisible();
    await expect(page.getByTestId("event-header-link")).toContainText("My example tävling");
    await expect(page.getByTestId("db-status-button")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("header").getByTestId("user-chip")).toBeHidden();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);

    await page.getByTestId("more-menu-button").click();
    await expect(page.getByTestId("more-menu-content").getByTestId("user-chip")).toBeVisible();
    await page.locator("div.fixed.inset-0.z-20").click({ position: { x: 1, y: 1 } });

    await page.getByTestId("sync-status-button").click();
    await expect(page.getByTestId("sync-status-panel")).toBeVisible();
    const syncPanelZ = await page.getByTestId("sync-status-panel").evaluate(
      (el) => Number(getComputedStyle(el).zIndex),
    );
    expect(syncPanelZ).toBeGreaterThan(0);
    await page.locator("div.fixed.inset-0.z-20").click({ position: { x: 1, y: 1 } });

    const mapPanel = page.getByTestId("map-panel").first();
    await expect(mapPanel.getByRole("button", { name: "Replace map" })).toHaveCount(0);

    await uploadEventMap(page);
    const viewer = page.getByTestId("map-viewer").first();
    await expect(viewer).toBeVisible({ timeout: 60000 });
    const touchAction = await viewer.evaluate((el) => getComputedStyle(el).touchAction);
    expect(touchAction).toBe("pan-y");

    const beforeGesture = {
      lat: Number(await viewer.getAttribute("data-center-lat")),
      lng: Number(await viewer.getAttribute("data-center-lng")),
      zoom: Number(await viewer.getAttribute("data-zoom")),
    };
    const gestureBox = await viewer.boundingBox();
    if (!gestureBox) throw new Error("map viewer has no box");
    await twoFingerGesture(page, viewer, {
      from: [
        { x: gestureBox.x + 120, y: gestureBox.y + 300 },
        { x: gestureBox.x + 220, y: gestureBox.y + 300 },
      ],
      to: [
        { x: gestureBox.x + 150, y: gestureBox.y + 330 },
        { x: gestureBox.x + 280, y: gestureBox.y + 330 },
      ],
    });
    await expect
      .poll(async () => Number(await viewer.getAttribute("data-zoom")))
      .toBeGreaterThan(beforeGesture.zoom);
    const afterLat = Number(await viewer.getAttribute("data-center-lat"));
    const afterLng = Number(await viewer.getAttribute("data-center-lng"));
    expect(
      Math.abs(afterLat - beforeGesture.lat) +
        Math.abs(afterLng - beforeGesture.lng),
    ).toBeGreaterThan(0);

    const viewerBox = await viewer.boundingBox();
    expect(viewerBox).not.toBeNull();
    if (viewerBox) {
      // Inline map should use most of the viewport (min(..., 100dvh - 8rem)).
      expect(viewerBox.height).toBeGreaterThan(500);
    }

    await clickTab(page, "Course Editor");
    await expect(page.getByTestId("course-editor-page")).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByTestId("map-panel").getByRole("button", { name: "Replace map" }),
    ).toBeVisible();

    await clickEmptySpot(page);
    await expect(page.getByTestId("editor-phantom")).toBeAttached({ timeout: 10000 });
    await page.getByTestId("editor-dismiss").click();
    await expect(page.getByTestId("editor-phantom")).toHaveCount(0);
  });

  test("editor control tap-select and touch drag", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    // Map was uploaded in the prior serial test.
    await expect(page.getByTestId("map-viewer").first()).toBeVisible({ timeout: 60000 });

    await clickTab(page, "Course Editor");
    await expect(page.getByTestId("course-editor-page")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60000 });
    await expect(page.getByRole("button", { name: "Descriptions" })).toBeVisible();

    // itest controls are unpositioned — place one on the map first.
    await clickEmptySpot(page);
    await page.getByTestId("editor-action-add-start").click();
    const startHit = page.locator(
      '[data-testid="editor-control-hit"][data-control-code="Start 1"]',
    );
    await expect(startHit).toBeAttached({ timeout: 15000 });

    const box = await startHit.boundingBox();
    if (!box) throw new Error("control hit has no box");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const viewer = page.getByTestId("map-viewer");
    const beforeSelection = {
      lat: await viewer.getAttribute("data-center-lat"),
      lng: await viewer.getAttribute("data-center-lng"),
      zoom: await viewer.getAttribute("data-zoom"),
    };
    await page.touchscreen.tap(cx, cy);
    await expect(page.getByTestId("editor-context-menu")).toBeVisible({ timeout: 10000 });
    // Opening the editor menu can alter surrounding layout; it must never
    // trigger MapViewer's resize-to-fit path and yank the working viewport.
    await page.waitForTimeout(350);
    await expect(viewer).toHaveAttribute("data-center-lat", beforeSelection.lat!);
    await expect(viewer).toHaveAttribute("data-center-lng", beforeSelection.lng!);
    await expect(viewer).toHaveAttribute("data-zoom", beforeSelection.zoom!);

    await page.getByTestId("map-panel").getByTitle("Fullscreen").first().click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    const fullscreenZoom = Number(await viewer.getAttribute("data-zoom"));
    await viewer.getByTitle("Zoom in").tap();
    await expect
      .poll(async () => Number(await viewer.getAttribute("data-zoom")))
      .toBeGreaterThan(fullscreenZoom);
    await viewer.getByTitle("Measure distance").tap();
    await expect(viewer.getByTitle("Measure distance")).toHaveClass(/bg-blue-500/);
    await viewer.getByTitle("Measure distance").tap();
    await page.getByTestId("editor-dismiss").tap();
    await expect(page.getByTestId("editor-context-menu")).toHaveCount(0);
    await viewer.getByTitle("Exit fullscreen").tap();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);

    const refreshedBox = await startHit.boundingBox();
    if (!refreshedBox) throw new Error("control hit has no box after fullscreen");
    const refreshedCx = refreshedBox.x + refreshedBox.width / 2;
    const refreshedCy = refreshedBox.y + refreshedBox.height / 2;
    await twoFingerGesture(page, startHit, {
      from: [
        { x: refreshedCx - 25, y: refreshedCy },
        { x: refreshedCx + 25, y: refreshedCy },
      ],
      to: [
        { x: refreshedCx - 40, y: refreshedCy + 20 },
        { x: refreshedCx + 40, y: refreshedCy + 20 },
      ],
    });
    await page.waitForTimeout(450);
    await expect(page.getByTestId("editor-context-menu")).toHaveCount(0);

    const beforeDragBox = await startHit.boundingBox();
    if (!beforeDragBox) throw new Error("control hit has no box before drag");
    const dragStartX = beforeDragBox.x + beforeDragBox.width / 2;
    const dragStartY = beforeDragBox.y + beforeDragBox.height / 2;
    const dragDx = 40;
    await page.evaluate(
      ({ x, y, dx }) => {
        const el = document.elementFromPoint(x, y);
        if (!el) throw new Error("no element at control center");
        const target = el.closest("[data-testid='editor-control-hit']") ?? el;
        const dispatch = (type: string, clientX: number, clientY: number) => {
          const touch = new Touch({
            identifier: 1,
            target,
            clientX,
            clientY,
            pageX: clientX,
            pageY: clientY,
            screenX: clientX,
            screenY: clientY,
            radiusX: 1,
            radiusY: 1,
            rotationAngle: 0,
            force: 1,
          });
          target.dispatchEvent(
            new TouchEvent(type, {
              bubbles: true,
              cancelable: true,
              touches: type === "touchend" ? [] : [touch],
              targetTouches: type === "touchend" ? [] : [touch],
              changedTouches: [touch],
            }),
          );
        };
        dispatch("touchstart", x, y);
        dispatch("touchmove", x + dx / 2, y);
        dispatch("touchmove", x + dx, y);
        dispatch("touchend", x + dx, y);
      },
      { x: dragStartX, y: dragStartY, dx: dragDx },
    );

    const movedBox = await startHit.boundingBox();
    expect(movedBox).not.toBeNull();
    if (movedBox) {
      expect(Math.abs(movedBox.x - beforeDragBox.x)).toBeGreaterThan(10);
    }
  });

  test("switching events resets viewport and tile state", async ({ page }) => {
    test.setTimeout(120_000);
    const uniqueName = `E2E Mobile Map Switch ${Date.now()}`;

    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(uniqueName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15_000,
    });
    const secondNameId = new URL(page.url()).pathname.split("/")[1];

    await uploadEventMap(page);
    const secondViewer = page.getByTestId("map-viewer").first();
    await expect(secondViewer).toBeVisible({ timeout: 60_000 });
    await expectCurrentEventTile(secondViewer, secondNameId);
    const initialZoom = Number(await secondViewer.getAttribute("data-zoom"));
    await secondViewer.getByTitle("Zoom in").click();
    await secondViewer.getByTitle("Zoom in").click();
    await expect
      .poll(async () => Number(await secondViewer.getAttribute("data-zoom")))
      .toBeGreaterThan(initialZoom + 0.5);
    const changedZoom = Number(await secondViewer.getAttribute("data-zoom"));

    await page.goto("/");
    await page.getByText("My example tävling").click();
    const firstViewer = page.getByTestId("map-viewer").first();
    await expect(firstViewer).toBeVisible({ timeout: 60_000 });
    await expectCurrentEventTile(firstViewer, "itest");
    await expect
      .poll(async () => Number(await firstViewer.getAttribute("data-zoom")))
      .not.toBe(changedZoom);

    await page.goto("/");
    await page.getByText(uniqueName).click();
    const returnedViewer = page.getByTestId("map-viewer").first();
    await expect(returnedViewer).toBeVisible({ timeout: 60_000 });
    await expectCurrentEventTile(returnedViewer, secondNameId);
    await expect
      .poll(async () => Number(await returnedViewer.getAttribute("data-zoom")))
      .toBe(initialZoom);
  });

  test("locate button follows GPS and disengages on pan", async ({ page }) => {
    test.setTimeout(120_000);
    const mockLat = 59.3293;
    const mockLng = 18.0686;

    // Playwright's setGeolocation does not reliably re-fire watchPosition.
    // Drive a controllable mock so follow-mode updates are deterministic.
    await page.addInitScript(
      ({ lat, lng }) => {
        type Listener = (pos: GeolocationPosition) => void;
        const listeners = new Map<number, Listener>();
        let nextId = 1;
        let current = { lat, lng, accuracy: 12 };
        const emit = () => {
          const pos = {
            coords: {
              latitude: current.lat,
              longitude: current.lng,
              accuracy: current.accuracy,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
            },
            timestamp: Date.now(),
          } as GeolocationPosition;
          for (const cb of listeners.values()) cb(pos);
        };
        (
          window as unknown as {
            __setMockGeo: (nextLat: number, nextLng: number) => void;
          }
        ).__setMockGeo = (nextLat, nextLng) => {
          current = { lat: nextLat, lng: nextLng, accuracy: 12 };
          emit();
        };
        navigator.geolocation.watchPosition = ((success: Listener) => {
          const id = nextId++;
          listeners.set(id, success);
          success({
            coords: {
              latitude: current.lat,
              longitude: current.lng,
              accuracy: current.accuracy,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
            },
            timestamp: Date.now(),
          } as GeolocationPosition);
          return id;
        }) as typeof navigator.geolocation.watchPosition;
        navigator.geolocation.clearWatch = ((id: number) => {
          listeners.delete(id);
        }) as typeof navigator.geolocation.clearWatch;
        navigator.geolocation.getCurrentPosition = ((success: Listener) => {
          success({
            coords: {
              latitude: current.lat,
              longitude: current.lng,
              accuracy: current.accuracy,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null,
            },
            timestamp: Date.now(),
          } as GeolocationPosition);
        }) as typeof navigator.geolocation.getCurrentPosition;
      },
      { lat: mockLat, lng: mockLng },
    );

    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15_000,
    });

    const viewer = page.getByTestId("map-viewer").first();
    await expect(viewer).toBeVisible({ timeout: 60_000 });
    // Map may already be present from earlier serial tests; upload if not.
    if ((await viewer.getAttribute("data-center-lat")) == null) {
      await uploadEventMap(page);
      await expect(viewer).toBeVisible({ timeout: 60_000 });
    }

    const locate = viewer.getByTestId("locate-button");
    await expect(locate).toBeVisible();
    await locate.click();
    await expect(viewer.getByTestId("my-location-marker")).toBeVisible({
      timeout: 10_000,
    });
    await expect
      .poll(async () => Number(await viewer.getAttribute("data-center-lat")), {
        timeout: 10_000,
      })
      .toBeCloseTo(mockLat, 3);
    await expect
      .poll(async () => Number(await viewer.getAttribute("data-center-lng")))
      .toBeCloseTo(mockLng, 3);
    await expect(locate).toHaveAttribute("aria-pressed", "true");

    const followLat = 59.34;
    const followLng = 18.08;
    await page.evaluate(
      ([lat, lng]) =>
        (
          window as unknown as {
            __setMockGeo: (a: number, b: number) => void;
          }
        ).__setMockGeo(lat, lng),
      [followLat, followLng] as [number, number],
    );
    await expect
      .poll(async () => Number(await viewer.getAttribute("data-center-lat")), {
        timeout: 10_000,
      })
      .toBeCloseTo(followLat, 3);

    const box = await viewer.boundingBox();
    if (!box) throw new Error("map viewer has no box");
    await twoFingerGesture(page, viewer, {
      from: [
        { x: box.x + 120, y: box.y + 280 },
        { x: box.x + 220, y: box.y + 280 },
      ],
      to: [
        { x: box.x + 160, y: box.y + 320 },
        { x: box.x + 260, y: box.y + 320 },
      ],
    });
    // Follow disengages: further GPS updates must not re-center.
    const afterPanLat = Number(await viewer.getAttribute("data-center-lat"));
    await page.evaluate(
      ([lat, lng]) =>
        (
          window as unknown as {
            __setMockGeo: (a: number, b: number) => void;
          }
        ).__setMockGeo(lat, lng),
      [59.35, 18.09] as [number, number],
    );
    await page.waitForTimeout(800);
    expect(Number(await viewer.getAttribute("data-center-lat"))).toBeCloseTo(
      afterPanLat,
      5,
    );
    await expect(viewer.getByTestId("my-location-marker")).toBeVisible();
  });
});

async function expectCurrentEventTile(viewer: Locator, nameId: string) {
  const tiles = viewer.locator(`img[src*="/api/map-tile/${nameId}/"]`);
  await expect(tiles.first()).toBeAttached({ timeout: 30_000 });
  await expect
    .poll(() => tiles.evaluateAll(
      (images: HTMLImageElement[]) => images.some((img) => img.naturalWidth > 0),
    ), {
      timeout: 30_000,
    })
    .toBe(true);
}

async function twoFingerGesture(
  page: Page,
  viewer: Locator,
  gesture: {
    from: [{ x: number; y: number }, { x: number; y: number }];
    to: [{ x: number; y: number }, { x: number; y: number }];
  },
) {
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
    gesture,
  );
  await page.waitForTimeout(50);
}

async function clickTab(page: Page, name: string) {
  const mainTab = page
    .locator("nav[aria-label='Tabs']")
    .getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page
      .getByTestId("more-menu-content")
      .getByRole("link", { name, exact: true })
      .click();
  }
}

async function clickEmptySpot(page: Page) {
  const viewer = page.getByTestId("map-viewer");
  await expect(viewer).toBeVisible({ timeout: 20000 });
  const box = await viewer.boundingBox();
  if (!box) throw new Error("map viewer has no box");
  const obstacles: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const testId of ["editor-map-course-selector", "editor-inventory-panel"]) {
    const overlay = page.getByTestId(testId);
    const card = (await overlay.isVisible()) ? await overlay.boundingBox() : null;
    if (card) obstacles.push({ x: card.x, y: card.y, w: card.width, h: card.height });
  }
  const hits = page.getByTestId("editor-control-hit");
  const n = await hits.count();
  for (let i = 0; i < n; i++) {
    const b = await hits.nth(i).boundingBox();
    if (b) obstacles.push({ x: b.x, y: b.y, w: b.width, h: b.height });
  }

  let spot: { x: number; y: number } | null = null;
  for (let gy = 4; gy <= 16 && !spot; gy++) {
    for (let gx = 4; gx <= 16 && !spot; gx++) {
      const x = box.x + (box.width * gx) / 20;
      const y = box.y + (box.height * gy) / 20;
      const near = obstacles.some(
        (h) =>
          x >= h.x - 12 && x <= h.x + h.w + 12 && y >= h.y - 12 && y <= h.y + h.h + 12,
      );
      if (!near) spot = { x, y };
    }
  }
  if (!spot) throw new Error("no empty map point found");
  await page.touchscreen.tap(spot.x, spot.y);
  await expect(page.getByTestId("editor-phantom")).toBeAttached({
    timeout: 10000,
  });
}
