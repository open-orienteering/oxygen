# Bugfix: structured search dropped chips on rapid consecutive commits

## What happened

Committing two atoms in quick succession in the structured search bar
could silently drop the first one. Reproduced deterministically by the
E2E test `structured-search-or.spec.ts` ("typing class:foo|class:bar …")
under the 4-shard load of a full `pnpm test:e2e` run: after
`class:"Öppen 1"` + `|` + `class:"Öppen 2"` + Enter, only a plain
"Öppen 2" chip existed — no OR group, and the "Öppen 1" atom was gone.
The same race can hit fast human typing.

## Why

`StructuredSearchBar` is a controlled component: the token tree lives in
the URL (`useStructuredSearch` → `useSearchParams`). Every edit calls
`onTokensChange(next)`, which triggers an async router navigation before
the new tree comes back down as the `tokens` prop. All tree edits were
computed from the `tokens` prop, so a second edit that landed before the
round-trip completed was based on the stale tree — wiping out the first
edit. Slower machines widen the window; the sharded E2E run (4 stacks in
parallel) hit it every time while a standalone run never did.

## Fix

The bar now keeps `latestTokensRef`, updated eagerly by every local edit
(`emitTokens`) and synced from the prop only when the prop reference
actually changes (external updates, e.g. deep links). All tree edits —
append, remove, edit-in-place, negation toggles, backspace pop, clear —
read from the ref instead of the prop, so consecutive edits compose
correctly regardless of how long the parent round-trip takes.

## Tests

The existing E2E spec `e2e/structured-search-or.spec.ts` is the
regression test: it consistently failed in full sharded runs before the
fix and passes after. The tree-edit operations themselves were already
covered by `packages/web/src/lib/structured-search/__tests__/edit-ops.test.ts`
(the bug was in state plumbing, not the operations).
