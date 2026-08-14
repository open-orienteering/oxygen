# Web Lint Policy

`pnpm lint` must exit clean (zero errors) across all three packages. This
document explains the two deliberate deviations from the ESLint presets in
`packages/web/eslint.config.js`.

## React Compiler diagnostics are warnings, not errors

The August 2026 dependency drift sweep bumped `eslint-plugin-react-hooks`
to v7, whose `recommended` preset enables the React Compiler diagnostics
(`set-state-in-effect`, `refs`, `purity`, `immutability`,
`preserve-manual-memoization`, `use-memo`) as **errors**. That instantly
put ~60 violations into a codebase written before those rules existed —
latest-ref patterns, imperative canvas/ref code, sync-from-props effects.
All of it is working, E2E-covered code.

Rewriting 60 call sites in one sweep is exactly the kind of high-risk,
low-value refactor this project avoids, so those six rules are downgraded
to `warn`:

- **New code** should not add warnings — treat a new warning in your diff
  as a review finding.
- **Existing warnings** (~85 as of this writing) are burn-down material:
  fix them opportunistically when you're already touching the component,
  with test coverage, not in bulk.

Everything else from the presets (including `@typescript-eslint/no-explicit-any`
and `no-unused-vars`) stays at error severity. `no-unused-vars` ignores
`_`-prefixed identifiers, which is the conventional way to mark an
intentionally unused binding.

## `react-refresh/only-export-components` is off for `src/context/`

React context modules export a provider component plus its companion
hook(s) — the standard pattern. Fast-refresh purity can't be satisfied
there without splitting every context into two files for no runtime
benefit. The rule stays on everywhere else; the one non-context exception
(`hitTestControl` in `ReplayCourseLayer.tsx`) carries an inline disable
with justification.

## Known issue found during the cleanup

`cardReadout.readoutHistory` returned only `{id, cardType, voltageMv,
readAt, stationId}`, but the `ReadoutHistorySection` in `CardsPage.tsx`
renders punch, battery, and owner fields — the old `as any` cast hid
that they were never present. Fixed in the follow-up PR; see
`docs/bugfix-readout-history-empty.md`.
