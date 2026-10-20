/**
 * Regression test for e2e/helpers/trpc.ts — batch-aware tRPC response
 * matching (docs/bugfix-e2e-kiosk-and-editor-flakes.md).
 *
 * The web client's httpBatchLink merges calls issued in the same tick
 * into one request. kiosk-readout.spec.ts waited for
 * `url.includes("/trpc/cardReadout.readout")`, which never matched when a
 * background refetch was batched ahead of the readout:
 * `/trpc/competition.dashboard,…,cardReadout.readout`. These tests serve
 * such batches from a route, so they need no app state.
 */
import { test, expect, type Page } from "@playwright/test";
import { trpcProcedures, waitForTrpc } from "./helpers/trpc";

const ORIGIN = "http://trpc-batch.test";

async function serveBatch(
  page: Page,
  status: number,
  slots: Array<Record<string, unknown>>,
) {
  await page.route(`${ORIGIN}/trpc/**`, (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(slots),
    }),
  );
}

function fetchFromPage(page: Page, path: string) {
  return page.evaluate((url) => fetch(url).then((r) => r.status), `${ORIGIN}${path}`);
}

test.describe("batch-aware tRPC response matching", () => {
  test("parses the procedure list of a batched request", () => {
    expect(
      trpcProcedures(
        `${ORIGIN}/trpc/competition.dbStatus,cardReadout.readout?batch=1&input=%7B%7D`,
      ),
    ).toEqual(["competition.dbStatus", "cardReadout.readout"]);
    expect(trpcProcedures(`${ORIGIN}/trpc/cardReadout.applyResult?batch=1`)).toEqual([
      "cardReadout.applyResult",
    ]);
    expect(trpcProcedures(`${ORIGIN}/api/version`)).toEqual([]);
  });

  test("matches a procedure that is not first in its batch", async ({ page }) => {
    await serveBatch(page, 200, [
      { result: { data: { dashboard: true } } },
      { result: { data: { found: true } } },
    ]);
    const path = "/trpc/competition.dashboard,cardReadout.readout?batch=1";
    // The pre-fix predicate misses this request entirely.
    expect(`${ORIGIN}${path}`.includes("/trpc/cardReadout.readout")).toBe(false);

    const readout = waitForTrpc(page, "cardReadout.readout", { timeout: 5000 });
    await fetchFromPage(page, path);
    const resp = await readout;
    expect(resp.url()).toContain("competition.dashboard,cardReadout.readout");
  });

  test("ignores a batch in which the awaited call failed", async ({ page }) => {
    // tRPC answers 207 when a batch mixes results and errors.
    await serveBatch(page, 207, [
      { result: { data: { dashboard: true } } },
      { error: { message: "boom", code: -32603 } },
    ]);
    const applied = waitForTrpc(page, "cardReadout.applyResult", { timeout: 2000 });
    await fetchFromPage(page, "/trpc/competition.dashboard,cardReadout.applyResult?batch=1");
    await expect(applied).rejects.toThrow(/Timeout/);
  });

  test("accepts the successful call of a mixed batch", async ({ page }) => {
    await serveBatch(page, 207, [
      { error: { message: "boom", code: -32603 } },
      { result: { data: { ok: true } } },
    ]);
    const applied = waitForTrpc(page, "cardReadout.applyResult", { timeout: 5000 });
    await fetchFromPage(page, "/trpc/competition.dashboard,cardReadout.applyResult?batch=1");
    expect((await applied).status()).toBe(207);
  });
});
