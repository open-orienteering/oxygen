import { test, expect } from "@playwright/test";
import { trpcCall } from "./helpers/editor";
import { E2E_EVENTOR_PORT } from "./helpers/ports";

/**
 * Eventor re-sync keeps the desk's edits (review package 5,
 * docs/system/eventor-sync.md). Served by e2e/eventor-stub.mjs: event 90001
 * has two scenarios, switched with POST /__scenario/<n>.
 *
 *   1  Andersson (card 500001) and Berg (no card)
 *   2  Andersson's card is 500002, Berg has withdrawn, Carlsson entered
 */
const STUB = `http://127.0.0.1:${E2E_EVENTOR_PORT}`;

async function setScenario(n: number) {
  const res = await fetch(`${STUB}/__scenario/${n}`, { method: "POST" });
  expect(res.ok).toBe(true);
}

type Row = { id: number; name: string; cardNo: number };

test.describe("Eventor sync", () => {
  test("preview, confirm, differs-from-Eventor markers and 'use Eventor's value'", async ({ page }) => {
    await trpcCall("eventor.validateKey", { apiKey: "df34af90a0c64ca4abfe9492be057e9c", env: "prod" });
    let nameId = "";
    try {
      await setScenario(1);
      const imported = await trpcCall<{ nameId: string; runnerCount: number }>("eventor.importEvent", {
        eventId: 90001,
        eventName: `E2E_eventor_sync_${Date.now()}`,
        eventDate: "2026-08-01",
        classificationId: 3,
        env: "prod",
      });
      nameId = imported.nameId;
      expect(imported.runnerCount).toBe(2);

      const runners = () => trpcCall<Row[]>("runner.list", {}, false, nameId);
      const anna = (await runners()).find((r) => r.name.startsWith("Andersson"))!;
      expect(anna.cardNo).toBe(500001);

      // The desk gives Anna a rental card; then Eventor changes things.
      await trpcCall("runner.update", { id: anna.id, cardNo: 700001 }, true, nameId);
      await setScenario(2);

      // Preview: nothing is written yet.
      await page.goto(`/${nameId}/event`);
      await page.getByTestId("eventor-sync-button").click();
      const preview = page.getByTestId("eventor-sync-preview");
      await expect(preview).toBeVisible({ timeout: 15000 });
      await expect(preview).toContainText("1 runner added");
      await expect(preview).toContainText("1 runner will be marked as withdrawn");
      await expect(preview).toContainText("1 runner keeps local edits");
      await expect(preview).toContainText("Berg");
      expect((await runners()).map((r) => r.name).sort()).toEqual(["Andersson, Anna", "Berg, Bo"]);

      // Cancel leaves it as it was; confirm applies.
      await page.getByTestId("eventor-sync-cancel").click();
      await expect(preview).toHaveCount(0);
      await page.getByTestId("eventor-sync-button").click();
      await expect(page.getByTestId("eventor-sync-preview")).toBeVisible({ timeout: 15000 });
      await page.getByTestId("eventor-sync-confirm").click();
      await expect(page.getByTestId("eventor-sync-result")).toBeVisible({ timeout: 15000 });

      const after = await runners();
      expect(after.map((r) => r.name).sort()).toEqual(["Andersson, Anna", "Berg, Bo", "Carlsson, Cia"]);
      expect(after.find((r) => r.id === anna.id)!.cardNo).toBe(700001);

      // The runner list finds the runner that differs, and the one gone from Eventor.
      await page.goto(`/${nameId}/runners?q=${encodeURIComponent("eventor:differs")}`);
      await expect(page.getByTestId("eventor-diff-badge")).toHaveCount(1, { timeout: 15000 });
      await expect(page.getByRole("row", { name: /Andersson/ })).toBeVisible();
      await expect(page.getByRole("row", { name: /Carlsson/ })).toHaveCount(0);
      await page.goto(`/${nameId}/runners?q=${encodeURIComponent("eventor:gone")}`);
      await expect(page.getByRole("row", { name: /Berg/ })).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole("row", { name: /Andersson/ })).toHaveCount(0);

      // The detail shows Eventor's value and applies it on request.
      await page.goto(`/${nameId}/runners?runner=${anna.id}`);
      const marker = page.getByTestId("eventor-marker-cardNo");
      await expect(marker).toBeVisible({ timeout: 15000 });
      await expect(marker).toContainText("Eventor: 500002");
      await page.getByTestId("eventor-use-cardNo").click();
      await expect(marker).toHaveCount(0, { timeout: 15000 });
      expect((await runners()).find((r) => r.id === anna.id)!.cardNo).toBe(500002);
    } finally {
      if (nameId) await trpcCall("competition.delete", { nameId }).catch(() => undefined);
      await setScenario(1);
      await trpcCall("eventor.clearKey", { env: "prod" }).catch(() => undefined);
    }
  });
});
