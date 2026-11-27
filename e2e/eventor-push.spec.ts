import { test, expect } from "@playwright/test";
import { trpcCall } from "./helpers/editor";
import { E2E_EVENTOR_PORT } from "./helpers/ports";

/**
 * A push to Eventor that gets no answer (EVT-13, docs/system/eventor-sync.md
 * "Upload timeouts"): the stub accepts the POST and never replies, the API
 * gives up after EVENTOR_UPLOAD_TIMEOUT_MS (2 s on the E2E stack) and the
 * page says the outcome is unknown, then lets the operator try again.
 */
const STUB = `http://127.0.0.1:${E2E_EVENTOR_PORT}`;

async function setUpload(mode: "ok" | "stall") {
  const res = await fetch(`${STUB}/__upload/${mode}`, { method: "POST" });
  expect(res.ok).toBe(true);
}

test.describe("Eventor push timeout", () => {
  test("a stalled upload shows the outcome-unknown notice and re-enables the button", async ({ page }) => {
    await trpcCall("eventor.validateKey", { apiKey: "df34af90a0c64ca4abfe9492be057e9c", env: "prod" });
    try {
      const imported = await trpcCall<{ nameId: string }>("eventor.importEvent", {
        eventId: 90001,
        eventName: `E2E_eventor_push_${Date.now()}`,
        eventDate: "2026-08-01",
        classificationId: 3,
        env: "prod",
      });

      await setUpload("stall");
      await page.goto(`/${imported.nameId}/event`);
      const push = page.getByTestId("eventor-push-results");
      await push.click();

      const notice = page.getByTestId("eventor-push-notice");
      await expect(notice).toBeVisible({ timeout: 20000 });
      await expect(notice).toHaveAttribute("data-tone", "unknown");
      await expect(notice).toContainText("may or may not have been received");
      await expect(push).toBeEnabled();

      // The guard was released: with the stub answering again, the push goes through.
      await setUpload("ok");
      await push.click();
      await expect(page.getByText("Push complete:")).toBeVisible({ timeout: 15000 });
    } finally {
      await setUpload("ok");
    }
  });
});
