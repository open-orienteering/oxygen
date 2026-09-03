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
    await expect(page.getByText("No events match the current search.")).toBeVisible();
    await page.getByTestId("clear-event-filters").click();
    await expect(page.getByText("My example tävling").first()).toBeVisible();
  });

  test("event row keeps the slug and owner on one line", async ({ page }) => {
    // Owner attribution comes from the creator's grant, so the row has to
    // be one we made ourselves — the seed events have no owning user.
    const uniqueName = `E2E Row Layout ${Date.now()}`;
    await page.goto("/");
    await page.getByRole("button", { name: /New Event/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(uniqueName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    await page.goto("/");
    const row = page.locator("li", { hasText: uniqueName }).first();
    await expect(row).toBeVisible({ timeout: 10000 });

    const owner = row.getByTestId("event-owner");
    await expect(owner).toBeVisible();
    const slug = row.locator("span.font-mono").first();
    const slugBox = (await slug.boundingBox())!;
    const ownerBox = (await owner.boundingBox())!;

    // Same line: their vertical centres coincide within a pixel or two.
    const slugMid = slugBox.y + slugBox.height / 2;
    const ownerMid = ownerBox.y + ownerBox.height / 2;
    expect(Math.abs(slugMid - ownerMid)).toBeLessThan(4);
    // Owner is pushed to the right rather than jammed against the slug.
    expect(ownerBox.x).toBeGreaterThan(slugBox.x + slugBox.width);
  });

  test("create form has no advanced MySQL fields and can open an event", async ({
    page,
  }) => {
    const uniqueName = `E2E Selector ${Date.now()}`;

    await page.goto("/");
    await expect(page.getByRole("button", { name: /New Event/ })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: /New Event/ }).click();
    await expect(page.getByRole("heading", { name: "New Event" })).toBeVisible();
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
