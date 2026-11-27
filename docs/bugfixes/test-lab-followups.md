# Test Lab guard: follow-up items left as they are

Package 19 ([test-lab-live-event-guard.md](test-lab-live-event-guard.md)) made
the Test Lab test-event only. These were deliberately left out.

1. **Test events are not barred from Eventor upload or LiveResults.** The flag
   stops the Test Lab touching a real event. It does not stop a test event
   from pushing its synthetic results to Eventor or to a LiveResults feed if
   the organiser configures one. No path links an existing event to Eventor (an
   import always creates a new event), and the Test Lab refuses an event that
   has an Eventor link anyway.
2. **Eventor test-environment events are refused as test events.** An event
   linked to Eventor's test environment (`eventorEnv = "test"`) has an Eventor
   id, so `event.setTestEvent` refuses it like a production link, although a
   test-environment event would be a fair test event.
3. **`AUTH_MODE=off` lets anyone flip the flag.** With auth off every caller
   has `event.manage`, so anyone who can reach the API can mark an event (that
   passes the refusal checks: no Eventor link, lease, runners, cards, punches or readouts) and then use
   the Test Lab on it. That is the existing meaning of auth off (a venue box
   or a development machine). The refusal on readouts is the protection that
   remains: an event that has been raced cannot be marked.
4. **A refused queued entry holds the station queue.** `INVALID_PAYLOAD` is a
   batch-stopping code (`JOURNAL_BATCH_STOPPING_CODES`), so a queued
   `finish.adjusted`, `result.applied`, `runner.updated` or start entry refused
   for an unknown status or an out-of-range time stops its batch and holds the
   entries behind it until the operator discards it. A non-stopping refusal
   code would let the rest through; left for a later package.
5. **Only an empty event can be marked.** An event that already has runners
   cannot be turned into a test event, by design; the way round it is to create
   the event with the test mark. Clearing the mark does not delete the
   synthetic data.
6. **Peer-shipped entries are not validated.** The status and time checks run
   on a station's own pushes only, so an out-of-range value from a peer (an
   older release, or an entry journaled before the checks) still lands. The
   cost of validating there is a blocked shipping stream; the value can be
   corrected on the runner afterwards.
7. **`clearRunners` is a single delete** and is not re-checked mid-way; the
   long loops (`registerFictionalRunners`, `registerRunners`, the instant
   simulation) re-check the flag, lease and Eventor link every 25 rows.
8. **A corrupt card time wraps silently.** `cardSecondsToDs` folds a time past
   one day back into the day, so exactly 86400 s becomes 0 ("no time") and any
   other corrupt value becomes a plausible clock time with no trace; the
   offline readout tests `> 0` on the raw seconds before converting. Returning
   0 and logging for out-of-range input would be more honest.
9. **Lock order in `event.setTestEvent`.** It takes the event's advisory
   lease/sync lock, then `SELECT … FOR UPDATE` on the event row. No transaction
   found takes them in the other order, but none should.
10. **Two concurrent `startSimulation` calls** both pass the "already running"
    check (awaits sit between the check and `simulations.set`), orphaning the
    first timer. Predates this package; reserve the key before the awaits.
11. **The timed tick re-checks only the flag**, not the lease and Eventor link
    that `assertTestEvent` checks. Enough today (a test event cannot be checked
    out and no path links an existing event to Eventor); calling
    `assertTestEvent` in the tick would close it for good.
12. `ControlsPage.tsx` still multiplies card seconds by 10 without
    `cardSecondsToDs`; its endpoints don't bound times, so nothing is refused.
