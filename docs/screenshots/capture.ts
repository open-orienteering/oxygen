/**
 * Automated screenshot capture for documentation.
 *
 * Creates a competition with GDPR-safe fictional data, runs a draw and
 * simulation, then captures screenshots of every major view.
 *
 * Prerequisites: dev servers running (API on :3002, web on :5173)
 *   pnpm dev
 *
 * Usage:
 *   pnpm docs:screenshots
 */
import { chromium, type Page } from "playwright";

const API_URL = process.env.API_URL ?? "http://localhost:3002";
const WEB_URL = process.env.WEB_URL ?? "http://localhost:5173";
const OUTPUT_DIR = new URL("./", import.meta.url).pathname;
const COMPETITION_NAME = "Demo LD 2026";
const RUNNER_COUNT = 250;

// ─── Lightweight tRPC caller (no @trpc/client dependency) ───
// tRPC v11 non-batch: POST raw input, GET with ?input=<json>

async function trpcMutate<T = unknown>(
  procedure: string,
  input?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
  const json = await res.json();
  if (json.error) {
    const msg = json.error.message ?? JSON.stringify(json.error);
    throw new Error(`${procedure}: ${msg}`);
  }
  return json.result?.data as T;
}

async function trpcQuery<T = unknown>(
  procedure: string,
  input?: unknown,
): Promise<T> {
  const params = input !== undefined
    ? `?input=${encodeURIComponent(JSON.stringify(input))}`
    : "";
  const res = await fetch(`${API_URL}/trpc/${procedure}${params}`);
  const json = await res.json();
  if (json.error) {
    const msg = json.error.message ?? JSON.stringify(json.error);
    throw new Error(`${procedure}: ${msg}`);
  }
  return json.result?.data as T;
}

// ─── Helpers ────────────────────────────────────────────────

async function healthCheck() {
  for (const [label, url] of [
    ["API", `${API_URL}/trpc`],
    ["Web", WEB_URL],
  ] as const) {
    try {
      const res = await fetch(url);
      // tRPC root returns 404 but that's fine — server is up
      if (res.status >= 500) throw new Error(`${label} returned ${res.status}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("returned")) throw e;
      throw new Error(
        `${label} server not reachable at ${url}. Start with: pnpm dev`,
      );
    }
  }
  console.log("  Health check passed");
}

async function screenshot(page: Page, name: string) {
  const path = `${OUTPUT_DIR}${name}`;
  await page.screenshot({ path, fullPage: false });
  console.log(`  Captured ${name}`);
}

async function waitForData(page: Page, timeout = 10000) {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  await page.waitForTimeout(500);
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log("\n--- Screenshot Capture ---\n");

  // 1. Health check
  console.log("Step 1: Health check");
  await healthCheck();

  // 2. Create competition
  console.log("Step 2: Creating competition");
  let nameId: string;
  try {
    const result = await trpcMutate<{ nameId: string }>(
      "competition.create",
      { name: COMPETITION_NAME, date: "2026-04-15" },
    );
    nameId = result.nameId;
    console.log(`  Created: ${nameId}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("already exists") || msg.includes("database exists")) {
      console.log("  Competition exists, deleting and recreating...");
      const slug = COMPETITION_NAME.toLowerCase()
        .replace(/[åä]/g, "a")
        .replace(/ö/g, "o")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      try { await trpcMutate("competition.delete", { nameId: slug }); } catch { /* ignore */ }
      const result = await trpcMutate<{ nameId: string }>(
        "competition.create",
        { name: COMPETITION_NAME, date: "2026-04-15" },
      );
      nameId = result.nameId;
      console.log(`  Recreated: ${nameId}`);
    } else {
      throw e;
    }
  }

  // 3. Select competition (switches API to this database)
  console.log("Step 3: Selecting competition");
  await trpcMutate("competition.select", { nameId });
  console.log("  Selected");

  // 4. Generate data
  console.log("Step 4: Generating data");

  const classResult = await trpcMutate<{ created: number }>("testLab.generateClasses");
  console.log(`  Classes: ${classResult.created} created`);

  const courseResult = await trpcMutate<{ coursesCreated: number; controlsCreated: number }>(
    "testLab.generateCourses",
  );
  console.log(`  Courses: ${courseResult.coursesCreated}, Controls: ${courseResult.controlsCreated}`);

  const runnerResult = await trpcMutate<{ created: number; clubsCreated: number }>(
    "testLab.registerFictionalRunners",
    { count: RUNNER_COUNT },
  );
  console.log(`  Runners: ${runnerResult.created}, Clubs: ${runnerResult.clubsCreated}`);

  // 5. Run draw
  console.log("Step 5: Running draw");
  const drawDefaults = await trpcQuery<{
    classes: { id: number; name: string; courseId: number; courseName: string; runnerCount: number }[];
  }>("draw.defaults");

  // First start: "now + 5 minutes" in deciseconds since midnight
  const now = new Date();
  const midnightDs = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;
  const firstStartDs = midnightDs + 5 * 60 * 10;

  const drawResult = await trpcMutate<{ totalDrawn: number }>("draw.execute", {
    classes: drawDefaults.classes.map((cls, idx) => ({
      classId: cls.id,
      method: "clubSeparation",
      interval: 120,
      orderHint: idx,
    })),
    settings: {
      firstStart: firstStartDs,
      baseInterval: 120,
      maxParallelStarts: 4,
      detectCourseOverlap: true,
    },
  });
  console.log(`  Draw: ${drawResult.totalDrawn} runners drawn`);

  // 6. Run simulation (instant)
  console.log("Step 6: Running simulation");
  const simResult = await trpcMutate<{ processed: number }>(
    "testLab.startSimulation",
    { speed: 0 },
  );
  console.log(`  Simulation: ${simResult.processed} readouts processed`);

  // 7. Capture screenshots
  console.log("Step 7: Capturing screenshots");
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();

  try {
    // Competition selector
    await page.goto(WEB_URL);
    await page.waitForSelector(`text=${COMPETITION_NAME}`, { timeout: 10000 });
    await waitForData(page);
    await screenshot(page, "competition-selector.png");

    // Select the competition
    await page.getByText(COMPETITION_NAME).click();
    await page.waitForURL(`**/${nameId}/**`, { timeout: 10000 }).catch(() => {});
    await waitForData(page);

    // Dashboard
    await page.goto(`${WEB_URL}/${nameId}`);
    await waitForData(page);
    await screenshot(page, "dashboard.png");

    // Event page (sync buttons)
    await page.goto(`${WEB_URL}/${nameId}/event`);
    await waitForData(page);
    await screenshot(page, "event.png");

    // Runners with inline detail expanded
    await page.goto(`${WEB_URL}/${nameId}/runners`);
    await waitForData(page);
    const firstRunnerRow = page.locator("tbody tr").first();
    await firstRunnerRow.click();
    await page.waitForTimeout(600);
    await screenshot(page, "runners.png");

    // Runners with bulk selection
    await page.goto(`${WEB_URL}/${nameId}/runners`);
    await waitForData(page);
    const checkboxes = page.locator('tbody input[type="checkbox"]');
    const cbCount = await checkboxes.count();
    for (let i = 0; i < Math.min(5, cbCount); i++) {
      await checkboxes.nth(i).check();
    }
    await page.waitForTimeout(300);
    await screenshot(page, "runners-bulk.png");

    // Start list
    await page.goto(`${WEB_URL}/${nameId}/startlist`);
    await waitForData(page);
    await screenshot(page, "start-list.png");

    // Draw panel with timeline
    await page.goto(`${WEB_URL}/${nameId}/startlist`);
    await waitForData(page);
    const drawBtn = page.locator('[data-testid="draw-start-times-btn"]');
    if (await drawBtn.isVisible()) {
      await drawBtn.click();
      await page.waitForTimeout(500);
      const previewBtn = page.getByRole("button", { name: /preview/i });
      if (await previewBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await previewBtn.click();
        await page.waitForTimeout(1000);
      }
      await screenshot(page, "draw-panel.png");
    }

    // Results
    await page.goto(`${WEB_URL}/${nameId}/results`);
    await waitForData(page);
    await screenshot(page, "results.png");

    // Classes
    await page.goto(`${WEB_URL}/${nameId}/classes`);
    await waitForData(page);
    await screenshot(page, "classes.png");

    // Courses
    await page.goto(`${WEB_URL}/${nameId}/courses`);
    await waitForData(page);
    await screenshot(page, "courses.png");

    // Controls
    await page.goto(`${WEB_URL}/${nameId}/controls`);
    await waitForData(page);
    await screenshot(page, "controls.png");

    // Cards
    await page.goto(`${WEB_URL}/${nameId}/cards`);
    await waitForData(page);
    await screenshot(page, "cards.png");

    // Test Lab
    await page.goto(`${WEB_URL}/${nameId}/test-lab`);
    await waitForData(page);
    await screenshot(page, "test-lab.png");

    // Kiosk idle
    await page.goto(`${WEB_URL}/${nameId}/kiosk`);
    await page
      .waitForSelector("text=Insert your SI card", { timeout: 10000 })
      .catch(() => {});
    await waitForData(page);
    await screenshot(page, "kiosk-idle.png");

    // Kiosk readout (simulate via BroadcastChannel)
    await page.evaluate(
      ({ nameId }) => {
        const ch = new BroadcastChannel(`oxygen-kiosk-${nameId}`);
        ch.postMessage({
          type: "card-readout",
          card: {
            id: "docs-screenshot-1",
            cardNumber: 8234567,
            cardType: "SIAC",
            action: "readout",
            hasRaceData: true,
            runnerName: "Erik Andersson",
            className: "H21",
            clubName: "OK Forsarna",
            status: "OK",
            runningTime: 3847,
            checkTime: 32100,
            startTime: 32400,
            finishTime: 70870,
          },
        });
        ch.close();
      },
      { nameId },
    );
    await page.waitForTimeout(1000);
    await screenshot(page, "kiosk-readout.png");

    // Start screen
    await page.goto(`${WEB_URL}/${nameId}/start-screen`);
    await page.waitForTimeout(2000);
    await screenshot(page, "start-screen.png");
  } finally {
    await browser.close();
  }

  // 8. Cleanup
  console.log("Step 8: Cleanup");
  try {
    await trpcMutate("competition.delete", { nameId });
    console.log("  Deleted competition");
  } catch (e) {
    console.warn("  Warning: could not delete competition:", e);
  }

  console.log(`\nDone! Screenshots saved to docs/screenshots/\n`);
}

main().catch((e) => {
  console.error("Screenshot capture failed:", e);
  process.exit(1);
});
