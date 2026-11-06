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

  test("compact header, map footer gating, the editor on a phone", async ({ page }) => {
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
    // The editor on a phone; its chrome and gestures are field-mode.spec.ts's
    // and the touch describe of course-editor.spec.ts.
    await expect(page.getByTestId("editor-page")).toHaveAttribute("data-layout", "phone", { timeout: 15000 });
  });

  test("the controls toolbar fits a phone", async ({ page }) => {
    test.setTimeout(120_000);
    // The course editor's phone chrome is field-mode.spec.ts "opens in Field
    // mode … compact chrome"; Layout mode, where a template's *Edit layout*
    // opens, is not on the phone (docs/course-editor.md §10).
    await page.goto("/");
    await page.getByText("My example tävling").click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    // Map was uploaded in the first serial test.
    await expect(page.getByTestId("map-viewer").first()).toBeVisible({ timeout: 60000 });

    // ── Controls page: the AIR+ / station-mode row wraps instead of
    // pushing the page wider than the screen.
    await clickTab(page, "Controls");
    await expect(page.getByTestId("controls-toolbar")).toBeVisible({ timeout: 15000 });
    const controlsToolbar = (await page.getByTestId("controls-toolbar").boundingBox())!;
    expect(controlsToolbar.x + controlsToolbar.width).toBeLessThanOrEqual(390);
    await expect(page.getByRole("button", { name: "Program Controls" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Read Controls" })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  });

  test("switching events resets the viewport and draws each event's map", async ({ page }) => {
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
    await expectCurrentEventBase(secondViewer);
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
    await expectCurrentEventBase(firstViewer);
    await expect
      .poll(async () => Number(await firstViewer.getAttribute("data-zoom")))
      .not.toBe(changedZoom);

    await page.goto("/");
    await page.getByText(uniqueName).click();
    const returnedViewer = page.getByTestId("map-viewer").first();
    await expect(returnedViewer).toBeVisible({ timeout: 60_000 });
    await expectCurrentEventBase(returnedViewer);
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

/** The event's base map is drawn: the vector layer's first view. */
async function expectCurrentEventBase(viewer: Locator) {
  await expect(viewer.getByTestId("map-vector-layer")).toHaveAttribute("data-ready", "true", {
    timeout: 30_000,
  });
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
