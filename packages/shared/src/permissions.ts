/**
 * Named capabilities for per-event grants.
 * Instance admins receive every capability; AUTH_MODE=off bypasses checks.
 */

export const ALL_CAPABILITIES = [
  "event.view",
  "event.manage",
  "courses.view",
  "courses.edit",
  "race.operate",
  "results.view",
] as const;

export type Capability = (typeof ALL_CAPABILITIES)[number];

export function isCapability(value: unknown): value is Capability {
  return (
    typeof value === "string" &&
    (ALL_CAPABILITIES as readonly string[]).includes(value)
  );
}

/** Fixed UUIDs for the four seeded system groups (shared across instances). */
export const SYSTEM_GROUP_IDS = {
  eventAdmin: "01990e00-0000-7000-8000-000000000001",
  courseSetter: "01990e00-0000-7000-8000-000000000002",
  raceCrew: "01990e00-0000-7000-8000-000000000003",
  member: "01990e00-0000-7000-8000-000000000004",
} as const;

export const SYSTEM_GROUP_CAPABILITIES: Record<
  keyof typeof SYSTEM_GROUP_IDS,
  readonly Capability[]
> = {
  eventAdmin: ALL_CAPABILITIES,
  courseSetter: ["event.view", "courses.view", "courses.edit"],
  raceCrew: ["event.view", "race.operate", "results.view"],
  member: ["event.view", "results.view"],
};
