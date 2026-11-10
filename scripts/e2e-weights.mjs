/**
 * Relative run-time weights per spec file for the sharded E2E runner
 * (`scripts/e2e-sharded.mjs`, LPT assignment; docs/e2e-sharding.md
 * "File partitioning"). Rough proportions only — rebalance using the
 * per-shard durations printed after each full run. One unit is about 8 s
 * of a shard's wall time.
 *
 * A file that more than one Playwright project runs (`playwright.config.ts`:
 * `course-editor.spec.ts` under `chromium` and `mobile`) is listed per
 * project, `{ "<project>": weight }`, and its weight is the
 * sum: the shard that gets it runs it once per project.
 * `scripts/__tests__/e2e-config.test.mjs` fails when such a file's entry
 * does not name exactly the projects that run it. A plain number is a
 * file run by one project.
 */
export const WEIGHTS = {
  // The course editor (D10): every desktop flow under `chromium`; only the touch describe under `mobile`
  // (the desktop describes skip there, the fixture import still runs per test).
  "course-editor.spec.ts": { chromium: 32, mobile: 4 }, // ~240 s + ~35 s single run (D10, E3)
  "course-presence.spec.ts": 4, // OCAD+map, two contexts, 5 s polls
  // `mobile` project: OCAD+map, 11 Field mode flows (~50s single run).
  "field-mode.spec.ts": { mobile: 5 },
  "registration-dialog.spec.ts": 8, // ~63s — reseed, dual pages, watchdog
  "rental-cards.spec.ts": 4, // ~28s
  "kiosk.spec.ts": 3, // ~22s after merges (still has 5s auto-reset)
  "controls.spec.ts": 3, // ~22s
  "courses.spec.ts": 3, // ~21s — OCAD/ppen imports
  "phase2.spec.ts": 3, // ~21s
  "course-maps.spec.ts": 4, // Courses page overview + Layout sheet/template/club actions + PDF exports (E-pages)
  "phase3.spec.ts": 3, // ~20s
  "kiosk-readout.spec.ts": 3, // ~20s — dual contexts + 5s auto-reset
  "offline.spec.ts": 3, // ~19s — drain polling
  "draw.spec.ts": 3, // ~18s
  "wide-screen-map-pane.spec.ts": 3, // ~18s
  "editor-start-finish.spec.ts": 3, // ~18s — fresh event + map
  "mobile-layout.spec.ts": 3, // ~18s — touch + map upload
  "permissions.spec.ts": 3, // ~18s
  "webserial.spec.ts": 2, // ~16s
  "control-series.spec.ts": 3, // ~15s — library + map upload
  "map-multicourse.spec.ts": 4, // OCAD replace-all + wide viewport
  "map-control-circles.spec.ts": 3,
  "map-viewer-gestures.spec.ts": 2,
  "map-vector-layer.spec.ts": 4, // pixel probes + E3: no WebGL2, lost context, no pin, unaligned stack
  "kiosk-smart.spec.ts": 2, // ~14s after merges
  "printer-settings.spec.ts": 2,
  "eventor.spec.ts": 2,
  "classes.spec.ts": 2,
  "error-paths.spec.ts": 2,
  "competition.spec.ts": 2,
  "event.spec.ts": 2,
  "club-map-library.spec.ts": 2,
};

export const DEFAULT_WEIGHT = 2;

/** A spec file's total weight: the sum over the projects that run it (a plain number is one run). */
export function weightOf(file) {
  const w = WEIGHTS[file];
  if (w === undefined) return DEFAULT_WEIGHT;
  if (typeof w === "number") return w;
  return Object.values(w).reduce((sum, v) => sum + v, 0);
}
