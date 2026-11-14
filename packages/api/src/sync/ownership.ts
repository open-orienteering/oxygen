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
 *     integrations, event lifecycle, the map patch, layout and print data)
 *     are forwarded upstream when this node runs as a venue — see
 *     `venueForwarder.ts`. Everything not listed executes locally, so an
 *     ambiguous endpoint degrades to "works offline" rather than "breaks at
 *     the venue".
 *
 * The list lives in `@oxygen/shared` (`cloud-ownership.ts`), since the web
 * batches cloud-owned mutations apart from local ones (row G18).
 */

export {
  CLOUD_OWNED_MUTATION_PREFIXES,
  CLOUD_OWNED_MUTATIONS,
  isCloudOwnedMutation,
} from "@oxygen/shared";
