/**
 * Prisma 7 CLI configuration. Replaces the schema-file `url = env(...)`
 * datasource and the package.json "prisma" block. Environment variables
 * are no longer auto-loaded by the CLI, so pull in dotenv explicitly —
 * the CLI always runs with cwd = packages/api (pnpm --filter), where the
 * .env lives.
 */
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
