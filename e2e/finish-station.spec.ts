/**
 * Finish Station: a runner who already has a finish needs a second, explicit
 * step to replace it (WEB-53), and a double Enter records one finish (SI-10).
 */
import { test, expect, type Page } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";
import { reseed } from "./helpers/reseed";

const COMP_HEADERS = { "x-competition-id": "itest" };
const CARD = 9_900_123;

test.beforeAll(async () => {
  await reseed();
});
test.afterAll(async () => {
  await reseed();
});

async function recordFinishCalls(page: Page): Promise<() => number> {
  let n = 0;
  page.on("request", (r) => {
    if (r.url().includes("race.recordFinish")) n++;
  });
  return () => n;
}

test("an existing finish is replaced only by the explicit button", async ({ page, request }) => {
  const classes = await (await request.get(`${API_BASE}/trpc/class.list`, { headers: COMP_HEADERS })).json();
  const classId = (classes?.result?.data ?? classes?.result?.data?.json)[0].id as number;
  const created = await request.post(`${API_BASE}/trpc/runner.create`, {
    headers: COMP_HEADERS,
    data: { name: "Finish Guard Runner", cardNo: CARD, classId, startTime: 360_000 },
  });
  expect(created.ok()).toBeTruthy();

  const calls = await recordFinishCalls(page);
  await page.goto("/itest/finish-station");
  const cardInput = page.locator('input[type="number"]').first();
  await cardInput.fill(String(CARD));
  await expect(page.getByText("Finish Guard Runner")).toBeVisible({ timeout: 10000 });

  // First finish: a double Enter sends one request.
  await cardInput.press("Enter");
  await cardInput.press("Enter");
  await expect(async () => expect(calls()).toBe(1)).toPass({ timeout: 10000 });

  // The runner now has a finish: plain Enter is ignored, the button replaces.
  await cardInput.fill("");
  await cardInput.fill(String(CARD));
  const button = page.getByTestId("record-finish");
  await expect(button).toContainText(/Replace finish|Ersätt måltid/, { timeout: 10000 });
  await cardInput.press("Enter");
  await page.waitForTimeout(500);
  expect(calls()).toBe(1);

  await button.click();
  await expect(async () => expect(calls()).toBe(2)).toPass({ timeout: 10000 });
});
