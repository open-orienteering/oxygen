import { test, expect } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";
import { reseed } from "./helpers/reseed";

test.beforeAll(reseed);

async function goToRunners(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 15000,
  });
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("link", { name: "Runners", exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name: "Runners", exact: true }).click();
  }
  await expect(page.locator("span", { hasText: "runners" })).toBeVisible({
    timeout: 15000,
  });
}

test.describe("Runners Bulk Editing", () => {
  test("selects multiple runners and updates status via bulk action", async ({ page }) => {
    await goToRunners(page);
    page.on("dialog", (dialog) => dialog.accept());

    const rows = page.locator("tr").filter({ has: page.locator('input[type="checkbox"]') });
    await rows.nth(1).locator('input[type="checkbox"]').click();
    await rows.nth(2).locator('input[type="checkbox"]').click();

    const actionBar = page.locator(".animate-slide-up");
    await expect(actionBar).toBeVisible();
    await expect(actionBar.locator("div", { hasText: "2" }).first()).toBeVisible();
    await expect(actionBar.getByText("selected", { exact: true })).toBeVisible();

    await actionBar.locator("select").nth(1).selectOption({ label: "DNS -- Did Not Start" });
    await actionBar.getByRole("button", { name: "Apply to 2" }).click();

    await expect(actionBar).not.toBeVisible();
    await expect(page.locator("span", { hasText: "Did Not Start" }).first()).toBeVisible();
  });

  test("bulk Set club writes the club name with its Eventor id (WEB-10)", async ({ page, request }) => {
    const headers = { "x-competition-id": "itest" };
    const list = async () =>
      ((await (await request.get(`${API_BASE}/trpc/runner.list`, { headers })).json())?.result?.data ?? []) as Array<{
        id: number;
        name: string;
        clubName: string;
        clubId: number;
      }>;
    const before = await list();
    // The club with the most runners, so it is in the picker whatever the
    // earlier test set to DNS.
    const counts = new Map<number, number>();
    for (const r of before) if (r.clubId > 0 && r.clubName) counts.set(r.clubId, (counts.get(r.clubId) ?? 0) + 1);
    const topId = [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
    const target = before.find((r) => r.clubId === topId)!;
    expect(target).toBeTruthy();

    await goToRunners(page);
    page.on("dialog", (dialog) => dialog.accept());
    const rows = page.locator("tr").filter({ has: page.locator('input[type="checkbox"]') });
    // The first two runners whose club differs from the target club.
    const names: string[] = [];
    for (let i = 1; names.length < 2 && i < 30; i++) {
      const row = rows.nth(i);
      const text = (await row.innerText()).trim();
      const r = before.find((x) => text.includes(x.name));
      if (!r || r.clubId === target.clubId) continue;
      await row.locator('input[type="checkbox"]').click();
      names.push(r.name);
    }
    expect(names).toHaveLength(2);

    const actionBar = page.locator(".animate-slide-up");
    await actionBar.locator("select").nth(0).selectOption("club");
    await actionBar.locator("select").nth(1).selectOption({ label: target.clubName });
    await actionBar.getByRole("button", { name: "Apply to 2" }).click();
    await expect(actionBar).not.toBeVisible();

    await expect(async () => {
      const after = await list();
      for (const n of names) {
        const r = after.find((x) => x.name === n)!;
        expect(r.clubName).toBe(target.clubName);
        expect(r.clubId).toBe(target.clubId);
      }
    }).toPass({ timeout: 10000 });
  });
});
