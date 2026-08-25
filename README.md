# Oxygen — Lightweight orienteering management

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https://github.com/open-orienteering/oxygen&cloudshell_tutorial=docs/demo.md)

A modern web application for managing orienteering competitions — from entry and course setup through start draw, SI card readout, and live results. Built by [Open Orienteering](https://github.com/open-orienteering). Inspired by [MeOS](http://www.melin.nu/meos), rebuilt as a Progressive Web App with direct [Eventor](https://eventor.orientering.se) integration.

> **Note (May 2026):** Oxygen previously stored data in a MeOS-compatible MySQL layout. That compatibility layer was dropped in May 2026 — the app now runs on a single PostgreSQL 18 database (`oxygen` schema). See [`docs/migrations/2026-drop-meos.md`](docs/migrations/2026-drop-meos.md) for the migration story and the one-shot CLI that moves a MeOS database into the new schema.

## Features

- **Competition management** — create and manage events, races, and classes
- **Eventor integration** — sync entries, competitors, and clubs directly from the Swedish Orienteering Federation's API; upload results and start lists back
- **Course management** — import courses from OCAD/IOF XML, manage controls and legs
- **Start draw** — automated start time allocation with configurable algorithms
- **SI card readout** — read SportIdent cards via Web Serial, process punches and compute results live
- **Live results** — real-time result updates as cards are read
- **Kiosk mode** — self-service registration and start/finish station interfaces
- **PostgreSQL 18** — single-database design with UUIDv7 PKs, JSONB columns, native enums, and foreign-key integrity

See the [feature showcase](docs/features.md) for screenshots of every view.

## Architecture

| Layer | Technologies |
|-------|-------------|
| Frontend | React 19, Vite 8, Tailwind CSS v4, TanStack Query v5, React Router v7 |
| Backend | Fastify 5, tRPC 11 (end-to-end type safety), Zod 4 |
| Database | PostgreSQL 18 (`oxygen` schema), Prisma 7 ORM |
| Testing | Playwright 1.62 E2E, Vitest 4 unit tests |

```
oxygen/
  packages/
    api/      # Fastify + tRPC backend
    web/      # React PWA frontend
    shared/   # Shared types and utilities
  e2e/        # Playwright E2E tests
  docs/       # Guides and tutorials
```

For a deeper dive into database design, deployment options, and subsystem details, see the [technical architecture](docs/architecture.md).

## Quick Start

### With Docker (recommended)

```bash
git clone https://github.com/open-orienteering/oxygen
cd oxygen
cp packages/api/.env.example packages/api/.env
docker compose up -d        # starts PostgreSQL 18
pnpm install
pnpm db:push                # apply the oxygen schema
pnpm db:generate
pnpm dev                    # API on :3002, web on :5173
```

### Manual setup

Prerequisites: Node.js >= 20, pnpm >= 10, PostgreSQL 18

```bash
pnpm install
# Edit packages/api/.env so DATABASE_URL points at your PostgreSQL,
# e.g. postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen
pnpm db:push
pnpm db:generate
pnpm dev
```

See [packages/api/.env.example](packages/api/.env.example) for all environment variables.

## Try It Online

Click the **Open in Cloud Shell** button at the top of this page to spin up a fully working instance in your browser — no local install needed. The [Cloud Shell tutorial](docs/demo.md) walks you through loading demo data or connecting your Eventor API key.

## Eventor API Key

If you have access to the Swedish Orienteering Federation's Eventor system, you can connect Oxygen directly:

1. Log in to [eventor.orientering.se](https://eventor.orientering.se) → your profile → API key
2. Open Oxygen → Settings → paste the key

This syncs entries, clubs, and competitors automatically and lets you upload results/start lists back to whichever Eventor the event is linked to — Test-Eventor or production.

## License

[GNU Affero General Public License v3.0](LICENSE) — free to use and modify; derivatives must remain open source, including when deployed as a hosted service.
