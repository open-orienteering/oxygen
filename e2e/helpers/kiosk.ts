import { expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Budget for a freshly opened kiosk tab to reach its idle screen.
 *
 * The suite runs against the Vite dev server, so a new tab fetches and
 * evaluates the unbundled app (~230 modules: app shell, shared package,
 * all locale files) before the lazily loaded kiosk route can render.
 * Measured under a four-shard full run: 1.3–6 s, with peaks above 10 s
 * when other work shares the machine. The tab is cold even when the
 * admin tab in the same context has loaded the same modules, because
 * Vite serves source modules `no-cache`.
 */
export const KIOSK_TAB_READY_TIMEOUT = 20_000;

/**
 * Open the kiosk for `nameId` in a new tab of `context` (sharing its
 * BroadcastChannel with an admin tab) and wait until it shows the idle
 * "insert card" screen.
 */
export async function openKioskTab(
  context: BrowserContext,
  nameId: string,
): Promise<Page> {
  const kioskPage = await context.newPage();
  await kioskPage.goto(`/${nameId}/kiosk`);
  await expect(kioskPage.getByText("Insert your SI card")).toBeVisible({
    timeout: KIOSK_TAB_READY_TIMEOUT,
  });
  return kioskPage;
}
