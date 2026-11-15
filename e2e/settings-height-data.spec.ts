import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { API_BASE } from "./helpers/api-base";

/**
 * Settings → Height data (docs/map-terrain.md §7.0b, §7.8): the admin tab
 * and its explanation, saving the Geotorget account (write-only: shown as
 * saved with the user name, never sent back), clearing it, a provider
 * switched on and the club map's DEM state with its retry, Test
 * connection. The stack runs with `MAP_DEM_OFFLINE=1`, so no request
 * leaves it: the map's job ends `failed: http`, the test ends in an error.
 *
 * Leaves the settings as it found them: the account cleared, providers and
 * resolution reset, the live-check record and the sealing key deleted, and
 * the club map it uploaded removed, so later specs see DEM fetch off.
 */

/** Obviously fake test values. */
const USER = "e2e-test-geotorget-user";
const PASSWORD = "e2e-test-password-not-real";
const HEADERS = { "content-type": "application/json", "x-forwarded-email": "e2e-admin@oxygen.test" };

async function trpc(path: string, input?: unknown, mutation = true): Promise<string> {
  const res = mutation
    ? await fetch(`${API_BASE}/trpc/${path}`, { method: "POST", headers: HEADERS, body: JSON.stringify(input ?? {}), signal: AbortSignal.timeout(20_000) })
    : await fetch(`${API_BASE}/trpc/${path}`, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  expect(res.ok, text).toBe(true);
  return text;
}

const E2E_DATABASE_URL = process.env.E2E_DATABASE_URL ?? `postgresql://oxygen:oxygen@localhost:5433/${process.env.E2E_DB_NAME ?? "oxygen_e2e"}?schema=oxygen`;

async function resetSettings(): Promise<void> {
  await trpc("demSettings.clearAccount");
  await trpc("demSettings.save", { providers: null, resolutionM: null });
  // the rows the tab has no control for: the last connection test and the sealing key
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  try {
    await db.query("DELETE FROM oxygen.settings WHERE key LIKE 'map\\_dem.%'");
  } finally {
    await db.end();
  }
}

let clubMapId: string | null = null;

async function openTerrainTab(page: Page): Promise<void> {
  await page.goto("/settings?tab=terrain");
  await expect(page.getByTestId("height-data-panel")).toBeVisible({ timeout: 15_000 });
}

test.describe("Settings → Height data", () => {
  test.beforeAll(resetSettings);
  test.afterAll(async () => {
    await resetSettings();
    if (clubMapId) await trpc("clubMap.remove", { id: clubMapId });
  });

  test("the tab, the account saved and cleared, a provider on, the map's state and retry", async ({ page }) => {
    test.setTimeout(120_000);

    // a georeferenced club map (SWEREF 99 TM) to list
    await page.goto("/settings");
    await expect(page.getByTestId("library-dropzone")).toBeVisible({ timeout: 15_000 });
    const cards = page.locator('[data-testid^="library-map-card-"]');
    const cardIds = async () => (await cards.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? ""))).filter(Boolean);
    const before = new Set(await cardIds());
    await page.getByTestId("library-map-upload").setInputFiles("e2e/test.ocd");
    await expect.poll(async () => (await cardIds()).filter((id) => !before.has(id)).length, { timeout: 30_000 }).toBe(1);
    const added = (await cardIds()).find((id) => !before.has(id)) ?? "";
    clubMapId = added.replace("library-map-card-", "");
    expect(clubMapId).toMatch(/^[0-9a-f-]{36}$/);
    await expect(page.getByTestId(added).getByTestId("library-map-name")).toBeVisible({ timeout: 30_000 });

    // the admin tab beside Eventor, with its explanation
    const tabs = page.getByTestId("library-tabs").locator("button");
    const names = await tabs.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(names.indexOf("library-tab-terrain")).toBe(names.indexOf("library-tab-eventor") + 1);
    await page.getByTestId("library-tab-terrain").click();
    await expect(page).toHaveURL(/[?&]tab=terrain/);
    const explanation = page.getByTestId("height-data-explanation");
    await expect(explanation).toContainText("Markhöjdmodell Nedladdning");
    await expect(explanation).toContainText("© Lantmäteriet");
    await expect(explanation).toContainText("Copernicus GLO-30");
    await expect(page.getByTestId("height-data-geotorget-link")).toHaveAttribute("href", /^https:\/\/geotorget\.lantmateriet\.se\//);

    // nothing saved, nothing in the stack's environment: off
    await expect(page.getByTestId("height-data-provider-lantmateriet")).not.toBeChecked();
    await expect(page.getByTestId("height-data-provider-glo30")).not.toBeChecked();
    await expect(page.getByTestId("height-data-providers-origin")).toHaveText("Default");
    await expect(page.getByTestId("height-data-account-status")).toHaveText("No account");
    const row = page.getByTestId(`height-data-map-${clubMapId}`);
    await expect(row).toHaveAttribute("data-state", "disabled");
    await expect(row.getByTestId("height-data-map-retry")).toHaveCount(0);

    // save the account: shown as saved with the user name, the password never comes back
    await page.getByTestId("height-data-account-user").fill(USER);
    await page.getByTestId("height-data-account-password").fill(PASSWORD);
    await page.getByTestId("height-data-account-save").click();
    await expect(page.getByTestId("height-data-account-status")).toHaveText(`Saved: ${USER}`);
    await expect(page.getByTestId("height-data-account-saved-at")).toContainText("e2e-admin");
    await expect(page.getByTestId("height-data-account-password")).toHaveCount(0);
    expect(await trpc("demSettings.get", undefined, false)).not.toContain(PASSWORD);
    expect(await trpc("demSettings.maps", undefined, false)).not.toContain(PASSWORD);

    await page.reload();
    await expect(page.getByTestId("height-data-account-status")).toHaveText(`Saved: ${USER}`);
    await page.getByTestId("height-data-account-change").click();
    await expect(page.getByTestId("height-data-account-password")).toHaveValue("");
    await expect(page.getByTestId("height-data-account-user")).toHaveValue("");
    expect(await page.content()).not.toContain(PASSWORD);

    // GLO-30 on, saved here over the (empty) environment
    await page.getByTestId("height-data-provider-glo30").click();
    await expect(page.getByTestId("height-data-providers-origin")).toHaveText("Saved here");
    await expect(page.getByTestId("height-data-provider-glo30")).toBeChecked();

    // the map has not been fetched: fetch now, which fails offline and offers a retry
    await expect(row).toHaveAttribute("data-state", "pending");
    await row.getByTestId("height-data-map-retry").click();
    await expect(row).toHaveAttribute("data-state", "failed", { timeout: 30_000 });
    await expect(row).toContainText("the download failed");
    await expect(row).toContainText("glo30-30m");
    await expect(row.getByTestId("height-data-map-retry")).toHaveText("Retry");
    await row.getByTestId("height-data-map-retry").click();
    await expect(row).toHaveAttribute("data-state", "failed", { timeout: 30_000 });

    // Test connection on the map: offline, it ends in an error that is stored and shown
    await page.getByTestId("height-data-test-map").selectOption(clubMapId);
    await page.getByTestId("height-data-test-run").click();
    const result = page.getByTestId("height-data-test-result");
    await expect(result).toHaveAttribute("data-state", "error", { timeout: 60_000 });
    await expect(result).toContainText("MAP_DEM_OFFLINE");
    await page.reload();
    await expect(page.getByTestId("height-data-test-result")).toHaveAttribute("data-state", "error");
    expect(await page.content()).not.toContain(PASSWORD);

    // clear the account; reset the providers to the deploy's default: off again
    await page.getByTestId("height-data-account-clear").click();
    await expect(page.getByTestId("height-data-account-status")).toHaveText("No account");
    await expect(page.getByTestId("height-data-account-password")).toBeVisible();
    await page.getByTestId("height-data-providers-reset").click();
    await expect(page.getByTestId("height-data-providers-origin")).toHaveText("Default");
    await expect(page.getByTestId("height-data-provider-glo30")).not.toBeChecked();
    await expect(row).toHaveAttribute("data-state", "disabled");
  });

  test("Lantmäteriet on without an account stays off and says so; the resolution saves and resets", async ({ page }) => {
    await openTerrainTab(page);
    await page.getByTestId("height-data-provider-lantmateriet").click();
    await expect(page.getByTestId("height-data-provider-lantmateriet")).toBeChecked();
    await expect(page.getByTestId("height-data-lm-needs-account")).toBeVisible();
    await page.getByTestId("height-data-resolution-1").click();
    await expect(page.getByTestId("height-data-resolution-1")).toBeChecked();
    await expect(page.getByTestId("height-data-resolution-origin")).toHaveText("Saved here");
    await page.getByTestId("height-data-resolution-reset").click();
    await expect(page.getByTestId("height-data-resolution-origin")).toHaveText("Default");
    await expect(page.getByTestId("height-data-resolution-2")).toBeChecked();
    await page.getByTestId("height-data-providers-reset").click();
    await expect(page.getByTestId("height-data-lm-needs-account")).toHaveCount(0);
  });

  test("Swedish explanation", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("oxygen-lang", "sv"));
    await openTerrainTab(page);
    await expect(page.getByTestId("library-tab-terrain")).toHaveText("Höjddata");
    await expect(page.getByTestId("height-data-explanation")).toContainText("Markhöjdmodell Nedladdning");
    await expect(page.getByTestId("height-data-explanation")).toContainText("Skapa en användare på Lantmäteriets Geotorget");
  });
});
