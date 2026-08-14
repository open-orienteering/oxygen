/**
 * Seed builder for the `itest_multirace` event ("Multi-Race Series").
 *
 * The legacy MeOS dump for this event was essentially empty (just the
 * oEvent row), so we mirror that here — a single event with no entries,
 * classes, or controls. Tests use it primarily to verify
 * empty-state UI and competition switching.
 */
import { newPrisma, recreateEvent } from "./shared.js";

export async function buildMultirace(databaseUrl?: string) {
  console.log(`  [seed:multirace] Building "itest_multirace"...`);
  const prisma = newPrisma(databaseUrl);
  try {
    const event = await recreateEvent(prisma, {
      nameId: "itest_multirace",
      name: "Multi-Race Series",
      date: "2026-03-15",
    });
    // Mark as Eventor-linked so the e2e tests can exercise the Eventor
    // sync panel on a competition that has no runners (linked = true
    // requires eventorEventId).
    await prisma.event.update({
      where: { id: event.id },
      data: { eventorEventId: 90001, eventorEnv: "test" },
    });
    console.log(`  [seed:multirace] Done.`);
  } finally {
    await prisma.$disconnect();
  }
}

// CLI entry (`pnpm exec tsx e2e/seed-builder/build-multirace.ts`); no-op
// when imported by global-setup / reseed. argv check instead of
// import.meta — Playwright's TS transform compiles this file to CJS
// where import.meta is unavailable.
if (process.argv[1]?.endsWith("build-multirace.ts")) {
  buildMultirace().catch((err) => {
    console.error("[seed:multirace] failed:", err);
    process.exit(1);
  });
}
