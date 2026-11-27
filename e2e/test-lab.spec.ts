/**
 * Test Lab is for test events only (API-06): a normal event has no Test Lab
 * entry and refuses the page and the procedures; marking the event as a test
 * event in its settings switches the tab on; an event with card readouts
 * cannot be marked.
 */
import { test, expect, type Page } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";
import { reseed } from "./helpers/reseed";

const SLUG = `e2e_test_lab_${Date.now().toString(36)}`;

test.beforeAll(async ({ request }) => {
  await reseed();
  const created = await request.post(`${API_BASE}/trpc/event.create`, {
    data: { name: "E2E Test Lab", nameId: SLUG, date: "2026-06-01" },
  });
  expect(created.ok()).toBeTruthy();
});

test.afterAll(async ({ request }) => {
  await request.post(`${API_BASE}/trpc/event.delete`, { data: { nameId: SLUG } });
  await reseed();
});

async function openMore(page: Page) {
  await page.getByTestId("more-menu-button").click();
  return page.getByTestId("more-menu-content");
}

test("a normal event has no Test Lab entry, and its direct URL shows the notice", async ({ page }) => {
  await page.goto(`/${SLUG}`);
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
  const more = await openMore(page);
  await expect(more.getByRole("link", { name: "Event", exact: true })).toBeVisible();
  await expect(more.getByRole("link", { name: "Test Lab", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("test-event-badge")).toHaveCount(0);

  await page.goto(`/${SLUG}/test-lab`);
  const notice = page.getByTestId("test-lab-not-test-event");
  await expect(notice).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("button", { name: "Generate classes" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start simulation" })).toHaveCount(0);
  await notice.getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/${SLUG}/event$`));
});

test("marking the event as a test event shows the tab, and the Test Lab works", async ({ page }) => {
  await page.goto(`/${SLUG}/event`);
  const toggle = page.getByTestId("test-event-switch");
  await expect(toggle).toBeVisible({ timeout: 10000 });
  await expect(toggle).not.toBeChecked();
  page.once("dialog", (d) => d.accept());
  await toggle.click();
  await expect(toggle).toBeChecked({ timeout: 10000 });
  await expect(page.getByTestId("test-event-badge")).toBeVisible();

  const more = await openMore(page);
  await more.getByRole("link", { name: "Test Lab", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/${SLUG}/test-lab$`));

  await page.getByRole("button", { name: "Generate classes" }).click();
  await expect(page.getByText("Classes: 5")).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Register fictional runners" }).click();
  await expect(page.getByText("Runners: 50")).toBeVisible({ timeout: 15000 });

  // Taking the mark off hides the tab again.
  await page.goto(`/${SLUG}/event`);
  page.once("dialog", (d) => d.accept());
  await page.getByTestId("test-event-switch").click();
  await expect(page.getByTestId("test-event-switch")).not.toBeChecked({ timeout: 10000 });
  await page.goto(`/${SLUG}`);
  const again = await openMore(page);
  await expect(again.getByRole("link", { name: "Test Lab", exact: true })).toHaveCount(0);
});

test("the switch is refused on a seeded event with card readouts", async ({ page, request }) => {
  const res = await request.post(`${API_BASE}/trpc/event.setTestEvent`, {
    headers: { "x-competition-id": "itest" },
    data: { enabled: true },
  });
  expect(res.status()).toBe(412);

  await page.goto("/itest/event");
  const toggle = page.getByTestId("test-event-switch");
  await expect(toggle).toBeVisible({ timeout: 10000 });
  page.once("dialog", (d) => d.accept());
  await toggle.click();
  await expect(page.getByTestId("test-event-error")).toBeVisible({ timeout: 10000 });
  await expect(toggle).not.toBeChecked();
});
