import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";

test.beforeAll(reseed);

const WIDE = { width: 2400, height: 1200 };
const NARROW = { width: 1280, height: 800 };

async function gotoControls(page: Page) {
  await page.goto("/itest/controls");
  await expect(page.getByText("23 controls")).toBeVisible({ timeout: 15000 });
}

// Wait for the map pane to appear in its visible state. The shell mounts
// the pane lazily once a page first publishes map state via `<MapSlot>`,
// so we explicitly poll for the data-attribute rather than a fixed timeout.
async function waitForPaneVisible(page: Page) {
  const pane = page.getByTestId("map-pane");
  await expect(pane).toBeVisible({ timeout: 5000 });
  await expect(pane).toHaveAttribute("data-visible", "true");
}

// One-shot localStorage clear at the start of each test. We deliberately
// avoid `addInitScript` here because it re-runs on every navigation
// (including `page.reload()`), which would wipe the persisted pane state
// halfway through the persistence tests.
async function resetPaneStorage(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    try {
      window.localStorage.removeItem("oxygen.mapPane.collapsed");
      window.localStorage.removeItem("oxygen.mapPane.width");
      window.localStorage.removeItem("oxygen.mapPane.breakpoint");
    } catch {
      // localStorage may not be writable in some contexts
    }
  });
}

test.describe("Wide-screen map pane (>=2200px viewport)", () => {
  test.beforeEach(async ({ page }) => {
    await resetPaneStorage(page);
  });

  test("renders the persistent MapPanel inside the right pane on a wide viewport", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await gotoControls(page);

    await waitForPaneVisible(page);

    // The single shell-owned MapPanel should live inside the pane.
    const pane = page.getByTestId("map-pane");
    await expect(pane.getByTestId("map-panel")).toHaveCount(1);

    // The shell container should be laid out as a 2-column grid.
    const shell = page.getByTestId("shell-container");
    await expect(shell).toHaveAttribute("data-pane-visible", "true");
  });

  test("renders the map inline on a narrow viewport and does not mount the pane", async ({
    page,
  }) => {
    await page.setViewportSize(NARROW);
    await gotoControls(page);

    // The pane and its associated chrome should never appear.
    await expect(page.getByTestId("map-pane")).toHaveCount(0);
    await expect(page.getByTestId("show-map-pane")).toHaveCount(0);

    // The inline MapPanel (MapSlot's narrow fallback) should still be on the page.
    await expect(page.getByTestId("map-panel")).toHaveCount(1);

    // And the shell stays in single-column mode.
    const shell = page.getByTestId("shell-container");
    await expect(shell).toHaveAttribute("data-pane-visible", "false");
  });

  test("collapse + show-map round-trip and persists across reload", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await gotoControls(page);
    await waitForPaneVisible(page);

    // Collapse the pane.
    await page.getByTestId("map-pane-collapse").click();
    await expect(page.getByTestId("map-pane")).toHaveCount(0);
    await expect(page.getByTestId("show-map-pane")).toBeVisible();

    // Reload — the collapsed state should survive (localStorage persistence).
    await page.reload();
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("map-pane")).toHaveCount(0);
    await expect(page.getByTestId("show-map-pane")).toBeVisible();

    // Click the show-map button — the pane should come back.
    await page.getByTestId("show-map-pane").click();
    await waitForPaneVisible(page);
    await expect(page.getByTestId("show-map-pane")).toHaveCount(0);
  });

  test("dragging the resize handle changes pane width and persists it", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await gotoControls(page);
    await waitForPaneVisible(page);

    const handle = page.getByTestId("map-pane-resize-handle");
    await expect(handle).toBeVisible();

    const initialBox = await page.getByTestId("map-pane").boundingBox();
    expect(initialBox).not.toBeNull();
    const initialWidth = Math.round(initialBox!.width);

    // Drag the handle ~200px to the left → pane should grow.
    const handleBox = await handle.boundingBox();
    expect(handleBox).not.toBeNull();
    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 200, startY, { steps: 10 });
    await page.mouse.up();

    // Wait for the React state commit to settle.
    await page.waitForTimeout(150);
    const afterBox = await page.getByTestId("map-pane").boundingBox();
    const afterWidth = Math.round(afterBox!.width);
    expect(afterWidth).toBeGreaterThan(initialWidth + 100);

    // Pin down what we expect to be persisted: the localStorage value
    // should match the on-screen width within ~1px (rounding). If this
    // assertion fails, it tells us the drag handler did not commit;
    // if it passes but the post-reload assertion fails, the persistence
    // hook is at fault.
    const persistedNow = await page.evaluate(() =>
      Number(window.localStorage.getItem("oxygen.mapPane.width")),
    );
    expect(persistedNow).toBeGreaterThan(900);

    // Reload — width should persist.
    await page.reload();
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 15000 });
    await waitForPaneVisible(page);

    // Sanity: localStorage survived the reload.
    const lsAfterReload = await page.evaluate(() =>
      window.localStorage.getItem("oxygen.mapPane.width"),
    );
    expect(Number(lsAfterReload)).toBeGreaterThan(900);

    // Sanity: the CSS variable on the shell container reflects the
    // persisted value. If this assertion is wrong, the useEffect that
    // mirrors paneWidth into `--map-pane-width` failed to run.
    const cssVar = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="shell-container"]',
      ) as HTMLElement | null;
      return el?.style.getPropertyValue("--map-pane-width") ?? "";
    });
    expect(parseInt(cssVar, 10)).toBeGreaterThan(900);

    const persistedBox = await page.getByTestId("map-pane").boundingBox();
    expect(Math.round(persistedBox!.width)).toBe(afterWidth);
  });

  test("pane stays visible across Runners \u2192 StartList \u2192 Results \u2192 Cards \u2192 Tracks on wide viewport", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);

    // Each of these non-overflow tabs publishes map state on mount, so the
    // pane shouldn't flip on/off during navigation. We visit each in turn
    // and assert the pane stays data-visible=true the whole way. Tracks
    // is included to lock down the page-level MapSlot push that survives
    // regardless of row expansion (previously gated on an expanded row).
    for (const path of ["runners", "startlist", "results", "cards", "tracks"]) {
      await page.goto(`/itest/${path}`);
      await waitForPaneVisible(page);
      const pane = page.getByTestId("map-pane");
      // Exactly one MapPanel inside the pane at all times.
      await expect(pane.getByTestId("map-panel")).toHaveCount(1);
    }
  });

  test("persistent MapPanel keeps its instance across navigation", async ({
    page,
  }) => {
    // The shell-owned MapPanel is mounted once for the wide-pane's
    // lifetime. Switching routes only updates its props via the
    // map-props-store; the React fibre — and therefore `useId()` —
    // stays the same. If this assertion fails, MapPanel is remounting
    // per navigation and the perf win of this refactor is gone.
    //
    // Tracks is included in the path because it's the page that
    // historically only published map state from an expanded-row
    // subcomponent — visiting it with no row expanded used to clear
    // the store and unmount the persistent MapPanel.
    await page.setViewportSize(WIDE);

    async function paneInstanceId(): Promise<string | null> {
      return page
        .getByTestId("map-pane")
        .getByTestId("map-panel")
        .getAttribute("data-instance-id");
    }

    await page.goto("/itest/runners");
    await waitForPaneVisible(page);
    const initialId = await paneInstanceId();
    expect(initialId).toBeTruthy();

    for (const path of ["results", "tracks", "cards", "runners"]) {
      await page.goto(`/itest/${path}`);
      await waitForPaneVisible(page);
      const id = await paneInstanceId();
      expect(id, `MapPanel remounted when navigating to /${path}`).toBe(
        initialId,
      );
    }
  });

  test("class filter populates the empty-state course highlight on Results", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    // Empty state (no runner expanded) but with `class:"\xD6ppen 1"` — the
    // map should highlight that class's course via the default fallback.
    // The class name contains a space, so we quote the value (the
    // structured-search parser supports quoted values for this case).
    const q = encodeURIComponent('class:"Öppen 1"');
    await page.goto(`/itest/results?q=${q}`);
    await waitForPaneVisible(page);

    const panel = page.getByTestId("map-pane").getByTestId("map-panel");
    // We don't pin the exact course name to the seed (it depends on the
    // class-to-course mapping); we just assert the attribute is non-empty,
    // i.e. the page is driving a highlight from the class filter.
    await expect(panel).toHaveAttribute(
      "data-highlight-course",
      /.+/,
      { timeout: 5000 },
    );
  });

  test("expanding a runner on Results sets the map's course highlight", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    // Drive row expansion via the URL param the page already supports,
    // so we don't have to interact with the row DOM (seed rows shift).
    await page.goto("/itest/results?runner=1");
    await waitForPaneVisible(page);

    const panel = page.getByTestId("map-pane").getByTestId("map-panel");
    // Runner 1's course is resolved server-side; we don't pin the name,
    // just assert the highlight ends up populated.
    await expect(panel).toHaveAttribute(
      "data-highlight-course",
      /.+/,
      { timeout: 5000 },
    );
  });

  test("viewport resize toggles between portal and inline rendering", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE);
    await gotoControls(page);
    await waitForPaneVisible(page);

    // Shrink → pane chrome disappears, MapSlot's inline fallback renders
    // on the page instead.
    await page.setViewportSize(NARROW);
    await expect(page.getByTestId("map-pane")).toHaveCount(0);
    await expect(page.getByTestId("map-panel")).toHaveCount(1);

    // Grow back → pane reappears with its own MapPanel.
    await page.setViewportSize(WIDE);
    await waitForPaneVisible(page);
    await expect(
      page.getByTestId("map-pane").getByTestId("map-panel"),
    ).toHaveCount(1);
  });
});
