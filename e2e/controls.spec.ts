import { test, expect } from "@playwright/test";
import { reseed } from "./helpers/reseed";

test.beforeAll(reseed);

async function selectCompetition(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function clickTab(page: import("@playwright/test").Page, name: string) {
  const mainTab = page.locator("nav[aria-label='Tabs']").getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page.getByTestId("more-menu-content").getByRole("link", { name, exact: true }).click();
  }
}

test.describe("Controls Page", () => {
  test("should navigate to controls tab and display control list", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Controls");
    expect(page.url()).toContain("/controls");

    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("cell", { name: "Radio 1" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Radio 2" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Pre-start" })).toBeVisible();
  });

  test("should expand a control to show course usage and editable fields", async ({
    page,
  }) => {
    await selectCompetition(page);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    await page.getByRole("cell", { name: "Radio 1" }).click();

    await expect(page.getByText("Used in Courses")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Bana 1")).toBeVisible();
    await expect(page.getByText("Bana 2")).toBeVisible();
    await expect(page.getByText("Bana 3")).toBeVisible();
    await expect(page.locator("label", { hasText: "Name" })).toBeVisible();
    await expect(page.locator("label", { hasText: "Punch Code(s)" })).toBeVisible();
    expect(page.url()).toContain("control=50");
  });

  test("should deep link to controls with expanded control", async ({ page }) => {
    await page.goto("/itest/controls?control=50");
    await expect(page.getByText("Used in Courses")).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Bana 1")).toBeVisible();
  });

  test("should show bulk action bar when selecting controls", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    // Select two controls via their row checkboxes. The Controls table's
    // checkboxes are unlabeled, so grab them by position inside the row.
    const radio1Row = page.getByRole("row").filter({ hasText: "Radio 1" });
    const radio2Row = page.getByRole("row").filter({ hasText: "Radio 2" });
    await radio1Row.getByRole("checkbox").check();
    await radio2Row.getByRole("checkbox").check();

    // Floating bulk bar appears with the right count + the existing
    // radio/AIR+ dropdowns
    await expect(page.getByText("selected").first()).toBeVisible();
    await expect(page.getByText("2", { exact: true }).first()).toBeVisible();
    await expect(page.locator("option", { hasText: "Set Radio Type..." })).toBeAttached();

    // "Deselect all" button in the floating bar dismisses it
    await page.getByRole("button", { name: "Deselect all" }).click();
    await expect(page.getByRole("button", { name: "Deselect all" })).not.toBeVisible();
  });

  test("should show code and allow bulk-selecting start/finish controls", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    // Create a Start control with code 998 — the seed has no start/finish
    // controls, so we make one in the test and clean up at the end.
    await page.getByRole("button", { name: "New Control" }).click();
    await expect(
      page.getByRole("heading", { name: "New Control" }),
    ).toBeVisible({ timeout: 3000 });

    await page.getByPlaceholder("e.g. 50 or 50;250").fill("998");
    await page.getByPlaceholder("e.g. Radio 1 (optional)").fill("Start E2E");
    // Status select inside the New Control form (value 4 == Start)
    const form = page.locator("form").filter({ has: page.getByPlaceholder("e.g. 50 or 50;250") });
    await form.locator("select").selectOption("4");
    await page.getByRole("button", { name: "Create" }).click();

    // Row appears with the configured code in the Code column (regression
    // for the old behaviour that showed "—" for start/finish rows)
    const startRow = page.getByRole("row").filter({ hasText: "Start E2E" });
    await expect(startRow).toBeVisible({ timeout: 5000 });
    await expect(startRow.getByText("998", { exact: true })).toBeVisible();

    // The row checkbox is now enabled and triggers the bulk action bar
    await startRow.getByRole("checkbox").check();
    await expect(page.getByText("selected").first()).toBeVisible();
    await expect(page.getByText("1", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Deselect all" }).click();

    // Cleanup — search by code and delete
    const search = page.getByPlaceholder("Search code, name...");
    await search.fill("998");
    await search.press("Enter");
    await expect(page.getByText("1 controls")).toBeVisible({ timeout: 5000 });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByTitle("Remove control").click();
    await expect(page.getByText("No controls found")).toBeVisible({ timeout: 5000 });
    await page.getByLabel("Clear all filters").click();
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 5000 });
  });

  test("should expand status help panel from the controls table", async ({ page }) => {
    // The expanded inline detail (per row) contains a status dropdown
    // with a "How do statuses affect evaluation?" toggle directly under
    // it. Toggling the button must reveal a help block listing every
    // status with its label and description.
    await selectCompetition(page);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    await page.getByRole("cell", { name: "Radio 1" }).click();
    await expect(page.getByText("Used in Courses")).toBeVisible({ timeout: 5000 });

    const helpToggle = page.getByTestId("control-status-help-toggle").first();
    await expect(helpToggle).toBeVisible();
    // Closed initially.
    await expect(page.getByText("Required, time counts.")).not.toBeVisible();
    await helpToggle.click();
    // Once opened, descriptions for OK / Bad / NoTiming are present.
    await expect(page.getByText("Required, time counts.")).toBeVisible();
    await expect(page.getByText(/Reactive: control broke/)).toBeVisible();
    await expect(page.getByText(/leg into it does not count/)).toBeVisible();
    // Toggle closes it again.
    await helpToggle.click();
    await expect(page.getByText("Required, time counts.")).not.toBeVisible();
  });

  test("should create and then delete a control", async ({ page }) => {
    await selectCompetition(page);
    await clickTab(page, "Controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "New Control" }).click();
    await expect(
      page.getByRole("heading", { name: "New Control" }),
    ).toBeVisible({ timeout: 3000 });

    await page.getByPlaceholder("e.g. 50 or 50;250").fill("999");
    await page.getByPlaceholder("e.g. Radio 1 (optional)").fill("Test Control");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByRole("cell", { name: "Test Control" })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("24 controls")).toBeVisible({ timeout: 5000 });

    const search = page.getByPlaceholder("Search code, name...");
    await search.fill("999");
    await search.press("Enter");
    await expect(page.getByText("1 controls")).toBeVisible({ timeout: 5000 });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByTitle("Remove control").click();

    await expect(page.getByText("No controls found")).toBeVisible({ timeout: 5000 });
    await page.getByLabel("Clear all filters").click();
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 5000 });
  });

  test("should order the programming target picker by control number", async ({
    page,
  }) => {
    // control.list hands back import (seq) order; the picker is scanned by
    // eye, so its options must climb by control number instead. The seed is
    // already in ascending code order, so create a low code last — in import
    // order it would land at the bottom of the picker.
    await page.goto("/itest/controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "New Control" }).click();
    await page.getByPlaceholder("e.g. 50 or 50;250").fill("5");
    await page.getByPlaceholder("e.g. Radio 1 (optional)").fill("Late Low Code");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("24 controls")).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: "Program Controls" }).click();
    const picker = page.getByTestId("target-control-select");
    await expect(picker).toBeVisible({ timeout: 5000 });

    const codes = await picker
      .locator("option:not([value='auto'])")
      .evaluateAll((opts) =>
        opts.map((o) => parseInt(o.textContent?.split(/[;\s]/)[0] ?? "", 10)),
      );

    expect(codes).toEqual([...codes].sort((a, b) => a - b));
    expect(codes[0]).toBe(5);

    const search = page.getByPlaceholder("Search code, name...");
    await search.fill("Late Low Code");
    await search.press("Enter");
    await expect(page.getByText("1 controls")).toBeVisible({ timeout: 5000 });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByTitle("Remove control").click();
    await expect(page.getByText("No controls found")).toBeVisible({ timeout: 5000 });
  });

  test("should gate the autosend dropdown on radio type and station type", async ({
    page,
  }) => {
    // Autosend needs a radio to transmit over, and it means nothing on a
    // clear station. Operate on a throwaway control so the seed's radio
    // config and statuses stay untouched for later suites.
    await page.goto("/itest/controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 15000 });

    await page.getByRole("button", { name: "New Control" }).click();
    await page.getByPlaceholder("e.g. 50 or 50;250").fill("998");
    await page.getByPlaceholder("e.g. Radio 1 (optional)").fill("Autosend Control");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("cell", { name: "Autosend Control" })).toBeVisible({
      timeout: 5000,
    });

    await page.getByRole("cell", { name: "Autosend Control" }).click();
    const autosend = page.getByTestId("autosend-mode-select");
    await expect(autosend).toBeVisible({ timeout: 5000 });

    // No radio configured yet.
    await expect(autosend).toBeDisabled();

    await page.getByTestId("radio-type-select").selectOption("internal_radio");
    await expect(autosend).toBeEnabled({ timeout: 5000 });

    // A clear station has nothing to transmit, radio or not.
    await page.getByTestId("control-status-select").selectOption("12");
    await expect(autosend).toBeDisabled({ timeout: 5000 });

    // Back to a normal control and the selection applies again.
    await page.getByTestId("control-status-select").selectOption("0");
    await expect(autosend).toBeEnabled({ timeout: 5000 });

    const search = page.getByPlaceholder("Search code, name...");
    await search.fill("998");
    await search.press("Enter");
    await expect(page.getByText("1 controls")).toBeVisible({ timeout: 5000 });
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByTitle("Remove control").click();
    await expect(page.getByText("No controls found")).toBeVisible({ timeout: 5000 });
  });

  test("should filter controls by ordinal within a course", async ({ page }) => {
    // Seed courses: Bana 1 = 67,...,54,100 · Bana 2 = 81,50,40,150,100 ·
    // Bana 3 = 61,34,50,79,89,150,93,100. So ordinal:1 → {67, 81, 61},
    // ordinal:-1 → {100}, ordinal:-2 → {54, 150, 93}.
    await page.goto("/itest/controls");
    await expect(page.getByText("23 controls")).toBeVisible({ timeout: 15000 });

    // The ordinal key is discoverable in the autocomplete dropdown.
    const input = page.getByRole("combobox", { name: "Search filter input" });
    await input.click();
    await input.fill("ord");
    await expect(
      page.getByRole("option", { name: /Ordinal/ }),
    ).toBeVisible({ timeout: 5000 });

    // Row lookup by the leading code in the row's accessible name — a bare
    // cell match is ambiguous (a code can equal another row's runner count).
    const rowFor = (code: string) =>
      page.getByRole("row", { name: new RegExp(`^${code} `) });

    // ordinal:1 — the first control of every course.
    await input.fill("ordinal:1");
    await input.press("Enter");
    await expect(page.getByText("3 controls")).toBeVisible({ timeout: 5000 });
    for (const code of ["67", "81", "61"]) {
      await expect(rowFor(code)).toBeVisible();
    }

    // ordinal:-2 — second-to-last before finish, via deep link.
    await page.goto(`/itest/controls?q=${encodeURIComponent("ordinal:-2")}`);
    await expect(page.getByText("3 controls")).toBeVisible({ timeout: 15000 });
    for (const code of ["54", "150", "93"]) {
      await expect(rowFor(code)).toBeVisible();
    }

    // ordinal:-1 — the shared last control (code 100 on all three courses).
    await page.goto(`/itest/controls?q=${encodeURIComponent("ordinal:-1")}`);
    await expect(rowFor("100")).toBeVisible({ timeout: 15000 });
    await expect(rowFor("67")).not.toBeVisible();

    // Comma list ORs ordinals: first or last of any course.
    await page.goto(`/itest/controls?q=${encodeURIComponent("ordinal:1,-1")}`);
    await expect(page.getByText("4 controls")).toBeVisible({ timeout: 15000 });
  });
});
