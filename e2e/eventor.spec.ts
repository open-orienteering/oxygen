import { test, expect } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";

/** Clear the stored Eventor API key via tRPC so tests start fresh. */
async function clearEventorKey(page: import("@playwright/test").Page) {
  await page.request.post("/trpc/eventor.clearKey", {
    headers: { "x-competition-id": "itest" },
    data: {},
  });
}

test.describe("Competition Selector — New Features", () => {
  test("should create a new empty competition and navigate to it", async ({
    page,
  }) => {
    const uniqueName = `E2E Test ${Date.now()}`;

    await page.goto("/");
    await expect(
      page.getByRole("button", { name: /New Event/ }),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByRole("button", { name: /Import from Eventor/ }),
    ).toBeVisible();

    await page.getByRole("button", { name: /New Event/ }).click();
    await expect(
      page.getByRole("heading", { name: "New Event" }),
    ).toBeVisible({ timeout: 3000 });

    await page.getByPlaceholder(/Klubbmästerskap/).fill(uniqueName);

    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(uniqueName)).toBeVisible();

    // Verify it appears in competition list
    await page.goto("/");
    await expect(page.getByText(uniqueName).first()).toBeVisible({
      timeout: 10000,
    });

    // Clean up
    const dbName = uniqueName.replace(/[^a-zA-Z0-9]/g, "_");
    await fetch(`${API_BASE}/trpc/competition.delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nameId: dbName }),
    });
  });

  test("import panel without a key points admins at Settings → Eventor", async ({
    page,
  }) => {
    // The key form itself moved off the selector: it is now an admin-only
    // Settings tab. The import panel only says where to go.
    await clearEventorKey(page);
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: /Import from Eventor/ }),
    ).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: /Import from Eventor/ }).click();
    await expect(
      page.getByRole("heading", { name: "Import from Eventor" }),
    ).toBeVisible({ timeout: 3000 });

    await expect(page.getByTestId("eventor-import-no-key")).toBeVisible();
    await expect(page.getByPlaceholder(/API key/)).toHaveCount(0);
    await expect(page.getByText("1. API Key")).toHaveCount(0);

    await page.getByTestId("eventor-import-settings-link").click();
    await expect(page).toHaveURL(/\/settings\?tab=eventor/);
    await expect(page.getByTestId("eventor-keys-panel")).toBeVisible();
  });

  test("admin stores the key under Settings → Eventor and the import panel lists events", async ({
    page,
  }) => {
    // Served by e2e/eventor-stub.mjs, so this needs neither a real key
    // nor a reachable Eventor.
    await clearEventorKey(page);
    await page.goto("/settings?tab=eventor");
    const prod = page.getByTestId("eventor-key-card-prod");
    await expect(prod).toBeVisible({ timeout: 10000 });
    await expect(prod.getByTestId("eventor-key-status-prod")).toHaveText(
      /No key configured/,
    );
    // The test-environment card is independent and starts empty too.
    await expect(
      page.getByTestId("eventor-key-card-test").getByTestId("eventor-key-status-test"),
    ).toHaveText(/No key configured/);

    await prod
      .getByTestId("eventor-key-input-prod")
      .fill("df34af90a0c64ca4abfe9492be057e9c");
    await prod.getByTestId("eventor-key-connect-prod").click();
    await expect(prod.getByTestId("eventor-key-status-prod")).toHaveText(
      /Connected: E2E Test Club/,
      { timeout: 15000 },
    );
    await expect(prod.getByTestId("eventor-key-clear-prod")).toBeVisible();
    await expect(prod.getByTestId("eventor-key-input-prod")).toHaveCount(0);

    // Back on the selector the import panel goes straight to the list.
    // Assert against the stub's organisation and event names rather than
    // just the surrounding chrome, so this fails if the event list stops
    // reaching the UI.
    await page.goto("/");
    await page.getByRole("button", { name: /Import from Eventor/ }).click();
    await expect(page.getByText(/Connected:/)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(/E2E Test Club/)).toBeVisible();
    await expect(page.getByTestId("eventor-import-no-key")).toHaveCount(0);
    await expect(page.getByTestId("eventor-manage-keys-link")).toBeVisible();
    await expect(page.getByPlaceholder("Search events...")).toBeVisible();
    await expect(page.getByText("E2E Stub Sprint")).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.locator("button", { hasText: "Import" }).first(),
    ).toBeVisible();

    // Removing the key flips the status back and empties the import panel.
    await page.goto("/settings?tab=eventor");
    await page.getByTestId("eventor-key-clear-prod").click();
    await expect(page.getByTestId("eventor-key-status-prod")).toHaveText(
      /No key configured/,
      { timeout: 10000 },
    );
    await page.goto("/");
    await page.getByRole("button", { name: /Import from Eventor/ }).click();
    await expect(page.getByTestId("eventor-import-no-key")).toBeVisible({
      timeout: 10000,
    });
  });

  test("Eventor tab is hidden from members and its mutations are refused", async ({
    browser,
    page,
  }) => {
    // Invite a plain member, then look at Settings as them: no Eventor tab,
    // deep link falls back to Base maps, and the API refuses the mutation.
    const email = `eventor-member-${Date.now()}@oxygen.test`;
    await clearEventorKey(page);
    await page.goto("/settings?tab=users");
    await expect(page.getByTestId("users-admin-panel")).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId("invite-email").fill(email);
    await page.getByTestId("invite-submit").click();
    await expect(page.getByText(email)).toBeVisible({ timeout: 10000 });

    const member = await browser.newContext({
      extraHTTPHeaders: { "x-forwarded-email": email },
    });
    try {
      const memberPage = await member.newPage();
      await memberPage.goto("/settings?tab=eventor");
      await expect(memberPage.getByTestId("library-tab-maps")).toBeVisible({
        timeout: 15000,
      });
      await expect(memberPage.getByTestId("library-tab-eventor")).toHaveCount(0);
      await expect(memberPage.getByTestId("eventor-keys-panel")).toHaveCount(0);
      await expect(memberPage.getByTestId("library-dropzone")).toBeVisible();

      const refused = await memberPage.request.post("/trpc/eventor.clearKey", {
        data: { env: "test" },
      });
      expect(refused.status()).toBe(403);

      // The import panel tells a member to ask an admin, without a link.
      await memberPage.goto("/");
      await memberPage.getByRole("button", { name: /Import from Eventor/ }).click();
      await expect(memberPage.getByTestId("eventor-import-no-key")).toBeVisible({
        timeout: 10000,
      });
      await expect(memberPage.getByText(/Ask an instance admin/)).toBeVisible();
      await expect(
        memberPage.getByTestId("eventor-import-settings-link"),
      ).toHaveCount(0);
    } finally {
      await member.close();
    }
  });

  test("should show delete confirmation dialog and allow cancel", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText("My example tävling").first()).toBeVisible({ timeout: 10000 });

    const entry = page.locator("li").filter({ hasText: "My example tävling" }).first();
    await entry.hover();
    const deleteBtn = entry.getByTestId("event-delete");
    await expect(deleteBtn).toBeVisible();
    await deleteBtn.click();

    const dialog = page.getByTestId("delete-event-dialog");
    await expect(dialog).toBeVisible();
    // Deleting is a soft delete: the copy must not promise permanence.
    await expect(dialog).toContainText("disappears from the list");
    await expect(dialog).toContainText("Settings → Maintenance");

    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).not.toBeVisible();
  });

  test("should delete a test competition via the dialog", async ({ page }) => {
    const uniqueName = `Delete Test ${Date.now()}`;
    await page.goto("/");
    await page.getByRole("button", { name: "New Event" }).click();
    await expect(
      page.getByPlaceholder("e.g. Klubbmästerskap 2026"),
    ).toBeVisible({ timeout: 5000 });
    await page.getByPlaceholder("e.g. Klubbmästerskap 2026").fill(uniqueName);
    await page.locator("input[type='date']").fill("2026-03-01");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("Dashboard")).toBeVisible({ timeout: 10000 });

    await page.goto("/");
    await expect(page.getByText(uniqueName)).toBeVisible({ timeout: 10000 });

    const entry = page.locator("li").filter({ hasText: uniqueName }).first();
    await entry.getByTestId("event-delete").click({ force: true });
    const dialog = page.getByTestId("delete-event-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("delete-event-confirm").click();

    await expect(dialog).not.toBeVisible({ timeout: 10000 });
    await expect(
      page.locator("li").filter({ hasText: uniqueName }),
    ).toHaveCount(0, { timeout: 10000 });
  });

  // Clubs are no longer first-class per-event entities after the Phase I
  // refactor — they're derived from runners + the global club_directory.
  // Per-event create/edit/delete don't exist anymore (the router stubs
  // throw PRECONDITION_FAILED). The UI keeps these buttons disabled.
  test.skip("should create and delete a club", async ({ page }) => {
    await page.goto("/");
    await page.getByText("My example tävling").first().click();
    await expect(page.getByText("Dashboard")).toBeVisible({ timeout: 5000 });

    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name: "Clubs" }).click();
    await expect(page.getByText(/\d+ clubs/)).toBeVisible();

    // Show all clubs so we can see newly created empty ones
    await page.getByRole("button", { name: "Show all clubs" }).click();
    await expect(page.getByText("Showing all clubs")).toBeVisible();

    const uniqueClub = `Test Club ${Date.now()}`;
    await page.getByRole("button", { name: "New Club" }).click();
    await page.getByPlaceholder("e.g. OK Ansen").fill(uniqueClub);
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(uniqueClub)).toBeVisible({ timeout: 15000 });

    page.on("dialog", (dialog) => dialog.accept());
    const clubRow = page.locator("tbody tr").filter({ hasText: uniqueClub }).first();
    await clubRow.locator("button[title='Remove club']").click({ force: true });
    await expect(page.getByText(uniqueClub)).not.toBeVisible({ timeout: 10000 });
  });
});
