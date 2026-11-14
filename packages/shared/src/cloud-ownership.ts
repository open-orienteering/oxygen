/**
 * Cloud-owned tRPC mutations (docs/offline-architecture.md "Ownership
 * follows the journal").
 *
 * On a venue node these are forwarded to the cloud and executed there
 * (`packages/api/src/sync/venueForwarder.ts`); the venue never writes
 * them locally. The list lives in shared because the web sends these
 * mutations in a batch of their own (`packages/web/src/lib/trpc-links.ts`):
 * the forwarder forwards a batch only when every procedure in it is
 * cloud-owned, and refuses a batch that mixes them with local ones.
 * Everything not listed executes locally, so an ambiguous endpoint degrades
 * to "works offline" rather than "breaks at the venue".
 */

/** Mutation path prefixes that always belong to the cloud. */
export const CLOUD_OWNED_MUTATION_PREFIXES: readonly string[] = [
  "club.",
  "eventor.",
  "tracks.",
  "liveresults.",
  // The event's map patch (docs/map-patches.md §3.4; slice G answer 1).
  "mapPatch.",
  // Layout and print data (slice G answer 4, row G18; docs/map-storage.md
  // §7.2): the box prints from its checkout copy, edits go to the cloud.
  "courseMap.",
  "mapTemplate.",
  "layout.",
  "graphics.",
  "courseObject.",
];

/** Exact cloud-owned mutation paths (event lifecycle is cloud admin). */
export const CLOUD_OWNED_MUTATIONS: ReadonlySet<string> = new Set([
  "event.create",
  "event.delete",
  "event.purgeDeleted",
  "competition.create",
  "competition.delete",
  "competition.purgeDeleted",
]);

/** True when a tRPC procedure path is a cloud-owned mutation. */
export function isCloudOwnedMutation(path: string): boolean {
  if (CLOUD_OWNED_MUTATIONS.has(path)) return true;
  return CLOUD_OWNED_MUTATION_PREFIXES.some((p) => path.startsWith(p));
}
