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
  test.describe.configure({ mode: "serial" });
  // One Eventor event can be imported once: both tests push from it.
  let nameId = "";
  test.beforeAll(async () => {
    await trpcCall("eventor.validateKey", { apiKey: "df34af90a0c64ca4abfe9492be057e9c", env: "prod" });
    nameId = (await trpcCall<{ nameId: string }>("eventor.importEvent", {
      eventId: 90001,
      eventName: `E2E_eventor_push_${Date.now()}`,
      eventDate: "2026-08-01",
      classificationId: 3,
      env: "prod",
    })).nameId;
  });

  test("a stalled upload shows the outcome-unknown notice and re-enables the button", async ({ page }) => {
    try {
      await setUpload("stall");
      await page.goto(`/${nameId}/event`);
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

  test("the switch leaves the course element out of the start list; on, it is sent", async ({ page }) => {
    const call = <T>(path: string, input: unknown) => trpcCall<T>(path, input, true, nameId);
    const course = await call<{ id: number }>("course.create", { name: "Long", length: 8420, climb: 265 });
    const cls = await call<{ id: number }>("class.create", { name: "E2E-C", courseId: course.id });
    await call("runner.create", { name: "Test Runner", classId: cls.id, cardNo: 123456 });
    const lastUpload = async () => (await fetch(`${STUB}/__lastUpload`)).text();

    await setUpload("ok");
    await page.goto(`/${nameId}/event`);
    const include = page.getByTestId("eventor-push-include-course");
    await expect(include).toBeChecked();
    await page.getByTestId("eventor-push-startlist").click();
    await expect(page.getByText(/Uploaded start list for \d+ runners/)).toBeVisible({ timeout: 15000 });
    expect(await lastUpload()).toContain("<Climb>265</Climb>");

    // Off: remembered for the event, and the next push has no Course element.
    await include.uncheck();
    await page.reload();
    await expect(page.getByTestId("eventor-push-include-course")).not.toBeChecked();
    await page.getByTestId("eventor-push-startlist").click();
    await expect(page.getByText(/Uploaded start list for \d+ runners/).first()).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await lastUpload()).length).toBeGreaterThan(0);
    const body = await lastUpload();
    expect(body).toContain("E2E-C");
    expect(body).not.toContain("<Course");
  });
});
