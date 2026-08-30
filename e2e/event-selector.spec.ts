import { test, expect } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";

test.describe("Event selector", () => {
  test("groups seed events under Past and filters by search", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("My example tävling").first()).toBeVisible({
      timeout: 10000,
    });

    await expect(page.getByTestId("event-group-past")).toBeVisible();
    await expect(page.getByTestId("event-group-past").getByText("My example tävling")).toBeVisible();
    await expect(page.getByTestId("event-type-filter")).toHaveCount(0);

    await page.getByTestId("event-search").fill("example");
    await expect(page.getByText("My example tävling").first()).toBeVisible();
    await expect(page.getByText("itest_multirace")).toHaveCount(0);

    await page.getByTestId("event-search").fill("zzzz-no-such-event");
    await expect(page.getByText("No competitions match the current search.")).toBeVisible();
    await page.getByTestId("clear-event-filters").click();
    await expect(page.getByText("My example tävling").first()).toBeVisible();
  });

  test("create form has no advanced MySQL fields and can open an event", async ({
    page,
  }) => {
    const uniqueName = `E2E Selector ${Date.now()}`;

    await page.goto("/");
    await expect(page.getByRole("button", { name: /New Competition/ })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: /New Competition/ }).click();
    await expect(page.getByRole("heading", { name: "New Competition" })).toBeVisible();
    await expect(page.getByText("Show advanced options")).toHaveCount(0);
    await expect(page.getByTestId("event-advanced-toggle")).toHaveCount(0);

    await page.getByPlaceholder(/Klubbmästerskap/).fill(uniqueName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(uniqueName)).toBeVisible();

    await page.goto("/");
    await expect(page.getByText(uniqueName).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("event-group-upcoming").getByText(uniqueName)).toBeVisible();

    const dbName = uniqueName.replace(/[^a-zA-Z0-9]/g, "_");
    await fetch(`${API_BASE}/trpc/competition.delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nameId: dbName }),
    });
  });
});
