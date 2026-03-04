# Oxygen — Lightweight orienteering management

A modern web application for managing orienteering competitions. Built by [Open Orienteering](https://github.com/open-orienteering). Inspired by [MeOS](http://www.melin.nu/meos), rebuilt as a Progressive Web App.

## Architecture

- **Frontend**: React 19 + Vite + Tailwind CSS v4 + TanStack Query
- **Backend**: Fastify + tRPC (end-to-end type safety)
- **Database**: MySQL (compatible with existing MeOS databases), PostgreSQL planned
- **Testing**: Playwright E2E tests

## Quick Start

### Prerequisites

- Node.js >= 20
- pnpm >= 10
- MySQL server (local or via Docker)

### Setup

```bash
# Install dependencies
pnpm install

# Generate Prisma client
pnpm db:generate

# Start development servers (API on :3001, Web on :5173)
pnpm dev
```

### Environment Variables

Copy `packages/api/.env.example` to `packages/api/.env` and adjust:

```env
DATABASE_URL="mysql://meos@localhost:3306/itest"
MEOS_MAIN_DB_URL="mysql://meos@localhost:3306/MeOSMain"
PORT=3001
```

### Using Docker for MySQL

```bash
docker compose up -d
```

### Running Tests

```bash
# Run E2E tests (starts servers automatically if not running)
pnpm test:e2e
```

## Project Structure

```
oxygen/
  packages/
    api/          # Fastify + tRPC backend
    web/          # React PWA frontend
    shared/       # Shared types, constants, utilities
  e2e/            # Playwright E2E tests
```

## Current Status (Phase 1)

- [x] Project scaffolding (monorepo, pnpm workspace)
- [x] Prisma schema matching MeOS MySQL database
- [x] tRPC API: list competitions, select competition, dashboard, runners, clubs
- [x] React UI: competition selector, competition dashboard with classes/runners
- [x] Playwright E2E test suite (9 tests)
- [ ] PWA service worker setup
- [ ] Docker Compose MySQL seeding

## License

TBD
