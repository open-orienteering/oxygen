# webserial.spec readout tests failed once the readout guard landed

## What happened

`e2e/webserial.spec.ts` "readout notification navigates to card readout" and "post-readout map" began failing on 2026-11-24 ~23:50 UTC. It looked clock dependent (it passed at 23:35) but was not: it is the commit that made the server's readout guard (`packages/shared/src/readout-guard.ts`) hold a read even when the runner has no result ("stale-punches"), plus the earlier "no-finish" hold.

The tests read card 501438, Malin Johannesson's SI6 card. The app reads SI5/SI6 as detection only (`supportsFullReadout` is false for them, `webserial.ts` emits a readout with no punches and no finish). So:

- `isPunchDataFresh` is false (no punches), the app sends `punchesFresh: false`, and
- Malin has a stored OK result in the seed, so the guard answers `needsConfirmation` ("no-finish" / "stale-punches") and a "Replace result?" banner replaces `card-notification`. The click on "View Readout" then never lands.

The weekday in the PTD bytes was never involved: the mock writes PTD 0, which `parseDayOfWeek` decodes as null (treated as fresh), and an SI6 read parses no PTD at all. Writing today's weekday into the mock would not have helped.

## Fix

Test-only. The guard behaved correctly. The two specs now give the runner an SI8-range card the mock reader reads in full (`setRunnerCardNo` in `e2e/helpers/runner-result.ts`, 501438 to 2401438), so the read carries punches and a finish and applies without a hold; the file reseeds afterwards. Date independence follows from the mock's PTD 0 (day of week unknown, always fresh).

Not changed: an SI6 read of a runner with a stored result is held by the guard in the real app too. That is the guard working as designed (a detection-only read cannot confirm a finish).
