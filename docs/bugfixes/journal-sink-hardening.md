# The journal sink trusted whatever it was sent

Review package 3 of the 2026-11 full code review (kept outside `main`, on branch `claude/project-thread-qb2vbb`) (findings MC-01, API-01, API-03, RES-07, MC-20, SYNC-20, BLD-25, API-37s, BLD-21 and their duplicates). Decision D1 (capability map) was taken as recommended.

## What happened

`events.push` is the one endpoint every station outbox drains into and the venue box ships its journal through. It:

- applied every entry to the event named in the request header, never comparing it with the entry's own `competitionId`. The station drain read that header from the page URL at send time, so switching competition mid-drain (or opening race B while A's queue was draining) wrote A's runners, finishes and results into B, and reported them `synced` for ever (idempotency was a global id lookup);
- checked no capability. On the cloud any account the proxy admits is auto-provisioned as a Member, and a Member could push one entry that removed every course or overwrote results. The box's own push only worked because its service account happened to be a Member; the sync secret was never read;
- addressed reference rows (`class/course/control.upserted`, `reference.imported`) by bare UUID and spread the client's `fields` into Prisma, so a crafted entry could rewrite another event's course or move a row to another event;
- deduped `runner.registered` and `punch.recorded` by id across all events, turning a foreign id into a silent drop;
- applied an entry, wrote its journal row and ran the variant follow-up as separate statements, and carried on past a failed entry, so a crash between them created duplicate runners or lost the variant deal, and later entries overtook a failed one;
- returned raw Prisma messages in `failed[].error`; on the station any server-answered error (a schema 400, an unknown event, a 5xx) looked like a network error and blocked the queue silently.

## The fix

Server (`packages/api/src/routers/events.ts`, `journalCapabilities.ts`, `trpc.ts`, `referenceJournal.ts`):

- A presented sync secret is checked first (constant-time). Valid: the venue box, all entry types, no user. Wrong: `UNAUTHORIZED`. Node has none: `PRECONDITION_FAILED`.
- Without a secret, a signed-in user is needed when login is on, and each entry needs the capability its online action needs (table in [authentication.md](../system/authentication.md)). `runner.registered` needs Race crew, and the online `runner.create` was lowered to Race crew to match; editing and deleting runners stay Event admin. A finish-station overwrite (`runner.updated` with only `finishTime`) needs Race crew.
- Every entry's `competitionId` must equal the request's event; idempotency is per event.
- Refusals come back per entry in `failed` with a stable code (`COMPETITION_MISMATCH`, `FORBIDDEN` + capability, `ENTRY_IN_OTHER_EVENT`, `ROW_IN_OTHER_EVENT`, `INVALID_PAYLOAD`, `APPLY_FAILED`) and stay retryable. Gate refusals (`COMPETITION_MISMATCH`, `FORBIDDEN`) and `ENTRY_IN_OTHER_EVENT` never stop the batch; the codes an apply throws (`APPLY_FAILED`, `INVALID_PAYLOAD`, `ROW_IN_OTHER_EVENT`) do (see below). The set is `JOURNAL_BATCH_STOPPING_CODES` in `@oxygen/shared`, used by the server and the station.
- `reference.imported` with a non-empty `classes[]` needs `event.manage` as well as `courses.edit` (it writes whole class rows). An id already journaled under this event answers `synced` before the gate (the competition check still applies).
- Each entry is one transaction: journal row, apply, variant follow-up. An apply failure stops the batch so later entries keep their order; the rest go out next round.
- Reference upserts refuse rows of another event, allow-list fields from the Prisma models (unknown keys dropped and logged), coerce BigInt columns, and check that every referenced control, course and class belongs to the event.
- With login on, the journal `actorId` is the signed-in user, not the wire value.

Station (`packages/web/src/lib/offline/sync.ts`, `lib/trpc.ts`, `SyncStatusIndicator.tsx`):

- Pending entries are grouped by `competitionId` and each group is pushed through a client whose header is that competition, never the URL. Drains lock per competition, and the auto-drain covers every competition with pending entries.
- Ordering rule: when an answer carries a batch-stopping code (`APPLY_FAILED`, `INVALID_PAYLOAD`, `ROW_IN_OTHER_EVENT`), that competition's pass ends, and entries ordered (by HLC, wall clock only for entries without one) behind a failed entry with one of those codes are not pushed until it is retried or discarded (Retry and Discard drain at once). An entry the server rejected on its own as malformed (a schema 400, `rejectedBySchema`) holds nothing. Other competitions keep draining. The blocked reason is kept per competition. The auto-drain starts on an enqueue signal (`subscribeEnqueue` in `events.ts`), not on a growing count, so an entry queued while the previous one drains is never left waiting; stuck entries alone never retrigger it. The sync panel shows how many entries wait behind a failed one.
- A schema 400 is probed and resent one by one so only the bad entry is marked failed; an unknown event, auth failures and 5xx keep entries pending and show "sync blocked" with the reason.
- Failed rows show a translated text per code ("Missing permission: Race crew"), and a Retry all button re-queues them after a role is granted.

Tests: `events-push.test.ts` (competition, capabilities, secret path, reference isolation, atomicity with injected failures, concurrency, MC-20, every `result.applied` status), `permissions.test.ts`, `journalCapabilities.test.ts`, `offline-sync.test.ts`, `trpc-cache-scope.test.ts`, and `e2e/offline.spec.ts` (refusal text, Retry all, an entry reaching its own competition after switching).

## Left out on purpose

- **The two-node run behind Google IAP** that the review asked for could not be done in the cloud test container (no IAP). The secret path is covered by integration tests only; the first real venue-to-cloud push after this change should be watched.
- **RES-07's status mapping was already fixed by package 2** (`applyResultGuarded`); this package only adds the tests. Replicas that stored `unknown` from a `result.applied` replay before package 2 are not repaired: that needs a data repair from journal payloads and a call on which node is right.
- **`docker-compose.venue.yml` does not pass the Google credentials** the cloud runbook asks for. With the secret the push no longer depends on the box's account being a Member, but IAP still needs the token. Left for the deploy and venue setup package.
- **Entries that resolve no runner** (unknown runner, missing class) are still journaled as `synced` with nothing applied. A real silent-loss path, but outside this package's findings and it changes what peers accept; worth its own finding.
- **Shipper HLC cursor and checkout over unshipped entries** (MC-02, API-07): package 4.
- **Per-type zod schemas on the wire**: larger than the allow-list and risks version skew between nodes; the allow-list plus `INVALID_PAYLOAD` covers the security side.
- **Permanent refusals on the node-to-node shipper** (`ENTRY_IN_OTHER_EVENT`, `ROW_IN_OTHER_EVENT`, `INVALID_PAYLOAD`) stop that event's shipping stream at the entry until it is resolved, and show only in the server log. A status or alarm UI is left for the shipper package (4).
- **`runner.create` at Race crew** still accepts `status`, `finishTime`, `fee`, `paid` and `startNo`. Accepted: Race crew can set finish and status elsewhere, and the desk records payment.
- **No E2E signs in as Race crew and drains an outbox**; capability refusals are covered by integration and web unit tests.
