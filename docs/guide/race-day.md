# Race day and results

Kiosk, start and finish stations, card readout, backup punches, results, cards and LiveResults. This page is the detail behind the [feature tour](../features.md).

## Kiosk mode

A self-service interface designed for a dedicated touch screen at the arena. The kiosk runs in a dark theme and communicates with the admin window via the BroadcastChannel API — no network required. See [system/registration-and-readout.md](../system/registration-and-readout.md) for the full state machine.

Idle — waiting for a card:

![Kiosk idle screen](../screenshots/kiosk-idle.png)

Successful readout — name, club, class, and total time appear the instant the card is returned:

![Kiosk readout — OK](../screenshots/kiosk-readout.png)

Mispunch — the runner sees exactly what went wrong:

![Kiosk readout — mispunch](../screenshots/kiosk-mispunch.png)

### When the network drops at the kiosk

A standalone kiosk keeps working without the server. A card read is saved on the device, the result is shown from the data the kiosk already holds, and a small amber badge counts the reads waiting to be sent. They are sent by themselves when the connection is back. If a read could not be saved at all, a red notice asks you to insert the card again. A kiosk opened with a kiosk key only (no one signed in, login required) keeps the reads on the device until an operator signs in there; the badge says so.

## Start and finish stations

Dedicated register-only stations for the arena — designed to run on cheap tablets and survive flaky Wi-Fi. Both stations work offline: mutations queue locally and drain when connectivity returns.

![Start station — pre-start timer and card scan](../screenshots/start-station.png)

![Finish station — recent finishers feed](../screenshots/finish-station.png)

A runner who already has a finish is not overwritten by one Enter: the button reads **Replace finish HH:MM:SS with now** and plain Enter does nothing. A double Enter records one finish. A finish keyed in here is kept when the runner's card has no finish punch.

## Card readout

A dedicated readout workflow for organizers — type a card number (or scan one with a reader) and see the full splits table immediately, with status, course match, and per-control timing. On a forked course, a mispunch whose punches match another variant completely shows **Accept variant XX** (the red exit; see [system/registration-and-readout.md](../system/registration-and-readout.md) §4f).

![Card readout with splits](../screenshots/card-readout.png)

**Re-reading a card never silently changes a result.** A disqualified runner or a status you set by hand stays as it is (a banner says so). A read that would replace a result with a worse one, such as a cleared hire card with no finish or punches that look like an old card's, asks first: **Replace result** or **Keep result**. Pushing a readout-station backup now writes the result too, under the same rules.

## Backup punches

SI backup-memory punches (the unit's local fallback when the chip read failed) land in a dedicated reconciliation view. Each backup punch is matched to a registered card/runner; unmatched rows are highlighted, and a one-click action pushes the reconciled punch into the `punches` table for the result engine to pick up.

![Backup-punch reconciliation](../screenshots/backup-punches.png)

## Readout-station backup recovery

The same Backup Punches page also recovers full card readouts from a SI **readout station's** internal flash. This is the last-line-of-defence when Oxygen itself is broken and runners have read out on a standalone readout station — Oxygen wasn't there to hear the readout, but the station's own beep confirmed it landed in flash. Later, the operator dumps the flash through the Read Controls panel, reviews the recovered card readouts on the Backup Punches page's "Card readouts" tab, and pushes selected rows through the normal `storeReadout` pipeline — each one gets results, splits, and (optionally) a retroactive receipt as if it had happened live. Full details in [`docs/system/registration-and-readout.md`](../system/registration-and-readout.md#11-readout-station-backup-memory-recovery) and [`docs/si-protocol/readout-backup-format.md`](../si-protocol/readout-backup-format.md).

## Start screen

A dedicated big-board display for the start area. The screen auto-advances to the next starting group based on the current time, showing class, name, and start time in a format readable from across a field.

![Start screen for the arena](../screenshots/start-screen.png)

## Dashboard

The race-day dashboard is the single view that answers "how are we doing?" — runner counts, clubs, classes, competition progress, and the live map with real-time control punches.

![Race-day dashboard](../screenshots/dashboard.png)

## Receipt printer

Oxygen supports direct USB receipt printing on Linux at the finish station and kiosk — no print server, no driver gymnastics. Splits, status, position, and personal best are rendered into an ESC/POS-compatible layout. See [ops/receipt-printer-setup.md](../ops/receipt-printer-setup.md) for hardware notes.

## Results

Live results update as cards are processed — OK, mispunch, DNF, over max time, out of competition, no timing. Three-layer stale-punch detection ensures a card read today can't bring in phantom punches from a test run last week. See [system/registration-and-readout.md](../system/registration-and-readout.md) for the full readout pipeline.

![Live results](../screenshots/results.png)

## Cards

Every readout lands here — card type, battery, owner, current punches, and status. Click a row to expand the full punch timeline with splits, cumulative times, and OK/extra/miss badges per control.

![Cards page with punch detail](../screenshots/cards.png)

## LiveResults push

Enable LiveResults on the event page and Oxygen will push splits to [liveresultat.se](https://liveresultat.se) on the interval you pick (typically 30 s during a race). Punches flow through the same pipeline that drives the local results view, so what's published matches what's on screen.

Radio controls are stored in LiveResults' `visit × 1000 + code` form (first punch of 82 → `1082`) so a MeOS upload to the same competition can share the radio columns. Each sync only rewrites `splitcontrols` for Oxygen's own class names; it does not wipe radios another client attached under a different class name. Do not leave Oxygen's pusher and MeOS Resultat-online running against the same `tavid` at once — they still disagree on class names (`U4` vs `U4 3 km`) and runner ids.
