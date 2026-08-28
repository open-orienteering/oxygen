import { test, expect, type APIRequestContext } from "@playwright/test";
import { API_BASE } from "./helpers/api-base";

/**
 * Coverage for searching runner names that contain a comma.
 *
 * Eventor stores personal names as "Family, Given", so nearly every
 * imported runner has a comma in their name. A deep link such as
 * `/itest/runners?q=name:"Kempe, Hugo"` used to return nothing: the comma
 * inside the quotes was read as an `in` list separator, so the substring
 * search became an exact match against "kempe" or "hugo".
 *
 * These tests create their own runners and delete them afterwards, so
 * they do not disturb the seed counts other specs assert on.
 */

const COMP_HEADERS = { "x-competition-id": "itest" };
const CLASS_NAME = "Öppen 1";

const RUNNERS = [
  { name: "E2E_Kempe, Hugo", cardNo: 8907001 },
  { name: "E2E_Kempe, Marcus", cardNo: 8907002 },
];

async function getClassId(request: APIRequestContext, className: string): Promise<number> {
  const resp = await request.get(`${API_BASE}/trpc/class.list`, { headers: COMP_HEADERS });
  const body = await resp.json();
  const classes = (body?.result?.data ?? []) as Array<{ id: number; name: string }>;
  const cls = classes.find((c) => c.name === className);
  if (!cls) throw new Error(`Class "${className}" not found`);
  return cls.id;
}

async function createRunner(
  request: APIRequestContext,
  name: string,
  cardNo: number,
  classId: number,
): Promise<number> {
  const resp = await request.post(`${API_BASE}/trpc/runner.create`, {
    headers: COMP_HEADERS,
    data: { name, cardNo, classId, startTime: 0 },
  });
  const body = await resp.json();
  const id = body?.result?.data?.id ?? body?.result?.data?.json?.id;
  if (!id) throw new Error(`Failed to create runner: ${JSON.stringify(body).slice(0, 300)}`);
  return id;
}

/**
 * The runner's name also appears in the filter pill, so table assertions
 * target the row cell specifically.
 */
function runnerCell(page: import("@playwright/test").Page, name: string) {
  return page.getByRole("cell", { name, exact: true });
}

async function readRunnerCount(page: import("@playwright/test").Page): Promise<number> {
  const txt = await page
    .locator("span", { hasText: /^\d+ runners$/ })
    .first()
    .textContent();
  const m = txt?.match(/(\d+)\s+runners/);
  if (!m) throw new Error(`could not parse runner count from "${txt}"`);
  return parseInt(m[1], 10);
}

test.describe("Structured search — comma-separated names", () => {
  const createdIds: number[] = [];

  test.beforeAll(async ({ request }) => {
    const classId = await getClassId(request, CLASS_NAME);
    for (const r of RUNNERS) {
      createdIds.push(await createRunner(request, r.name, r.cardNo, classId));
    }
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      await request
        .post(`${API_BASE}/trpc/runner.delete`, { headers: COMP_HEADERS, data: { id } })
        .catch(() => {
          /* best effort */
        });
    }
  });

  test('deep link with name:"Last, First" matches exactly that runner', async ({ page }) => {
    const q = `name:"E2E_Kempe, Hugo"`;
    await page.goto(`/itest/runners?q=${encodeURIComponent(q)}`);

    await expect(runnerCell(page, "E2E_Kempe, Hugo")).toBeVisible({ timeout: 15000 });
    expect(await readRunnerCount(page)).toBe(1);
    await expect(runnerCell(page, "E2E_Kempe, Marcus")).toBeHidden();
  });

  test("a quoted partial name still substring-matches", async ({ page }) => {
    const q = `name:"E2E_Kempe, "`;
    await page.goto(`/itest/runners?q=${encodeURIComponent(q)}`);

    await expect(runnerCell(page, "E2E_Kempe, Hugo")).toBeVisible({ timeout: 15000 });
    await expect(runnerCell(page, "E2E_Kempe, Marcus")).toBeVisible();
    expect(await readRunnerCount(page)).toBe(2);
  });

  test("typing a comma name in the search bar filters and survives the URL round-trip", async ({
    page,
  }) => {
    await page.goto("/itest/runners");
    await expect(page.locator("span", { hasText: "runners" }).first()).toBeVisible({
      timeout: 15000,
    });

    const input = page.getByRole("combobox", { name: "Search filter input" });
    await input.click();
    await input.fill(`name:"E2E_Kempe, Hugo"`);
    await input.press("Enter");

    // The comma must stay inside the quotes in the URL, otherwise
    // reloading the page would re-read it as an in-list.
    await expect(page).toHaveURL(/q=name%3A%22E2E_Kempe%2C\+Hugo%22/, { timeout: 5000 });

    // The token commit routes through `useSearchParams`, so the browser
    // URL updates a tick before React re-renders the filtered table.
    await expect(runnerCell(page, "E2E_Kempe, Hugo")).toBeVisible({ timeout: 15000 });
    await expect(runnerCell(page, "E2E_Kempe, Marcus")).toBeHidden();
    await expect.poll(() => readRunnerCount(page), { timeout: 10000 }).toBe(1);

    // Reloading the canonical URL yields the same single result.
    await page.reload();
    await expect(runnerCell(page, "E2E_Kempe, Hugo")).toBeVisible({ timeout: 15000 });
    expect(await readRunnerCount(page)).toBe(1);
  });

  test("comma-separated in-lists still filter on multi-word class names", async ({ page }) => {
    await page.goto("/itest/runners");
    await expect(page.locator("span", { hasText: "runners" }).first()).toBeVisible({
      timeout: 15000,
    });
    const baseline = await readRunnerCount(page);

    // Per-item quoting keeps the list splittable while preserving spaces.
    const q = `class:"Öppen 1","Öppen 2"`;
    await page.goto(`/itest/runners?q=${encodeURIComponent(q)}`);

    await expect(page.locator("span", { hasText: "runners" }).first()).toBeVisible({
      timeout: 15000,
    });
    const filtered = await readRunnerCount(page);
    expect(filtered).toBeGreaterThan(30);
    expect(filtered).toBeLessThan(baseline);
  });
});
