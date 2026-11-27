# Test Lab guard: follow-up items left as they are

Package 19 ([test-lab-live-event-guard.md](test-lab-live-event-guard.md)) made
the Test Lab test-event only. These were deliberately left out.

1. **Test events are not barred from Eventor upload or LiveResults.** The flag
   stops the Test Lab touching a real event. It does not stop a test event
   from pushing its synthetic results to Eventor or to a LiveResults feed if
   the organiser configures one. Setting the mark is refused once an event is
   linked to Eventor, but an event marked first and linked later is not
   refused.
2. **Eventor test-environment events are refused as test events.** An event
   linked to Eventor's test environment (`eventorEnv = "test"`) has an Eventor
   id, so `event.setTestEvent` refuses it like a production link, although a
   test-environment event would be a fair test event.
3. **`AUTH_MODE=off` lets anyone flip the flag.** With auth off every caller
   has `event.manage`, so anyone who can reach the API can mark an event (that
   passes the refusal checks: no Eventor link, readouts or lease) and then use
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
