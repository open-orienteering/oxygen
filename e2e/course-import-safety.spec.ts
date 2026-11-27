// Course import safety in the dialog (review package 17, decision D3;
// docs/course-layer.md §6.4 "Import semantics"): Merge is pre-selected,
// Replace all lists what it removes before anything is written, and a file
// the server refuses shows why with the Import button disabled. Nothing
// here is imported, so the seed stays as it was.
import { test, expect, type Page } from "@playwright/test";
import { reseed } from "./helpers/reseed";

test.beforeAll(async () => {
  await reseed();
});

async function openImport(page: Page, file: string) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({ timeout: 10000 });
  const nameId = new URL(page.url()).pathname.split("/")[1];
  await page.goto(`/${nameId}/courses`);
  await expect(page.getByText("3 courses")).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "Import courses" }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Browse files" }).click();
  await (await chooser).setFiles(file);
}

test("Merge is pre-selected and Replace all lists what it removes", async ({ page }) => {
  await openImport(page, "e2e/test.ocd");
  await expect(page.getByText("Courses and Class Assignments")).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId("course-import-mode-merge")).toBeChecked();
  await expect(page.getByTestId("course-import-consequence-coursesRemoved")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Import 5 courses" })).toBeEnabled();

  await page.getByTestId("course-import-mode-replace").check();
  await expect(page.getByTestId("course-import-consequence-coursesRemoved")).toContainText("Removes 3 courses");
  // The removed courses' names open under the line.
  await page.getByTestId("course-import-consequence-coursesRemoved").locator("summary").click();
  await expect(page.getByTestId("course-import-consequence-coursesRemoved")).toContainText("Bana 1");
  await expect(page.getByTestId("course-import-consequence-classesUnassigned")).toBeVisible();
  await expect(page.getByRole("button", { name: "Replace all and import 5 courses" })).toBeEnabled();

  await page.getByTestId("course-import-mode-merge").check();
  await expect(page.getByTestId("course-import-consequence-coursesRemoved")).toHaveCount(0);
});

test("a file without courses cannot replace all", async ({ page }) => {
  await openImport(page, "e2e/fixtures/course-import-no-courses.xml");
  await expect(page.getByText("Courses and Class Assignments")).toBeVisible({ timeout: 20000 });
  await page.getByTestId("course-import-mode-replace").check();
  await expect(page.getByTestId("course-import-blockers")).toContainText("The file holds no courses");
  await expect(page.getByTestId("course-import-submit")).toBeDisabled();
});

test("a file with several races is refused with its reason", async ({ page }) => {
  await openImport(page, "e2e/fixtures/course-import-two-races.xml");
  await expect(page.getByText("The file holds 2 races; export one race per file")).toBeVisible({ timeout: 20000 });
});
