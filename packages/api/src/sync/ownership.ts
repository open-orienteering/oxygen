/**
 * Endpoint ownership classification (pivot Step 4).
 *
 * Two duals of the same boundary (docs/offline-architecture.md § "Ownership
 * follows the journal"):
 *
 *   - **Race-critical mutations** are owned by the lease holder. They are
 *     guarded by `raceProcedure` (typed PRECONDITION_FAILED on a non-holder
 *     node) — enforcement is the procedure type, not a list here.
 *   - **Cloud-owned mutations** (global directories, Eventor admin, external
 *     integrations, event lifecycle) are forwarded upstream when this node
 *     runs as a venue — see `venueForwarder.ts`. Everything not listed here
 *     executes locally, so an ambiguous endpoint degrades to "works offline"
 *     rather than "breaks at the venue".
 */

/** Mutation path prefixes that always belong to the cloud. */
export const CLOUD_OWNED_MUTATION_PREFIXES: readonly string[] = [
  "club.",
  "eventor.",
  "tracks.",
  "liveresults.",
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
