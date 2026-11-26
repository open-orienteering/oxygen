/**
 * ZeroTime and time zone (fix package 8): strict time inputs (RES-13,
 * WEB-40), the draw away from ZeroTime (RES-04), the zero-time and time-zone
 * settings, and a station clock that ticks without the server (RES-06).
 *
 * The browser runs in Europe/Stockholm and the API in UTC
 * (playwright.config.ts), as at a venue with the Docker images.
 */
import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";
import { reseed } from "./helpers/reseed";

const COMP_HEADERS = { "x-competition-id": "itest" };
const H = 36_000;

test.beforeAll(async () => {
  await reseed();
});
test.afterAll(async () => {
  await reseed();
});

async function trpcQuery(request: APIRequestContext, proc: string) {
  const res = await request.get(`${API_BASE}/trpc/${proc}`, { headers: COMP_HEADERS });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).result.data;
}

async function trpcMutate(request: APIRequestContext, proc: string, data: unknown) {
  const res = await request.post(`${API_BASE}/trpc/${proc}`, { headers: COMP_HEADERS, data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).result.data;
}

async function newRunner(request: APIRequestContext, name: string, cardNo: number, startTime = 0) {
  const classes = await trpcQuery(request, "class.list");
  const classId = classes[0].id as number;
  const r = await trpcMutate(request, "runner.create", { name, cardNo, classId, startTime });
  return r.id as number;
}

async function storedStart(request: APIRequestContext, id: number): Promise<number> {
  const res = await request.get(
    `${API_BASE}/trpc/runner.getById?input=${encodeURIComponent(JSON.stringify({ id }))}`,
    { headers: COMP_HEADERS },
  );
  return (await res.json()).result.data.startTime as number;
}

test("runner start time saves on Enter, never a half-typed value (RES-13)", async ({ page, request }) => {
  const id = await newRunner(request, "Clock Field Runner", 9_900_301);
  await page.goto(`/itest/runners?runner=${id}`);
  const field = page.getByTestId("runner-start-time");
  await expect(field).toBeVisible({ timeout: 10000 });

  // A pause after "1" used to store 0 (and "10:4" 00:10:04). Now nothing is
  // saved until Enter or blur, and an invalid value stays red.
  await field.fill("10:4");
  await field.press("Enter");
  await expect(field).toHaveAttribute("aria-invalid", "true");
  expect(await storedStart(request, id)).toBe(0);

  await field.fill("12.45.30");
  await field.press("Enter");
  await expect(async () => expect(await storedStart(request, id)).toBe((12 * 3600 + 45 * 60 + 30) * 10)).toPass({
    timeout: 10000,
  });
  await expect(field).toHaveValue("12:45:30");

  // A start exactly at the zero time (09:00) is refused with a message.
  await field.fill("9:00");
  await field.press("Enter");
  await expect(page.getByTestId("runner-save-error")).toContainText(/zero time/i, { timeout: 10000 });
  expect(await storedStart(request, id)).toBe((12 * 3600 + 45 * 60 + 30) * 10);
});

test("class max time 2:30 is two and a half hours (WEB-40)", async ({ page, request }) => {
  await page.goto("/itest/classes?classId=3");
  const field = page.getByTestId("class-max-time");
  await expect(field).toBeVisible({ timeout: 10000 });
  await field.fill("2:30");
  await expect(page.getByTestId("class-max-time-echo")).toHaveText("02:30:00");
  await field.blur();
  await expect(async () => {
    const detail = await (
      await request.get(`${API_BASE}/trpc/class.detail?input=${encodeURIComponent(JSON.stringify({ id: 3 }))}`, {
        headers: COMP_HEADERS,
      })
    ).json();
    expect(detail.result.data.maxTime).toBe(150 * 600);
  }).toPass({ timeout: 10000 });

  await field.fill("2h");
  await expect(field).toHaveAttribute("aria-invalid", "true");
});

async function openDraw(page: Page) {
  await page.goto("/itest/startlist");
  await page.getByTestId("draw-start-times-btn").click();
  const panel = page.getByTestId("draw-panel");
  await expect(panel).toBeVisible({ timeout: 10000 });
  await panel.getByRole("button", { name: "All", exact: true }).click();
  return panel;
}

test("the draw proposes one hour after the zero time and refuses the zero time (RES-04)", async ({ page }) => {
  const panel = await openDraw(page);
  const firstStart = panel.getByPlaceholder("09:00:00");
  await expect(firstStart).toHaveValue("10:00:00");

  // A half-typed first start blocks the preview instead of becoming 00:10.
  await firstStart.fill("10:");
  await expect(page.getByTestId("draw-input-errors")).toBeVisible();
  await expect(page.getByTestId("draw-preview-btn")).toBeDisabled();

  // A first start on the zero time is shown and cannot be applied.
  await firstStart.fill("09:00:00");
  await page.getByTestId("draw-preview-btn").click();
  await expect(page.getByTestId("draw-blockers")).toContainText(/zero time/, { timeout: 10000 });
  await expect(page.getByTestId("draw-execute-btn")).toBeDisabled();
});

test("zero time and time zone are edited under Event Info", async ({ page, request }) => {
  // The seed has read cards, so the zero time is locked; the zone is not.
  await page.goto("/itest/event");
  const card = page.getByTestId("event-time-settings");
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("event-zero-time")).toHaveValue("09:00:00");
  const settings = await trpcQuery(request, "event.getTimeSettings");
  if (settings.zeroTimeLocked) await expect(page.getByTestId("event-zero-time")).toBeDisabled();

  await page.getByTestId("event-time-zone").fill("Mars/Olympus");
  await expect(page.getByTestId("event-time-save")).toBeDisabled();
  await page.getByTestId("event-time-zone").fill("Europe/Helsinki");
  await page.getByTestId("event-time-save").click();
  await expect(card.getByText("Time settings saved")).toBeVisible({ timeout: 10000 });
  expect((await trpcQuery(request, "event.getTimeSettings")).timeZone).toBe("Europe/Helsinki");
  await trpcMutate(request, "event.setTimeSettings", { zeroTime: 9 * H, timeZone: "Europe/Stockholm" });
});

test("the start station clock keeps ticking without the server (RES-06)", async ({ page }) => {
  await page.goto("/itest/start-station");
  const clock = page.getByTestId("station-clock");
  await expect(clock).toHaveText(/\d{2}:\d{2}:\d{2}/, { timeout: 10000 });
  // The event is in Europe/Stockholm, so is this browser: the station shows
  // this browser's time of day, not the UTC of the API process.
  const browserNow = await page.evaluate(() => new Date().toTimeString().slice(0, 5));
  await expect(clock).toContainText(browserNow.slice(0, 2));

  // Block every later serverTime answer: the clock still advances.
  await page.route(/race\.serverTime/, (route) => route.abort());
  const before = await clock.textContent();
  await expect(async () => expect(await clock.textContent()).not.toBe(before)).toPass({ timeout: 5000 });
  expect(before).not.toBe("00:00:00");
});
