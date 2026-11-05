# Bugfix: `course-maps.spec.ts` "creates templates, lays out several maps" flake

## Symptom

`e2e/course-maps.spec.ts:82` failed three times in full sharded runs (shard 3,
`map-legacy` project, `expect(locator).toBeVisible()` about 7 s into the test)
and passed on every selective run.

## What was established

- The spec cannot be disturbed by another project or spec: `workers: 1`, and
  each shard has its own database and stack (`scripts/e2e-sharded.mjs`).
- It did not reproduce here: 6 repeats of the spec under `map-legacy` and one
  full sharded run (all four shards) passed. The failure artifacts of the
  original runs were no longer available, so **the cause below is identified
  by reading the test against the page, not by catching a failure**.

## Cause (most likely)

Two steps in the test fire a page mutation that the page does not await, then
act on the result of its refetch:

1. `save-template-to-club-*` calls `mapTemplate.saveToClub` fire-and-forget; the
   test immediately opens the club-template dialog and expects the saved row.
   The row only appears after the write *and* the `listClub` invalidation
   refetch have both completed. Under shard load the shared Postgres answers
   trivial queries in 3–5 s (see PR #45 notes), so write plus refetch can
   exceed the 10 s default budget. About 7 s into the test is where this step
   sits.
2. `apply-map-template` calls `mapTemplate.applyToCourses` the same way, then
   the test expands the course row and waits for its map group.

## Fix

The test arms `waitForTrpc()` (batch-aware, PR #45) before each click and awaits
the mutation response before moving on. No assertion or timeout was changed.

## Verification

10 repeats of the spec under both projects (40 tests) and one full sharded E2E run (4 shards) passed under the lock after the change.
