/**
 * Runner inline editor (fix package 11, WEB-07 and WEB-08): edits made in
 * quick succession are all stored, a refetch never rewrites the field being
 * typed in, a refused save says why and shows the stored value again, and
 * the bib field saves.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";
import { reseed } from "./helpers/reseed";

const COMP_HEADERS = { "x-competition-id": "itest" };

test.beforeAll(async () => {
  await reseed();
});
test.afterAll(async () => {
  await reseed();
});

async function trpcQuery(request: APIRequestContext, proc: string, input?: unknown) {
  const q = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await request.get(`${API_BASE}/trpc/${proc}${q}`, { headers: COMP_HEADERS });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).result.data;
}

async function trpcMutate(request: APIRequestContext, proc: string, data: unknown) {
  const res = await request.post(`${API_BASE}/trpc/${proc}`, { headers: COMP_HEADERS, data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).result.data;
}

async function newRunner(request: APIRequestContext, name: string, cardNo: number) {
  const classes = await trpcQuery(request, "class.list");
  const r = await trpcMutate(request, "runner.create", { name, cardNo, classId: classes[0].id as number });
  return r.id as number;
}

type Stored = { name: string; cardNo: number; bib: string };
const stored = (request: APIRequestContext, id: number): Promise<Stored> =>
  trpcQuery(request, "runner.getById", { id });

test("name and card edited back to back are both stored (WEB-07)", async ({ page, request }) => {
  const id = await newRunner(request, "Quick Tab Runner", 9_910_001);
  await page.goto(`/itest/runners?runner=${id}`);
  const name = page.getByTestId("runner-name");
  const card = page.getByTestId("runner-card");
  await expect(name).toBeVisible({ timeout: 10000 });

  // No wait between the two: the name used to be dropped behind "Saved".
  await name.fill("Quick Tab Renamed");
  await card.fill("9910002");
  await card.press("Enter");

  await expect(async () => {
    const r = await stored(request, id);
    expect(r.name).toBe("Quick Tab Renamed");
    expect(r.cardNo).toBe(9_910_002);
  }).toPass({ timeout: 10000 });

  await page.reload();
  await expect(page.getByTestId("runner-name")).toHaveValue("Quick Tab Renamed", { timeout: 10000 });
  await expect(page.getByTestId("runner-card")).toHaveValue("9910002");
});

test("an edit is stored when the row is closed right after typing", async ({ page, request }) => {
  const id = await newRunner(request, "Close Fast Runner", 9_910_011);
  await page.goto(`/itest/runners?runner=${id}`);
  const name = page.getByTestId("runner-name");
  await expect(name).toBeVisible({ timeout: 10000 });

  await name.fill("Close Fast Renamed");
  await page.getByRole("cell", { name: /Close Fast R/ }).first().click();
  await expect(name).toBeHidden();

  await expect(async () => expect((await stored(request, id)).name).toBe("Close Fast Renamed")).toPass({
    timeout: 10000,
  });
});

test("closing the row while a save is in flight keeps the later edit", async ({ page, request }) => {
  const id = await newRunner(request, "In Flight Runner", 9_910_061);
  await page.goto(`/itest/runners?runner=${id}`);
  const name = page.getByTestId("runner-name");
  await expect(name).toBeVisible({ timeout: 10000 });

  // Hold the first save so the next edits queue behind it.
  const update = /\/trpc\/[^?]*runner\.update/;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = false;
  await page.route(update, async (route) => {
    if (!held) {
      held = true;
      await gate;
    }
    await route.continue();
  });

  const first = page.waitForRequest(update);
  await name.fill("In Flight First");
  await name.press("Enter");
  await first;
  // Same field again plus another one, queued behind the held save; the
  // close-time save must land after it, so the later name wins.
  await name.fill("In Flight Last");
  await page.getByTestId("runner-bib").fill("B9");
  await page.keyboard.press("Tab");
  await page.getByRole("cell", { name: /In Flight/ }).first().click();
  await expect(name).toBeHidden();
  release();

  await expect(async () => {
    const r = await stored(request, id);
    expect(r.name).toBe("In Flight Last");
    expect(r.bib).toBe("B9");
  }).toPass({ timeout: 10000 });
  await page.waitForTimeout(1000);
  expect((await stored(request, id)).name).toBe("In Flight Last");
});

test("a card held by another runner is refused with a message and the field reverts (WEB-08)", async ({
  page,
  request,
}) => {
  await newRunner(request, "Card Holder", 9_910_021);
  const id = await newRunner(request, "Card Taker", 9_910_022);
  await page.goto(`/itest/runners?runner=${id}`);
  const card = page.getByTestId("runner-card");
  await expect(card).toBeVisible({ timeout: 10000 });

  await card.fill("9910021");
  await card.press("Enter");

  await expect(page.getByTestId("runner-save-error")).toContainText(/9910021.*already assigned/i, {
    timeout: 10000,
  });
  await expect(card).toHaveValue("9910022");
  await expect(page.getByTestId("runner-saved")).toHaveCount(0);
  expect((await stored(request, id)).cardNo).toBe(9_910_022);

  // The message stays until a save succeeds.
  await page.getByTestId("runner-name").fill("Card Taker Two");
  await page.getByTestId("runner-name").press("Enter");
  await expect(page.getByTestId("runner-save-error")).toHaveCount(0, { timeout: 10000 });
});

test("an empty name is not sent and says why (WEB-08)", async ({ page, request }) => {
  const id = await newRunner(request, "Named Runner", 9_910_031);
  await page.goto(`/itest/runners?runner=${id}`);
  const name = page.getByTestId("runner-name");
  await expect(name).toBeVisible({ timeout: 10000 });

  await name.fill("");
  await name.press("Enter");
  await expect(page.getByText("Name is required")).toBeVisible();
  await expect(name).toHaveAttribute("aria-invalid", "true");
  await page.waitForTimeout(1000);
  expect((await stored(request, id)).name).toBe("Named Runner");
});

test("a refetch for an earlier save does not rewrite the field being typed in (WEB-07)", async ({
  page,
  request,
}) => {
  const id = await newRunner(request, "Slow Refetch Runner", 9_910_041);
  await page.goto(`/itest/runners?runner=${id}`);
  const card = page.getByTestId("runner-card");
  await expect(card).toBeVisible({ timeout: 10000 });

  // Hold the runner read-back after the save of "12" until "345" has been
  // typed, so its answer ("12") lands while the field holds "12345".
  const getById = /\/trpc\/[^?]*runner\.getById/;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(getById, async (route) => {
    await gate;
    await route.continue();
  });

  await card.fill("");
  const refetch = page.waitForRequest(getById);
  await card.pressSequentially("12");
  await refetch; // the 600 ms pause saved "12" and asked for the runner again
  await card.pressSequentially("345");
  release();
  await page.waitForResponse(getById);
  // Sampled, not retried: the old editor showed "12" here until its next
  // save put "12345" back, which a retrying assertion would wait out.
  for (let i = 0; i < 4; i++) {
    expect(await card.inputValue()).toBe("12345");
    await page.waitForTimeout(100);
  }

  await card.press("Enter");
  await expect(async () => expect((await stored(request, id)).cardNo).toBe(12345)).toPass({ timeout: 10000 });
  await expect(card).toHaveValue("12345");
});

test("the bib field saves", async ({ page, request }) => {
  const id = await newRunner(request, "Bib Field Runner", 9_910_051);
  await page.goto(`/itest/runners?runner=${id}`);
  const bib = page.getByTestId("runner-bib");
  await expect(bib).toBeVisible({ timeout: 10000 });

  await bib.fill("77");
  await bib.press("Enter");
  await expect(async () => expect((await stored(request, id)).bib).toBe("77")).toPass({ timeout: 10000 });
});
