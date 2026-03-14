# E2E Seed Builder

TypeScript scripts that build the E2E test databases programmatically using Prisma, then export them as SQL dumps via `mysqldump`. The committed `e2e/seed*.sql` files are the _outputs_ of these scripts — they are loaded quickly at test run time, but the _source of truth_ is the builder code here.

## Why

The raw mysqldump files (731–531 lines of MeOS binary SQL) are hard to maintain:

- Schema changes require a manual re-dump
- Adding or removing test fixtures means editing opaque INSERT statements
- It's impossible to tell what data actually exists without running the database

The builders replace that with readable TypeScript using the Prisma client.

## Databases

| Builder | Output | Competition |
|---------|--------|-------------|
| `build-itest.ts` | `e2e/seed.sql` | "My example tävling" (`itest`) — main test competition |

> The `seed-multirace.sql` and `seed-test-competition.sql` files are still raw dumps. Add builders for them following the same pattern when they need updating.

## Usage

### Prerequisites

- Local MySQL running at `localhost:3306`, user `meos` (no password, or set `MYSQL_PWD`)
- The `MeOSMain` database exists with an `oEvent` table
- `mysqldump` available in `$PATH`
- Packages installed: `pnpm install` from the repo root

### Regenerate `itest`

```bash
# From the repo root:
cd packages/api

DATABASE_URL="mysql://meos@localhost:3306/itest" \
MEOS_MAIN_DB_URL="mysql://meos@localhost:3306/MeOSMain" \
pnpm tsx ../../e2e/seed-builder/build-itest.ts
```

The script will:
1. Drop and recreate the `itest` MySQL database
2. Push the current Prisma schema (`prisma db push`)
3. Insert all test data via Prisma client
4. Run `mysqldump` and write the output to `e2e/seed.sql`

After running, commit the updated `e2e/seed.sql`.

### Modifying test data

Edit the data arrays in `build-itest.ts` (clubs, controls, courses, classes, runners, cards), then re-run the builder. The SQL file will update automatically.

### Adding a new builder

Follow the same structure as `build-itest.ts`:

1. Call `recreateDb()` to drop/recreate the target database and register it in MeOSMain
2. Call `pushSchema()` to apply the Prisma schema
3. Insert data using the `PrismaClient`
4. Call `dumpToSql()` to write the output SQL file
