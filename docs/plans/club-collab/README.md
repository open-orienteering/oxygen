# Club Collaboration Feature — Process & Phase Index

Master plan for the collaborative club event management feature set. Each phase
has a self-contained spec in this directory, written to be executed by an
implementation agent without further architectural decisions.

## Decisions already made (do not re-litigate during execution)

- **Single owning club per instance.** Other clubs exist only as labels on
  borrowed control series. No multi-tenancy.
- **No password handling in Oxygen.** Identity comes from a trusted reverse
  proxy / IdP header (oauth2-proxy, Cloudflare Access, GCP IAP). Oxygen keeps
  a `users` table keyed by email and an invite-only provisioning model.
- **Login required by default** once auth is enabled, except explicitly public
  surfaces (kiosk, start screen) which are enumerated per spec.
- **Menu progression is automatic** — derived from event content signals, no
  stored phase field. Everything stays reachable via the More overflow.

## Phase order and dependencies

| Phase | Spec | Depends on |
|-------|------|------------|
| 1 | [phase-1-event-selector.md](phase-1-event-selector.md) | — |
| 2 | [phase-2-progressive-menus.md](phase-2-progressive-menus.md) | — |
| 3 | [phase-3-auth-foundation.md](phase-3-auth-foundation.md) | — |
| 4 | [phase-4-permissions.md](phase-4-permissions.md) | 3 |
| 5 | [phase-5-club-map-library.md](phase-5-club-map-library.md) | 3 (uploader attribution) |
| 6 | [phase-6-control-series.md](phase-6-control-series.md) | 3; shares library UI with 5 |
| 7 | [phase-7-library-polish.md](phase-7-library-polish.md) | 4, 5 |
| 8 | [phase-8-editor-enhancements.md](phase-8-editor-enhancements.md) | 6 |
| 9 | [phase-9-class-presets.md](phase-9-class-presets.md) | 5 (library UI) |

Phases 1, 2, 3 are mutually independent and may be executed in any order or in
parallel worktrees. Phase 4 requires 3. Phases 5 and 6 require 3 and should
land after 5's "Club library" page exists (phase 6 adds a second tab to it).

Phases 7–9 are follow-ups from the first user review of phases 4–6
(library/visibility polish, course-editor enhancements, club class
presets). They are mutually independent and may be executed in any
order; each still follows the execution protocol below.

## Branch and workflow

- All work happens on the feature branch **`feature/club-collab`**, branched
  from `main`. This directory (`docs/plans/club-collab/`) is committed as the
  first commit on that branch.
- Each phase is one commit series on the branch (or a short-lived
  `club-collab/phase-N` sub-branch merged back). Do not open PRs to `main`
  per phase; the whole set ships as one PR at the end.
- Each phase must independently pass the full AGENTS.md §6 verification
  checklist before the next dependent phase starts: `pnpm build`, `pnpm test`,
  integration suite, targeted then full E2E, Docker rebuild.
- New Prisma models always come with a dated migration
  (`YYYYMMDDHHMMSS_description`) applied via `prisma migrate deploy` — never
  `db push` alone.

## Execution protocol (for the implementing agent)

1. Read this README and the phase spec in full before touching code.
2. Follow AGENTS.md TDD rules: failing tests first, then implementation.
   Every spec lists the required test files and cases — treat those as the
   minimum, not the ceiling.
3. Stay inside the phase scope. If the spec conflicts with reality (schema
   drift, renamed file), fix the trivial mismatch and note it in the final
   summary; if the conflict is architectural, stop and report instead of
   improvising.
4. All user-facing strings go in both `en` and `sv` locale files.
5. Each phase updates `docs/features.md` and adds/extends its own doc page as
   listed in the spec.
6. End every phase with the §6 checklist output pasted into the final summary.

## Final verification gate (review model, after all phases)

Before the PR to `main` is opened, a separate review pass must:

1. Re-run the full §6 checklist from a clean checkout of the branch.
2. Perform the AGENTS.md §11 code-review checklist across the whole diff,
   with emphasis on: capability enforcement coverage (every event-scoped
   mutating procedure gated), no secrets/PII in logs, migration ↔ schema
   parity, i18n completeness (both locales, typed keys compile).
3. Cross-phase consistency: phase 2's tab relevance and phase 4's capability
   filtering compose correctly in `CompetitionShell`; phase 6's allocation
   respects phase 5's library page structure.
4. Manual smoke pass in the browser: fresh event flow (stripped menus →
   grows), unauthenticated access blocked, kiosk still reachable, club map
   copy-on-use, series-based code allocation.
5. Decide whether this `docs/plans/club-collab/` directory is pruned or kept
   in the merge commit (default: keep, it documents the design).
