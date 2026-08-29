import { test, expect } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";

async function trpcMutate<T>(
  page: import("@playwright/test").Page,
  procedure: string,
  nameId: string,
  data: Record<string, unknown>,
): Promise<T> {
  const res = await page.request.post(`/trpc/${procedure}`, {
    headers: { "x-competition-id": nameId },
    data,
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as {
    result?: { data?: T | { json?: T } };
  };
  const payload = body.result?.data;
  if (payload && typeof payload === "object" && "json" in payload && payload.json) {
    return payload.json;
  }
  return payload as T;
}

test.describe("Progressive shell menus", () => {
  test("fresh event shows a planning bar; entries promote runners", async ({ page }) => {
    const uniqueName = `E2E Progressive ${Date.now()}`;

    await page.goto("/");
    await page.getByRole("button", { name: /New Competition/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(uniqueName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });

    const nameId = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
    const tabNav = page.locator("nav[aria-label='Tabs']");

    await expect(tabNav.getByRole("link", { name: "Course Editor" })).toBeVisible({
      timeout: 15000,
    });
    await expect(tabNav.getByRole("link", { name: "Classes" })).toBeVisible();
    await expect(tabNav.getByRole("link", { name: "Courses" })).toBeVisible();
    await expect(tabNav.getByRole("link", { name: "Controls" })).toBeVisible();
    await expect(tabNav.getByRole("link", { name: "Runners", exact: true })).toHaveCount(0);
    await expect(tabNav.getByRole("link", { name: "Start List" })).toHaveCount(0);

    await page.getByTestId("more-menu-button").click();
    await expect(page.getByTestId("progressive-hint")).toBeVisible();
    await expect(
      page.getByTestId("more-menu-content").getByRole("link", { name: "Runners", exact: true }),
    ).toBeVisible();
    await page.locator("div.fixed.inset-0.z-20").click({ position: { x: 1, y: 1 } });

    const cls = await trpcMutate<{ id: number }>(page, "class.create", nameId, { name: "H21" });
    await trpcMutate(page, "course.create", nameId, { name: "Bana 1" });
    await trpcMutate(page, "runner.create", nameId, {
      name: "Test Runner",
      classId: cls.id,
      cardNo: 94001,
    });

    await page.reload();
    await expect(tabNav.getByRole("link", { name: "Runners", exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(tabNav.getByRole("link", { name: "Start List" })).toBeVisible();
    await expect(tabNav.getByRole("link", { name: "Course Editor" })).toHaveCount(0);

    await fetch(`${API_BASE}/trpc/competition.delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nameId }),
    });
  });

  test("seeded itest shows the full race bar with course editor in More", async ({ page }) => {
    await page.goto("/");
    await page.getByText("My example tävling").click();
    const tabNav = page.locator("nav[aria-label='Tabs']");
    await expect(tabNav.getByRole("link", { name: "Runners", exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(tabNav.getByRole("link", { name: "Results" })).toBeVisible();
    await expect(tabNav.getByRole("link", { name: "Tracks" })).toBeVisible();
    await expect(tabNav.getByRole("link", { name: "Course Editor" })).toHaveCount(0);

    await page.getByTestId("more-menu-button").click();
    await expect(
      page.getByTestId("more-menu-content").getByRole("link", { name: "Course Editor" }),
    ).toBeVisible();
  });
});
