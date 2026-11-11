/**
 * The editor's top bar collapses in two tiers when `MapPanel`'s
 * `map-toolbar` row is short (docs/course-editor.md §2 "Top bar", F29).
 * `map-toolbar` is a CSS `@container` (`@container/toolbar`); these are
 * container-query classes on that row's content width (inside its
 * padding), not the viewport's.
 *
 * - **Tier 1** (row under `TIER1_PX`): the labels of Hide other controls,
 *   Auto slits, Hide descriptions and Export, and the course picker's
 *   "Course" word, are hidden; the buttons keep their icons.
 * - **Tier 2** (row under `TIER2_PX`): the mode switch (Course / Layout /
 *   Field) shows its icons alone.
 *
 * A hidden word is `display: none`; every control keeps its `aria-label`
 * and `title`, so the accessible name does not change. `flex-wrap` on the
 * top bar stays as the last resort. The thresholds are measured on the
 * E2E seed (`e2e/editor-top-bar.spec.ts`): the row's widest content with
 * every label shown, and with tier 1 applied. Tailwind needs the class
 * strings literal, so the numbers appear twice.
 */
export const TIER1_PX = 1600;
export const TIER2_PX = 1170;

/** On a label: hidden below tier 1. */
export const TOP_BAR_TIER1_HIDE = "@max-[1600px]/toolbar:hidden";
/** On a mode word: hidden below tier 2. */
export const TOP_BAR_TIER2_HIDE = "@max-[1170px]/toolbar:hidden";
/** On a mode icon: shown (as `inline-flex`) below tier 2 only. */
export const TOP_BAR_TIER2_SHOW = "hidden @max-[1170px]/toolbar:inline-flex";
