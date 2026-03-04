import { test, expect, type Page } from "@playwright/test";

// ─── Helpers ───────────────────────────────────────────────

const COMPETITION_NAME = "My example tävling";

async function selectCompetition(page: Page) {
    await page.goto("/");
    await page.getByText(COMPETITION_NAME).click();
    await expect(page.getByRole("button", { name: "Dashboard" })).toBeVisible({
        timeout: 10000,
    });
}

/** Get the competition nameId from the current URL */
function getNameId(page: Page): string {
    const url = new URL(page.url());
    const parts = url.pathname.split("/").filter(Boolean);
    return parts[0] || "";
}

/** Navigate directly to the start screen page */
async function goToStartScreen(page: Page) {
    await selectCompetition(page);
    const nameId = getNameId(page);
    await page.goto(`/${nameId}/start-screen`);
    // Wait for the clock to be visible
    await expect(page.getByText("Call-up")).toBeVisible({
        timeout: 10000,
    });
}

// ─── Tests ─────────────────────────────────────────────────

test.describe("Start Screen", () => {
    test("should display competition name and call-up clock", async ({ page }) => {
        await goToStartScreen(page);
        await expect(page.getByText(COMPETITION_NAME)).toBeVisible();
        await expect(page.getByText("Call-up")).toBeVisible();

        // Check the advance clock via test-id
        const clock = page.getByTestId("advance-clock");
        await expect(clock).toBeVisible();
        await expect(clock).toHaveText(/\d{2}:\d{2}:\d{2}/);
    });

    test("should have settings panel with offset options", async ({ page }) => {
        await goToStartScreen(page);

        // Initial offset button (shows "⚙ 3m")
        const settingsBtn = page.getByText(/⚙ \d+m/);
        await expect(settingsBtn).toBeVisible();
        await settingsBtn.click();

        // Settings panel content
        await expect(page.getByText("Call-up offset")).toBeVisible();
        await expect(page.getByText("1m")).toBeVisible();
        await expect(page.getByText("5m")).toBeVisible();

        // Change offset
        await page.getByText("5m").click();
        await expect(settingsBtn).toContainText("5m");
    });

    test("should have fullscreen toggle button", async ({ page }) => {
        await goToStartScreen(page);
        const fullscreenBtn = page.getByText("⛶");
        await expect(fullscreenBtn).toBeVisible();
    });

    test("should show runners layout or no-runners message", async ({ page }) => {
        await goToStartScreen(page);

        // Check for the "upcoming" section container via test-id
        await expect(page.getByTestId("upcoming-section")).toBeVisible();

        // Since seed data is old, we expect either a list or the "No runners" message
        const noRunnersMsg = page.getByText(/No runners starting at/);
        const hasNoRunners = await noRunnersMsg.count() > 0;

        if (hasNoRunners) {
            await expect(noRunnersMsg).toBeVisible();
        }
    });

    test("launcher button should be present in competition header", async ({ page }) => {
        await selectCompetition(page);
        const launcher = page.getByTestId("start-screen-launcher");
        await expect(launcher).toBeVisible();
        await expect(launcher).toContainText("Start");
    });
});
