import { test, expect } from "@playwright/test";

test.describe("Event selector", () => {
  test("groups seed events under Past and filters by search", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("My example tävling").first()).toBeVisible({
      timeout: 10000,
    });

    await expect(page.getByTestId("event-group-past")).toBeVisible();
    await expect(page.getByTestId("event-group-past").getByText("My example tävling")).toBeVisible();
    await expect(page.getByTestId("event-type-filter")).toBeVisible();

    await page.getByTestId("event-search").fill("example");
    await expect(page.getByText("My example tävling").first()).toBeVisible();
    await expect(page.getByText("itest_multirace")).toHaveCount(0);

    await page.getByTestId("event-search").fill("zzzz-no-such-event");
    await expect(page.getByText("No events match the current search.")).toBeVisible();
    await page.getByTestId("clear-event-filters").click();
    await expect(page.getByText("My example tävling").first()).toBeVisible();
  });

  test("event row keeps event type and creator visible on mobile", async ({ page }) => {
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
    await page.setViewportSize({ width: 390, height: 844 });
    const row = page.locator("li", { hasText: uniqueName }).first();
    await expect(row).toBeVisible({ timeout: 10000 });

    const owner = row.getByTestId("event-owner");
    await expect(owner).toBeVisible();
    const eventType = row.getByTestId("event-type");
    await expect(eventType).toHaveText("Competition");
    await expect(row.getByText(/E2E_Row_Layout/)).toHaveCount(0);
    const typeBox = (await eventType.boundingBox())!;
    const ownerBox = (await owner.boundingBox())!;

    // Same line: their vertical centres coincide within a pixel or two.
    const slugMid = typeBox.y + typeBox.height / 2;
    const ownerMid = ownerBox.y + ownerBox.height / 2;
    expect(Math.abs(slugMid - ownerMid)).toBeLessThan(4);
    // Creator is pushed to the right rather than jammed against the type.
    expect(ownerBox.x).toBeGreaterThan(typeBox.x + typeBox.width);
  });

  test("manifest provides authenticated install metadata and PNG icons", async ({ page, request }) => {
    await page.goto("/");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "crossorigin",
      "use-credentials",
    );
    const manifestResponse = await request.get("/manifest.webmanifest");
    expect(manifestResponse.ok()).toBeTruthy();
    const manifest = await manifestResponse.json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.scope).toBe("/");
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/pwa-192.png", sizes: "192x192" }),
        expect.objectContaining({ src: "/pwa-512.png", sizes: "512x512" }),
      ]),
    );
    await expect((await request.get("/pwa-192.png")).ok()).toBeTruthy();
    await expect((await request.get("/pwa-512.png")).ok()).toBeTruthy();
  });

  test("create form has no advanced MySQL fields and can open an event", async ({
    page,
  }) => {
    const uniqueName = `E2E Selector ${Date.now()}`;
    const dbName = uniqueName.replace(/[^a-zA-Z0-9]/g, "_");

    await page.goto("/");
    await expect(page.getByRole("button", { name: /New Event/ })).toBeVisible({
      timeout: 10000,
    });
    await page.getByRole("button", { name: /New Event/ }).click();
    await expect(page.getByRole("heading", { name: "New Event" })).toBeVisible();
    await expect(page.getByText("Show advanced options")).toHaveCount(0);
    await expect(page.getByTestId("event-advanced-toggle")).toHaveCount(0);

    await page.getByPlaceholder(/Klubbmästerskap/).fill(uniqueName);
    await page.getByTestId("new-event-type").selectOption("club_training");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(uniqueName)).toBeVisible();

    await page.goto("/");
    await expect(page.getByText(uniqueName).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("event-group-upcoming").getByText(uniqueName)).toBeVisible();
    await expect(
      page.locator("li", { hasText: uniqueName }).getByTestId("event-type"),
    ).toHaveText("Club training");

    await page.goto(`/${dbName}/event`);
    await expect(page.getByTestId("event-type-editor")).toBeVisible();
    await page.getByTestId("event-type-select").selectOption("weekly_course");
    await page.getByTestId("event-type-save").click();
    await expect(page.getByText("Event type saved.")).toBeVisible();

    await page.goto("/");
    await page.getByTestId("event-type-filter").selectOption("weekly_course");
    await expect(page.getByText(uniqueName).first()).toBeVisible();
    await expect(
      page.locator("li", { hasText: uniqueName }).getByTestId("event-type"),
    ).toHaveText("Weekly course");

    const createdRow = page.locator("li", { hasText: uniqueName });
    await createdRow.getByTestId("event-delete").click();
    await page.getByTestId("delete-event-confirm").click();
    await expect(createdRow).toHaveCount(0);
  });
});
