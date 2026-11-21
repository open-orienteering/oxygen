/**
 * Shared plumbing for the showcase shots (playwright.showcase.config.ts,
 * docs/screenshots/README.md).
 *
 * Public run (default): the Demo Competition on the CC0 Puit de Laven map,
 * PNGs into docs/screenshots/. The run checks the event's map really is that
 * map, so a machine whose demo event carries another map cannot write it
 * into the docs.
 *
 * Private run (SHOWCASE_PRIVATE=1): any event on the machine the run is on,
 * PNGs into .local/showcase-shots/ (gitignored) for a person to look at
 * before anything is committed. Every write the page sends is refused, and
 * shots that need one are skipped, so a real event is only ever read.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

export const ROOT = path.resolve(__dirname, "..", "..");

export const PRIVATE = process.env.SHOWCASE_PRIVATE === "1";
export const EVENT = process.env.SHOWCASE_EVENT ?? "demo_competition";
/** A course to feature, by name; the first course when unset. */
export const COURSE = process.env.SHOWCASE_COURSE;

/** Environments that are not the machine the map lives on: CI and hosted shells. */
const HOSTED = ["CI", "CLAUDE_CODE_REMOTE", "CODESPACES", "GITPOD_WORKSPACE_ID", "CLOUD_SHELL", "DEVSHELL_PROJECT_ID"];

if (PRIVATE && !process.env.SHOWCASE_EVENT) {
  throw new Error("SHOWCASE_PRIVATE=1 needs SHOWCASE_EVENT=<event nameId>: a private run never falls back to the demo.");
}
if (PRIVATE && HOSTED.some((v) => process.env[v])) {
  // A private event's map must stay on the machine it lives on.
  throw new Error("Private showcase shots run only on a local machine, never in CI or a hosted shell.");
}
if (PRIVATE && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(process.env.SHOWCASE_URL ?? "http://127.0.0.1:5173")) {
  throw new Error("A private run reads only an Oxygen on this machine: SHOWCASE_URL must be http://127.0.0.1:<port> or http://localhost:<port>.");
}
if (!PRIVATE && process.env.SHOWCASE_EVENT && process.env.SHOWCASE_EVENT !== "demo_competition") {
  throw new Error("Public shots come from the Demo Competition only. For another event, set SHOWCASE_PRIVATE=1.");
}

export const OUT_DIR = PRIVATE ? path.join(ROOT, ".local", "showcase-shots") : path.join(ROOT, "docs", "screenshots");
/** Intermediate files (the exported PDF): under .local/ in a private run, and removed after use. */
export const SCRATCH_DIR = path.join(ROOT, ".local", "showcase-scratch");

/**
 * Puit de Laven, the demo map (docs/ops/demo.md, "The map"), lies near
 * 43.58° N, 3.70° E. A public run refuses an event whose map is elsewhere.
 */
const DEMO_MAP_BOX = { south: 43.4, north: 43.8, west: 3.5, east: 3.9 };

/** TRPC writes a private run lets through: choosing the event, and the editor's "who else is here" ping. */
const PRIVATE_WRITES = new Set(["competition.select", "course.presence"]);

/**
 * Call once at the top of every shot file. A public run checks the demo's
 * map; a private run refuses every write but the harmless ones above.
 */
export function showcaseGuards(): void {
  if (!PRIVATE) {
    test.beforeAll(async ({ request }) => {
      const res = await request.get("/trpc/course.mapMetadata", { headers: { "x-competition-id": EVENT } });
      const bounds = (await res.json())?.result?.data?.bounds as { north: number; south: number; east: number; west: number } | undefined;
      const inBox = !!bounds && bounds.south >= DEMO_MAP_BOX.south && bounds.north <= DEMO_MAP_BOX.north && bounds.west >= DEMO_MAP_BOX.west && bounds.east <= DEMO_MAP_BOX.east;
      if (!inBox) {
        throw new Error(
          `The ${EVENT} event here does not carry the CC0 Puit de Laven map (bounds ${JSON.stringify(bounds)}). ` +
            "Public shots go into the docs, so they come only from the demo map: reload it with `pnpm showcase:load`, " +
            "or take these shots as a private run (SHOWCASE_PRIVATE=1).",
        );
      }
    });
  } else {
    test.beforeEach(async ({ page }) => {
      await page.route("**/trpc/**", async (route) => {
        const req = route.request();
        const procs = decodeURIComponent(new URL(req.url()).pathname.split("/trpc/")[1] ?? "").split(",");
        if (req.method() !== "GET" && !procs.every((p) => PRIVATE_WRITES.has(p))) {
          console.warn(`  refused a write in a private run: ${procs.join(", ")}`);
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
    });
  }
}

/** Skip a shot that writes to the event (creating a sheet) in a private run. */
export function changesData(): void {
  test.skip(PRIVATE, "changes data: public demo only");
}

/** Chrome that says nothing to a reader of the docs: the database transactions-per-second pill, presence chips. */
export async function hideNoise(page: Page): Promise<void> {
  await page.addStyleTag({ content: `[data-testid="db-status-button"], [data-testid="editor-presence"] { visibility: hidden !important; }` });
}

/** Write `<name>.png`, of the page or of one element. */
export async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  await hideNoise(page);
  const file = path.join(OUT_DIR, `${name}.png`);
  if (target) await target.screenshot({ path: file, animations: "disabled" });
  else await page.screenshot({ path: file, animations: "disabled" });
  console.log(`  ${path.relative(ROOT, file)}`);
}

/** Remove the scratch folder (an exported PDF is vector data of the map). */
export function clearScratch(): void {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
}

/** Wait until the map viewer has drawn its vector layer. */
export async function mapDrawn(page: Page, timeout = 90_000): Promise<void> {
  await expect(page.getByTestId("map-vector-layer").first()).toHaveAttribute("data-ready", "true", { timeout });
}

/** Make the run's event the selected competition; fails loudly when the API refuses (auth on, or no such event). */
export async function selectEvent(page: Page): Promise<void> {
  const res = await page.request.post("/trpc/competition.select", { data: { nameId: EVENT }, headers: { "x-competition-id": EVENT } });
  if (!res.ok()) throw new Error(`competition.select ${EVENT}: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`);
}

/** Pick the course to feature in the editor's course picker (SHOWCASE_COURSE, else the first). */
export async function pickCourse(page: Page): Promise<void> {
  const picker = page.getByTestId("editor-course-picker");
  const values = await picker.locator("option").evaluateAll((os) => os.map((o) => ({ v: (o as HTMLOptionElement).value, t: (o.textContent ?? "").trim() })));
  const want = COURSE ? values.find((o) => o.t === COURSE) : values.find((o) => o.v);
  if (!want) throw new Error(`course ${COURSE ?? "(first)"} not in the picker: ${values.map((o) => o.t).join(", ")}`);
  await picker.selectOption(want.v);
  await expect(page).toHaveURL(/[?&]course=/, { timeout: 15_000 });
  await mapDrawn(page);
}
