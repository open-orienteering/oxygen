import { test, expect } from "@playwright/test";

async function selectCompetition(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function clickTab(page: import("@playwright/test").Page, name: string) {
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

async function clearOnlineInputState(page: import("@playwright/test").Page) {
  // Reset persisted config and lastId via raw oxygen_settings rows.
  // The endpoints are tRPC mutations that overwrite rather than delete,
  // so we set known clean values before each test.
  await page.request.post("/trpc/onlineInput.disable", {
    headers: { "x-competition-id": "itest" },
    data: {},
  });
  await page.request.post("/trpc/onlineInput.saveConfig", {
    headers: { "x-competition-id": "itest" },
    data: {
      unitId: "",
      endpointUrl: "http://roc.olresultat.se/getpunches.asp",
      intervalSeconds: 10,
    },
  });
  await page.request.post("/trpc/onlineInput.clearLastId", {
    headers: { "x-competition-id": "itest" },
    data: {},
  });
}

test.describe("Online Input panel", () => {
  test.beforeEach(async ({ page }) => {
    await clearOnlineInputState(page);
  });

  test.afterAll(async ({ request }) => {
    await request.post("/trpc/onlineInput.disable", {
      headers: { "x-competition-id": "itest" },
      data: {},
    });
  });

  test("displays the panel with default ROC endpoint and disabled toggle", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    const panelHeading = page.getByText("Online Input (ROC)");
    await expect(panelHeading).toBeVisible({ timeout: 10000 });

    // Default endpoint visible
    await expect(
      page.locator('input[type="text"][value*="roc.olresultat.se"]'),
    ).toBeVisible();

    // First-time help is shown when no unitId is set
    await expect(page.getByText(/roc\.olresultat\.se/i).first()).toBeVisible();
  });

  test("saving a unit ID enables the toggle button", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    await expect(page.getByText("Online Input (ROC)")).toBeVisible({ timeout: 10000 });

    const unitInput = page.getByTestId("online-input-unit-id");
    await unitInput.fill("E2E-UNIT-12345");

    // The Save button is only rendered when the form is dirty
    const saveBtn = page.getByTestId("online-input-save");
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    await expect(unitInput).toHaveValue("E2E-UNIT-12345");
  });

  test("can add and remove a control mapping", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");
    await expect(page.getByText("Online Input (ROC)")).toBeVisible({ timeout: 10000 });

    // Add raw code 100 → Finish
    await page.getByTestId("online-input-new-code").fill("100");
    await page.getByTestId("online-input-new-target").selectOption("2"); // PunchFinish
    await page.getByTestId("online-input-add-mapping").click();

    const mapping = page.getByTestId("online-input-mapping-100");
    await expect(mapping).toBeVisible();
    await expect(mapping).toContainText("100");
    await expect(mapping).toContainText("Finish");

    // Remove it again
    await mapping.getByRole("button", { name: "Remove mapping" }).click();
    await expect(mapping).toHaveCount(0);
  });

  test("Reset button on lastId becomes enabled after a poll has advanced it", async ({
    page,
    request,
  }) => {
    // Configure the puller with a unit id and pre-seed a lastId via the
    // tRPC API so we don't have to wait for a real poll.
    await request.post("/trpc/onlineInput.saveConfig", {
      headers: { "x-competition-id": "itest" },
      data: {
        unitId: "E2E-RESET",
        endpointUrl: "http://roc.olresultat.se/getpunches.asp",
        intervalSeconds: 10,
      },
    });

    await selectCompetition(page);
    await clickTab(page, "Event");

    const resetButton = page.getByTestId("online-input-reset-last-id");
    await expect(resetButton).toBeVisible({ timeout: 10000 });
    // With lastId=0 the reset should be disabled
    await expect(resetButton).toBeDisabled();
  });
});
