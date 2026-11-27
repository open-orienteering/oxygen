# Bugfix notes

One note per fixed bug: what happened, why, and how it was fixed (AGENTS.md §10). A new note goes in this folder as `<descriptive-name>.md` and gets a line under its area below, newest first. The date is when the note was first committed.

Notes whose code no longer exists (mostly the raster tile pipeline, deleted in slice E) are kept in [`archive/`](archive/) for the record; see the last table.

## Map pipeline: import, rendering, storage, viewer

| Note | Added |
| --- | --- |
| [Course purples under the map on a table with misplaced purples](course-purples-under-map.md) | 2026-11-14 |
| [Course circles and legs drawn under area fills on `vector` events](lower-purple-under-areas.md) | 2026-10-31 |
| [Corpus parity counted a tone on the ink threshold as a missing shape](parity-ink-threshold.md) | 2026-10-24 |
| [The page oracle composited premultiplied pixels as straight alpha](page-oracle-premultiplied.md) | 2026-10-24 |
| [North-oriented OCAD point symbols drew rotated objects north-up](ocad-point-rotation.md) | 2026-10-24 |
| [Vertex arenas lost data when growing on Adreno (Galaxy S25)](adreno-arena-grow.md) | 2026-10-23 |
| [Power-line poles on every line end, rings one line width small](ocad-line-glyphs-and-rings.md) | 2026-10-21 |
| [OCAD import warnings the S0 corpus check could not trust](ocad-import-s0-warnings.md) | 2026-10-20 |
| [OCAD ScalePar `d` stored as a declination](ocad-scalepar-declination.md) | 2026-10-19 |
| [Map editor number inputs could not be cleared](map-editor-number-input-clearing.md) | 2026-09-25 |
| [Auto-applied north correction displaced GPS by ~200 m](auto-north-correction-gps-offset.md) | 2026-09-18 |
| [Measure tool phantom points and undo button](measure-phantom-points.md) | 2026-09-07 |
| [Map import failed with `Unexpected token '<', "<html><hea"...`](map-upload-html-json.md) | 2026-09-07 |
| [Map north correction for mis-georeferenced OCAD files](map-north-correction.md) | 2026-09-07 |
| [A map upload could be silently dropped on a remounting panel](map-upload-lost-on-remount.md) | 2026-09-02 |
| [Map control circles vanish when a selection is active](map-control-id-space.md) | 2026-08-13 |

## Course editor

| Note | Added |
| --- | --- |
| [Two course writes in flight sent one token, and the stale one was a 500](editor-overlapping-course-writes.md) | 2026-11-15 |
| [A dragged control redrew once a second or worse](course-drag-redraw.md) | 2026-11-08 |
| [A large white-out outside turned the map white in Layout mode](whiteout-layout.md) | 2026-11-07 |
| [A second, thinner circle on the armed tool's ghost](ghost-circle-doubles-the-layer.md) | 2026-11-07 |
| [No pending leg from a just-placed start](first-leg-from-start.md) | 2026-11-07 |
| [A press inside a course area grabbed the area instead of panning](editor-area-press-pans.md) | 2026-11-04 |
| [Chrome's "press Esc to exit full screen" bubble flickers in the editor](fullscreen-bubble-flicker.md) | 2026-11-02 |
| [Object drags accelerated away; the `A` menu sat under the inspector](editor-object-drag-and-area-menu.md) | 2026-11-02 |
| [Mobile editor gestures and header polish](mobile-editor-gestures-and-header.md) | 2026-09-05 |
| [Course editor undo looked like a no-op for moves](course-editor-undo-snapback.md) | 2026-08-20 |
| [Ambiguous control-number placement in congested clusters](control-number-placement.md) | 2026-08-14 |

## Print, course maps and course data

| Note | Added |
| --- | --- |
| [An empty or wrong course file wiped the event's courses; re-import reset control settings](course-import-safety.md) (follow-ups: [course-import-followups.md](course-import-followups.md)) | 2026-11-26 |
| [Two prints a second apart hashed differently with the same drawing](printed-drawing-hash.md) | 2026-11-17 |
| [An image course object printed without its graphic](course-object-image-print.md) | 2026-11-13 |
| [The toner saver let text and out-of-bounds areas show outside it](toner-saver-draw-order.md) | 2026-11-07 |
| [A special instruction after a control was missing from the print](description-special-anchor.md) | 2026-11-06 |
| [Small-object cuts and control-number contrast](small-object-overprint-cuts-and-label-halo.md) | 2026-09-24 |
| [Overprint cut slits skewed by meridian tilt](overprint-cut-meridian-tilt.md) | 2026-09-24 |
| [Control description columns and column-C picker](control-description-columns.md) | 2026-09-24 |
| [Course-map print orientation used the wrong rotation source](course-map-print-orientation.md) | 2026-09-18 |
| [Course-map control roles and corrected georeference](course-map-control-roles-and-georeference.md) | 2026-09-18 |
| [OCAD course scale and stale IOF export lengths](ocad-course-scale-and-export-lengths.md) | 2026-08-25 |
| [Deleting a control left ghost references in courses](control-delete-course-cascade.md) | 2026-08-20 |
| [Stale OCD course geometry after XML re-import](stale-ocd-course-geometry.md) | 2026-04-26 |

## Readout, SI hardware and stations

| Note | Added |
| --- | --- |
| [Ties got different places; the receipt, offline readout and Eventor upload disagreed with the result list](results-and-lists.md) | 2026-11-26 |
| [Results and lists: what package 13 left out](results-and-lists-followups.md) | 2026-11-26 |
| [ROC radio intake stalled after a reset, and the control mapping was never applied](roc-radio-intake.md) | 2026-11-26 |
| [ROC radio intake: what package 12 left out](roc-radio-intake-followups.md) | 2026-11-26 |
| [Registration desk stored wrong clubs, names and cards; offline registrations lost fields](registration-correctness.md) | 2026-11-26 |
| [LiveResults: two nodes pushed one event, and each cycle deleted the runners in the forest](liveresults-single-owner-and-incremental-push.md) (follow-ups: [liveresults-followups.md](liveresults-followups.md)) | 2026-11-26 |
| [Registration: follow-ups left out of package 10](registration-followups.md) | 2026-11-26 |
| [A station went down for the whole outage although its data was cached](station-outage-resilience.md) | 2026-11-26 |
| [Station outage resilience: what package 9 left out](station-outage-followups.md) | 2026-11-26 |
| [A start at ZeroTime read as "no start", early starters vanished, and station clocks ran in UTC](zerotime-and-time-zone.md) | 2026-11-26 |
| [ZeroTime and time zone follow-ups: review items left as they are](zerotime-followups.md) | 2026-11-26 |
| [SI card protocol: SI8 punches read from the owner area, half-read cards filed, clock-skewed punches lost](si-card-protocol.md) | 2026-11-25 |
| [SI card protocol: what package 6 left out](si-card-protocol-followups.md) | 2026-11-25 |
| [Venue edits of event settings reverted every 5 minutes and never reached the cloud](settings-refresh-venue-edits.md) (follow-ups: [settings-refresh-followups.md](settings-refresh-followups.md)) | 2026-11-26 |
| [Venue shipping, checkout and the lease lost or duplicated data](venue-shipping-and-lease.md) | 2026-11-25 |
| [The journal sink trusted whatever it was sent](journal-sink-hardening.md) | 2026-11-25 |
| [Offline and kiosk readouts lost or applied to the wrong runner](offline-kiosk-readout-path.md) | 2026-11-24 |
| [A re-read or a manual finish overwrote the stored result](readout-overwrites-result.md) | 2026-11-24 |
| [SIAC readouts with a battery value rejected by `storeReadout`](readout-battery-millivolts.md) | 2026-11-18 |
| [Programmed controls never reached the Controls list](control-programming-battery-units.md) | 2026-08-25 |
| [Radio-equipped check stations never got autosend](check-station-autosend.md) | 2026-08-25 |
| [Readout History Always Showed "No Punch Data"](readout-history-empty.md) | 2026-08-14 |
| [Offline `card.read` entries drifted 10× and were never applied](offline-card-read-pipeline.md) | 2026-07-14 |
| [Field-control programming showed stale 3.00 V and unreliable power-off](control-programming-voltage-and-poweroff.md) | 2026-04-29 |
| [SIAC battery voltage stored in wrong units (and decoded as ~270 V)](siac-voltage-units.md) | 2026-04-27 |
| [Consistent cancellation (Status=21) handling](cancellation-handling.md) | 2026-04-27 |
| [Cards Page Improvements](cards-page.md) | 2026-04-05 |

## Event admin, search and UI

| Note | Added |
| --- | --- |
| [Runner editor dropped edits behind "Saved" and refused saves silently](runner-inline-editor.md) | 2026-11-26 |
| [Runner editor: follow-ups left out of package 11](runner-inline-editor-followups.md) | 2026-11-26 |
| [Draw safety: a redraw rewrote started runners, the draw was not atomic, and Apply differed from the preview](draw-safety.md) | 2026-11-26 |
| [Demo Competition courses read no controls](showcase-stale-course-structure.md) | 2026-11-07 |
| [Runner search failed in given-name order](runner-name-search-order.md) | 2026-09-19 |
| [`OXYGEN_ADMIN_EMAILS` silently did nothing for existing accounts](bootstrap-admin-not-reconciled.md) | 2026-09-02 |
| [Searching a name containing a comma returned nothing](search-quoted-comma-values.md) | 2026-08-28 |
| [Structured search dropped chips on rapid consecutive commits](structured-search-commit-race.md) | 2026-08-14 |
| [Classes Page Layout Issues](classes-page-layout.md) | 2026-04-05 |

## Eventor and integrations

| Note | Added |
| --- | --- |
| [Runner directory sync timed out in the cloud](runner-directory-sync-timeout.md) | 2026-09-19 |
| [Google Sheets webhook URL leaked across events](sheets-webhook-cache.md) | 2026-09-02 |
| [LiveResults radio codes, shared tavid, hashed login](liveresults-radio-codes-and-shared-tavid.md) | 2026-08-25 |
| [Eventor re-sync cancelled finished runners and reverted desk edits](eventor-resync-data-loss.md) | 2026-11-26 |
| [Eventor import was not atomic and wrote absolute times](eventor-import-atomic.md) | 2026-11-26 |
| [Eventor sync follow-ups: review items left as they are](eventor-sync-followups.md) | 2026-11-26 |
| [Eventor course lengths in IOF CourseData export](eventor-course-lengths.md) | 2026-08-25 |
| [Eventor import fails on cardless runners (unique constraint on `event_id, card_no`)](eventor-import-cardless-runners.md) | 2026-08-13 |

## Cloud, deploy and performance

| Note | Added |
| --- | --- |
| [The event backup was incomplete, failed silently and could not be restored](event-backup-restore.md) (follow-ups: [backup-restore-followups.md](backup-restore-followups.md)) | 2026-11-26 |
| [Performance: polling endpoints and per-request auth round trips](perf-polling-and-auth-round-trips.md) | 2026-09-24 |
| [GitHub Actions Node 20 runtime warnings](gha-node20-actions.md) | 2026-09-19 |
| [Cloud Shell demo required pnpm and a source build](cloud-shell-demo-ghcr.md) | 2026-09-19 |
| [Cloud SQL "handshake failed … EOF" after raising max instances](cloud-sql-handshake-eof.md) | 2026-09-07 |
| [PWA "Event not found" after dormancy (expired IAP)](pwa-iap-session-recovery.md) (superseded in part by [station-outage-resilience.md](station-outage-resilience.md)) | 2026-09-05 |
| [A tab could keep running an old web bundle after a deploy](stale-web-bundle-after-deploy.md) | 2026-08-25 |

## E2E and test infrastructure

| Note | Added |
| --- | --- |
| [webserial.spec readout tests held by the readout guard (SI6 card, no finish)](webserial-spec-held-by-readout-guard.md) | 2026-11-25 |
| [`map-multicourse.spec.ts` left its imported courses behind](e2e-map-multicourse-leaves-courses.md) | 2026-11-14 |
| [E2E flakes in `course-editor-legs.spec.ts`: presence chips moved the map, an apex on another leg](course-editor-legs-flakes.md) | 2026-11-13 |
| [F7's control into B was placed under the inspector](f7-offleg-under-inspector.md) | 2026-11-11 |
| [Bend drags left the map or pressed the action bar; F21's and F13's probes found no fit](e2e-bend-drags-and-band-probes.md) | 2026-11-11 |
| [The F13 apex probe read the wrong pixel, or a map line](e2e-apex-probe-pixel.md) | 2026-11-09 |
| [The action bar ran off the viewer (F15 E2E flake)](action-bar-off-viewer.md) | 2026-11-09 |
| [E2E flakes: course presence and multi-course leg labels](e2e-presence-multicourse-flakes.md) | 2026-11-06 |
| [`course-maps.spec.ts` "creates templates, lays out several maps" flake](course-maps-template-flake.md) | 2026-10-31 |
| [Storage GC schedule test raced its own run](gc-schedule-test-race.md) | 2026-10-22 |
| [E2E runs could attach to a server they did not start](e2e-reuses-dev-server.md) | 2026-10-22 |
| [Kiosk and course-editor E2E flakes under sharded load](e2e-kiosk-and-editor-flakes.md) | 2026-10-20 |
| [Eventor API key wiped on every E2E run](eventor-key-wiped-by-e2e.md) | 2026-04-27 |

## Archive (legacy pipeline)

| Note | Added | Why archived |
| --- | --- | --- |
| [Red bands around maps (empty-tile placeholder was red, not transparent)](archive/red-empty-tiles.md) | 2026-09-07 | raster tiles; `map-tiles.ts` deleted in E4a |
| [Map tiles timing out on Cloud Run after the colour-stack release](archive/map-tile-cold-render-cloud-timeouts.md) | 2026-09-24 | raster tile rendering, deleted in E4a |
| [Missing OCAD hatch and structure fills in map PDFs](archive/librsvg-pattern-tile-size.md) | 2026-09-18 | `rsvg-convert` PDF path, replaced by the PDF backend |
| [Power lines (and other black lines) hidden under area fills](archive/powerline-render-order.md) | 2026-08-17 | `ocad2geojson`'s `ocadToSvg` render path, no longer used (AGENTS.md §14 still cites the fork's fix) |
| [Course-map exports with black terrain areas](archive/course-map-svg-root-fill.md) | 2026-09-18 | SVG course-map composer, replaced by the shared pass stream |
