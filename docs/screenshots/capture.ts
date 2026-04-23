/**
 * Automated screenshot capture for documentation.
 *
 * Seeds a competition from the committed showcase fixture
 * (docs/screenshots/fixtures/showcase.sql — an anonymized Vinterserien dump
 * with real controls, courses, classes, GPS tracks, and pre-rendered map tiles)
 * and then drives the frontend through every major user-facing feature
 * with Playwright, capturing one PNG per screen.
 *
 * Prerequisites: dev servers running (API on :3002, web on :5173)
 *   pnpm dev
 *
 * Usage:
 *   pnpm docs:screenshots                     — run every step
 *   pnpm docs:screenshots --only=kiosk,tracks — run only the listed steps
 *   pnpm docs:screenshots --list              — print the available step names
 *   pnpm docs:screenshots --keep              — skip final competition delete
 *
 * Stepwise capture keeps the pipeline debuggable: each step is self-contained
 * (navigates fresh, screenshots, returns), so a failed step can be retried
 * without rerunning the whole thing.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getMockWebSerialScript } from "../../e2e/helpers/mock-webserial.js";

// ─── Config ──────────────────────────────────────────────────

const API_URL = process.env.API_URL ?? "http://localhost:3002";
const WEB_URL = process.env.WEB_URL ?? "http://localhost:5173";
const COMPETITION_NAME = process.env.COMPETITION_NAME ?? "Demo Competition";

const OUTPUT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ─── Lightweight tRPC caller (no @trpc/client dependency) ────
// tRPC v11 non-batch: POST raw input, GET with ?input=<json>

async function trpcMutate<T = unknown>(
  procedure: string,
  input?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${API_URL}/trpc/${procedure}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: input !== undefined ? JSON.stringify(input) : "{}",
  });
  const json = (await res.json()) as {
    error?: { message?: string };
    result?: { data?: unknown };
  };
  if (json.error) {
    const msg = json.error.message ?? JSON.stringify(json.error);
    throw new Error(`${procedure}: ${msg}`);
  }
  return json.result?.data as T;
}

async function trpcQuery<T = unknown>(
  procedure: string,
  input?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const params =
    input !== undefined
      ? `?input=${encodeURIComponent(JSON.stringify(input))}`
      : "";
  const res = await fetch(`${API_URL}/trpc/${procedure}${params}`, { headers });
  const json = (await res.json()) as {
    error?: { message?: string };
    result?: { data?: unknown };
  };
  if (json.error) {
    const msg = json.error.message ?? JSON.stringify(json.error);
    throw new Error(`${procedure}: ${msg}`);
  }
  return json.result?.data as T;
}

// ─── Shared helpers ──────────────────────────────────────────

async function healthCheck(): Promise<void> {
  for (const [label, url] of [
    ["API", `${API_URL}/trpc`],
    ["Web", WEB_URL],
  ] as const) {
    try {
      const res = await fetch(url);
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

async function screenshot(page: Page, name: string): Promise<void> {
  const filePath = path.join(OUTPUT_DIR, name);
  await page.screenshot({ path: filePath, fullPage: false });
  console.log(`  Captured ${name}`);
}

async function waitForData(page: Page, timeout = 10_000): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
  await page.waitForTimeout(400);
}

async function gotoPage(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForData(page);
}

/**
 * Send a BroadcastChannel message to the kiosk instance for `nameId`.
 * Used to simulate SI card readouts without needing a real punch unit.
 */
async function broadcastKiosk(
  page: Page,
  nameId: string,
  message: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ({ nameId, message }) => {
      const ch = new BroadcastChannel(`oxygen-kiosk-${nameId}`);
      ch.postMessage(message);
      ch.close();
    },
    { nameId, message },
  );
  await page.waitForTimeout(600);
}

/**
 * Attach the mock WebSerial implementation to every page in `context`.
 * Expose `window.__siMock.insertCard/removeCard` for station captures.
 */
async function withMockedWebSerial(context: BrowserContext): Promise<void> {
  await context.addInitScript(getMockWebSerialScript());
}

// ─── Competition lifecycle ───────────────────────────────────

async function createCompetition(): Promise<string> {
  const slug = competitionSlug();

  try {
    const result = await trpcMutate<{ nameId: string }>("competition.create", {
      name: COMPETITION_NAME,
      date: "2026-04-15",
    });
    return result.nameId;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("already exists") && !msg.includes("database exists")) {
      throw e;
    }
    console.log("  Competition exists, deleting and recreating...");
    try {
      await trpcMutate("competition.delete", { nameId: slug });
    } catch {
      /* ignore */
    }
    const result = await trpcMutate<{ nameId: string }>("competition.create", {
      name: COMPETITION_NAME,
      date: "2026-04-15",
    });
    return result.nameId;
  }
}

function competitionSlug(): string {
  return COMPETITION_NAME.toLowerCase()
    .replace(/[åä]/g, "a")
    .replace(/ö/g, "o")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

async function seedShowcase(nameId: string): Promise<void> {
  const result = await trpcMutate<{ ok: boolean; sizeBytes: number }>(
    "testLab.seedShowcase",
    {},
    { "x-competition-id": nameId },
  );
  const mb = (result.sizeBytes / 1024 / 1024).toFixed(2);
  console.log(`  Seeded showcase fixture (${mb} MB)`);
}

// ─── Capture context ─────────────────────────────────────────

interface CaptureCtx {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  nameId: string;
}

interface CaptureStep {
  name: string;
  description: string;
  run: (ctx: CaptureCtx) => Promise<void>;
}

// ─── Capture steps ───────────────────────────────────────────

const STEPS: CaptureStep[] = [
  {
    name: "competition-selector",
    description: "Landing page with competition picker",
    async run({ page }) {
      await gotoPage(page, WEB_URL);
      await page.waitForSelector(`text=${COMPETITION_NAME}`, { timeout: 10_000 });
      await screenshot(page, "competition-selector.png");
    },
  },

  {
    name: "dashboard",
    description: "Race-day dashboard (real-time counters)",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}`);
      await page.waitForTimeout(1200);
      await screenshot(page, "dashboard.png");
    },
  },

  {
    name: "event",
    description: "Event metadata page with sync integrations",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/event`);
      await screenshot(page, "event.png");
    },
  },

  {
    name: "runners",
    description: "Runner list with inline detail (splits + punches)",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/runners`);
      const firstRow = page.locator("tbody tr").first();
      if (await firstRow.count()) {
        await firstRow.click();
        await page.waitForTimeout(700);
      }
      await screenshot(page, "runners.png");
    },
  },

  {
    name: "runners-bulk",
    description: "Runner list with bulk-edit floating action bar",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/runners`);
      const checkboxes = page.locator('tbody input[type="checkbox"]');
      const total = await checkboxes.count();
      for (let i = 0; i < Math.min(5, total); i++) {
        await checkboxes.nth(i).check().catch(() => {});
      }
      await page.waitForTimeout(400);
      await screenshot(page, "runners-bulk.png");
    },
  },

  {
    name: "start-list",
    description: "Public start list",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/startlist`);
      await screenshot(page, "start-list.png");
    },
  },

  {
    name: "draw-panel",
    description: "Start-time draw panel with class/corridor setup",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/startlist`);
      const drawBtn = page.locator('[data-testid="draw-start-times-btn"]');
      if (!(await drawBtn.isVisible().catch(() => false))) {
        console.log("  (draw button not visible — skipping)");
        return;
      }
      await drawBtn.click();
      await page.waitForTimeout(700);
      // Select all classes so the dialog shows the full race configuration
      // rather than an empty "0 classes · 0 runners" header.
      const allLink = page.getByRole("button", { name: /^All$/ }).first();
      if (await allLink.isVisible({ timeout: 1500 }).catch(() => false)) {
        await allLink.click().catch(() => {});
        await page.waitForTimeout(400);
      }
      // Preview is disabled when start times already exist (e.g. our fixture
      // is a finished competition). Only click when it's enabled.
      const previewBtn = page.getByRole("button", { name: /preview/i });
      if (await previewBtn.isEnabled({ timeout: 1500 }).catch(() => false)) {
        await previewBtn.click().catch(() => {});
        await page.waitForTimeout(1200);
      }
      await screenshot(page, "draw-panel.png");
    },
  },

  {
    name: "results",
    description: "Live results view",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/results`);
      await screenshot(page, "results.png");
    },
  },

  {
    name: "classes",
    description: "Classes configuration",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/classes`);
      await screenshot(page, "classes.png");
    },
  },

  {
    name: "courses",
    description: "Courses with map overlay",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/courses`);
      // Let tiles load
      await page.waitForTimeout(2000);
      await screenshot(page, "courses.png");
    },
  },

  {
    name: "controls",
    description: "Controls table with units / status",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/controls`);
      await screenshot(page, "controls.png");
    },
  },

  {
    name: "clubs",
    description: "Clubs with logos",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/clubs`);
      await screenshot(page, "clubs.png");
    },
  },

  {
    name: "cards",
    description: "Cards page with punch detail expanded",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/cards`);
      const firstRow = page.locator("tbody tr").first();
      if (await firstRow.count()) {
        await firstRow.click().catch(() => {});
        await page.waitForTimeout(500);
      }
      await screenshot(page, "cards.png");
    },
  },

  {
    name: "start-station",
    description: "Start station (SI reader) page",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/start-station`);
      await screenshot(page, "start-station.png");
    },
  },

  {
    name: "finish-station",
    description: "Finish station page",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/finish-station`);
      await page.waitForTimeout(2500);
      await screenshot(page, "finish-station.png");
    },
  },

  {
    name: "card-readout",
    description: "Card readout — typed lookup with splits table",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/card-readout`);
      // Look up a real (anonymized) card number from the showcase fixture.
      const input = page.locator('input[type="number"]').first();
      await input.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      // type="number" controlled inputs reject rapid keystrokes; set the
      // value directly and dispatch an `input` event so React picks it up.
      await input
        .evaluate((el) => {
          const inputEl = el as HTMLInputElement;
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )?.set;
          setter?.call(inputEl, "9000508");
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        })
        .catch(() => {});
      await page.waitForTimeout(2500);
      await screenshot(page, "card-readout.png");
    },
  },

  {
    name: "backup-punches",
    description: "Backup punches — reconciliation view",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/backup-punches`);
      // Counter starts at "All (0)" and flips once the query resolves.
      await page
        .waitForFunction(
          () => {
            const btn = Array.from(document.querySelectorAll("button")).find(
              (b) => /^All\s*\(/.test(b.textContent?.trim() ?? ""),
            );
            if (!btn) return false;
            const m = btn.textContent?.match(/\((\d+)\)/);
            return m ? Number(m[1]) > 0 : false;
          },
          null,
          { timeout: 15_000 },
        )
        .catch(() => {});
      await page.waitForTimeout(800);
      await screenshot(page, "backup-punches.png");
    },
  },

  {
    name: "test-lab",
    description: "Test Lab (four-stage competition generator)",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/test-lab`);
      await page.waitForTimeout(2500);
      await screenshot(page, "test-lab.png");
    },
  },

  {
    name: "tracks",
    description: "Tracks page with one route expanded on the map",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/tracks`);
      await page.waitForSelector("tbody tr", { timeout: 10_000 }).catch(() => {});
      // Expand a runner with a solid finish time so the inline map shows a
      // real GPS trace instead of a stub.
      const firstRow = page.locator("tbody tr").first();
      if (await firstRow.count()) {
        await firstRow.click({ force: true }).catch(() => {});
      }
      await page.waitForSelector(".leaflet-container", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(4000);
      const mapEl = page.locator(".leaflet-container").first();
      if (await mapEl.count()) {
        await mapEl.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
      }
      await screenshot(page, "tracks.png");
    },
  },

  {
    name: "replay",
    description: "GPS replay viewer (mass-start, speed slider)",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/tracks/replay`);
      // The class <select> starts with just a placeholder and is populated
      // asynchronously from listSyncedClasses. Wait until a real option shows
      // up before trying to select.
      const classDropdown = page.locator("select").first();
      await classDropdown.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
      const realOption = classDropdown.locator('option[value]:not([value=""])').first();
      await realOption.waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});
      const value = await realOption.getAttribute("value").catch(() => null);
      if (value) {
        await classDropdown.selectOption(value);
      }
      await page.waitForSelector(".leaflet-container", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(5000);
      await screenshot(page, "replay.png");
    },
  },

  {
    name: "start-screen",
    description: "Public start screen (big board)",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/start-screen`);
      await page.waitForTimeout(2000);
      await screenshot(page, "start-screen.png");
    },
  },

  {
    name: "kiosk-idle",
    description: "Kiosk — idle screen, waiting for a card",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/kiosk`);
      await page
        .waitForSelector("text=/card|sätt|insert/i", { timeout: 5000 })
        .catch(() => {});
      await screenshot(page, "kiosk-idle.png");
    },
  },

  {
    name: "kiosk-readout",
    description: "Kiosk — successful readout (runner + splits)",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/kiosk`);
      await broadcastKiosk(page, nameId, {
        type: "card-readout",
        card: {
          id: "docs-ok",
          cardNumber: 9807045,
          cardType: "SIAC",
          action: "readout",
          hasRaceData: true,
          runnerName: "Linus Larsson",
          className: "Klass A",
          clubName: "Skogsluffarna",
          status: "OK",
          runningTime: 3847,
          checkTime: 32100,
          startTime: 32400,
          finishTime: 70870,
        },
      });
      await screenshot(page, "kiosk-readout.png");
    },
  },

  {
    name: "kiosk-mispunch",
    description: "Kiosk — mispunch outcome",
    async run({ page, nameId }) {
      await gotoPage(page, `${WEB_URL}/${nameId}/kiosk`);
      await broadcastKiosk(page, nameId, {
        type: "card-readout",
        card: {
          id: "docs-mp",
          cardNumber: 9439783,
          cardType: "SIAC",
          action: "readout",
          hasRaceData: true,
          runnerName: "Veronica Lundgren",
          className: "Klass B",
          clubName: "OK Forsarna",
          status: "MP",
          runningTime: 4120,
          missingControls: ["72"],
          checkTime: 32100,
          startTime: 32400,
          finishTime: 72520,
        },
      });
      await screenshot(page, "kiosk-mispunch.png");
    },
  },
];

// ─── Entrypoint ──────────────────────────────────────────────

function parseArgs(argv: string[]): {
  only?: string[];
  list: boolean;
  keep: boolean;
} {
  let only: string[] | undefined;
  let list = false;
  let keep = false;
  for (const arg of argv) {
    if (arg === "--list") list = true;
    else if (arg === "--keep") keep = true;
    else if (arg.startsWith("--only=")) {
      only = arg
        .slice("--only=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return { only, list, keep };
}

async function main(): Promise<void> {
  const { only, list, keep } = parseArgs(process.argv.slice(2));

  if (list) {
    console.log("Available steps:");
    for (const step of STEPS) {
      console.log(`  ${step.name.padEnd(22)} ${step.description}`);
    }
    return;
  }

  console.log("\n--- Oxygen docs screenshots ---\n");

  console.log("Step 1: Health check");
  await healthCheck();

  console.log("Step 2: Create competition");
  const nameId = await createCompetition();
  console.log(`  Competition: ${nameId}`);

  console.log("Step 3: Seed showcase fixture");
  await seedShowcase(nameId);

  console.log("Step 4: Select competition");
  await trpcMutate(
    "competition.select",
    { nameId },
    { "x-competition-id": nameId },
  );

  console.log("Step 5: Launch browser");
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await withMockedWebSerial(context);
  const page = await context.newPage();

  const ctx: CaptureCtx = { page, context, browser, nameId };

  const toRun = only
    ? STEPS.filter((s) => only.includes(s.name))
    : STEPS;

  if (only) {
    const missing = only.filter((n) => !STEPS.some((s) => s.name === n));
    if (missing.length) {
      console.warn(`  (unknown step names: ${missing.join(", ")})`);
    }
  }

  console.log(`Step 6: Capture (${toRun.length} steps)`);
  for (const step of toRun) {
    try {
      console.log(`  → ${step.name}`);
      await step.run(ctx);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`    FAILED: ${msg}`);
    }
  }

  await browser.close();

  if (!keep) {
    console.log("Step 7: Cleanup");
    try {
      await trpcMutate("competition.delete", { nameId });
      console.log("  Deleted competition");
    } catch (e) {
      console.warn("  (could not delete competition):", e);
    }
  } else {
    console.log(`Step 7: Keeping competition ${nameId} (--keep)`);
  }

  console.log("\nDone! Screenshots saved to docs/screenshots/\n");
}

// Silence TS: reference the helper so it's considered used even when only
// a subset of steps call it through CaptureCtx.
void readFileSync;

main().catch((e) => {
  console.error("Screenshot capture failed:", e);
  process.exit(1);
});
