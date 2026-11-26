# LiveResults: two nodes pushed one event, and each cycle deleted the runners in the forest

Review package 16: SYNC-14 (EVT-06), SYNC-15 (DB-09, RES-14, MC-31), MC-29 (API-33), EVT-16, MC-28.

## Symptoms

- **Runners flickered on the public start list.** Every cycle deleted the remote `runners` row and all `results` rows of every runner whose status was still Unknown (everyone in the forest, all morning), then put them back one statement at a time, outside any transaction. For 2,000 runners over a 30 ms link a cycle took 2 to 3 minutes against a 30 s interval, so cycles overlapped and one cycle's delete removed what the other had just written. A manual "Push now" added a third.
- **A deleted entry stayed in the public results.** Removed runners were never deleted remotely.
- **Two nodes pushed one event (SYNC-14).** The docs said the single-owner services were "config-flagged so a venue copy never double-runs them". No such flag existed: a venue box with 4G and the cloud both pushed a checked-out event from two databases, and the cloud's lagging copy undid the box's rows each cycle. The Google Sheets backup got every readout twice: once from the box when it stored the readout, again from the cloud when it ingested the shipped `card.read`.
- **Two events could share one competition (MC-29).** `liveresults.saveConfig` accepted any `tavid` and `liveresults.setConfig` wrote the raw column, with no unique index, so one event's push could delete another's rows. Allocation (`MAX(tavid) + 1`) was unlocked.
- **A deleted event kept publishing (MC-28).** The pusher reconcile did not look at `events.removed`, the ROC puller reconcile read only `settings`, and `purgeDeleted` left the per-event settings rows behind.
- **A flaky config endpoint broke the working pool (EVT-16).** The connection string was fetched on every call with no timeout and no `resp.ok` check; any different body (a proxy's 502 page) ended the pool and split the HTML into credentials. No queue limit or statement timeout: five stalled queries blocked every later push.

## Fix

- **Plan, then apply (SYNC-15).** `syncAll` reads the event once (one punch query per event, grouped by card), builds the wanted rows with the pure `buildLiveResultsRows`, reads what the remote holds in Oxygen's scope, diffs (`diffLiveResultsRows`) and writes only the changes in one MySQL transaction (`pushLiveResultsRows`), with chunked multi-row `INSERT … ON DUPLICATE KEY UPDATE`. An in-forest runner is never deleted; `results.changed` moves only on a real change; a removed runner, a reset finish or a dropped radio is deleted. A failed statement rolls the whole cycle back.
- **Scope on a shared tavid.** Oxygen's scope is runner rows filed under an Oxygen class name (removed classes included, plus the empty class name), the results of those runners and of the wanted ids, and split controls of Oxygen class names. Rows another client (MeOS) wrote under its own class names are never read for deletion.
- **One cycle at a time.** The manager skips a tick while the event's previous cycle is running; `pushNow` goes through the manager, waits for the running cycle and then runs. `lastPush` is the start of the last successful cycle, and a skipped tick changes no status.
- **Cloud only (SYNC-14).** The background reconcile skips the LiveResults pusher on `NODE_ROLE=venue` and drops any timer (`publishesLiveResults()` in `background/supervisor.ts`); the `liveresults.*` mutations were already forwarded to the cloud. On a box, `getStatus` returns `pushedByCloud` and the panel says "Pushed by the cloud server". The ROC puller keeps running on both nodes, each into its own database.
- **Sheets once.** `ingestJournalEntries` takes `fromNode`: set for a sync-secret push and for the shipper's pull, it skips the post-commit Sheets push, because the node that journaled the readout already pushed it. A station's own push still pushes.
- **tavid (MC-29).** `saveConfig` no longer takes a `tavid` and `setConfig` is gone (nothing called it). Migration `20261126230000_liveresults_tavid_unique` adds a unique index on `events.liveresults_tavid` (NULLs allowed); it refuses, listing the event ids, if two events already share one. `ensureCompetition` allocates again when its `login` insert hits a duplicate key.
- **Deleted events (MC-28).** Both reconciles skip `removed` events and stop their timers, keeping the stored config so a restore resumes; `syncAll` and the ROC poll refuse a removed event; `purgeDeleted` deletes the `online_input_<id>_*` and `liveresults_<id>_status` rows in the same transaction.
- **Connection (EVT-16).** The connection string is cached for 10 minutes and fetched again after a connection or auth error; the fetch has a 10 s timeout and checks `resp.ok`; the body must be exactly four non-empty `;`-separated parts. A changed string builds the new pool before ending the old one in the background. The pool has `queueLimit: 10` and keep-alive, and every statement a 15 s client timeout.

Bring-up needs `pnpm db:migrate` (the unique index).

## Tests

- `packages/api/src/__tests__/liveresults-push-plan.test.ts`: the plan, the diff, and the apply across cycles against an in-memory stand-in for the remote MySQL (no delete of an in-forest runner, unchanged rows not rewritten, removed runner and reset finish deleted, MeOS rows kept, rollback on failure); connection-string validation.
- `packages/api/src/__tests__/liveresults-pusher.test.ts`: skipped overlapping tick, `pushNow` serialised with the timer both ways, `lastError` survives a skipped tick, `lastPush` is the cycle start; connection cache (one fetch for many cycles, refetch after TTL and after an auth error, a 502 or garbage body keeps the pool).
- `packages/api/src/__tests__/background-supervisor-role.test.ts`: a venue node never reconciles the pusher; a cloud node does.
- `packages/api/src/__tests__/integration/liveresults-ownership.test.ts`: `saveConfig` ignores a tavid, `setConfig` is gone, the unique index, removed events skipped by both reconciles, `purgeDeleted` drops the settings rows, and a shipped `card.read` is not pushed to Sheets while a station's own push is.

Follow-ups left out: [liveresults-followups.md](liveresults-followups.md).
