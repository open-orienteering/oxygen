/**
 * Playwright global teardown.
 *
 * The new Postgres backend uses a dedicated `oxygen_e2e` database for E2E
 * runs, so nothing here needs to "restore" anything against the developer's
 * working DB. Suite-internal state is wiped at the start of the next run
 * by global-setup. Kept as a no-op stub so swapping back is easy if we ever
 * need cross-run state preservation again.
 */
export default async function globalTeardown(): Promise<void> {
  // No-op.
}
