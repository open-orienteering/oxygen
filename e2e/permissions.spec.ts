import { test, expect, type Browser, type Page } from "@playwright/test";

async function inviteUser(page: Page, email: string) {
  await page.goto("/admin/users");
  await expect(page.getByTestId("users-admin-page")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("invite-email").fill(email);
  await page.getByTestId("invite-submit").click();
  await expect(page.getByText(email)).toBeVisible({ timeout: 10000 });
}

async function grantRole(page: Page, email: string, roleName: string) {
  await expect(page.getByTestId("permissions-panel")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("grant-role").locator("option", { hasText: roleName })).toHaveCount(1, {
    timeout: 15000,
  });
  await page.getByTestId("grant-subject-user").click();
  await page.getByTestId("grant-email").fill(email);
  await page.getByTestId("grant-role").selectOption({ label: roleName });
  await page.getByTestId("grant-submit").click();
  await expect(page.getByTestId(`revoke-${email}`)).toBeVisible({ timeout: 10000 });
}

test.describe("event permissions", () => {
  const stamp = Date.now();
  const setterEmail = `setter-${stamp}@oxygen.test`;
  const memberEmail = `member-${stamp}@oxygen.test`;
  const eventName = `E2E Perm ${stamp}`;
  let nameId = "";
  let kioskHref = "";

  test.beforeAll(async ({ browser }: { browser: Browser }) => {
    const page = await browser.newPage();
    await inviteUser(page, setterEmail);
    await inviteUser(page, memberEmail);

    await page.goto("/");
    await page.getByRole("button", { name: /New Competition/ }).click();
    await page.getByPlaceholder(/Klubbmästerskap/).fill(eventName);
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    nameId = new URL(page.url()).pathname.split("/").filter(Boolean)[0];

    await page.goto(`/${nameId}/event`);
    await grantRole(page, setterEmail, "Course setter");
    await grantRole(page, memberEmail, "Member");

    await page.goto("/itest/event");
    await grantRole(page, setterEmail, "Course setter");
    await expect(page.getByTestId("permissions-panel")).toBeVisible({ timeout: 15000 });
    await page.getByTestId("regenerate-kiosk-key").click();
    await expect(page.getByTestId("kiosk-url")).toBeVisible({ timeout: 10000 });
    kioskHref = (await page.getByTestId("kiosk-url").innerText()).trim();
    await page.close();
  });

  test("member pre-race cannot open courses; classes stay available", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { "x-forwarded-email": memberEmail },
    });
    const page = await ctx.newPage();
    await page.goto(`/${nameId}`);
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    const tabNav = page.locator("nav[aria-label='Tabs']");
    await expect(tabNav.getByRole("link", { name: "Classes" })).toBeVisible();
    await expect(tabNav.getByRole("link", { name: "Courses" })).toHaveCount(0);
    await expect(tabNav.getByRole("link", { name: "Course Editor" })).toHaveCount(0);
    await expect(tabNav.getByRole("link", { name: "Controls" })).toHaveCount(0);

    await page.goto(`/${nameId}/courses`);
    await expect(page.getByTestId("forbidden-pane")).toBeVisible({ timeout: 15000 });
    await ctx.close();
  });

  test("course setter can open the course editor", async ({ browser }) => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { "x-forwarded-email": setterEmail },
    });
    const page = await ctx.newPage();
    await page.goto("/itest/course-editor");
    await expect(page.getByTestId("course-editor-page")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId("course-editor-toolbar")).toBeVisible();
    await ctx.close();
  });

  test("member sees courses on a completed event", async ({ browser }) => {
    const ctx = await browser.newContext({
      extraHTTPHeaders: { "x-forwarded-email": memberEmail },
    });
    const page = await ctx.newPage();
    await page.goto("/itest");
    await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.locator("nav[aria-label='Tabs']").getByRole("link", { name: "Courses" }),
    ).toBeVisible();
    await ctx.close();
  });

  test("kiosk without a key shows an error; with ?k= it idles", async ({
    browser,
  }) => {
    const anon = await browser.newContext({
      extraHTTPHeaders: { "x-forwarded-email": "" },
    });
    const denied = await anon.newPage();
    await denied.goto("/itest/kiosk");
    await expect(denied.getByTestId("kiosk-key-required")).toBeVisible({
      timeout: 15000,
    });
    await denied.close();

    const path = new URL(kioskHref).pathname + new URL(kioskHref).search;
    const kiosk = await anon.newPage();
    await kiosk.goto(path);
    await expect(kiosk.getByText("Insert your SI card")).toBeVisible({
      timeout: 15000,
    });
    await anon.close();
  });

  test("selector shows a manager badge on events the admin can manage", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByText(eventName)).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("event-manager-badge").first()).toBeVisible();
  });

  test("club group can invite and add an unknown email inline", async ({ page }) => {
    const email = `inline-group-${stamp}@oxygen.test`;
    const groupName = `E2E Inline ${stamp}`;

    await page.goto("/library");
    await page.getByTestId("library-tab-groups").click();
    await page.getByTestId("group-create-name").fill(groupName);
    await page.getByTestId("group-create-submit").click();
    await page.getByTestId(`group-expand-${groupName}`).click();
    await expect(page.getByText(/Members must be invited users/)).toBeVisible();

    await page.getByTestId("group-member-email").fill(email);
    await page.getByTestId("group-member-add").click();
    const inviteAndAdd = page.getByTestId("group-invite-and-add");
    await expect(inviteAndAdd).toBeVisible({ timeout: 10000 });
    await inviteAndAdd.click();
    await expect(page.getByTestId(`group-member-remove-${email}`)).toBeVisible({
      timeout: 10000,
    });
  });

  test("club group: define in library, grant a role, member gets access", async ({
    page,
    browser,
  }) => {
    const groupUserEmail = `grouped-${stamp}@oxygen.test`;
    const groupName = `E2E Crew ${stamp}`;
    await inviteUser(page, groupUserEmail);

    // Define the group in the club library and add the member.
    await page.goto("/library");
    await page.getByTestId("library-tab-groups").click();
    await expect(page.getByTestId("group-create-form")).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId("group-create-name").fill(groupName);
    await page.getByTestId("group-create-submit").click();
    await expect(page.getByTestId(`group-card-${groupName}`)).toBeVisible({
      timeout: 10000,
    });
    await page.getByTestId(`group-expand-${groupName}`).click();
    await page.getByTestId("group-member-email").fill(groupUserEmail);
    await page.getByTestId("group-member-add").click();
    await expect(
      page.getByTestId(`group-member-remove-${groupUserEmail}`),
    ).toBeVisible({ timeout: 10000 });

    // Grant the group a role on the event.
    await page.goto(`/${nameId}/event`);
    await expect(page.getByTestId("permissions-panel")).toBeVisible({
      timeout: 15000,
    });
    await page.getByTestId("grant-subject-group").click();
    await page
      .getByTestId("grant-club-group")
      .selectOption({ label: `${groupName} (1)` });
    await page.getByTestId("grant-role").selectOption({ label: "Course setter" });
    await page.getByTestId("grant-submit").click();
    await expect(page.getByTestId(`revoke-${groupName}`)).toBeVisible({
      timeout: 10000,
    });

    // The member gets the role through the group.
    const ctx = await browser.newContext({
      extraHTTPHeaders: { "x-forwarded-email": groupUserEmail },
    });
    const memberPage = await ctx.newPage();
    await memberPage.goto(`/${nameId}/course-editor`);
    await expect(memberPage.getByTestId("course-editor-page")).toBeVisible({
      timeout: 15000,
    });
    await ctx.close();
  });
});
