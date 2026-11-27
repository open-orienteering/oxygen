/**
 * Which capability a journal entry needs when it arrives through
 * `events.push` from a signed-in user (a station's outbox drain).
 *
 * The online procedures that make the same change already gate on a
 * capability; a queued entry must not be a way around that gate. The map
 * mirrors them (docs/system/authentication.md "Journal push"):
 *
 *   race.operate  card / punch / finish / start / result entries and a
 *                 station registration (`runner.registered`, online
 *                 `runner.create`)
 *   event.manage  `runner.updated`, `runner.deleted`, `start.adjusted`,
 *                 `class.upserted`
 *   courses.edit  `course.upserted`, `control.upserted`, `reference.imported`
 *
 * One exception: `runner.updated` whose `fields` is exactly `{ finishTime }`
 * is the finish station's confirmed overwrite (online `race.recordFinish`,
 * `race.operate`), so it needs only `race.operate`.
 *
 * A `reference.imported` that carries classes writes whole class rows, so on
 * this path it needs `event.manage` as well as `courses.edit`
 * (`capabilitiesForEntry` lists every capability an entry needs).
 *
 * `null` means the type is not known here and the entry is refused.
 * Node-to-node pushes carry the shared secret instead and skip this map.
 */

import type { Capability } from "@oxygen/shared";

const RACE_OPERATE = [
  "card.read",
  "result.applied",
  "finish.recorded",
  "start.recorded",
  "runner.registered",
  "finish.adjusted",
  "punch.recorded",
  "punch.removed",
  "punch.updated",
] as const;

const EVENT_MANAGE = [
  "start.adjusted",
  "runner.updated",
  "runner.deleted",
  "class.upserted",
] as const;

const COURSES_EDIT = [
  "course.upserted",
  "control.upserted",
  "reference.imported",
] as const;

const BY_TYPE: ReadonlyMap<string, Capability> = new Map<string, Capability>([
  ...RACE_OPERATE.map((t) => [t, "race.operate"] as [string, Capability]),
  ...EVENT_MANAGE.map((t) => [t, "event.manage"] as [string, Capability]),
  ...COURSES_EDIT.map((t) => [t, "courses.edit"] as [string, Capability]),
]);

export function capabilityForEntry(entry: {
  type: string;
  payload: Record<string, unknown>;
}): Capability | null {
  if (entry.type === "runner.updated") {
    const fields = entry.payload.fields;
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      const keys = Object.keys(fields);
      if (keys.length === 1 && keys[0] === "finishTime") return "race.operate";
    }
  }
  return BY_TYPE.get(entry.type) ?? null;
}

/**
 * Every capability the entry needs, the one `capabilityForEntry` names first.
 * `reference.imported` with a non-empty `classes[]` also needs `event.manage`.
 * `null` for an unknown type.
 */
export function capabilitiesForEntry(entry: {
  type: string;
  payload: Record<string, unknown>;
}): Capability[] | null {
  const primary = capabilityForEntry(entry);
  if (!primary) return null;
  if (
    entry.type === "reference.imported" &&
    Array.isArray(entry.payload.classes) &&
    entry.payload.classes.length > 0
  ) {
    return [primary, "event.manage"];
  }
  return [primary];
}
