# Sub-slice index

The work queue for the vector map pipeline, one row per unit a single
session implements end to end. Coordinator sessions read this file to
decide what is ready; implementer sessions update their own row (in the
slice's file under `slices/`, and here while it is open). The
normative content lives in the spec chapters (`docs/map-*.md`), each of
which ends in a "Pending in this chapter" section — this index only
orders that backlog and records who is on what.

Branch model: `vector-map-pipeline` is the long-lived integration branch.
Every sub-slice is a worktree cut from it and a PR back into it. Spike
branches may be cut from it and merged back the same way. `main` is not
involved until a slice's gate (09 §4) has passed and the user decides.

Finished rows live in one file per slice under [slices/](slices/) (moved there on 2026-11-21, unchanged except for statuses that were stale after the 2026-11-20 merges). Below, each slice keeps a summary, a link to its file, and only the rows that are still open. A row id cited as "SLICES.md F21" is found in the slice's file.

## Status values

| Status | Meaning |
|--------|---------|
| `ready` | Dependencies merged; may be started |
| `blocked: <ids>` | Waits for the listed rows to merge |
| `in progress: <session>` | A session owns it; nobody else touches its area |
| `review` | PR open against `vector-map-pipeline` |
| `done <date>` | Merged; decision-log row written |
| `manual` | Needs the user (corpus, staging, the club's instance) |

A row is `done` only when all of: spec section written or updated,
"Pending in this chapter" trimmed, tests per AGENTS.md §4 matrix, a
decision-log row in the slice's file under [decisions/](decisions/) (index in [README.md](README.md#decision-log)) naming deviations, PR merged.

Two rows whose **area** columns overlap are never in progress at the
same time. Verification steps that use fixed ports or shared databases
(`pnpm test:e2e*`, `playwright test`, integration tests, the Docker
rebuild) run through `scripts/with-verify-lock.sh`; a hook blocks bare
invocations.

## Slice A — import and storage (09 §4)

Import and storage: codec, OCAD and OMAP import, content-addressed storage, import jobs, backfill. Released in v0.2.0. Rows: [slices/slice-a.md](slices/slice-a.md).

| Id | Sub-slice | Status |
|----|-----------|--------|
| S4 | 36 MB upload + inline-start job on Cloud Run idle mode | manual |

## Slice B — GL viewer (09 §4)

The WebGL2 viewer behind the per-event switch. Released in v0.3.0. Rows: [slices/slice-b.md](slices/slice-b.md).

| Id | Sub-slice | Status |
|----|-----------|--------|
| B0 | Real-phone baseline (S1 residual): Pixel-class device, throttled 4G, `/dev/map-gl-doc?mode=envelope` on Sprint envelope and Club-2026 pilot; record first frame, frame GPU, resident GPU in `map-rendering.md` §5.2 | manual (user; a baseline for B2, not a blocker) |
| B-gate | 04 phone budgets met on Sprint and Crop-B on the B0 device; visual parity on the corpus against tiles for the sanctioned differences only (03 §6.9 rule; B9's tool); `webserial.spec.ts` post-readout map and `mobile-layout.spec.ts` green under `vector`; one real event run with `vector` on the organiser's instance before `map.pipeline.default` flips | manual — slice B released as `v0.3.0` (2026-10-23, decision log); the real-event run can be scheduled on the club's instance; S4 runs on this release |

## Slice C — derived course layer and PDF (09 §4)

The derived course layer and the PDF backend. Released in v0.4.0. Rows: [slices/slice-c.md](slices/slice-c.md).

| Id | Sub-slice | Status |
|----|-----------|--------|
| S2 | Print-shop preflight and OCAD-export confirmation (09 §7): one real course map from the vector path sent to the club's usual shop (`cmyk`; `cmyk` only — decision (2)), preflight without manual intervention, purple and brown side by side with the current workflow's output; the same map exported from OCAD by the user, rasters compared to settle the rows marked *provisional (S2)* in `map-rendering.md` §8 — §4.2 step 3 dash stretching, `endGapUm`, vertical-anchor metrics, default tab interval, OCAD box top, line-text arc length, frame extent — and `map-import.md` §3.3's provisional rows; amendments recorded as a report `S2-print-spike.md` and spec edits | manual (ready — `v0.4.0` is on the club's instance) |
| C-gate | Golden PDFs on the corpus with sanctioned differences only (C7); S2 preflight passed; `course-maps.spec.ts` green under `map-legacy` and `map-vector`; `qpdf --check` in CI; one club dry run (09 §8): one real event's maps printed from the vector path on the organiser's instance before `map.pipeline.default` flips | manual — slice C released as `v0.4.0` (2026-10-24, decision log); corpus golden PDFs (C7, C10), `course-maps.spec.ts` under both projects (C3) and `qpdf --check` in CI (C3) are done; S2 and the club dry run remain |

## Slice D — editor phase 1 (08 §8) and layout mode (09 §4)

The new course editor (phase 1) and Layout mode. Released in v0.5.0. Rows: [slices/slice-d.md](slices/slice-d.md).

| Id | Sub-slice | Status |
|----|-----------|--------|
| D-mobile | Real-phone Field mode: the B0 device at a real control site — GPS fix and accuracy on the map, bottom sheet in sunlight with gloves, long-press move of a control by a few metres, check-off; first frame and tap-target numbers into `course-editor.md` §10 (Playwright mocks the fix; only a phone in a forest proves the mode) | manual (user; after D9 merges); released in v0.5.0 (2026-11-05), `map.editor.vector` on in production |
| D-gate | `course-editor.spec.ts` green on desktop (`map-vector`) and on the `mobile` project (09 §4 D); a setter plans **one real event on the new editor end to end including print** on the club's instance (09 §8 club dry run) — courses placed with the armed tools, an OOB area, auto templates, class override, PDFs through C3's path; **rollback drill**: the event flipped to `legacy` shows the same courses in the old editor (`structure` ignored, `geometry` current — 09 §6 D); the per-event dump and restore carry `structure` and `course_objects` (07 §12 floor) | manual; released in v0.5.0 (2026-11-05), `map.editor.vector` on in production |

## Slice E — full migration: the flip and the retirement of the legacy pipeline (09 §4 E + F's retirement)

The flip to the vector pipeline and the retirement of the legacy one. Released in v0.6.0 and v0.6.1. Rows: [slices/slice-e.md](slices/slice-e.md).

No open rows.

## Slice P — polish after slice E (user feedback 2026-11-06) and the next slice

Polish after slice E from user feedback (2026-11-06 onwards). Released with slices E and F. Rows: [slices/slice-p.md](slices/slice-p.md).

No open rows.

## Slice F — course structure (08 §8 phase 2)

Course structure: legs, bends, corridors, variations, map exchange, Field mode work (editor phase 2). Released in v0.7.0. Rows: [slices/slice-f.md](slices/slice-f.md).

| Id | Sub-slice | Status |
|----|-----------|--------|
| F-gate | `course-editor.spec.ts` (with the F describes) and `field-mode.spec.ts` green on desktop and `mobile`; a setter plans **one real forked class** (a relay or a butterfly) on the editor on the club's instance, prints its variants and the all-variations page with `copies=runners`, its runners carry pre-set variants shown on the start list (F6b), one runner who ran another variant is MP on the kiosk and accepted at the desk with one click (F6c); a map-exchange course printed as two parts; the IOF export opened in Purple Pen or Condes without complaint; setter maps and description sheets printed for one event | manual; released in v0.7.0 (2026-11-13, PR #174, revision `oxygen-00054-26b`, `docs/releases/slice-f.md`) — the check runs on prod |

## Slice G — Map mode (08 §8 phase 3) and offline print (09 §4 G)

Map mode (map corrections, GPS tracks) and offline print. Released in v0.8.0. Rows: [slices/slice-g.md](slices/slice-g.md).

| Id | Sub-slice | Status |
|----|-----------|--------|
| G-gate | `map-mode.spec.ts`, `course-maps.spec.ts`, `map-vector-layer.spec.ts` and `map-gps-tracks.spec.ts` green; on the club's instance a real ski-O correction from GPX: at least two logged passes of one ski track imported, averaged, a break trimmed out, converted with an ISSkiOM track symbol on the club's ski-O base map, its ends snapped to the existing network, seen in the editor, on the kiosk and in the printed PDF, then promoted and re-matched with the track kept; an imported ISSkiOM-symbolled map's track symbols matched in the review; the corpus run (09 §8) with an empty patch byte-identical to before; on the club's instance: one real correction (a hidden object, a new path) drawn in the editor, on the kiosk and in the printed PDF, the toggle switched off and on (09 §6), then promoted and the club version re-matched with the correction kept; one event's maps exported on a laptop with the network off; one checked-out box prints with its uplink pulled; release notes naming the toggle and the rollback | manual |

## Slice H — terrain: height sources and 3D draping (research 10)

Terrain: contour graph, height field, DEM and 3D draping. Released in v0.8.0. Rows: [slices/slice-h.md](slices/slice-h.md).

| Id | Sub-slice | Status |
|----|-----------|--------|
| H-gate | `map-terrain.spec.ts` and `map-viewer-3d.spec.ts` green; the corpus run (09 §8) extended with the terrain report per map, diffed against the previous run; on the club's instance: the club's own map opened in 3D on a laptop and on a phone, recognised by a club member; one event's course and one logged GPS track seen on the terrain; frame time on the S1 phone within 04 §9's budget; release notes. The DEM track (H9–H11) gets its own check and release after (answer 10) | manual |

## Slice I — canonical colour layers (split 2026-11-17; user 2026-11-14)

Canonical IOF colour layers, deviations and their overrides, the compare view. Released in v0.9.0. Rows: [slices/slice-i.md](slices/slice-i.md).

| Id | Sub-slice | Status |
|----|-----------|--------|
| I-gate | `map-vector-layer.spec.ts` and `map-review.spec.ts` green; the colour-order harness at 0 unclassified on the ten maps; on the club's instance after the re-match: every club map's before / after picture looked at by the user; a course on a map whose table is badly ordered (Testkarta) — circles and legs over the areas, numbers on top; one map switched to its own order and back; one map printed; release notes naming the switch and the rollback | manual |

## Slice J — graphics: images and object transparency (split 2026-11-18; user 2026-11-18)

Graphics: images and object transparency. Released in v0.9.0. Rows: [slices/slice-j.md](slices/slice-j.md).

| Id | Sub-slice | Status |
|----|-----------|--------|
| J17 | **Graphics turned with the map's north lines** (user 2026-11-19: deferred — "I'd rather do a bigger slice at some point to be able to reorient the north lines correctly and then apply some central fix"). Today an image's rotation is in the paper frame. A later slice first makes the north lines correct (re-orienting them), then applies one central rule (images, texts, symbols) for north-relative rotation | deferred (user 2026-11-19) |
| J-gate | The specs above green. On the club's instance: two or three door PNGs in the club library; one placed on a control, attached, copied onto every control of a course; a control moved, its door follows; frame opacity changed and Multiply tried; the sheet printed on the club printer — the middle shows the map at full strength, circles and numbers show, canvas and paper agree. A photo beside a control. A rotated, cropped logo on a template. An old event's `maps.pdf` byte-identical to before the slice. Release notes | manual |

## General — outside the map pipeline

| Id | Sub-slice | Spec home | Research | Depends on | Area (files a session may touch) | Status |
|----|-----------|-----------|----------|------------|----------------------------------|--------|
| V1 | **One version, aligned with the git tag** (user 2026-11-13; answer 7). Today the footer's `v0.1.0` is the root `package.json` (`vite.config.ts` → `__APP_VERSION__`, never bumped), `Image:` is `OXYGEN_DEPLOY_REF` (the Dockerfile's `BUILD_REF`, overridden by `deploy.sh` / the release compose file with the tag the operator chose) and `Commit:` is `OXYGEN_BUILD_ID`; `release.yml` retags an image built before the tag existed, so a tag cannot be baked in at build time. Scheme: the git tag is the version of record; the release PR sets `version` in the four `package.json` files (`pnpm release:version X.Y.Z`, a script) and `release.yml` fails when the tag differs from the tagged commit's `package.json`; `publish.yml` checks out with tags and passes `BUILD_VERSION`: the `package.json` version when it is ahead of the last tag (the release commit, built before its tag), else `git describe --tags --match 'v*'` (`v0.7.0-3-gabc1234`); the Dockerfile bakes it as `OXYGEN_VERSION`, `/api/version` answers it, and the web shows the server's value (its own baked value as fallback; a local build is `<package version>-dev`). Footer: `Oxygen v0.7.0 · Connected to PostgreSQL` / `Build: 2026-11-13 17:14 · Commit: 2dd412d`, with `· Image: <ref>` only when the deploy ref is not that version's tag (`edge`, `sha-…`, `source-…`). Tests: unit — the version rule (ahead of the tag, at the tag, past the tag, no git), `ghcr-ref.mjs` tag / package check, `formatDeployRef` hiding; E2E `competition.spec.ts` footer | `docs/releases/README.md` ("Tags", the footer block, "Cut a release"); `docs/ops/deploy-gcp-cloud-run.md`; the release runbook template | — | — | root and package `package.json` (version only), `scripts/` (version script, `ghcr-ref.mjs`), `Dockerfile`, `.github/workflows/{publish,release}.yml`, `scripts/gcp/{deploy.sh,cloudbuild.yaml}`, `docker-compose.release.yml`, `packages/api/src/index.ts`, `packages/web/{vite.config.ts,src/env.d.ts}`, `src/lib/app-update.ts`, `src/hooks/useBuildInfo.ts`, `src/components/BuildInfoLine.tsx`, `src/pages/CompetitionSelector.tsx`, locales, `playwright.config.ts`, `e2e/competition.spec.ts`; docs | done (#175) |

## Decision gates

G1 concurrent editing — **decided 2026-10-31** (README decision log;
normative text in `course-layer.md` "Decided by the user 2026-10-31", to
be written out as its §7 by D0). D0, D2, D4 and D11 are unblocked; slice
D stays parked until the user starts it.
