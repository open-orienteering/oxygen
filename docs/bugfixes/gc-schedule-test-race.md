# Bugfix: storage GC schedule test raced its own run

## What happened

`map-storage-gc.test.ts` › "daily schedule" › "runs when it never ran, …"
failed on CI (PR #63, run 39824982200) with
`AssertionError: the given combination of arguments (undefined and string)`
at `expect(result?.documents).toContain(doc)`. Locally the suite passed.

The test started the scheduled run, then awaited a settings read
(`getSetting(GC_SETTINGS.startedAt)`), and only then asked for the run with
`currentStorageGc()`. `maybeStartStorageGc` runs the GC in the background
and clears `running` in its `.finally`. On the CI runner's nearly empty
database the whole run finished during that one settings round trip, so
`currentStorageGc()` returned `null` and `result` was `undefined`. No
`[map-gc] run failed` line was logged: the run itself succeeded.

## Fix

Test only: take the promise (`const run = currentStorageGc()`) right after
`maybeStartStorageGc()` returns `true`, before any other await, and await
it after the settings check. The other schedule tests already take the run
immediately after starting it. `packages/api/src/map-store/gc.ts` is
unchanged — exposing only the in-flight run is its documented contract
(`docs/map-storage.md` §8.3).
