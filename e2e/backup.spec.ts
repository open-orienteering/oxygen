import { test, expect } from "@playwright/test";
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { reseed } from "./helpers/reseed";
import { uploadEventMap } from "./helpers/map-upload";
import { API_BASE } from "./helpers/api-base";

async function selectCompetition(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByText("My example tävling").click();
  await expect(page.getByRole("link", { name: "Dashboard" })).toBeVisible({
    timeout: 10000,
  });
}

async function clickTab(page: import("@playwright/test").Page, name: string) {
  const mainTab = page
    .locator("nav[aria-label='Tabs']")
    .getByRole("link", { name, exact: true });
  if (await mainTab.isVisible()) {
    await mainTab.click();
  } else {
    await page.getByTestId("more-menu-button").click();
    await page
      .getByTestId("more-menu-content")
      .getByRole("link", { name, exact: true })
      .click();
  }
}

test.describe("Event Backup", () => {
  test("Download backup button delivers a non-empty .sql file", async ({
    page,
  }) => {
    await selectCompetition(page);
    await clickTab(page, "Event");

    await expect(page.getByText("Event backup").first()).toBeVisible({
      timeout: 10000,
    });
    const downloadLink = page.getByRole("button", { name: /Download backup/i });
    await expect(downloadLink).toBeVisible({ timeout: 10000 });

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      downloadLink.click(),
    ]);

    expect(download.suggestedFilename()).toMatch(
      /^itest_backup_\d{8}_\d{6}\.sql$/,
    );

    const path = await download.path();
    expect(path).toBeTruthy();
    const size = statSync(path!).size;
    expect(size).toBeGreaterThan(1024);

    const head = readFileSync(path!, "utf-8").slice(0, 4096);
    expect(head).toContain("-- Oxygen backup");
    expect(head).toContain("-- Event:      itest");
    expect(head).toContain("-- INSERT INTO oxygen.events (");
  });
});

/** The map part of the dump (docs/map-storage.md §7.3): blobs by hash, before map_files. */
test.describe("Event Backup with a map", () => {
  test.afterAll(reseed);

  test("the backup carries the event's map source and document by hash", async ({ page, request }) => {
    test.setTimeout(120_000);
    await selectCompetition(page);
    await clickTab(page, "Courses");
    await uploadEventMap(page);
    await expect(page.getByTestId("map-viewer")).toBeVisible({ timeout: 60_000 });
    const meta = await request.get(`${API_BASE}/trpc/course.mapMetadata`, { headers: { "x-event-id": "itest" } });
    const documentHash = (await meta.json())?.result?.data?.documentHash as string;
    expect(documentHash).toMatch(/^[0-9a-f]{64}$/);
    const sourceHash = createHash("sha256").update(readFileSync("e2e/test.ocd")).digest("hex");

    await clickTab(page, "Event");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Download backup/i }).click(),
    ]);
    const text = readFileSync((await download.path())!, "utf-8");
    expect(text).not.toContain("-- BACKUP FAILED");

    const at = (t: string) => text.indexOf(`--- ${t} ---`);
    expect(at("map_sources")).toBeGreaterThan(-1);
    expect(at("map_sources")).toBeLessThan(at("map_documents"));
    expect(at("map_documents")).toBeLessThan(at("map_files"));
    const sources = text.slice(at("map_sources"), at("map_documents"));
    const documents = text.slice(at("map_documents"), at("map_files"));
    expect(sources).toContain(`\n${sourceHash},ocad,\\x`);
    expect(documents).toContain(`\n${documentHash},\\x`);
    expect(text).not.toContain("--- map_previews ---");
  });
});
