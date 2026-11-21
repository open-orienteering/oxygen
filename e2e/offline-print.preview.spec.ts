import { expect, test, type Download, type Response } from "@playwright/test";
import {
  cachedPaths,
  courseIds,
  download,
  expectA4Pages,
  expectSamePdf,
  openTab,
  pickers,
  seedBaseMap,
  selectEvent,
  trpc,
} from "./helpers/print-pdf";

/**
 * The preview-build smoke (G29; course-print.md §8.6 "Delivery" and
 * "Offline"; map-storage.md §7.1): the production bundle under
 * `vite preview`, its service worker registered — project `preview`,
 * `E2E_PREVIEW=1` (docs/dev/e2e-sharding.md "The preview stack"). What the dev
 * server's E2E (`course-maps.spec.ts`, G17) cannot reach: the built
 * `print-worker-entry-<hash>.js` constructed in its emitted format
 * (an IIFE, `{ type: "module" }`), the `print-worker`, `map-fonts` and
 * `map-documents` routes, the `globIgnores` entry, and an offline export
 * after a reload, when the module worker must start again with no network.
 */

const WORKER_CHUNK = /^\/assets\/print-worker-entry-[\w-]+\.js$/;
const FACE = /^\/assets\/[\w-]+\.ttf$/;

test.describe("offline print from the production bundle (G29)", () => {
  test.beforeAll(seedBaseMap);

  test("store, reload, go offline, export: the stored job, the chunk and faces from the service worker", async ({ page, context }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);

    // The service worker installs on the first load; `registerType: "prompt"` claims no
    // client, so the page it controls is the next one. On the event list, before the
    // event is opened, so its document is fetched by a controlled page.
    await page.goto("/");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toMatch(/\/sw\.js$/);

    // The service worker's own network fetches (Playwright reports them on the context,
    // `request.serviceWorker()` set): a CacheFirst hit makes none.
    const swFetched: string[] = [];
    context.on("request", (r) => {
      if (r.serviceWorker()) swFetched.push(new URL(r.url()).pathname);
    });
    const fetchedBySw = (re: RegExp, from: number) => swFetched.slice(from).filter((p) => re.test(p));

    // `globIgnores` (§8.6 "Delivery"): the bundle is precached, the print worker is not.
    const precache = (await cachedPaths(page, /^workbox-precache/)).map((p) => p.split("?")[0]);
    expect(precache.some((p) => /^\/assets\/index-[\w-]+\.js$/.test(p))).toBe(true);
    expect(precache.filter((p) => p.includes("print-worker-entry-"))).toEqual([]);
    expect(await cachedPaths(page, "print-worker")).toEqual([]);

    await selectEvent(page);
    await openTab(page, "Courses");
    const [courseId] = await courseIds(page);
    await trpc("layout.autoSheets", { courseId });

    // Make maps available offline (§8.6 "Offline", steps 2–7): the jobs, the document, the
    // faces, and — composing or warming — the worker, whose chunk the route keeps.
    await page.getByTestId("course-export-menu").click();
    await page.getByTestId("course-export-offline").click();
    await expect(page.getByTestId("course-maps-notice")).toContainText("Maps stored on this device", { timeout: 90_000 });

    const meta = (await (await page.request.get("/trpc/course.mapMetadata", { headers: { "x-competition-id": "itest" } })).json()) as { result: { data: { documentHash: string } } };
    const hash = meta.result.data.documentHash;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    await expect.poll(() => cachedPaths(page, "print-worker")).toHaveLength(1);
    expect((await cachedPaths(page, "print-worker"))[0]).toMatch(WORKER_CHUNK);
    const faces = (await cachedPaths(page, "map-fonts")).filter((p) => FACE.test(p));
    expect(faces).toHaveLength(3);
    expect(await cachedPaths(page, "map-documents")).toContain(`/api/map-documents/${hash}`);
    const stored = await cachedPaths(page, "offline-print");
    expect(stored).toContain(`/api/maps/itest/print-job?courses=${courseId}`);
    expect(stored).toContain("/offline-print/itest");
    const storedAt = await page.evaluate(async () => {
      const res = await (await caches.open("offline-print")).match("/offline-print/itest");
      return ((await res!.json()) as { storedAt: string }).storedAt;
    });
    expect(storedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // Detection works: storing, the service worker fetched the chunk and the faces itself (a miss).
    expect(fetchedBySw(WORKER_CHUNK, 0), "the worker chunk fetched by the service worker").toHaveLength(1);
    expect(new Set(fetchedBySw(FACE, 0)).size, "the faces fetched by the service worker").toBe(3);

    // What the new page receives, and whether the service worker answered it.
    const responses: Response[] = [];
    const requested: string[] = [];
    page.on("request", (r) => requested.push(new URL(r.url()).pathname));
    page.on("response", (r) => responses.push(r));
    const answered = (re: RegExp, from = 0) => responses.slice(from).filter((r) => re.test(new URL(r.url()).pathname));
    const swFrom = swFetched.length;

    // A new page: nothing of the store's run is left in memory — no worker, no document,
    // no faces. Still controlled (a reload keeps the service worker).
    await page.reload();
    await expect(pickers(page).first()).toBeVisible();
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

    await context.setOffline(true);
    const offlineFrom = responses.length;
    let offline: Download;
    try {
      // Offline holds inside the service worker too: a face it has not cached does not load.
      expect(
        await page.evaluate(() =>
          fetch("/assets/no-such-face-g29.ttf").then(
            (r) => `answered ${r.status}`,
            () => "rejected",
          ),
        ),
      ).toBe("rejected");

      // The course's export: the stored job (2a), composed by the built worker (2b) — its
      // chunk, the faces and the document from the service worker's caches.
      offline = await download(page, () => page.getByTestId(`export-course-${courseId}`).click());
      await expect(page.getByTestId("course-maps-notice")).toContainText("Printed offline from the maps stored on");
      await expect(page.getByTestId("course-maps-notice")).toHaveAttribute("data-stored-at", storedAt);
      await expect(page.getByTestId("course-maps-error")).toHaveCount(0);
      expect(requested.filter((p) => p.endsWith("/maps.pdf"))).toEqual([]);

      // The worker starts only for the export, so its chunk is asked with the network gone.
      const chunk = answered(WORKER_CHUNK, offlineFrom);
      expect(chunk.length, "the worker chunk was requested offline").toBeGreaterThan(0);
      for (const r of chunk) expect(r.fromServiceWorker(), r.url()).toBe(true);
      // The faces and the document may be read once the page loads (online) and kept in
      // memory for the export: answered by the service worker since the reload, and — the
      // service worker fetching none of them — from its caches.
      const faceResponses = answered(FACE);
      expect(new Set(faceResponses.map((r) => new URL(r.url()).pathname)).size).toBe(3);
      for (const r of faceResponses) {
        expect(r.fromServiceWorker(), r.url()).toBe(true);
        expect(r.status(), r.url()).toBe(200);
      }
      const doc = answered(/^\/api\/map-documents\/[0-9a-f]{64}$/);
      expect(doc.length, "the document was requested").toBeGreaterThan(0);
      for (const r of doc) {
        expect(r.fromServiceWorker(), r.url()).toBe(true);
        expect(r.status(), r.url()).toBe(200);
      }
      expect(fetchedBySw(WORKER_CHUNK, swFrom)).toEqual([]);
      // The one face it went to the network for is the probe's, which it had not cached.
      expect(fetchedBySw(FACE, swFrom)).toEqual(["/assets/no-such-face-g29.ttf"]);
      expect(fetchedBySw(/^\/api\/map-documents\//, swFrom)).toEqual([]);
    } finally {
      await context.setOffline(false);
    }

    // What was printed offline is maps.pdf of the stored event, object for object (§8.6 "What identity rests on").
    await expectA4Pages(offline, 1);
    const printed = await page.request.get(`/api/maps/itest/maps.pdf?courses=${courseId}`);
    expect(printed.ok()).toBe(true);
    expect(offline.suggestedFilename()).toBe(/filename="([^"]+)"/.exec(printed.headers()["content-disposition"] ?? "")![1]);
    await expectSamePdf(offline, await printed.body());
  });
});
