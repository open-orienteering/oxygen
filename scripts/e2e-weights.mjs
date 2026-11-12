/**
 * Run-time weights per spec file for the sharded E2E runner
 * (`scripts/e2e-sharded.mjs`, LPT assignment; docs/e2e-sharding.md
 * "File partitioning"). One unit is one second of a CI shard: the file's
 * summed test durations (the `list` reporter's per-test times) on one
 * `ubuntu-latest` runner with one stack, as the CI matrix runs it.
 * Measured 2026-11-12: PR #172's first matrix run, averaged with four
 * earlier two-stack runs scaled to it. A file split off the editor's spec
 * carries 8 s more for its own `reseed()` and first fixture import.
 * Refresh from a CI run's logs when a shard's time drifts from its weight
 * (docs/e2e-sharding.md "CI").
 *
 * A file that more than one Playwright project runs is listed per
 * project, `{ "<project>": weight }`, and its weight is the sum: the shard
 * that gets it runs it once per project. Today every file runs in one
 * project; the two `mobile` files say so with `{ mobile: n }`.
 * `scripts/__tests__/e2e-config.test.mjs` fails when an object entry does
 * not name exactly the projects that run its file. A plain number is a
 * file run by `chromium`.
 */
export const WEIGHTS = {
  "course-editor.spec.ts": 132, // the editor's core: GL canvas, Course mode, descriptions, cuts, checks, F7
  "course-editor-tools.spec.ts": 111, // the tool chain, the filter symbol picker
  "course-editor-legs.spec.ts": 102, // F3 legs, F13 Bézier bends, F23 tablet bend drags
  "course-editor-status.spec.ts": 77, // two-context conflicts, P2 save state, P6 map info, F5 exchange
  "course-editor-layout.spec.ts": 76, // Layout mode, templates, setter maps, description sheets, white-outs
  "course-editor-placing.spec.ts": 65, // P1/P4/P5 placing, F4 crossings, F27 placement loupe
  "field-mode.spec.ts": { mobile: 62 }, // OCAD+map, Field mode flows
  "registration-dialog.spec.ts": 46,
  "course-presence.spec.ts": 45,
  "map-vector-layer.spec.ts": 41,
  "map-gl-doc.spec.ts": 39,
  "map-gl-golden.spec.ts": 34,
  "course-editor-phone.spec.ts": { mobile: 31 }, // the editor's phone subset (touch, F3/F7 on a phone)
  "editor-url.spec.ts": 30, // F31: five flows, two reloads each; not yet measured in CI
  "courses.spec.ts": 23,
  "controls.spec.ts": 22,
  "course-maps.spec.ts": 19,
  "kiosk-smart.spec.ts": 19,
  "kiosk.spec.ts": 19,
  "offline.spec.ts": 18,
  "wide-screen-map-pane.spec.ts": 18,
  "kiosk-readout.spec.ts": 17,
  "permissions.spec.ts": 17,
  "phase3.spec.ts": 17,
  "classes.spec.ts": 16,
  "webserial.spec.ts": 16,
  "control-series.spec.ts": 15,
  "club-map-library.spec.ts": 14,
  "editor-fullscreen.spec.ts": 13,
  "event-selector.spec.ts": 13,
  "mobile-layout.spec.ts": 13,
  "phase2.spec.ts": 13,
  "eventor.spec.ts": 11,
  "printer-settings.spec.ts": 11,
  "rental-cards.spec.ts": 11,
  "competition.spec.ts": 9,
  "editor-start-finish.spec.ts": 9,
  "draw.spec.ts": 8,
  "error-paths.spec.ts": 8,
  "map-multicourse.spec.ts": 8,
  "structured-search-names.spec.ts": 8,
  "auth.spec.ts": 7,
  "event.spec.ts": 7,
  "structured-search-or.spec.ts": 7,
  "backup.spec.ts": 6,
  "class-presets.spec.ts": 6,
  "map-review.spec.ts": 6,
  "red-exit.spec.ts": 6,
  "editor-space.spec.ts": 4,
  "lease.spec.ts": 4,
  "start-screen.spec.ts": 4,
  "card-history.spec.ts": 3,
  "discovery.spec.ts": 3,
  "editor-top-bar.spec.ts": 3,
  "map-control-circles.spec.ts": 3,
  "map-documents.spec.ts": 3,
  "map-viewer-gestures.spec.ts": 3,
  "online-input-config.spec.ts": 3,
  "progressive-menus.spec.ts": 3,
  "registration-trends.spec.ts": 3,
  "runners-bulk.spec.ts": 3,
  "session-recovery.spec.ts": 3,
  "trpc-batch-matching.spec.ts": 3,
};

export const DEFAULT_WEIGHT = 10;

/** A spec file's total weight: the sum over the projects that run it (a plain number is one run). */
export function weightOf(file) {
  const w = WEIGHTS[file];
  if (w === undefined) return DEFAULT_WEIGHT;
  if (typeof w === "number") return w;
  return Object.values(w).reduce((sum, v) => sum + v, 0);
}

/**
 * LPT partition of spec files (base names) into `count` shards: heaviest
 * first, each into the currently lightest shard; ties go to the lower
 * shard and equal weights keep name order, so the split is a pure function
 * of the file list. The local runner and every CI matrix job compute the
 * same split from it, and each CI job runs only its own entry.
 */
export function partition(specs, count, weigh = weightOf) {
  const shards = Array.from({ length: count }, () => ({ files: [], weight: 0 }));
  const byWeightDesc = [...specs]
    .sort()
    .sort((a, b) => weigh(b) - weigh(a));
  for (const file of byWeightDesc) {
    const lightest = shards.reduce((min, s) => (s.weight < min.weight ? s : min));
    lightest.files.push(file);
    lightest.weight += weigh(file);
  }
  return shards;
}
