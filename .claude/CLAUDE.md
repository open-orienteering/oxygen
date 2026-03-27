# Claude Code Instructions for Oxygen

Read and follow all rules in [`AGENTS.md`](../AGENTS.md) at the project root. That file is the single source of truth for development rules, test requirements, verification steps, and coding conventions.

## Claude-Specific Behavior

These are automatic behaviors that Claude Code should perform without being asked:

- **After any code change**: Run `pnpm test` immediately.
- **After tests pass**: Run `pnpm build` to verify zero TypeScript errors.
- **After completing a feature or fix**: Rebuild Docker automatically: `docker compose -f docker-compose.host-db.yml up --build -d`
- **Before pushing code**: Run the full E2E suite: `pnpm test:e2e`. Fix failures before pushing.

## Documentation Requirement

**Every feature or significant change must include documentation updates** (AGENTS.md §10). This includes:
- Update `docs/features.md` for user-facing features
- Update the relevant technical doc in `docs/` (architecture, registration-and-readout, etc.)
- For bug fixes: create `docs/bugfix-<name>.md` explaining what happened and how it was fixed
- Do not consider a task complete until documentation is updated

## Known Pre-Existing Issues

- Build errors in `clubRouter.ts`, `eventor.ts`, and `index.ts` related to `oxygen_club_logo` are known Prisma schema issues — they do not block the build and are not caused by your changes.
