# Bugfix: offline and kiosk readouts lost or applied to the wrong runner

Full review work package 1 (SYNC-03, SI-02, SI-03, MC-06, MC-04, WEB-01, SYNC-19, MC-19, BLD-24, MC-05, SI-16, SI-15, SI-29, SYNC-24, BLD-23).

## Symptom

With the network down, a standalone kiosk stored and queued nothing while still showing the runner a screen. In every tab the offline `result.applied` event was never queued, so after the network returned the runner had a card but no result. A card re-read after a failed save was skipped as a duplicate. The persisted query cache had one key for all events, so opening event B offline could show event A's runners, and fixing the missing event would have queued A's result against B.

## Root cause

- The competition used for queued events came from a ref set only by `CompetitionShell`, and the offline branch read a stale closure value that was always `null`. The kiosk and start-screen routes are outside the shell.
- Duplicate detection ignored the event and whether the earlier read had been saved.
- `useEventQueue` was mounted only by the shell's sync indicator, so the kiosk never drained.
- Event-scoped tRPC keys carry no event, and the persisted cache was a single blob. The local readout took the first matching query, even a filtered `runner.list({search})`.
- Queue writes (`emitEvent`) were fire-and-forget, `localStorage` was unguarded, and a failed store still triggered a server fetch.

## Fix

- The event comes from the URL (`activeEventNameId()`, the same source as the request header). `card.read` and, for devices that may write results, `result.applied` are queued with awaited writes; a failed write shows a notice and the read is not a duplicate next time.
- A cache owner and one persisted blob per event (`cache-scope.ts`, `persister.ts`); the event is claimed before it is selected. Local lookups read exact no-input queries and only for the owning event.
- The kiosk route mounts `useEventQueue`, shows a sync badge, and tells a server refusal (kiosk key only) from a network error.
- `storeReadout` is capped at 8 s; a failed store skips the server fetch and resolves locally; the HLC clock and station id fall back to memory if `localStorage` throws.
- Finish Station awaits its queue write and shows an error instead of a receipt when it fails.

## Left as it was, on purpose

- A kiosk-key-only device stays display-only (decision D11): its `card.read` waits on the device until an operator signs in.
- `card.read` is not journaled before the store call (SI-29's full form); the 8 s cap and the server's dedup cover a late delivery. Dexie `blocked` / `versionchange` handlers and `navigator.storage.persist()` (SYNC-24) are a follow-up.
- `result.applied` replay still maps only OK, MP and DNF (SYNC-06, another package).

## Tests

`cache-scope.test.ts`, `readout-policy.test.ts`, `local-readout.test.ts` (unit); `permissions.test.ts` (kiosk key cannot store, apply or push); `kiosk-readout.spec.ts` "Standalone kiosk: network down" and `offline.spec.ts` "Offline readout" (E2E, `context.setOffline`).
