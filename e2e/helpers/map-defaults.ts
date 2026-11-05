/**
 * The E2E stack's map pipeline default (docs/map-pipeline-switch.md §5): one
 * value for the seed (`e2e/seed-builder/shared.ts` `seedMapDefaults`) and the
 * test helper (`e2e/helpers/map-pipeline.ts`). No imports, so both the
 * seed's tsx process and Playwright's transform load it.
 */
export const DEFAULT_MAP_PIPELINE = "vector" as const;
