/**
 * Seed builder for the `meos_20251222_001121_2BC` event ("Test competition").
 *
 * The legacy MeOS dump for this event held only the oEvent row plus a few
 * fee defaults. We replicate the same minimal shape — error-paths tests
 * use it to verify hard-coded ID handling and event-not-found scenarios.
 */
import { newPrisma, recreateEvent } from "./shared.js";

export async function buildTestCompetition(databaseUrl?: string) {
  console.log(`  [seed:test-competition] Building "meos_20251222_001121_2BC"...`);
  const prisma = newPrisma(databaseUrl);
  try {
    await recreateEvent(prisma, {
      nameId: "meos_20251222_001121_2BC",
      name: "Test competition",
      date: "2026-04-01",
      // Legacy MeOS event had ZeroTime=21600 (06:00:00) — preserve for any
      // test that checks ZeroTime-relative arithmetic against this event.
      zeroTime: 216000,
    });
    console.log(`  [seed:test-competition] Done.`);
  } finally {
    await prisma.$disconnect();
  }
}

// CLI entry (`pnpm exec tsx e2e/seed-builder/build-test-competition.ts`);
// no-op when imported by global-setup / reseed. argv check instead of
// import.meta — Playwright's TS transform compiles this file to CJS
// where import.meta is unavailable.
if (process.argv[1]?.endsWith("build-test-competition.ts")) {
  buildTestCompetition().catch((err) => {
    console.error("[seed:test-competition] failed:", err);
    process.exit(1);
  });
}
