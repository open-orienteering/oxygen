import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Wait until the map panel has stopped remounting.
 *
 * At narrow viewports `MapSlot` renders `<MapPanel>` inline, so it sits at
 * a different position in the tree on every page and React remounts it on
 * navigation. The hidden `<input type="file">` is recreated with it. A file
 * delivered while that node is being replaced lands on the detached input,
 * React never sees the change event, and the upload is dropped with no
 * request and no error — the drop zone just sits there.
 *
 * A person cannot click "Upload map" within a few milliseconds of a route
 * change, but Playwright can, so specs have to wait for the panel to
 * settle. `data-instance-id` is a `useId()` that changes on every mount,
 * which makes "several consecutive reads agree" a real quiescence signal
 * rather than a disguised sleep.
 */
export async function waitForStableMapPanel(page: Page): Promise<Locator> {
  const panel = page.getByTestId("map-panel").first();
  await expect(panel).toBeVisible();

  const seen: (string | null)[] = [];
  await expect
    .poll(
      async () => {
        seen.push(await panel.getAttribute("data-instance-id"));
        if (seen.length > 3) seen.shift();
        return (
          seen.length === 3 &&
          seen[0] !== null &&
          seen.every((id) => id === seen[0])
        );
      },
      {
        message: "map panel kept remounting",
        timeout: 20_000,
        intervals: [100],
      },
    )
    .toBe(true);

  return panel;
}

/**
 * Upload an OCAD file as the event map through the map panel, once the
 * panel is stable. Returns after the file has been handed to the browser;
 * callers still assert on the resulting UI.
 */
export async function uploadEventMap(
  page: Page,
  file = "e2e/test.ocd",
): Promise<void> {
  const panel = await waitForStableMapPanel(page);
  const chooserPromise = page.waitForEvent("filechooser");
  await panel.getByRole("button", { name: "Upload map" }).click();
  await (await chooserPromise).setFiles(file);
}
