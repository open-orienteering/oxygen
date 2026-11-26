# LiveResults: what package 16 left out

Items from the package 16 plan and review that were not changed, with the reason. See [liveresults-single-owner-and-incremental-push.md](liveresults-single-owner-and-incremental-push.md) for what was fixed.

- **Never checked against the live MySQL.** The remote schema, the `(dbid, control)` and `(classname, corder, code)` row-constructor deletes and the `changed` semantics are taken from the old pump and the review, not observed. Do one manual push against a test competition before the next release.
- **A renamed class leaves its old rows.** The cleanup scope is Oxygen's class names. A runner row written under a class name the event no longer has (renamed class) is outside the scope and stays until removed by hand. Removed classes are covered.
- **Remote cleanup on purge.** `purgeDeleted` drops the local settings rows but leaves the remote `login`, `runners` and `results` of the event's competition.
- **Sheets when the box is offline at readout.** The box pushes a readout to the sheet when it stores it, fire-and-forget. If it has no uplink then, that row is lost: the cloud no longer pushes it again on ingest (that was the duplicate). A retry queue on the box would close it.
- **ROC on both nodes.** The ROC puller still runs on the cloud and on a venue box, each into its own database, as before. The cloud's puller writes punches into an event leased to a box without a `mayWriteEventData` check. Whether the puller should be cloud-only or holder-only belongs to the ROC area; the spec line that called it cloud-only was corrected to describe what runs.
- **Storage GC on a venue box** still runs; harmless, left as is.
- **A manual push on a non-leader instance** is serialised only with cycles on its own instance. On a multi-instance cloud it can still run beside the leader's cycle; each is one transaction over the same rows, so the effect is two equal writes, not a flicker.
