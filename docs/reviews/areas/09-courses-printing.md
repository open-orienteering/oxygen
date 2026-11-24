# Area 09 review: courses, printing and elevation

Part of the November 2026 full review of Oxygen. This is a review only: no code was changed.

- **Reviewed at:** commit `871c74de`, the head of PR #254 (branch `claude/project-thread-avzbks`, course elevation and leg routes) as it stood on 2026-11-23 22:33 UTC. That branch holds `main` up to its merge-base; `main` (`df5460c3`) has moved on since then only in demo and showcase scripts, which are outside this area.
- **Scope:** course editor and course data (controls, legs, courses, class-course assignment), course import and export (IOF XML 3.0, OCAD, Purple Pen), course map and description-sheet printing and the PDF pipeline, start lists, result lists and receipts, and the PR #254 elevation work (climb, profile, leg routes, route finder, speed model, automatic route refresh, Eventor length and climb upload).
- **Method:** the area was split into seven sub-areas. A fresh Fable reviewer read each one in full against its spec docs. Then every finding went to its own fresh Fable verifier, which was given only the location and the claim and was asked to disprove it by reading the code. No test suite was run because `node_modules` was not installed in the review container, so every finding is proven from the code (some with small standalone scripts). Each verifier also set the severity itself, and the severities below are the verifiers'.
- **Outcome:** 7 reviewers raised 101 findings. Verifiers refuted 3, all of them behaviour already listed under a "Pending in this chapter" section. 5 were the same defect found by two reviewers and are merged here. That leaves **93 findings: 92 confirmed and 1 plausible.**

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 62 |
| Low | 28 |

No finding reached critical. The verifiers moved most of the reviewers' "high" findings down to medium, because each needs a specific setter action or an unusual course shape before it does harm. They are still the ones most likely to hurt at an event, and they are listed first within medium.

### Fix these five first

1. **CRS-001: re-importing courses resets every matched control.** Re-importing a course file (say, an updated OCAD export the week before the event) resets each matched control's status, its extra punch codes and its name. A control set to "bad" or given a replacement unit's code silently goes back, so readout judges against the wrong codes. Size S.
2. **CRS-005: an empty or unreadable course file still wipes the event's courses.** A file that parses to zero courses still runs the default replace-all wipe of courses, controls and class assignments. CRS-022 adds that this wipe and the import that follows run outside one transaction, so a failure part-way leaves the event half-imported. Size S, then M.
3. **CRS-015: queued course-editor writes can land in another competition.** Editor writes that are still queued keep sending after the user navigates away. The competition header is read from the URL at send time, so moves made in one competition can be written into the next one the user opens. Size M.
4. **CRS-002: setter maps go stale without warning.** Setter maps are a frozen list of controls. A control added or placed after the maps were generated appears on no setter map, and nothing says so. Size M.
5. **CRS-009: description sheets for forked classes are wrong.** For a forked or butterfly class, `descriptions.pdf` prints the root course's first-alternative controls for every runner, so most runners get a sheet that does not match their map. Size M.

The only high in security, **CRS-003** (stored XSS through uploaded SVG graphics), comes next. A laptop at an arena is a small attack surface, but the fix is small.

### Per sub-area

- **Course data and course/control API:** Event scoping and capability gating are sound across the course/control/class/courseObject routers and the structure/variant materialisation is carefully transactional; the real risks are the name-based start mirror, importCourses (resets control status/codes, can revive removed duplicates, non-atomic replaceAll), weaker code validation and uniqueness on control.update/create, and a few mid-event hazards (variant re-deal of finished runners, course.delete leaving references, map numbers shifting past an unplaced control).
- **Course import/export (IOF XML, OCAD, Purple Pen):** Export is structurally sound and escaping/XXE look safe, but the import path can silently produce wrong courses mid-event: an empty parse still runs the default replace-all wipe, re-import resets control codes and status, the OCD parser flattens forks and drops unresolved controls, and positions from IOF/OCD are never checked against the event map.
- **Course map printing and PDF:** The composer, writer and operator maths (scale, T_map, colour order, frame culling, patch-keyed document cache, event scoping of rows and graphics) read as sound; the real risks are at the edges: description sheets ignore variants, setter maps go stale, missing graphics print silently (even when they replace a control circle), SVG uploads are a stored-XSS vector, and the server print worker has a total-time timeout with a stale-worker race.
- **Start/result lists and receipts:** Printing never blocks a card readout, and lists and receipts are correctly scoped to one competition, but the result list endpoint has real correctness gaps (ties, no-timing classes, midnight, missing flags, no tests), every receipt prints a wrong finish split, and a stalled printer can hang the registration dialog and lead to a duplicate registration.
- **Elevation, climb, leg routes, route finder (PR #254):** Climb maths, typed-vs-computed precedence, route permissions and competition scoping, and the migrations read correct; the problems are in the background automatic-route refresh — one high (it writes and journals from a node without the lease), four medium (stale climb for courses that join a pair mid-refresh, climbs empty for minutes, one bad pair blocking its chunk, whole-event re-search after any map correction) and three low.
- **Web course editor: pages:** The editor's single-user write path is careful, but multi-editor safety and concurrency have real holes (15 findings: 3 high, 10 medium, 2 low). The highest risks: (1) queued/outbox writes continue after navigation and can land in another competition, because the competition header is read from the URL at request time; (2) undo/redo re-send whole pre-edit snapshots on the newest token and silently revert another editor's work; (3) the Controls page shows an unsaved control status as if saved when the write fails. Further medium issues: unserialised undo/redo (reproduced with a small script), delete-undo with variation courses, Class view editing a different variant than drawn, false conflicts in Layout mode, silent failures and lenient code parsing on the Courses page. Nothing was run against the app; all findings are from reading the code, plus one standalone script for the undo ordering.
- **Web course editor: lib/editor:** The editor's pure geometry, hit-testing, snapping, clipboard and conflict rules read clean, but there are four high findings: two write-ordering holes that let a structure edit or an undo silently overwrite other work, and two structure-edit bugs (both reproduced) that put a control into the wrong fork or butterfly loop. Field-mode outbox has three medium durability/routing gaps.

## Findings

Most severe first. Within a severity, the reviewer's original severity breaks ties, then area.

### CRS-001 course.importCourses resets status, extra punch codes and name of every matched control

- **Area:** Course data and course/control API · **Category:** functional · **Severity:** high · **Size:** S
- **Location:** `packages/api/src/routers/course.ts:2067-2071 (written at 2086-2107; values derived at 2004-2026)`; also `packages/api/src/routers/course.ts:2067`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the path is DB-bound). Read packages/api/src/routers/course.ts:1938-1962 (existing-control lookup and keying), :2004-2026 (status/name/codes derived from the file only), :2061-2084 (baseData), :2086-2110 (matched branch writes baseData via control.update), and :331-366 (resolveCourseExpectedPositions). Checked callers in cardReadout.ts:235/371/635, lists.ts:144, event.ts:495, eventor.ts:1587. Searched docs/course-layer.md §6.4 and its Pending notes, plus the import integration tests, for any statement or guard that preserves these fields.
- **Found twice:** a second reviewer reported the same defect independently ("Re-import resets a matched control's codes, status and name", Course import/export (IOF XML, OCAD, Purple Pen)); its verifier also confirmed it.

**What is wrong.** For a file control that matches an existing row, baseData unconditionally writes `status` (valueToControlStatus(0) = ok for every regular control), `codes: pc.id` and `name: ""`. A control the organiser has marked Bad / Optional / NoTiming / BadNoTiming, or given a second accepted code ("31;131", a replaced unit) or a name, loses that on any re-import, although those fields are race configuration the file does not carry. resolveCourseExpectedPositions reads control.status and codes at readout and list time, so results change.

**Scenario.** During an event control 45 is stolen; the organiser sets it to Bad so it is skipped in matching. Later someone re-imports the course file (to add a missing course, fix a position, or map classes). Control 45 is matched by code, its status is written back to ok, and every runner without a 45 punch is evaluated as missing punch in subsequent readouts and in the lists that recompute against the course. Likewise a control stored as "31;131" becomes "31" and punches from unit 131 stop matching.

**Proposed fix.** On the matched (update) branch do not write status for a row that is not changing role (only set start/finish when the file's type differs from the row's kind), keep existing extra codes (write codes only when the first code differs, preserving the tail), and keep a non-empty name. Add an integration test: mark a control bad + multi-code, re-import, assert status/codes unchanged.

**Verifier's note on the fix.** - **Matched ordinary controls:** leave `status`, `codes` and `name` out of the update. Keep the stored status unless the row is start/finish and the kind is changing, keep the stored codes (the file id is already among them, since that is how it matched), and keep a non-empty stored name.
- **Create path:** must still set all three.
- **Name-matched rows:** a row can match by name rather than code (controlByKey also keys by name), so make sure the file code is still added or kept in that case.
- **Kind/status sync:** start/finish rows rely on `status` being written for the kind/status sync (course-layer.md §6.3), and a restored removed row still needs `removed: false`.
- **Spec first:** the spec is silent here, so the project rules require recording the rule in docs/course-layer.md §6.4 before implementing.
- **Severity reasoning:** high, not critical. Nothing is destroyed beyond the three fields, and it needs a re-import after the organiser configured controls. But re-importing a revised course file is a normal operation, and the result is silently wrong readout and list evaluations (missing punches for a voided control, punches from a replacement unit rejected).

<details><summary>Verifier's evidence</summary>

The claim holds as stated; I found no guard, spec text or Pending entry that covers it.

- **Values come from the file only.** course.ts:2004-2009 sets `status` to `valueToControlStatus(0)` for every non-start/finish control; :2022-2025 sets `name = ""` and `codes = pc.id`.
- **Written unconditionally on a match.** baseData (:2067-2071) is `{ name, ...(isEnd ? {} : { codes }), status, ..., removed: false }`. The matched branch (:2086-2107) copies it into `data` and calls `ctx.db.control.update`. `existingControls` selects `status` (:1946) but nothing reads it to preserve the stored value.
- **Multi-code rows are matched, then truncated.** controlByKey keys a row under each `;`-separated code (:1957-1960), so "31;131" matches file id "31" and is rewritten to `codes: "31"`.
- **Only starts and finishes keep their codes** (F32, docs/course-layer.md:1058-1062). The spec is silent on status, extra codes and name for ordinary controls, and descriptions and lat/lng are explicitly preserved when the file lacks them, so the reset is not a documented choice.
- **The fields drive results.** resolveCourseExpectedPositions (:343-364) parses `ctrl.codes` into the accepted codes and turns Bad / Optional / BadNoTiming into `skipMatching` and NoTiming into `noTimingLeg`. It is called at readout (cardReadout.ts:235, 371, 635) and from lists.ts:144, event.ts:495 and eventor.ts:1587.

After a re-import, a control previously marked Bad is required again, and punches from a second unit code no longer match.

The crossing-point branch (:1979-1986) has the same pattern, but it is harmless there because crossing points carry no codes.

No import test asserts either preservation or reset of these fields.

</details>

### CRS-002 Setter maps are a frozen control list: controls added or placed after generation appear on no setter map, with no warning

- **Area:** Course map printing and PDF · **Category:** functional · **Severity:** high · **Size:** M
- **Location:** `packages/shared/src/course-maps/sheet-rows.ts:293`; also packages/api/src/course-maps/auto-sheets.ts:531 (setterMaps), packages/api/src/course-maps/routes.ts:270 (setter export)
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the logic is a plain set filter). Read packages/shared/src/course-maps/sheet-rows.ts:271-302, packages/api/src/course-maps/auto-sheets.ts:490-560 and 590-646, packages/api/src/course-maps/routes.ts:225-271, packages/api/src/routers/courseMap.ts:96-102/345-346/377/523, packages/web/src/pages/editor/layout/SetterSection.tsx, and docs/course-layout.md §8 plus its "Pending in this chapter" section. Grepped every writer of `controlIds` in setter props and every setter mention in check/validation/warning code.

**What is wrong.** A setter sheet draws `ctx.allControls.filter((c) => group.has(c.id))` where `group` is `props.controlIds`, written only by `layout.setterMaps` (auto-sheets.ts:531) and `moveToSetter`. Nothing updates the groups when a control is created, placed, or added to the scoped course afterwards, and neither `courseMap.list` validation, `course.checks` nor `maps.pdf?setter=1` reports scope sites that belong to no setter sheet. The UI row only says 'Setter n · k controls'.

**Scenario.** Setter maps are generated on Monday (3 groups, 42 controls). On Wednesday the course setter adds control 87 to a course. On Friday 'Export > Setter maps' prints three sheets with the original 42 controls; 87 is on none of them, nobody is told, and the control is not put out in the forest.

**Proposed fix.** Compute, per scope, `setterScopeSites(...)` minus the union of the scope's `props.controlIds`; (a) return it from `courseMap.list` / the Setter section as an 'N controls in no setter map' issue with a one-click 'add to nearest setter' or Regenerate, and (b) make `maps.pdf?setter=1` fail with a 400 naming the controls (or append them to the nearest group's sheet by centroid). Add an integration test in setter-maps.test.ts: generate, add a control, expect the issue.

**Verifier's note on the fix.** The spec (docs/course-layout.md §8) is silent on what happens to controls added after generation, so per the project rules the behaviour (auto-assign to nearest group, or a warning listing scope sites in no setter sheet) needs a user decision and a spec entry first. A fix must cover both scopes (event: every placed site; course: `setterScopeSites` including start/finish, crossing points and map-issue points), controls placed after generation as well as newly created ones, and should surface in both `courseMap.list` validation / the Setter maps section and the `maps.pdf?setter=1` export. `moveToSetter` currently refuses a control that is in no sheet, so adopting an unassigned control needs a path. Regenerate is not an acceptable sole remedy because it discards edits and manual moves. The Field-mode setter list reads the same group and needs the same treatment.

<details><summary>Verifier's evidence</summary>

1. A setter sheet draws only its stored group: sheet-rows.ts:293 `allControls: ctx.allControls.filter((c) => group.has(c.id))`, where `group = setterControlIds(row.props)` (sheet-rows.ts:272-275).

2. `props.controlIds` has exactly two writers in the repo: `setterMaps` at auto-sheets.ts:550 (`controlIds: group.map((s) => s.id)`, computed once from `setterScopeSites`, which keeps placed sites only) and `moveToSetter` at auto-sheets.ts:643-644. `moveToSetter` cannot adopt a new control: auto-sheets.ts:637-638 throws BAD_REQUEST "The control is in none of these setter maps" when no sheet of the scope already holds it. Nothing in routers/control.ts or routers/course.ts (create, place, course.update) touches setter rows. docs/course-layout.md §8 states "Written by `layout.setterMaps` only".

3. `layout.recalculateSheet` refits to the same stored group (auto-sheets.ts:594-595), so it does not pick up new sites either. The only remedy is Regenerate, which deletes the scope's setter rows (auto-sheets.ts:541) and loses their edits.

4. No warning anywhere. A grep for "setter" in shared/api/web files named check/valid/warn returns nothing. courseMap.list validates a setter sheet "alone (its controls are its group's)" (courseMap.ts:377, 523). The export `maps.pdf?setter=1` selects `kind: "setter"` rows and only errors when there are none (routes.ts:233-234, 270). It does not regenerate or compare against the scope.

5. The UI row is `layoutSetterRow` = "Setter {{n}} · {{count}} controls" (SetterSection.tsx, en/editor.json:458-459), with no unassigned indicator.

6. Not covered by Pending. The only setter item in docs/course-layout.md "Pending in this chapter" is that Layout mode's canvas draws the view's controls over a setter sheet, not only its group, while "print and the lists are the group's". That makes this worse: a control added later can appear on screen over the setter sheet and still be absent from the printed PDF and the description block.

Also affected by the same mechanism: a control that existed but was unplaced at generation and is placed later, and the Field-mode setter list (it reads the same group via `courseMap.list` `setter.controls`).

Mitigating facts: the all-controls sheet and course sheets are live and do show the new control; the per-sheet count is visible; Regenerate fixes it. The "control is not put out in the forest" outcome is a possible consequence, not a certain one.

</details>

### CRS-003 Stored XSS through SVG graphics: the validator checks a stripped copy, the original bytes are stored and served as image/svg+xml without CSP

- **Area:** Course map printing and PDF · **Category:** security · **Severity:** high · **Size:** S
- **Location:** `packages/api/src/course-maps/graphics.ts:62 (checked at 73-77; bytes stored at 166-174; served at packages/api/src/course-maps/routes.ts:521-524)`; also packages/api/src/course-maps/routes.ts:521-524, 564-567, 612-615
- **Status:** confirmed. Code read plus a standalone node reproduction of the validator. Files read: packages/api/src/course-maps/graphics.ts:31-41, 53-77, 160-175; packages/api/src/course-maps/svg-window.ts:37-52, 92-116; packages/api/src/routers/graphics.ts:90-124; packages/api/src/course-maps/routes.ts:501-527; packages/api/src/restGuard.ts:15-38, 64-105; packages/api/src/auth.ts:41-53; docker/nginx.conf. I copied SVG_FORBIDDEN, sanitizeSvgMarkup and the root/closing checks of parseSvgGraphic into a script and ran both payloads. I grepped the API source and the docker/nginx configs for Content-Security-Policy, helmet, nosniff and X-Content-Type. Not run: a real browser, resvg, or the test suite (node_modules is absent), so script execution in the browser rests on standard SVG/XML behaviour, not on an observed run.

**What is wrong.** parseSvgGraphic runs SVG_FORBIDDEN against `sanitizeSvgMarkup(text)`, which first removes `<metadata>…</metadata>`, the DOCTYPE and processing instructions, but prepareGraphicUpload stores the uploaded bytes (or the trim wrapper around them) unchanged. So content inside what the sanitiser strips is never checked. Proven with a copy of the regexes: `<svg …><metadata><script>alert(1)</script></metadata></svg>` and `<!DOCTYPE svg [<!ENTITY x "&#60;script xmlns='http://www.w3.org/2000/svg'&#62;…&#60;/script&#62;">]><svg …>&x;</svg>` are both ACCEPTED (entities are deliberately kept: course-map-graphics-upload.test.ts 'keeps a DOCTYPE's entities'). `GET /api/maps/:nameId/graphics/:id` (routes.ts:521) answers the raw bytes with `Content-Type: image/svg+xml` and no CSP / nosniff / Content-Disposition; no CSP exists anywhere in the API. In proxy auth mode the session is ambient, so a top-level navigation to that URL runs the script in the app origin. `href="//host/x"` and local file paths also pass the 'external references' regex (resvg resolves local image paths).

**Scenario.** A user with `courses.edit` on any one event uploads the metadata/entity SVG with scope 'club' (visible to every event). They send an instance admin the link /api/maps/<event>/graphics/<id>. The admin's browser renders the SVG document, the script runs with the admin's identity and can call any tRPC mutation (delete events, change permissions, export runner data).

**Proposed fix.** Serve every graphic response (graphics/:id, and defensively print.png / thumb.png) with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `X-Content-Type-Options: nosniff`; optionally `Content-Disposition: inline; filename=…` stays. In the validator, run SVG_FORBIDDEN on the raw decoded text (not the stripped copy), also reject `<!ENTITY` values containing `<`/`&#60;`/`&lt;` followed by markup, and reject `href`/`src` values that are not `#fragment` or `data:image/`. Pass resvg `resourcesDir` unset plus an image-href resolver that refuses non-data URLs if the binding allows. Add the two payloads above to course-map-graphics.test.ts.

**Verifier's note on the fix.** Fix both ends. Serving (routes.ts:521-524): add `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `X-Content-Type-Options: nosniff`, and ideally `Content-Disposition` for SVG, so stored rows already in the database are neutralised too. Validation: run SVG_FORBIDDEN against the raw bytes, not the stripped copy, or store a re-serialised sanitised document. If checking raw bytes, the Illustrator DOCTYPE-with-entities case pinned by the 'keeps a DOCTYPE's entities' test in course-map-graphics-upload.test.ts must still pass: reject entity values containing `<`, `&#60;` or `&#x3c;` and not all DOCTYPEs. A regex blocklist remains bypassable (for example `java&#115;cript:` in an href, or protocol-relative `//host` references), so the response headers are the dependable control. saveToClub copies stored bytes without re-validating, so existing rows need the header fix or a re-scan.

<details><summary>Verifier's evidence</summary>

The defect is real: an SVG carrying script passes validation, is stored unchanged, and is served as an active document on the app origin.

1. **Validator checks a stripped copy.** graphics.ts:62 sets `text = sanitizeSvgMarkup(...)`, and lines 73-77 test SVG_FORBIDDEN against that `text` only. The sanitiser (53-59) removes the XML declaration, `<!DOCTYPE...>` up to the first `>`, comments and `<metadata>...</metadata>`.

2. **Reproduction.** Both payloads returned ACCEPT; the same script outside metadata returned REJECT `/<script/i`:
   - `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><metadata><script>alert(1)</script></metadata><rect width="10" height="10"/></svg>`
   - `<!DOCTYPE svg [<!ENTITY x "&#60;script xmlns='http://www.w3.org/2000/svg'&#62;alert(1)&#60;/script&#62;">]><svg ...><rect .../>&x;</svg>`

3. **Original bytes are stored.** prepareGraphicUpload (graphics.ts:160-175) stores `input` as is, or the trim result. The trim (svg-window.ts:51) is `svg.slice(0, rootStart) + outer + root + svg.slice(rootStart + m[0].length) + </svg>`, so the DOCTYPE prolog and all inner content, metadata included, survive. If resvg throws, the catch at graphics.ts:170 keeps the upload as is.

4. **Upload gate.** routers/graphics.ts:90 uses `coursesEditProcedure`; `scope: "club"` stores `eventId: null` (line 116) with no extra capability.

5. **Serving.** routes.ts:508-526 requires only `courses.view` on any event, matches `OR: [{eventId: event.id}, {eventId: null}]`, and replies with `Content-Type: graphic.mime` and Cache-Control only. There is no CSP, nosniff, Content-Disposition or sandbox, and none in the API source or docker/nginx.conf, which proxies `/api` on the same origin as the SPA and `/trpc`.

6. **Ambient identity.** In `AUTH_MODE=proxy`, restGuard.ts:29-31 takes the user from the proxy-injected header (default `x-forwarded-email`), so a top-level navigation is authenticated and the script can call `/trpc` as the victim.

7. **Not excused elsewhere.** No guard, test or "Pending" note in docs/course-print.md or docs/course-maps.md covers this.

**Limits that bear on severity:**
- The app embeds graphics as `<img>` or rasterised PNG, which does not run script; the victim must open the raw graphic URL at top level (a same-origin link).
- It only matters in proxy auth mode; with auth off, everyone already has full access.
- The attacker must already hold `courses.edit` on an event.
- The secondary claims (`href="//host/x"` and local file paths passing the external-reference regex) are consistent with the regex at graphics.ts:37, which only matches `https?:`. I did not test whether resvg resolves them.

That makes it a privilege escalation from course editor to whatever the victim can do, needing one click: high, not critical.

</details>

### CRS-004 A course's start is mirrored by name; renaming a start or a duplicate start name silently re-points courses to another start

- **Area:** Course data and course/control API · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/course-structure.ts:60`; also packages/api/src/routers/control.ts:797 (count+1 naming), :930 (rename without mirror update), :205-262 (courseIdsUsingControl by name); packages/api/src/routers/course.ts:402-404, 500-505 (startControlId by name); packages/shared/src/course/sequence.ts:118
- **Status:** confirmed. Code read only (no reproduction run; the logic is a plain name lookup). Files: packages/api/src/course-structure.ts:54-71, 179-186, 205-258; packages/api/src/routers/control.ts:195-247, 786-798, 925-1050, 1120-1141; packages/api/src/routers/course.ts:399-406, 505-538, 820-834, 925-936 (also callers at 665, 1199); packages/shared/src/course/sequence.ts:97-131; packages/web/src/pages/editor/EditorPage.tsx:746; packages/web/src/pages/ControlsPage.tsx:660-697; packages/api/prisma/schema.prisma (no unique on controls name); docs/course-layer.md §6.2 and its Pending section.

**What is wrong.** The explicit start of a course is mirrored into courses.start_name (the start control's NAME) and resolved back with starts.find(s => s.name === c.startName) over starts ordered by seq (structureFromColumns, courseSequenceOf's column path, courseIdsUsingControl, course.list/detail's startIdByName). Nothing keeps the name unique or follows a rename: control.update writes data.name with no check and no course update (routers/control.ts:930), and control.create auto-names with `count of live starts + 1` (routers/control.ts:797), which produces a duplicate after a delete. Every 'rewrite the structure from the columns' path (course.update with controlIds/orderMode/start/finish, course.bulkUpdate, control.delete on a plain course -> rewriteStructureFromColumns, line 243) then throws away the UUID the stored structure held and re-resolves the start by name.

**Scenario.** (a) Start 1 and Start 2 exist, course B explicitly uses Start 2. The setter renames 'Start 2' to 'Start Norr' on the Controls page. Later any control on course B is deleted (control.delete) or its sequence is edited through course.update: rewriteStructureFromColumns finds no start named 'Start 2', drops the explicit start, and B is drawn, measured (legs/length_m), exported and printed from Start 1. (b) Start 1 and Start 2 exist; Start 1 is deleted and a new start is added: count=1 so it is also named 'Start 2'. course.update { startControlId: <new start> } stores startName 'Start 2' and the rewrite resolves it to the OLD Start 2 (lower seq), so the user's choice is silently replaced; course.list also reports the wrong startControlId and the IOF export emits two controls with id 'Start 2'.

**Proposed fix.** Stop round-tripping the start through its name: in rewriteStructureFromColumns keep the previous stored structure's explicit start/finish item when it is still a live start/finish (only fall back to startName for a NULL structure), and in control.update, when a start's name changes, update courses.start_name for the courses that referenced the old name in the same transaction (emit course.upserted, advanceVersion false). Make control.create pick the lowest unused 'Start N'/'Mål N' instead of count+1 and refuse a start/finish name another live start/finish holds. Add integration tests for rename and delete-then-create.

**Verifier's note on the fix.** - **Rename:** `control.update` with a name change on a start must update `start_name` on the courses that hold the old name, in the same transaction, and emit `course.upserted` for them. `courseIdsUsingControl` must be computed with the old name, before the write.
- **Auto-naming:** `control.create` should pick a free "Start N" (for example max suffix + 1, or loop until unused) instead of count + 1. Consider rejecting a duplicate start name in both `control.create` and `control.update`.
- **Rewrite:** `rewriteStructureFromColumns` could keep the previous structure's explicit start UUID when `start_name` still equals that start's current name, or when the linear write did not touch the start.
- **Other by-name readers to keep consistent:** `course.list` / `course.detail` (`startIdByName`), `structureOfPayload` (course-structure.ts:404), and the importers at course.ts:2018 and 2189.
- **Docs:** docs/course-layer.md §6.2 needs the rule recorded, per the repo's spec-first rule.

<details><summary>Verifier's evidence</summary>

Both scenarios follow from the code; I found no guard that prevents either.

**Rename (a)**
- `control.update` sets `data.name = input.name` (control.ts:930) with no uniqueness check.
- Dependent courses are only computed when `positionChanged || kindChanged` (control.ts:~1027), so a rename never touches `courses.start_name`.
- The Controls page exposes this rename for any control (`ControlsPage.tsx` `handleSave` -> `control.update {name}`).
- While the stored structure is valid, readers still resolve the start by UUID (sequence.ts:108-117), so drawing stays correct at first.
- `course.list` / `course.detail` already report `startControlId: null` right after the rename (course.ts:404-405, 536-537), because they look the stale name up.
- The next rewrite loses the start: `rewriteStructureFromColumns` (course-structure.ts:243-258) nulls the structure, and `loadExplicitStructure` -> `structureFromColumns` runs `starts.find(s => s.name === c.startName)` (line 60). With the stale name this finds nothing, so no start item is written.
- `courseSequenceOf` then falls back to `sites.starts[0]`, the lowest-seq start (sequence.ts:124).
- The rewrite is triggered by `control.delete` on a plain course (control.ts:1141), `course.update` with controlIds/orderMode/flags/start/finish (course.ts:928-936, used by `CoursesPage.tsx:736`), and `course.bulkUpdate` (course.ts:1199).

**Duplicate name (b)**
- `control.create` auto-names with the live count + 1 (control.ts:791-797).
- The editor's Add start sends no name (`EditorPage.tsx:746`: `control.create {status:4,xpos,ypos}`).
- So with Start 1 and Start 2, deleting Start 1 and adding a start gives a second "Start 2".
- `course.update {startControlId}` stores only `start.name` (course.ts:833); the rewrite then picks the first match by seq ascending, which is the older start.
- `startIdByName` is a Map keyed by name, so it collapses the two starts as well (course.ts:505-509).

**What I checked to disprove it**
- No unique constraint on (event, name) for controls in the Prisma schema.
- The Pending section of docs/course-layer.md does not list this.
- §6.2 documents "a start is found by name in start_name" and the deleted-start case, but says nothing about rename or duplicate names.
- `course.setStructure` -> `persistStructure` re-mirrors the current name (course-structure.ts:182), so courses saved through the new editor heal themselves. The linear shortcuts and `control.delete` do not.

**Not verified**
- The claim that the IOF export emits two controls with id "Start 2"; I did not read the export id logic. It does not affect the verdict.

**Severity**
Medium. The result is silently wrong (start, legs, length, print), but it needs an event with several starts plus either a start rename or a delete-then-add of a start, followed by a column-rewrite path. Nothing is lost and it is recoverable by re-picking the start.

</details>

### CRS-005 A file that parses to zero courses still runs the default replaceAll wipe

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** S
- **Location:** `packages/api/src/routers/course.ts:1921`; also packages/web/src/components/CourseImportDialog.tsx:494; packages/api/src/iof-course-parser.ts:198; packages/api/src/ocd-course-parser.ts:283
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent). Followed importCourses from input to the wipe in /home/user/oxygen/packages/api/src/routers/course.ts:1817-1936, parseCourseFile at :222-236, resolveImportAlignment in /home/user/oxygen/packages/api/src/course-import-align.ts:160-201, both parsers, and the dialog /home/user/oxygen/packages/web/src/components/CourseImportDialog.tsx. Grepped course.ts for any emptiness guard and docs/course-*.md, docs/map-*.md for a Pending entry.

**What is wrong.** importCourses never checks that the parsed file contains any course or control before the replaceAll wipe (soft-delete every course and control, null every class.courseId). The dialog defaults replaceAll to true (CourseImportDialog.tsx:30) and its Import button is only disabled while pending (line 494), so 'Import 0 courses' is clickable. Several inputs parse to an empty result without an error: an .ocd with no course records (parseOCDCourseData has no magic or content check), and an IOF file with two RaceCourseData elements (iof-course-parser.ts:198 gets an array, so .Control/.Course are undefined).

**Scenario.** Mid-event the operator picks the map .ocd instead of the course .ocd (or a multi-race CourseData XML). Preview shows 0 courses; they click Import with the pre-ticked 'Replace all'. Every course and control of the event is soft-deleted and every class loses its course, so readout evaluates runners against no course until someone re-imports and re-maps the classes.

**Proposed fix.** In importCourses throw BAD_REQUEST when parsed.courses.length === 0 (and when no control resolved), before the wipe. Disable the Import button on an empty preview. In parseOCDCourseData reject a buffer without the 0x0CAD magic; in parseIOFCourseData add CourseData.RaceCourseData to isArray and either take the first or refuse several.

**Verifier's note on the fix.** Put the guard on the server in importCourses before course.ts:1921 (refuse when parsed.courses and parsed.controls are both empty, at least when replaceAll is true); a dialog-only fix leaves the API open. Also disable the Import button when preview.courses.length is 0. Consider whether a controls-only file (controls, zero courses) is a legitimate import before refusing on courses alone. Separately, the IOF parser should handle or reject multiple RaceCourseData elements instead of yielding an empty result, and the wipe plus import is not transactional, so any later failure also leaves the event wiped.

<details><summary>Verifier's evidence</summary>

1. No emptiness guard before the wipe. course.ts:1837-1842 parses and aligns; the only pre-wipe refusal is the start/finish code collision loop (:1900-1917), which iterates parsed.controls and is a no-op when empty. At :1921-1936 `if (input.replaceAll)` runs course.updateMany({removed:true}), control.updateMany({removed:true}) and class.updateMany({courseId:null}) for the whole event. The only `courses.length === 0` in the file is :205 (class-name inference), not a guard. resolveImportAlignment has no throw; it returns the base outcome when there is no source or event map.

2. The wipe is not in a transaction (bare ctx.db calls; $transaction is used elsewhere in the file but not here), so nothing rolls it back.

3. Empty parses without error:
- ocd-course-parser.ts:282-286: the only check is `fileData.length < 16`. No magic or content check. Objects outside symbols 700000-799999 are skipped (:317), so a plain map .ocd yields zero controls and zero courses.
- iof-course-parser.ts:148-160: isArray lists only Control, Course, CourseControl and ClassCourseAssignment paths, so two <RaceCourseData> elements come back as a JS array. :198-201 only checks truthiness; `raceCourseData.Control ?? []` (:208) and the Course read (:235) are then undefined on the array, giving empty lists. parseIOFCourseDataWithGeometry is an alias of the same function (:386). This follows from fast-xml-parser's standard repeated-element behaviour; I did not execute it.

4. UI: CourseImportDialog.tsx:30 `useState(true)` for replaceAll; :494 `disabled={importMutation.isPending}` only; :504 label is importCount with preview.courses.length, so "Import 0 courses" is clickable. handleImport (:106-113) sends replaceAll with no confirmation. The server default is false (course.ts:1825), so only the dialog path defaults to wiping.

5. Not listed as pending: no matching entry found in docs/course-*.md or docs/map-*.md.

Not verified: the claimed downstream effect that readout evaluates runners against no course once class.courseId is null. I did not trace the readout path.

Severity reasoning: the damage is soft-delete (removed=true) plus nulled class.courseId. Courses and controls come back by re-importing the right file (the import reactivates rows by name), but class-to-course assignments must be redone unless the file carries them. It needs an operator to pick the wrong file and click Import despite a preview showing 0 courses and 0 controls. That is an unusual case with a recoverable outcome, so medium rather than high.

</details>

### CRS-006 OCD course records with leg or relay variations are flattened into one linear course

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/ocd-course-parser.ts:256-263`
- **Status:** confirmed. Code read of /home/user/oxygen/packages/api/src/ocd-course-parser.ts:246-278 (parseRecord) and :646-759 (course build), the only caller /home/user/oxygen/packages/api/src/routers/course.ts:226-227, the Purple Pen guard at /home/user/oxygen/packages/api/src/ppen-course-parser.ts:269-274, the OCD parser tests, and a grep of docs/map-*.md, docs/course-*.md, docs/guide and docs/system for a documented limitation. Standalone node copy of the token loop run on a forked record. The OCAD token meanings could not be checked against a real forked .ocd file, because the repo has none.

**What is wrong.** parseRecord collects every 'c<code>' token of a course record in file order and ignores all other sequence tokens. In OCAD's course string (type 2) variations are encoded inline (l/b/p for leg variations, r/v/q for relay variations, also k/w crossing points and g map change), so a forked course yields all branches' controls concatenated. The Purple Pen parser refuses branching with a clear error (ppen-course-parser.ts:269); the OCD parser imports silently. Token meanings are from the OCAD file-format description (the parser's own use of C, E and m agrees with it); no forked fixture exists in the repo to confirm.

**Scenario.** OCAD course 'H21' = S1, 31, then fork (32 | 33), 34, M1. Import creates one course 31-32-33-34. Every runner, whichever fork they ran, is missing a control and is MP; printed maps and description sheets show both fork controls in sequence with a leg between them.

**Proposed fix.** In parseRecord detect the variation tokens (l, b, p, r, v, q) on a course record and throw an error naming the course, as the ppen parser does (or expand to variants). Require strType === 2 for course records. Add a unit test with a synthetic record.

**Verifier's note on the fix.** - **Minimum fix:** throw a clear error, as the Purple Pen parser does, when a course record contains a bare l/b/p or r/v/q token.
- **Match whole tokens, not prefixes:** the loop uses `startsWith` on single letters and class records also use `c`/`r` prefixes, so variation markers must be detected as exact tokens (or by the documented argument form) and only inside the course branch (`hasS && hasF`). Otherwise a start named `r...` or a relay token could be misread.
- **Verify against a real file first:** confirm the exact token form with a forked OCAD file before finalising, and add it as a fixture. None exists in the repo.
- **k/w/g tokens:** crossing points and map change are also dropped silently. Decide whether to ignore them (harmless for punch checking) or surface them.
- **Docs:** add the limitation to docs/guide/maps.md and add a bugfix doc per AGENTS.md §10.

<details><summary>Verifier's evidence</summary>

The flattening is proven from the code; the only unverified link is that real OCAD files encode forks the way the claim says.

- **Token loop:** ocd-course-parser.ts:256-263 handles only the prefixes s, f, c, m, E and C. Every `c<code>` is pushed to one flat `controls` array in file order (line 259). Tokens l, b, p, r, v, q, k, w and g match no branch and are dropped without a warning or error.
- **Course build:** line 651 builds `all = [start, ...controls, finish]`, and lines 656-722 emit one linear control sequence with a leg between each consecutive pair, so the two fork controls get a leg drawn between them.
- **No guard downstream:** `parseCourseFile` (course.ts:226-227) returns the parser result directly. Nothing detects variation tokens.
- **Reproduction:** the record `H21\tY0\tsS1\tc31\tl\tc32\tb\tc33\tp\tc34\tfM1` run through a copy of the loop gives start S1, controls [31, 32, 33, 34], finish M1.
- **Contrast:** the Purple Pen parser throws "has branching <next> links (relay/variation courses are not supported)" at ppen-course-parser.ts:269-274, and docs/system/ppen-import-export.md:132 documents that limit. No equivalent exists for OCD.
- **Not documented as pending:** no "Pending" section in docs/map-*.md or docs/course-*.md mentions OCD course variations. docs/guide/maps.md:7 describes OCD import with no caveat.
- **No test coverage:** packages/api/src/__tests__/ocd-course-parser.test.ts covers map scale, leg lengths and authored geometry only.
- **Format assumption:** the token meanings (l/b/p leg variation, r/v/q relay variation, k/w crossing points, g map change) match the published OCAD course-string description as I recall it, and the parser's own s/c/f/C/E use agrees with that description.

Severity is medium, not high. The failure is certain only for the less common case of an OCAD course-setting file with leg or relay variations; linear courses are unaffected. The result is visible at import (the course lists both fork controls and has an inflated length) and on the printed map, so it is likely to be noticed before race day. If it is not noticed, every runner on that course would be marked MP.

</details>

### CRS-007 Course controls without a resolvable control are silently dropped from the sequence

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/ocd-course-parser.ts:659 (also packages/api/src/routers/course.ts:2265; packages/api/src/iof-course-parser.ts:273 with safeStr at :171-177)`; also packages/api/src/routers/course.ts:2265; packages/api/src/iof-course-parser.ts:273
- **Status:** confirmed. Code read only, no reproduction run (node_modules absent, and the OCD path needs a binary fixture). Read packages/api/src/ocd-course-parser.ts:213-275, 293-385, 560-760; packages/api/src/routers/course.ts:1843-1870, 1960-2145, 2200-2290; packages/api/src/iof-course-parser.ts:148-177, 200-300. Grepped the importer for any warning or skipped-control reporting and docs/course-*.md / docs/map-*.md for a Pending entry covering it.

**What is wrong.** In the OCD parser a control named in the course record but with no position found among the 701/702/703/706 objects is skipped (`if (!ctrlPos) continue`), although the same code is still added to the control bank at (0,0). In importCourses any CourseControl whose id is not in controlIdMap is skipped the same way (course.ts:2265). In the IOF parser a CourseControl with several <Control> children (schema allows 1..n) becomes the string '31,32' via safeStr and is then dropped. No error or warning is produced; the preview only shows the reduced count.

**Scenario.** An OCD file where one control's code cannot be read from the object text (the regex at line 328 allows only [A-Za-z0-9_-.]{1,15}, and the 703 display-number fallback fails). Course B imports with 11 instead of 12 controls: runners who skipped that control get OK results, and the printed course and description sheet lack it.

**Proposed fix.** Keep position-less controls in the parsed sequence (the importer already supports unplaced controls at 0,0); only the geometry needs a position. In importCourses, throw BAD_REQUEST listing course and control id when a CourseControl references an unknown control. In the IOF parser handle an array-valued cc.Control explicitly (refuse or take the first with a warning).

**Verifier's note on the fix.** The skip at course.ts:2265 also covers crossing points, which are intentionally never items (course-layer.md §10.3); a fix must keep that and report only ids that are missing from controlIdMap. The OCD parser has no warnings field on ParsedOCDCourseData, so one must be added and carried through previewImport and importCourses. The OCD skip also drops an unresolved start or finish, and the bank still receives the unresolved code at (0,0) (lines 624-640), so both need handling together. For IOF, decide explicitly what a multi-`<Control>` CourseControl means (alternatives) instead of stringifying the array; choosing a behaviour is a spec question for the user per CLAUDE.md.

<details><summary>Verifier's evidence</summary>

All three drop sites exist as claimed and none reports anything.

1. OCD parser (ocd-course-parser.ts)
- Lines 566-571: `allCodes` collects every code named in the course records.
- Lines 624-640: every code in `allCodes` is pushed to the control bank with `mapX: p?.xMm ?? 0, mapY: p?.yMm ?? 0`, so an unresolved code becomes a bank control at (0,0).
- Lines 656-659: when building the course, `const ctrlPos = controlObjs.get(code); if (!ctrlPos) continue;` drops it from `cCtrls`. The same skip applies to start and finish.
- Lines 577-622: the display-number fallback only helps when a 703 label carrying the ordinal exists; otherwise the code stays unresolved.
- The parser has no warning channel: grep for warn/skip/missing in the file finds nothing.

2. importCourses (routers/course.ts)
- Lines 2262-2265: `const siteId = controlIdMap.get(cc.controlId); if (!siteId || crossingIds.has(cc.controlId)) continue;`.
- The item list goes straight to `linearStructure` and `persistStructure` (lines 2279-2281) with no count check.
- The only `warn` in the mutation is the CRS load failure at line 1886.

3. IOF parser (iof-course-parser.ts)
- Lines 151-159: `isArray` forces arrays only for Control, Course, CourseControl and ClassCourseAssignment under RaceCourseData. Repeated `<Control>` children inside one CourseControl therefore arrive as a plain JS array.
- Lines 171-177: `safeStr` falls through to `String(val)`, giving "31,32".
- Line 273: that string becomes `controlId`; it is not in `controlIdMap`, so course.ts:2265 drops the row.

Not refuted elsewhere: no Pending section in docs/course-*.md or docs/map-*.md lists this as unimplemented. The only related documented skip is crossing_point / map_issue items (docs/course-layer.md:184), which is intentional and separate.

Severity is medium, not high. The trigger needs an unusual file:
- OCD: a course record naming a code that no 701/702/703/706 object resolves to and no ordinal 703 label rescues. OCAD codes are normally short alphanumerics that the regex at line 328 accepts, and OCAD does not normally leave a course referencing a control with no object.
- IOF: a CourseControl with several `<Control>` children is schema-legal but rare in exporter output.
When it does trigger, the consequence is serious (a control missing from the course, so punch evaluation and printed output are wrong) and the only visible sign is a lower control count. The claimed downstream effect on results was not traced; it follows from the stored course lacking the control.

</details>

### CRS-008 A class mapped to several courses is assigned to whichever comes last, silently

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/routers/course.ts:2314`; also packages/api/src/routers/course.ts:180
- **Status:** confirmed. Code read only, no reproduction run (the logic is a plain loop and a string `includes`). Files: /home/user/oxygen/packages/api/src/routers/course.ts lines 164-188, 201-215, 1741-1762, 2314-2334; /home/user/oxygen/packages/web/src/components/CourseImportDialog.tsx lines 41-53, 388-404; /home/user/oxygen/packages/api/src/course-export.ts lines 230-248; /home/user/oxygen/packages/api/src/iof-course-parser.ts lines 297-305; /home/user/oxygen/docs/course-layer.md lines 1090-1091 and 2518-2519; /home/user/oxygen/docs/course-import-class-fallback.md.

**What is wrong.** importCourses applies classMapping course by course and overwrites class.courseId each time, with no check that a class appears under one course only. Two normal inputs produce that: (1) an IOF file with several ClassCourseAssignment rows for one class (forked or relay classes from OCAD/Condes, and Oxygen's own export, which writes one assignment per variant); (2) the course-name fallback plus the substring matcher (findBestClassMatch lines 180-188), which pre-selects class 'D10' for a course named 'D1' even when course 'D10' matched it exactly. The dialog pre-fills all matches including substring ones (CourseImportDialog.tsx:47).

**Scenario.** File has courses 'D10' then 'D1'; the event has class D10 but no D1. Preview pre-selects D10 for both. After import class D10 runs course 'D1' (last write wins): wrong course on results, start list lengths and printed class maps. Likewise a forked class from an IOF file ends on the last variant only.

**Proposed fix.** Server: after resolving the mapping, if a class seq appears under more than one course, reject with BAD_REQUEST naming the class (or keep the exact match and report the rest). Preview: do not pre-select a substring match for a class that another course matched exactly or by normalised name; flag classes suggested for several courses.

**Verifier's note on the fix.** - Many classes on one course is legitimate and must stay allowed; only one class under several courses is the conflict.
- Detect the conflict in both places: the preview/dialog (warn, or do not pre-select a heuristic match for a class that already has an exact match under another course) and `importCourses` (reject or report, since the API accepts any mapping).
- For a class assigned to every course of one CourseFamily (Oxygen's own export of a forked class), "pick one" is still wrong; since no group is inferred on import, it needs an explicit decision, and per CLAUDE.md the spec is silent here, so ask the user and record the answer in docs/course-layer.md first.
- The mapping is keyed by course name with position-aligned arrays where 0 means skip; keep that alignment.
- `classesAssigned` currently counts overwritten assignments.

<details><summary>Verifier's evidence</summary>

The claim holds; I found no guard anywhere on the path.

1. Last write wins (course.ts:2314-2334). `importCourses` loops `Object.entries(input.classMapping)` and, for every class seq > 0, runs `class.update({ data: { courseId: courseUuid } })`. Nothing checks whether that class was already assigned by an earlier course in the same mapping. The zod input (`record(string, array(int))`, line 1822) has no uniqueness rule, and `classesAssigned++` counts both writes. The preview (1753-1762) builds `classMap` per course with no cross-course check either.

2. Substring matcher (course.ts:180-188). For 'D1' against a class list holding 'D10' and no 'D1': exact and normalized both miss, then `"d10".includes("d1")` is true, so D10 is returned as a `substring` match. Course 'D10' matches the same class exactly. With the course-name fallback (`deriveClassAssignments`, 201-215, only when the file has zero assignments) both courses get class D10.

3. Dialog pre-fill (CourseImportDialog.tsx:45-51). The initial mapping takes `m.matched ? m.dbClassId : 0` for every match type, so the substring match is pre-selected. Key order is file course order (non-integer keys keep insertion order), so 'D10' then 'D1' leaves class D10 on course 'D1'. In the reverse file order the result happens to be right.

4. Several ClassCourseAssignment rows for one class. The parser (iof-course-parser.ts:297-305) keeps every row. Oxygen's own export writes one assignment per variant for a class on a root (course-export.ts:230-248; course-layer.md:2040 "a class on the root assigned to each"). Re-importing that file gives the class an exact match under each variant course, and it ends on the last variant, with no amber marker since every match is exact.

Mitigations that exist but do not remove the defect:
- The substring row is tinted amber with a tooltip (CourseImportDialog.tsx:390-404), and the fallback shows an amber banner. Nothing says the same class is selected under two courses.
- docs/course-layer.md:1090 and 2518 document that an imported CourseFamily stays separate linear courses (no group inference, F9). That covers the loss of forking, not the class silently landing on one variant; no "Pending" section mentions it.

Severity is medium, not high. Case (2) needs a file with no class assignments, a course name that is a prefix or substring of another class's name, and that course's own class missing from the event; the row is visibly flagged as heuristic. Case (1) needs a forked or multi-course class, where import is already documented as not rebuilding the fork. When it does happen the effect is real: the whole class is evaluated against the wrong course until someone corrects the class's course, which is a one-field fix and not data loss.

</details>

### CRS-009 descriptions.pdf prints the root's first-alternative controls for every runner of a forked/butterfly class

- **Area:** Course map printing and PDF · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/course-maps/descriptions-pdf.ts:194-201 (class branch; the runner query at :144 and the courses= branch at :180-188 are part of it)`; also docs/course-print.md §6.4 (state the per-variant rule)
- **Status:** confirmed. Code read only (no reproduction: needs a database, node_modules absent). Read /home/user/oxygen/packages/api/src/course-maps/descriptions-pdf.ts:127-201 (selectDescriptionBlocks), /home/user/oxygen/packages/api/src/course-structure.ts:147-149 (persistStructure mirrors structureControlItems into course_controls), /home/user/oxygen/docs/course-layer.md:2161-2163, /home/user/oxygen/docs/course-print.md §4.6 (375-442), §6.4 (662-731) and "Pending in this chapter" (1964 on), the web dialog packages/web/src/lib/editor/export-menu.ts:129-133, and maps.pdf's selection in packages/api/src/course-maps/routes.ts:139-215 for contrast. Grepped descriptions-pdf.ts, DescriptionSheetsDialog.tsx and integration/descriptions-pdf.test.ts for variant/fork/butterfly: no hits.

**What is wrong.** selectDescriptionBlocks builds one block per class from the class's course row (`courses.get(c.courseId)` and its `courseControls`). For a root with variations, `course_controls` holds only the first alternatives (docs/course-layer.md line 2161), and the function never looks at the child variant courses or `runner.course_id`. maps.pdf prints one page per variant (selectPrintPages), but the loose description sheets do not. docs/course-print.md §6.4 claims the block is 'the sheet's by construction' and Pending does not list this.

**Scenario.** Class H21 runs root course 'Long' with variants AB and BA, 20 runners each. Export > Description sheets (count) -> 40 copies of the AB (first-alternative) description, header 'Long'. The 20 BA runners get loose descriptions with the wrong control order and codes for their forked legs. With `courses=<variant seq>` the block is right, but the count is 0 runners (floored to 1 copy) and the class header is empty, because classes point at the root.

**Proposed fix.** In selectDescriptionBlocks, when the class's (or requested) course has live children (`parentCourseId = course.id, removed = false`), emit one block per child in key order via the same `rowForVariant` fields maps.pdf uses (name `<root> <key>`, child structure and courseControls), with count = runners whose `course_id` is the child (plus class filter). Keep the single block for plain courses. Add an integration test on the butterfly fixture used by variant-pages.test.ts.

**Verifier's note on the fix.** The spec is silent, so per CLAUDE.md the per-variant rule must be asked of the user and written into course-print.md §6.4 before code changes, with a decision-log row. A fix has to account for: (1) per-variant blocks for a root with live children, with counts from `runner.course_id` per class — maps.pdf's `runnersOf` (routes.ts:209-215) treats a NULL runner course as the class's course, and vacancies have no variant, so their allocation needs a rule; (2) tiling's "classes never share a page / one label per page" and the /PageLabels and outline, which assume one block per class; (3) `courses=<child seq>` should resolve classes and counts through the parent; (4) the 200-page cap count; (5) uniform-numbering roots (F15) versus unequal forks; (6) the integration test descriptions-pdf.test.ts has no forked fixture.

<details><summary>Verifier's evidence</summary>

The claim holds; I could not find a guard, a Pending entry or a decision that covers it.

- **Class branch ignores variants.** descriptions-pdf.ts:194-201 loads `db.course.findMany({ where: { id: { in: courseIds } } })` from `class.courseId` only and builds one block per class from `course.courseControls` (line 152-166). The runner query (line 144) selects only `classId`, so `runner.course_id` (the pre-set variant) is never read, and nothing queries `parentCourseId` children.
- **Root rows are the first alternatives.** course-layer.md:2161-2163: "the root keeps `course_controls` = the first alternatives (`structureControlItems`, 08 §4.3's root path)"; persistStructure (course-structure.ts:147-149) writes exactly that. course-print.md §4.6 line 424 also says the root's block is "its first-alternatives path".
- **Count is the whole class.** `countOf` (line 149) = all runners of the class + vacancies, so every runner of a forked class gets a copy of the first-alternative block.
- **The UI always takes this branch.** `descriptionSheetsUrl` (export-menu.ts:129-133) is "always explicit classes".
- **`courses=<variant seq>` side claim also holds.** Lines 180-188 accept any course seq with no parent filter; `own = classes.filter(c => c.courseId === course.id)` is empty for a child, so the header has no class and the count is 0 (I did not locate the floor-to-1 code, but §6.4 states "at least 1").
- **Spec is silent.** §6.4 says the rows "are the sheet's by construction" and has no per-variant rule; the Pending section's only description-sheet item (line 2020) is about staying API-only. maps.pdf, by contrast, prints per variant with per-runner counts (routes.ts:139-215, §4.6). Decision row F11 (decisions/slice-f.md:9) does not mention variants.

Severity: medium, not high. It only affects classes on a course with variations (forked/butterfly), and the description block printed on each runner's variant map page is correct; only the loose sheets are wrong, with nothing in the label warning the organiser.

</details>

### CRS-010 A graphic that cannot be loaded is silently dropped from the PDF, even when it replaces a control's circle and number

- **Area:** Course map printing and PDF · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/shared/src/course/layer.ts:59`; also packages/shared/src/print/course-pages.ts:184 (SVG_RASTER continue), packages/api/src/course-maps/routes.ts:450, packages/web/src/print/client.ts:239, packages/api/src/routers/graphics.ts:161
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent). Read packages/shared/src/print/compose.ts:114-121, packages/shared/src/print/course-pages.ts:167-196, packages/shared/src/print/print-job.ts:86-97, packages/api/src/course-maps/routes.ts:438-456, packages/web/src/print/client.ts:165-181 and 218-241, packages/api/src/routers/graphics.ts:160-174, packages/shared/src/course/objects.ts:197-211, packages/shared/src/course/layer.ts:56-59, packages/shared/src/course/derive.ts:288, packages/web/src/components/GraphicPicker.tsx:35-96, plus docs/course-print.md (lines 624, 942-944, 1142-1144, 1231), docs/course-layer.md:1354-1366 and docs/research/vector-map-pipeline/decisions/slice-j.md:16.

**What is wrong.** writePage skips an image without bytes with an `IMAGE_MISSING` warning; renderCoursePages turns an SVG raster failure into `SVG_RASTER` and continues. The warnings only reach `req.log.warn` (routes.ts:450) or `console.warn` (web client.ts:239); the user gets a normal-looking PDF. But an attached image course object can carry `hideControlCircle` / `hideControlNumber` (course/objects.ts:199-210, J18): the layer hides the circle and number regardless of whether the image bytes arrive. Causes of missing bytes: `graphics.delete` has no in-use check and can delete club graphics used by other events (routers/graphics.ts:161-174); a transient `print.png` fetch error during device compose (client.ts fetchGraphic rejects -> reply error -> missing); a resvg failure or worker timeout; an offline store without that box.

**Scenario.** A control is drawn as a custom pictogram image with 'hide control circle' and 'hide number'. On the arena Wi-Fi the print-job fetch succeeds but `print.png` for the SVG times out (or someone deleted the club graphic last week). The device composes all course maps anyway: that control has no circle, no number and no image on every runner's map. Same path prints maps without sponsor logos unnoticed.

**Proposed fix.** Treat a missing graphic as a print failure, not a warning, at least when the page hides a control for it: in renderCoursePages collect the graphic ids of image objects with `hideControlCircle/Number` and throw a typed error (400 with the graphic name on the route; on the device, fall back to the server once, then show the error) when their bytes are absent. For other images, return the warnings to the user (e.g. an `X-Oxygen-Print-Warnings` header / `PrintedPdf.warnings` shown as a toast). Make `graphics.delete` refuse (409 listing sheets/templates/objects) while the id is referenced by any template, sheet or course object.

**Verifier's note on the fix.** The warn-and-continue behaviour is normative (docs/course-print.md §8.2 item 5, §8.5, §8.6; decision slice-j.md:16 item 6) and asserted by tests, so changing it is a spec deviation: per CLAUDE.md it needs the user's answer, a spec edit and a decision-log row first.

Constraints on any fix:
- Server and device output must stay byte-identical for the same job (G15), so a fallback such as "draw the circle and number when the image has no bytes" must be decided identically on both paths.
- The hides are applied in layer.ts and derive.ts, before image bytes are known at write time. A fallback needs either graphic availability passed into the layer derivation, or a fail/visible-warning policy at the print client and route instead.
- Surfacing warnings to the user (a toast on the device, a response header or pre-check on the server) and an in-use check or warning in `graphics.delete` are separate, smaller options. A club graphic can be used by other events, so an in-use check must look across events.

<details><summary>Verifier's evidence</summary>

Every step of the claim holds in the code.

- **Missing bytes are skipped, not fatal.** compose.ts:116-120 pushes `IMAGE_MISSING` and continues. course-pages.ts:191-193 catches a rasteriser error, pushes `SVG_RASTER` and continues, so the writer then also reports `IMAGE_MISSING`. print-job.ts:93-97 swallows a failed PNG fetch.
- **Warnings never reach the user.** routes.ts:450 sends them to `req.log.warn` and the PDF is served with a normal 200. client.ts:239 sends them to `console.warn` and resolves with the bytes. client.ts:225-229 says so outright: "a graphic is the writer's warning, as on the server"; only a document failure rejects the job.
- **The hide flags ignore whether the image loaded.** `attachedHides` (objects.ts:203-211) reads only `o.kind`, `o.attach` and the two props. layer.ts:59 uses it to skip the circle and derive.ts:288 to leave the number unplaced. Neither consults image bytes, which arrive later at write time. An attached image with both flags and no bytes therefore prints nothing at the control: no circle, no number, no image.
- **Delete has no in-use check.** graphics.ts:161-174 is a plain `deleteMany` on event or club (`eventId: null`) rows.

Two points count against the claim's framing, and neither removes the defect.

- **The silent drop is specified, not accidental.** docs/course-print.md §8.2 item 5 says the warnings "go to the log at `warn`; the PDF is still served"; §8.5 and §8.6 repeat it for the device. Decision log slice-j.md:16 item (6) records "Deleting a placed graphic: specified as before J2 (image objects report `IMAGE_MISSING`), no in-use check (not asked)". Tests assert it (print-job.test.ts:113-115, worker.test.ts:124-125). It is not listed under any "Pending" section.
- **Deletion is not one careless click.** GraphicPicker.tsx:86-96 needs a second click, with a club-specific confirm text (`graphicsDeleteClubConfirm`).

What is not covered anywhere is the J18 interaction. docs/course-layer.md:1354-1366 describes the hide flags and says nothing about a graphic that fails to load. Those decisions predate J18 (user 2026-11-19), which turned "a logo is missing" into "a control marking is missing".

**Severity: medium.** It needs an unusual combination: an attached image with the hide flags set, plus a deleted graphic, a failed `print.png` fetch or a resvg failure. The control's legs and description are still drawn, and a setter proofing the PDF would see the gap. It is a consequence of a documented design choice, not a likely failure in normal use.

</details>

### CRS-011 Result list gives tied runners different places and ranks no-timing classes

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/routers/lists.ts:190-215 (place counter); lists.ts:95 (class select omits noTiming)`; also packages/web/src/pages/ResultsPage.tsx:101,165 (reads entry.noTiming); packages/shared/src/results.ts:100
- **Status:** confirmed. Code read only, no reproduction run (the logic is a plain counter). Read packages/api/src/routers/lists.ts:77-235, packages/shared/src/results.ts:86-144, packages/shared/src/readout.ts:549-577, packages/web/src/pages/ResultsPage.tsx:33,100-171, packages/api/src/routers/eventor.ts:1640-1670, packages/api/src/routers/race.ts:234, packages/shared/src/types.ts:615-624. Grepped for every use of computeClassPlacements, resultList and noTiming.

**What is wrong.** `resultList` computes places with its own loop (`entry.place++` per OK runner, lines 190-215) instead of the shared, tested `computeClassPlacements` (packages/shared/src/results.ts:100). Equal running times therefore get consecutive places (1, 2, 3) where the shared helper, the Eventor upload (routers/eventor.ts) and the receipt rank (race.ts: 'ties share a rank') give 1, 1, 3. The class `noTiming` flag is never loaded (select at line 95 omits it), so no-timing classes are ranked, and `ResultEntry.noTiming` is never set, so the 'unofficial' badge and italic times in ResultsPage.tsx:101/165 can never show.

**Scenario.** Two H21 runners both finish in 45:12. The results page shows them as places 1 and 2 (order decided by the sort's stability), while each runner's receipt says 1/2 and the Eventor upload says 1, 1. A class flagged noTiming (e.g. a beginners' class) is shown with places 1..n and an amber winner row.

**Proposed fix.** Group runners per class and call `computeClassPlacements(runners, class.noTiming)` passing `runningTimeAdjustment`; add `noTiming: true` to the class select and set `noTiming` on each ResultEntry. Add an integration test for ties and a noTiming class.

**Verifier's note on the fix.** Switching to computeClassPlacements(runners, cls.noTiming) fixes the ties, but two things need care.

- **Zero running time:** the helper ranks OK runners whose adjusted time is 0, whereas resultList currently requires runningTime > 0. Keep that guard or accept the change deliberately.
- **No-timing rows:** in a noTiming class, runners normally have status NoTiming (2), not OK, and resultList currently returns runningTime 0 for them. For the "unofficial" badge and italic times to show anything, the fix must load class.noTiming, set entry.noTiming, and decide whether NoTiming-status runners should carry their running time.

The helper keys on numeric ids, so map UUIDs through an index as eventor.ts:1651-1670 does. Tied rows also need a deterministic secondary sort (name or startNo).

<details><summary>Verifier's evidence</summary>

The tie part is proven; the no-timing part is only partly true.

**Ties (confirmed).** lists.ts:180-186 sorts OK runners by runningTime with no tie-break. lists.ts:190-215 then does `entry.place++` for every OK runner with runningTime > 0, with no comparison to the previous time. Two equal times therefore get places 1 and 2, in whatever order the unordered `findMany` (lists.ts:92, no orderBy) returned them. The shared helper gives 1, 1, 3 (results.ts:124-128: nextPlace only advances when the time is strictly greater). The Eventor upload uses that helper (eventor.ts:1656), and the receipt rank is "strictly-faster peers + 1 (ties share a rank)" (race.ts:234). ResultsPage.tsx:33 reads `trpc.lists.resultList` directly and does not recompute places; rows with place === 1 get the amber winner style (lines 136, 171), so only one of two tied winners is highlighted. computeClassPlacements has no caller in lists.ts.

**noTiming flag never set (confirmed, dead UI).** The class select at lists.ts:95 is `{ name, seq, courseId }`, and neither `result.push` sets `noTiming`. `ResultEntry.noTiming` (types.ts:623) is therefore always undefined, so `isNoTiming` at ResultsPage.tsx:101 is always false and the badge at line 109 and the italic styling at 165/168 can never show.

**"No-timing classes are ranked" (overstated).** A normal readout in a noTiming class does not leave the runner OK: computeStatus turns OK into RunnerStatus.NoTiming when classNoTiming is set (readout.ts:571-572, fed from cardReadout.ts:263). In resultList such a runner fails `e.status === 1` and takes the else branch: place 0, runningTime 0, no winner row. Ranking of a no-timing class only happens when runners there hold status OK by another route, for example a manual status edit or the class being flagged noTiming after the readouts. The claimed "beginners' class shown with places 1..n and an amber winner row" is not the normal outcome.

**Severity.** The tie defect gives a wrong place on the on-screen results list for an exact tie within a class, which is uncommon but real. The Eventor upload and receipts are correct, so official results are not corrupted. That is medium, not high.

</details>

### CRS-012 Registration dialog awaits the receipt print; a stalled printer leaves the form live and allows a duplicate registration

- **Area:** Start/result lists and receipts · **Category:** stability · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** S
- **Location:** `packages/web/src/components/RegistrationDialog.tsx:663-681 (button guard at :1156)`; also packages/web/src/lib/receipt-printer/drivers/webusb.ts:304; packages/web/src/lib/receipt-printer/raster.ts:25
- **Status:** confirmed. Code read only; no reproduction run and no hardware. Read packages/web/src/components/RegistrationDialog.tsx:584-721 and 1153-1164, packages/web/src/context/PrinterContext.tsx:199-218, packages/web/src/lib/receipt-printer/drivers/webusb.ts:301-308, packages/web/src/lib/receipt-printer/raster.ts:17-71, and the server guard in packages/api/src/routers/runner.ts:146-166 and 417-420. Grepped the receipt-printer lib and PrinterContext for timeout / Promise.race: none on the send path.

**What is wrong.** After `createMutation.mutateAsync` has succeeded, `handleSubmit` awaits `fetchLogoRaster(...)` (line 665) and `printer.printRegistration(...)` (line 668) before `addRecentRegistration`, the query invalidations, `clearForm()` and `closeRegistration()`. `WebUsbPrinterDriver.sendBytes` (drivers/webusb.ts:304) awaits `transferOut` with no timeout, and `fetchLogoRaster` (raster.ts:25) awaits an image load with no timeout. The submit button is only disabled by `createMutation.isPending` (line 1156), which is already false at this point.

**Scenario.** Printer runs out of paper or its cover is open (printer goes offline and stops accepting bulk data once its buffer is full), with receipt printing enabled. The runner is saved, but the dialog stays filled in with no success message. The operator presses Register again and `runner.create` runs a second time for the same person and card. Not verified on hardware: whether a given printer stalls or errors when offline.

**Proposed fix.** Do not await printing in the submit path: run the logo fetch and print as a fire-and-forget promise after clearForm/close, with errors surfaced as a toast. Add a local `submitting` state covering the whole handler, and add a timeout (e.g. 10 s via Promise.race) in `sendBytes` and in `fetchLogoRaster`.

**Verifier's note on the fix.** Finish the registration UI (recent list, invalidations, clear/close) before printing, or print fire-and-forget, and add a local submitting guard covering the whole of `handleSubmit`. Put a timeout on `sendBytes` / `transferOut` and on the logo image load; `PrinterContext.print` (:189) shares the same unbounded send. Separately, the dialog replaces the server's CONFLICT message with the generic `registrationFailed` (:634-637), which hides "card already assigned" on a retry.

<details><summary>Verifier's evidence</summary>

The ordering and the missing guard are proved from the code; the duplicate half of the claim is only partly right.

**What holds**
- RegistrationDialog.tsx:618 awaits `createMutation.mutateAsync`, then :665-681 awaits `fetchLogoRaster` and `printer.printRegistration` before `addRecentRegistration` (:685), the invalidations (:695-700), `clearForm` (:707) and `closeRegistration` (:714).
- The `.catch(() => {})` at :681 only handles a rejection, not a promise that never settles.
- PrinterContext.tsx:210 awaits `driver.sendBytes(bytes)` with no timeout; webusb.ts:304 awaits `device.transferOut` with no timeout or abort.
- raster.ts:25-29 waits on `img.onload` / `onerror` with no timeout, so a hung logo request stalls the same way.
- The submit button is disabled only by `createMutation.isPending` (:1156), which is false once the mutation resolves. `handleSubmit` has no re-entrancy guard and the dialog does not read the context's `printing` state.
- So during a stalled print the runner is saved, the form stays filled in, there is no success message, and Register is clickable.

**What the claim overstates**
- A second `runner.create` for the same card is rejected: runner.ts:420 calls `assertCardNotTaken`, which throws CONFLICT when a non-removed runner in the event has that `cardNo` (:146-166).
- The dialog swallows that message and shows the generic `registrationFailed` (:634-637), so the operator sees "failed" for a runner who is in fact registered.
- A real duplicate row is created only when no card number is entered: `assertCardNotTaken` returns early for `cardNo` null or <= 0 (:152), and there is no name-based duplicate check in `create`.

**Not established**
- Whether a given printer NAKs bulk OUT indefinitely when out of paper or cover-open, rather than buffering a small receipt or returning an error, is hardware-dependent. An unplug or power-off rejects the transfer and is handled.

Severity is medium, not high: it needs an unusual printer state plus opt-in receipt printing, the duplicate needs a card-less registration, and the result is a recoverable duplicate entry or a misleading error, not lost data.

</details>

### CRS-013 Receipt 'Fin' row prints the last control's split and leg length, not the finish leg

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** S
- **Location:** `packages/web/src/lib/receipt-printer/escpos.ts:394-401`; also packages/web/src/lib/receipt-printer/star-raster.ts:534; packages/api/src/routers/race.ts:167,197
- **Status:** confirmed. Code read only (no reproduction run; logic is a direct assignment). Traced the data path: packages/shared/src/readout.ts:309-405 (matcher) -> packages/api/src/routers/course.ts:331-367 (expected positions) -> packages/api/src/routers/cardReadout.ts:232-248,326 (performReadout) -> packages/api/src/routers/race.ts:167-198,293 (finishReceipt) -> packages/web/src/pages/FinishStation.tsx:77-85 (also RunnerManagement.tsx:73, CompetitionShell.tsx:296) -> packages/web/src/lib/receipt-printer/escpos.ts:394-403 and star-raster.ts:534-542.

**What is wrong.** The Fin row takes `finSplitDs = lastSplit.splitTime` and paces it with `lastSplit.legLength`. `matchPunchesToCourse` (packages/shared/src/readout.ts:309) never emits a finish entry, so `lastSplit` is the last control: its split is the leg INTO that control. `race.finishReceipt` tracks `lastTime` (race.ts:167, 197) but never uses it, so no finish split is sent. The same code is copied in star-raster.ts:534.

**Scenario.** Course 31-32-33, last control punched 2:10 after control 32, finish 0:25 after control 33. The receipt prints row '3. 33 2:10' and then 'Fin 2:10' with the pace of the 32->33 leg; the real run-in of 0:25 appears nowhere. If the last control is missing the Fin split is blank.

**Proposed fix.** In `race.finishReceipt` return a `finish` entry: `splitTime = finishTime - lastTime` (the variable already tracked) and `legLength = legs[r.controls.length]`. Add it to `FinishReceiptData` and use it in both builders instead of `lastSplit`. Extend the escpos and star-raster tests to assert the Fin row value.

**Verifier's note on the fix.** The finish split should be finishTime minus the last OK punch time (race.ts already tracks this as `lastTime`, falling back to start time when no control was punched), guarded for finishTime <= 0. The finish leg length is legs[number of course positions] (the entry after the last control), not lastSplit.legLength; with skipped positions filtered out of `splits`, index by the course position count, not splits.length. Either send finishSplit/finishLegLength from finishReceipt and the offline path (packages/web/src/lib/offline/local-readout.ts:281 builds the same shape) and add them to the receipt types (receipt-printer/types.ts), or compute in the printer from timing.finishTime and the last OK split's punchTime; both escpos.ts and star-raster.ts need the same change. In free-order mode missing entries are appended last, so 'last split' must mean the latest OK punch, not the last array element. Consider whether noTimingLeg deductions should affect the finish split. Also correct the misleading comment at race.ts:192-194.

<details><summary>Verifier's evidence</summary>

1. No finish entry exists in the split list. matchPunchesToCourse filters PUNCH_FINISH out of controlPunches (readout.ts:318-321) and emits exactly one match per expected position (loop at 343-394). resolveCourseExpectedPositions builds positions only from courseControl rows (course.ts:335-365), no finish position. performReadout returns `controls: matches` (cardReadout.ts:326).

2. race.finishReceipt maps r.controls 1:1 into `splits` (race.ts:179-198) and returns them as `controls: splits` (race.ts:293). `lastTime` is declared at race.ts:167 and assigned at 197 but never read afterwards; no finish split is computed or returned. The comment at race.ts:192-194 claims 'finish included as the last entry', which is false for r.controls.

3. The web callers pass result.controls straight through as data.splits (FinishStation.tsx:77-85).

4. escpos.ts:394-401: `const lastSplit = data.splits[data.splits.length - 1]; const finSplitDs = (lastSplit && lastSplit.status !== "missing") ? lastSplit.splitTime : 0;` and the pace uses `lastSplit.legLength`. So the bold Fin row repeats the last control's split (leg INTO the last control) and its pace; star-raster.ts:534-541 is an identical copy. With a missing last control finSplitDs = 0 so the Fin split prints blank and pace '-'.

Claimed scenario holds: course 31-32-33, 33 punched 2:10 after 32, finish 0:25 later -> row '3. 33 2:10' then 'Fin 2:10' with the 32->33 pace. The Fin clock time and cumulative (total running time) on the same row are correct (finishTime / runningTime), so the true run-in is only derivable by subtracting cum times.

Not refuted by any guard: the legs array does carry the finish leg at legs[controlCount] (cardReadout.ts:105-108) but finishReceipt only indexes legs[idx] for control positions, so it is never sent. No docs/map-*.md or course-*.md Pending entry covers receipt Fin rows. Free-order courses are affected too (matches emitted in punch order, missing ones last, so Fin split is often blank or the last-punched control's split).

Severity: wrong figure on every printed finish receipt with splits (normal use), but it is an informational runner receipt; official result, running time, finish clock, status and placing are all correct. I rate it medium rather than high: one wrong split/pace cell on a courtesy printout, no effect on results or stored data.

</details>

### CRS-014 Automatic leg-route refresh writes courses and journals course.upserted on a node that does not hold the event's lease

- **Area:** Elevation, climb, leg routes, route finder (PR #254) · **Category:** stability · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/leg-routes-auto.ts:168`; also packages/api/src/leg-routes-auto.ts:168,214,227,239; packages/api/src/course-climb.ts:123-125; packages/api/src/routers/course.ts:1231
- **Status:** confirmed. Code read only (no reproduction: node_modules absent and the path needs two nodes plus a database). Followed the chain: packages/shared/src/cloud-ownership.ts:29 -> packages/api/src/sync/venueForwarder.ts:1-55 -> packages/api/src/routers/courseObject.ts:62-146 -> packages/api/src/trpc.ts:170-186, 313 -> packages/api/src/leg-routes-auto.ts:168-241 -> packages/api/src/course-geometry.ts:321-327 -> packages/api/src/course-climb.ts:97-128 -> packages/api/src/referenceJournal.ts:72-95,130-145 -> packages/api/src/sync/shipper.ts:186-262 -> packages/api/src/routers/events.ts:88-150, 843-895. Checked the guard (packages/api/src/sync/lease.ts:76-87) and docs/course-elevation.md §6, §7.5 and "Pending in this chapter" (lines 1291-1360).

**What is wrong.** The new eventProcedure middleware calls enqueueAutoRoutes after every successful `courseObject.*` mutation and after any mutation that marked climbs. `courseObject.` is a cloud-owned prefix (packages/shared/src/cloud-ownership.ts:29), so while an event is checked out to a venue the write is forwarded to and executed on the cloud. The cloud then runs refreshAutoRoutes (packages/api/src/leg-routes-auto.ts:168) in the background with no lease check: it writes leg_routes, clears computed climbs in `courses` (line 214), recomputes them (line 227 -> computeMissingClimbs) and appends `course.upserted` journal entries (course-climb.ts:125) from a non-holder. The same happens when a refresh that takes minutes is still running at the moment the event is checked out. The venue's shipper pulls cloud entries (sync/shipper.ts) and applyReferenceUpsert applies them as an unconditional full-row upsert that also replaces course_controls and sets climb_source to NULL (routers/events.ts:875).

**Scenario.** Event is checked out to the arena laptop. The setter adds an out-of-bounds area there; the write is forwarded to the cloud, which enqueues a refresh. A route changes, so the cloud clears and recomputes the climb of the courses on that pair and journals course.upserted with the cloud's copy of each row. The venue pulls it: (1) the venue's row gets the cloud's climb with source NULL, i.e. a typed climb that no later venue edit clears, so sheets printed after a control is moved carry a stale climb; (2) if the venue changed that course's sequence and it has not shipped yet, the cloud's stale course_controls replace it, so the control order reverts silently.

**Proposed fix.** Make the background path respect the single-writer rule: in enqueueAutoRoutes/refreshAutoRoutes return unless this node may write (the check mapRefresh.ts:461 uses: no active lease, or holderNodeId === nodeId()), and re-check before each chunk's write transactions and before the final refreshComputedClimbs. On the venue, trigger the refresh after the forwarded courseObject write's map refresh lands (venueForwarder.ts refresh hook). Add a two-node integration test: a forwarded courseObject write on the non-holder writes no course row and no journal entry.

**Verifier's note on the fix.** Check the lease inside the refresh, not only at enqueue: `refreshAutoRoutes` should skip (or at least not clear climbs or journal) when `getActiveLease` names another node, and re-check before each chunk's write and before the final `refreshComputedClimbs`, because a refresh can outlive a checkout. Writing `leg_routes` on the cloud is harmless (not journaled); the harm is `clearComputedClimbs` plus `emitCourseUpserted` from a non-holder. The same guard is needed on the `refreshMarkedClimbs` path in the `eventProcedure` middleware (trpc.ts:177) for cloud-owned mutations that mark climbs. Decide separately whether the holder should run the route refresh after its map-rows refresh, since otherwise routes and climbs on the venue stay stale after an out-of-bounds edit; this is a spec question for docs/course-elevation.md §7.5 and needs a decision-log row.

<details><summary>Verifier's evidence</summary>

The non-holder write is proven from the code; the two claimed consequences are real but narrower than stated, and one is a documented limitation.

**What holds**
- `courseObject.create/update/delete/reorder` use `coursesEditProcedure`, which is `eventProcedure` plus a capability check (trpc.ts:313). Only `raceProcedure` calls `assertRaceWritable` (trpc.ts:196-200), so the cloud accepts these writes for a checked-out event.
- `courseObject.` is cloud-owned (cloud-ownership.ts:29), so a venue forwards the write and the cloud runs the middleware, which calls `enqueueAutoRoutes(ctx.db, ctx.event.id)` (trpc.ts:182).
- `refreshAutoRoutes` and `enqueueAutoRoutes` contain no lease check; a grep for lease/assertRaceWritable in leg-routes-auto.ts and course-climb.ts returns nothing.
- When a chosen automatic route's vertices change, it calls `clearComputedClimbs` (leg-routes-auto.ts:214), which sets `climbM: 0, climbSource: null` on `courses` (course-geometry.ts:321-327). It then calls `refreshComputedClimbs` (line 227), and `computeMissingClimbs` updates the course and calls `emitCourseUpserted` (course-climb.ts:123-125).
- `courseUpsertPayload` carries the full row plus all `course_controls`, with `climbSource` stripped (referenceJournal.ts:72-95).
- The venue's shipper pulls peer entries through `ingestJournalEntries` (shipper.ts:232-241). The only skip is by entry id (events.ts:98-105); there is no HLC or version comparison.
- `applyReferenceUpsert` upserts the row, forces `climbSource: null`, and replaces `course_controls` wholesale (events.ts:870-893).
- `course.refreshClimbs` is lease-guarded (`coursesEditRaceProcedure`, course.ts:1231), but a refresh already running at checkout has no re-check, so the in-flight case holds too.

**What narrows it**
- An entry is journaled only for courses whose cloud row is still `climb_source = 'computed'`, or open with `climbM = 0`. Once the venue has shipped any upsert of a course, the cloud holds its climb as typed and `clearComputedClimbs` no longer touches it.
- Consequence (2), the sequence revert, therefore needs the venue's first unshipped edit of that course to fall inside one sync interval (default 5 s, nodeIdentity.ts:50-53) of a cloud refresh that changes a chosen route on one of its pairs. The shipper pushes before it pulls (shipper.ts:186-262), so the cloud ends with the venue's order and the venue with the cloud's stale one: the nodes diverge silently.
- Consequence (1), the climb held as typed and going stale on the venue, is the limitation already listed in docs/course-elevation.md Pending (lines 1344-1347: "a node that received a computed climb from a peer treats it as typed and does not recompute it on its own edits"). What is new is the direction, cloud to lease holder, which turns the holder's own computed climbs into typed ones.
- A non-holder journaling `course.upserted` is not new in kind: `refreshDerivedCourses` after a map change does it too (event-map.ts:66-80). This change makes it happen on every out-of-bounds edit that moves a chosen route.
- Nothing in the Pending section covers the missing lease check on the refresh, so it is not excused as "not implemented".

</details>

### CRS-015 Queued editor writes keep running after navigation and are sent to whichever competition the URL then names

- **Area:** Web course editor: pages · **Category:** security · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/web/src/lib/offline/control-outbox.ts:337 (the sends inside the drain loop); header source packages/web/src/main.tsx:51`; also packages/web/src/pages/editor/EditorPage.tsx:1392, 712, 1009; packages/web/src/lib/editor/write-client.ts:156; packages/web/src/pages/editor/modes/LayoutMode.tsx:105-113 (the silent `prepareOfflinePrint(a.nameId)` reads its lists through `trpcVanillaClient` with the same location-derived header while storing under `a.nameId`; narrow window, not traced further); also `packages/web/src/lib/offline/control-outbox.ts:326`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the path needs a browser). Traced the drain loop, the tRPC header function, the server's event resolution and the two procedures the drain calls: packages/web/src/pages/editor/useFieldOutbox.ts:93-133, packages/web/src/lib/offline/control-outbox.ts:296-380, packages/web/src/lib/editor/write-client.ts:167-257, packages/web/src/lib/editor/conflict.ts:47-56, packages/web/src/main.tsx:44-66, packages/web/src/pages/editor/EditorPage.tsx:169,205-207,375,1392, packages/api/src/trpc.ts:54-60,147-158, packages/api/src/routers/control.ts:156-181,918-1089, packages/api/src/version-conflict.ts:50-82. Grepped for full-page reloads on event switch and for any abort signal in the outbox.
- **Found twice:** a second reviewer reported the same defect independently ("Outbox drain keeps sending after the editor is left; the competition header is read from the URL at send time", Web course editor: lib/editor); its verifier also confirmed it.

**What is wrong.** The Field-mode outbox drain (`drain(store, writes, competitionId)`) is a loop over competition A's Dexie entries, but each send goes through `utils.client`, whose `x-competition-id` header is computed from `window.location` at request time (main.tsx:52-61, lib/trpc.ts:22-31). Nothing binds the request to `competitionId`, and nothing stops the loop when the editor unmounts. The same holds for every promise chain the page leaves running after unmount: `placeQueue` (EditorPage.tsx:1392), `instructionsQueue` (712), `nudgeQueue` (1009), `EditorWrites.serial`, and multi-step undo closures.

**Scenario.** A setter comes back into coverage with 15 queued moves and check-offs for event A; the drain starts (seconds per write on arena network). They go back to the event list and open event B. Remaining entries are sent with B's header. `control.check` takes no token, so B's controls with the same public ids are marked checked. A move whose entry has no baseVersion (after Retry, or queued before the token was seeded) rewrites the position of B's control with that code. At `/` (no header) entries are instead marked failed. A queued placement would likewise `control.create` a stray control in B.

**Proposed fix.** Bind the competition to the request, not to the location. Give EditorWrites/the outbox a client whose header is fixed to the `nameId` it was created for (a per-call tRPC context or a dedicated link reading `competitionId`). In addition have `drain` check before each send that the active event still equals `competitionId` and stop otherwise, and abort the page's queues on unmount. Add a unit test: drain with the active event changed mid-loop sends nothing more.

**Verifier's note on the fix.** Bind the event explicitly rather than only stopping on unmount.
- Give `EditorWrites` (or the client it wraps) a fixed nameId sent as `x-competition-id` per request, e.g. via tRPC operation context read in `headers({ opList })`. Note the link is `httpBatchLink`: ops for different events must not share a batch.
- Failing that, have `drain` re-check before each send that the location-derived nameId still equals `competitionId`, and stop with the entry left pending (not `failed`).
- An unmount abort alone is not enough: a request can be issued between navigation and effect cleanup, and the EditorPage promise chains (`placeQueue`, `instructionsQueue`, `nudgeQueue`, `serial`, undo closures) need the same binding.
- The fix must also avoid recording B's answer against A's entry (false `conflict` with B's position as "theirs", or deletion of A's check entry).

<details><summary>Verifier's evidence</summary>

The mechanism is real, but the claim overstates the move and placement parts.

**What holds**
- **Drain is not bound to its event.** `drain(store, writes, competitionId)` (control-outbox.ts:311-380) uses `competitionId` only to pick Dexie rows and the lock name. Each send goes through `writes.updateControl` / `writes.checkControl`, which call `this.client.control.update.mutate` / `control.check.mutate` (write-client.ts:235, 254) with no event argument.
- **Header is read at request time.** `writes` is built once from `utils.client` (EditorPage.tsx:169). That client's `headers()` derives `x-competition-id` from `window.location.pathname` on every request (main.tsx:51-64).
- **Nothing stops the loop on unmount.** The effect cleanup at useFieldOutbox.ts:132 only clears the interval and the visibility listener. There is no AbortController or mounted check in either file, so a running `for(;;)` keeps sending.
- **Navigation is in-app.** The only `location.reload` calls are in service-worker update, version check and session recovery; switching events never reloads the page.
- **Server trusts the header.** `ctx.event` comes solely from the header (trpc.ts:57-60). `getControlByCode(ctx.db, ctx.event.id, id)` (control.ts:156-181) looks the control up by punch code within that event, so code 31 from event A resolves to B's control 31.
- **Check-offs land in B.** `control.check` (control.ts:1075-1089) takes no token and sets `checkedAt` / `checkedBy` on B's control. The drain then treats it as sent and deletes A's entry (control-outbox.ts:354), so A's check-off is silently lost as well.
- **At `/`** there is no header, so `requireEvent` returns BAD_REQUEST and the entry is marked `failed`, as claimed.

**What is overstated**
- **Moves are mostly blocked.** An entry normally carries A's token. The server compares it to B's row version (control.ts:999-1001) and returns CONFLICT; with no base journal entry in B, `differing` is null, and `conflictDecision` (conflict.ts:51-55) returns `moved` unless B's control sits exactly at the entry's `from`. The usual result is a bogus `conflict` entry in A's outbox showing B's position as "theirs", not a write to B.
- **Retry does not make a move tokenless.** `retry()` clears `baseVersion`, but `withToken` falls back to `this.versions.get(kind, id)` (write-client.ts:174), and that book is seeded from A's control list (EditorPage.tsx:207). A move overwrites B only when B's control is at the same `from` position (e.g. B copied from A, which rebases onto B's token and writes) or the book has no token for that id.
- **Not an authorization bypass.** `control.check` is `coursesReviewRaceProcedure` and `control.update` checks `courses.edit` (control.ts:919-924) against the event in the header. The user must already hold those capabilities in B. This is a misdirected write by an authorized user, a correctness defect rather than a security breach.
- **`placeQueue`, `instructionsQueue`, `nudgeQueue`, `serial`:** these are promise chains with no unmount guard (EditorPage.tsx:1392 confirmed), so the same mechanism applies, but only to writes already queued in the moment of navigation. Not traced end to end, nor was the LayoutMode `prepareOfflinePrint` path.

**Trigger window**
The user must leave the editor and open another event (several clicks) while a drain is still running. That needs many queued entries and a slow link, which is the outbox's intended situation but still unusual. Nothing in the "Pending" sections of docs/course-editor.md covers this.

</details>

### CRS-016 Undo/redo write whole pre-edit snapshots on the newest token, silently reverting another editor's changes

- **Area:** Web course editor: pages · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/web/src/pages/editor/EditorPage.tsx:476`; also packages/web/src/pages/editor/modes/LayoutMode.tsx:247 (`record(() => save(w, prev), redo)`); packages/web/src/pages/editor/EditorPage.tsx:818 (move undo), 760-761, 876; packages/web/src/lib/editor/write-client.ts:187; also `packages/web/src/lib/editor/write-client.ts:173`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the path needs React plus a server). Traced the undo closure, the token source, the re-seeding and the server check, and searched for any guard that drops or revalidates undo entries after an external change.
- **Found twice:** a second reviewer reported the same defect independently ("Undo/redo and stale edits send the newest polled token, so they overwrite another setter's change without a conflict", Web course editor: lib/editor); its verifier also confirmed it.

**What is wrong.** Undo entries capture complete snapshots (`record(() => writeStructure(course.id, prev), redo)`; also lines 760-761 and 876). `EditorWrites.setStructure` sends `versions.get("course", id)`, and the VersionBook is re-seeded from every `course.list` / `course.detail` refetch (EditorPage.tsx:205-208). So after another editor's change has been reloaded, an undo or redo sends the old snapshot with a fresh token and the server accepts it. The token check that docs/course-editor.md §3 and §11 rely on ("Presence never blocks a write — the version tokens do that"; "a structure is never swapped silently") is bypassed. Layout mode has the same pattern with whole sheet/template snapshots.

**Scenario.** A places control 45 on course Lång (undo entry holds structure S0). B reorders Lång and adds a bend; A's editor reloads and shows the amber "changed elsewhere" line. A presses Ctrl+Z to take back the placement: `setStructure(S0)` goes out on B's token, succeeds, and B's reorder and bend are gone with no conflict notice. Same for A's Ctrl+Y, for a Layout undo (`save(w, prev)` wipes B's objects, block position and print scale on the sheet), and for a control-move undo after B moved the control.

**Proposed fix.** Store with each undo entry the token its write produced, and pass it as the explicit `baseVersion` for the entry's undo (and the undo's result token for the redo), instead of reading the book. A stale token then gives the existing refresh notice and the entry is dropped. Alternatively clear or mark the course's and sheet's entries when `courseChangedElsewhere` fires. Add write-client tests for undo after an external token change.

**Verifier's note on the fix.** A fix must still let back-to-back own writes chain: undo/redo need the predecessor's token (`EditorWrites.serial`, docs/bugfixes/editor-overlapping-course-writes.md), so pinning the token captured at gesture time would break Ctrl+Z twice. Workable options are to have each entry carry the version its own write produced and refuse (or drop with the "changed elsewhere" notice) when the row's current token is not in `ownCourseVersions` or the chain of own results, or to clear the affected entries when `courseChangedElsewhere` fires. The fix has to cover control moves (`updateControl`), the multi-course bulk-delete undo (line 876), the create-and-insert pair (760-761), and LayoutMode's separate `VersionBook`. The spec is silent on undo after an external change, so per the project rules the behaviour needs a user decision recorded in docs/course-editor.md §3 before implementing.

<details><summary>Verifier's evidence</summary>

The mechanism holds as claimed for Course mode; I found no guard that defeats it.

- **Undo entries hold whole snapshots.** `packages/web/src/pages/editor/EditorPage.tsx:476` records `record(() => writeStructure(course.id, prev), redo)`, with `prev`/`next` captured at gesture time. Same shape at 760-761 (create-and-insert) and 876 (bulk delete restores every affected structure).
- **The token is read at send time, not capture time.** `packages/web/src/lib/editor/write-client.ts:171` sends `baseVersion ?? this.versions.get(kind, id)`; `setStructure` (184-193) passes no captured token.
- **The book is re-seeded from every refetch.** `EditorPage.tsx:205-208` seeds from `course.list`, `control.list`, `courseObject.list` and `course.detail`. `packages/web/src/lib/version-book.ts` keeps the highest token seen. `docs/course-editor.md` §11 says the 5 s `useExternalChanges` poll invalidates these queries.
- **The server only compares the token.** `packages/api/src/routers/course.ts:892` and `:1017` call `assertCourseVersion` with `input.baseVersion`, so an old snapshot on B's current token is accepted.
- **Nothing ties undo entries to a version.** The external-change effect (`EditorPage.tsx:241-250`) only sets the amber notice. `runUndo`/`runRedo` (2192-2205) run the closure unconditionally. `packages/web/src/lib/undo-stack.ts` has no invalidation, and `undoStack.remove` is called only for Map-mode promote (line 414).
- **Control-move undo is the same.** `EditorPage.tsx:818` writes the old `xpos`/`ypos`/description through `updateControl` on the fresh token.
- **Layout mode is the same.** `packages/web/src/pages/editor/modes/LayoutMode.tsx:247` records `save(w, prev)`; `save` reads `versions.get(...)` at send time (217, 221), and the book is re-seeded from each `resolveSheet` result (201-205).
- **Not listed as pending.** The spec does not mention this case. §3 says a structure conflict is "never merged ... the user redoes the edit", which this path sidesteps once the reload has landed.

Limits on the claim:
- It only happens once A's client has refetched (poll of about 5 s). An undo before that still carries the stale token and is refused correctly.
- A is not uninformed: the amber "changed elsewhere" line is showing, and A sees the result of the undo. "Silently" is true only in that no conflict is raised and B is not told until B's own poll shows the notice.
- For Layout mode I did not trace what triggers a `resolveSheet` refetch after another setter's write, so that variant is proven in mechanism but not in trigger.

Severity: this is a lost update that needs two setters editing the same course (or control, or sheet) at the same time, plus an undo/redo across the other's change. That is an unusual case, and the overwritten work is visible and can be redone, so medium rather than high.

</details>

### CRS-017 Controls page: a failed status/name/code save is silent and the status select keeps showing the unsaved value

- **Area:** Web course editor: pages · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** S
- **Location:** `packages/web/src/pages/ControlsPage.tsx:660 (update mutation without onError; stale select at 750-754)`; also packages/web/src/pages/ControlsPage.tsx:96-114 (delete, upsertConfig, setAirPlusConfig), 660-670, 962-964
- **Status:** confirmed. Code read only (no reproduction; node_modules absent). Read /home/user/oxygen/packages/web/src/pages/ControlsPage.tsx lines 96-120, 656-760, 805-825, 950-975, 1036-1048 and /home/user/oxygen/packages/web/src/main.tsx. Grepped ControlsPage.tsx for isError/.error/onError/toast and all of packages/web/src for MutationCache/getMutationCache/useMutationState/useIsMutating.

**What is wrong.** `ControlInlineDetail` writes with `updateMutation.mutate({ id, [field]: value })` (line 697). The mutation has no `onError` (660-665) and there is no global mutation error handler (main.tsx:19). `editStatus` is set on change and never cleared (675, 750-754), so the select shows `editStatus ?? d.status` even when the write failed. The dependent autosend block (815) also reads it. Name and codes fields revert silently on failure. The page's delete, radio/AIR+ and create mutations (96-114, 962) show no error either.

**Scenario.** Race day: control 47 was stolen; the organiser sets its status to Bad/Missing while the laptop's connection drops (or the event is leased, or the token is refused). The mutation rejects, the select still reads the new status, no message appears. Results keep requiring control 47 and runners stay mispunched until someone reloads the page and sees the old status.

**Proposed fix.** Add `onError` to the mutations and show the message in the row. On error and on success reset `editStatus` to null so the select reflects `d.status`. Send `baseVersion: d.version` as the Courses page does and handle `versionConflictOfError`. Add a component test: rejected update shows an error and the stored status.

**Verifier's note on the fix.** Add `onError` to the update mutation that clears `editStatus` and shows the error, and clear `editStatus` on success or settle as well. Surface errors for delete, upsertConfig (both instances, 103 and 666) and setAirPlusConfig. The create form already shows its error (1042-1046) and needs no change. Name and codes clear their edit state on blur before the mutation settles, so an error message is needed there or the revert stays unexplained.

<details><summary>Verifier's evidence</summary>

The core claim holds; one sub-claim is wrong.

Confirmed:
- ControlsPage.tsx:660-665: `trpc.control.update.useMutation` has only `onSuccess` (invalidate), no `onError`.
- ControlsPage.tsx:675: `editStatus` state; the only `setEditStatus` call in the file is line 753, in the select's onChange. It is never reset to null, on success or failure.
- ControlsPage.tsx:750: `value={editStatus ?? d.status}`, so after a rejected mutation the select keeps showing the unsaved status for as long as the detail row stays mounted.
- ControlsPage.tsx:815: the autosend block reads `editStatus ?? d.status` too.
- ControlsPage.tsx:717-723 and 733-739: name and codes call `handleSave` on blur and then set the edit state to null, so on failure they silently fall back to the server value.
- Nothing in `ControlInlineDetail` renders `updateMutation.isError` or `.error`. The only error rendering in the file is at 1042 (create), 1129 and 1472/1980, none of them for update.
- No global handler: main.tsx:19-27 builds `new QueryClient` with query defaults only, and the grep for MutationCache/getMutationCache/useMutationState/useIsMutating across packages/web/src returns nothing.
- ControlsPage.tsx:96-114: `deleteMutation`, `upsertConfigMutation` and `setAirPlusMutation` have only `onSuccess`, and no error is rendered for them.

Wrong in the claim:
- The create mutation (962-964) does show its error: ControlsPage.tsx:1042-1046 renders `createMutation.error.message`.

Limits on the scenario:
- With react-query's default networkMode 'online', a mutation fired while the browser reports offline is paused and sent on reconnect, not rejected. The silent failure therefore needs a real rejection: a server error, a refused token or lease, or a fetch failure while `navigator.onLine` is still true.
- The stale value lasts only while the expanded row is mounted; collapsing and reopening it, or reloading, shows the true status.
- I did not trace whether control status actually changes result evaluation; the severity does not rest on that.

</details>

### CRS-018 Second structure edit made while the first is in flight silently reverts the first

- **Area:** Web course editor: lib/editor · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/web/src/pages/editor/EditorPage.tsx:468`; also packages/web/src/lib/editor/write-client.ts:155 (serial hands the stale-based write a fresh token)
- **Status:** confirmed. Code read only, no reproduction run (node_modules absent; the logic is short enough to prove from the lines). Read packages/web/src/pages/editor/EditorPage.tsx:256-263, 336-362, 445-478, 2032, 2045-2047, 2679-2681, 2806; packages/web/src/lib/editor/write-client.ts:147-195; packages/web/src/pages/editor/ActionBar.tsx:86,114; docs/course-editor.md:280-289 and 402-411; docs/bugfixes/editor-overlapping-course-writes.md.

**What is wrong.** applyStructure computes next = edit(baseStructure()) at call time. baseStructure() reads localStructure.current / course.detail, which only change after the previous setStructure reply. EditorWrites.serial (packages/web/src/lib/editor/write-client.ts:155) then queues the second write behind the first and gives it the token the first returned, so the server accepts a structure built on the pre-first-edit state. Inspector rows (onMove / onRemove, EditorPage.tsx:2680-2681), group edits, leg props, gaps, numberHidden and useAsRole/append/removeFromCourse are not gated on pendingOps. Only placements, nudges and instructions have their own queue.

**Scenario.** Slow arena link (1-2 s round trip). Setter clicks X on row 3 (S0 -> S1 sent), then before the reply sets a leg to dashed or clicks X on row 7. The second edit is computed from S0 and sent after the first with the first's token: the server stores S0 minus row 7, control 3 is back in the course, no conflict notice. Both undo entries hold prev = S0, so undo cannot recover the intended state either.

**Proposed fix.** Run applyStructure through a per-course promise queue (as placeQueue / instructionsQueue do) so currentStructure(), edit(base) and prev are evaluated only after the predecessor's writeStructure has updated localStructure; drop a queued edit when its predecessor was refused. Add a test with a deferred fake client: two edits before the first reply must compose.

**Verifier's note on the fix.** Deferring the computation of `next` into the queued op (edit applied to the structure current when the write runs) is not enough on its own. Edits such as removeVisit(seqIndex), moveVisit(from, to) and leg `path` arguments are positional and come from rows rendered from S0; replayed on S1 they would hit the wrong row or leg. Either gate the applyStructure entry points on pendingOps (as the placement and multi-selection paths do), or queue the edits and resolve positional arguments to stable ids before the rebase. The undo entry's `prev` must also be taken at run time, not call time, so that two queued edits undo to S1 and then S0. A queued edit behind a refused write should be dropped, as the instructions queue does (course-editor.md:409-411).

<details><summary>Verifier's evidence</summary>

1. applyStructure (EditorPage.tsx:468-478) computes prev = currentStructure(), base = baseStructure() and next = edit(base) synchronously at call time. The write closure captures the finished `next`: redo = () => writeStructure(course.id, next).

2. currentStructure (445-451) reads localStructure.current or latest.current.detailStructure. localStructure.current is assigned only in writeStructure after `await writes.setStructure(...)` resolves (460-462). While the first write is in flight, a second applyStructure call therefore reads the same S0.

3. EditorWrites.serial (write-client.ts:155-162) chains the second op behind the first. setStructure (181-190) reads the token inside the queued op through withToken -> this.versions.get, after the first write seeded its result (187). The second write carries a valid, fresh baseVersion with a structure built from S0, so the server accepts it as a full replace. No CONFLICT is raised and run() calls setNotice(null).

4. No guard blocks the second edit. pendingOps is passed as `busy` only to the inspector context (2032), and ActionBar uses busy only to disable Delete (ActionBar.tsx:86,114). CourseSection's onMove / onRemove / onOrderMode (2679-2681), useAsRole / append / removeFromCourse (2045-2047), writeLeg (563-567), editGroup (633), leg gaps (1530) and numberHidden (2806) all call applyStructure directly with no pendingOps check.

5. Both undo entries record prev = S0 (line 476), so undo cannot restore the intended S0-minus-both state.

6. The docs do not cover this. course-editor.md:284-289 and the bugfix doc describe serial as fixing token staleness only. The "second edit builds on the first" guarantee (course-editor.md:408-411) is stated for instructions, which have their own queue. The stated rationale for localStructure (253-255, placements building on the predecessor's result) only holds for writes that are awaited in sequence, such as the placement chain. I found no "Pending" entry covering this.

Severity: high is overstated; medium. It needs two structure edits on the same course within one round trip, so it is rare on a LAN and realistic only on a slow link or with very fast clicks. It happens in course setting, not during a live event. The loss is one edit, and it is visible once the refetch redraws the course (the removed control reappears), although no notice is shown. The setter can redo it by hand.

</details>

### CRS-019 moveVisit pulls a top-level control into a variation alternative that has two or more controls

- **Area:** Web course editor: lib/editor · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** S
- **Location:** `packages/web/src/lib/editor/structure-edit.ts:148-151 (fall-through to :161-162)`; also packages/web/src/lib/editor/__tests__/structure-edit.test.ts:144
- **Status:** confirmed. Code read of /home/user/oxygen/packages/web/src/lib/editor/structure-edit.ts:144-164 (slotBefore), :179-183 (insertItem), :226-234 (moveVisit); packages/shared/src/course/variants.ts:109-136 (pathOfOrders); callers packages/web/src/pages/editor/EditorPage.tsx:2680 and packages/web/src/pages/editor/modes/CourseMode.tsx:128 (drag: onMove(dragFrom, row.seqIndex)) and :171 (up arrow: onMove(seqIndex, seqIndex-1)). Then a standalone node reproduction copying pathOfOrders / slotBefore / placeAt / moveVisit (/tmp/claude-0/-home-user/955a9e60-b445-5cf6-b5b3-72ae6a31a60f/scratchpad/r.mjs); it reproduces the two existing test expectations (lines 144 and 147) exactly, so the copy is faithful.

**What is wrong.** slotBefore's prefer === "top" branch only handles a target slot with a top-level row on one side. When both neighbours of the slot are rows of one alternative, it falls through to the `next?.alt` rule and inserts into the group. docs/course-editor.md §12 (line 2081) and the function's own header say a top-level row passes a group without entering it. The existing test (structure-edit.test.ts:144-147) only uses alternatives with zero or one control, where the bug cannot show.

**Scenario.** Structure `1 31 [41 42|] 32 9` (group v1, A = 41 42). Inspector up-arrow on 32 calls moveVisit(from 3, to 2) and gives `1 31 [41 32 42|] 9`: control 32 is now only in fork A, so runners on fork B never visit it. Same for dragging a top-level row onto a row inside the group, and in a loop (`1 31 [41|42] 32 9` with up on 32 gives `1 31 [41|32 42] 9`). Reproduced with a standalone copy of pathOfOrders / slotBefore / moveVisit.

**Proposed fix.** In the prefer === "top" branch, when neither neighbour is top-level return the top-level slot on the side the row came from: `{ top: next.itemIndex }` (before the group's anchor successor, i.e. the group index) when moving up, `{ top: itemIndex + 1 }` (after the group) when moving down. moveVisit must pass the direction (from < to). Add tests with a two-control alternative and a loop.

**Verifier's note on the fix.** In the prefer === "top" branch, a slot inside a group (next is an alt row or anchor visit and prev is not top-level) must resolve to a top-level boundary of that group, chosen by move direction: moving up should land before the group's anchor or at least outside the group, moving down after the group (itemIndex + 1). slotBefore does not currently know the direction, so moveVisit needs to pass it (from vs to). Note that inserting at `group.itemIndex` (between anchor and group) re-anchors the group on the moved control, as the one-control case already does (`1 31 32 [41|] 9`); decide whether that is the intended meaning of "passes the group" and whether moving the anchor itself down (`1 30 31 [41 42|] 32 9` -> anchor 31 enters A) should be handled too. Cover the prev = anchorVisit / next = alt loop case, and add tests with alternatives of two or more controls for up, down and drag.

<details><summary>Verifier's evidence</summary>

slotBefore with prefer === "top" (lines 148-151) returns a top-level slot only if `next` is missing/top-level or `prev` is top-level. When both neighbours of the target slot are alternative rows (or prev is a loop's anchor visit and next an alternative row), neither condition holds, line 152 is skipped (prev not top) and line 161 `if (next?.alt) return { group: ... }` inserts into the alternative. No guard in moveVisit, edit(), normalise() or the callers prevents it; CourseMode passes the raw seqIndex for both the up arrow and drag-drop.

Reproduction output:
- `1 31 [41 42|] 32 9`, moveVisit(3,2) (up on 32) -> `1 31 [41 32 42|] 9` (32 now only in alternative A).
- `1 31 [41 42 43|] 32 9`, moveVisit(4,2) (drag 32 onto row 42) -> `1 31 [41 32 42 43|] 9`.
- loop `1 31 [41|42] 32 9`, moveVisit(4,3) -> `1 31 [41|32 42] 9`.
- Symmetric down case, also wrong: `1 30 31 [41 42|] 32 9`, down on the anchor 31 (moveVisit(1,2)) -> `1 30 [41 31 42|] 32 9`.
- Control: with a one-control alternative `1 31 [41|] 32 9`, up on 32 -> `1 31 32 [41|] 9` (stays top-level), which is why the existing tests do not show it.

This contradicts docs/course-editor.md:2081-2083 ("↑ / ↓ and a dragged row keep their level (moveVisit): a top-level row passes a group without entering it") and the slotBefore header comment (lines 139-141: "↑ / ↓ past a group never pull a control into it"). The behaviour is stated as implemented, not listed as pending. Tests at structure-edit.test.ts:144-147 never move a top-level row to a slot between two rows of one alternative (line 144 swaps 33/32 after the group, line 146 uses an all-empty group, line 147 moves an alternative's own row).

Severity: an ordinary inspector action (up arrow on the row after a fork whose active alternative has two or more controls, the usual shape of a fork) silently changes which runners visit a control. Mitigations: it is a course-planning edit, the row visibly lands inside the group in the inspector, and it can be moved back or undone; no stored data is corrupted beyond the single edit. Hence medium rather than high.

</details>

### CRS-020 K into an activated empty petal of a loop places the control in the other petal

- **Area:** Web course editor: lib/editor · **Category:** functional · **Severity:** medium (reviewer said high, verifier corrected) · **Size:** M
- **Location:** `packages/web/src/lib/editor/structure-edit.ts:157`; also packages/web/src/lib/editor/sequence.ts:142 (alternativeEndAt); packages/web/src/pages/editor/EditorPage.tsx:663
- **Status:** confirmed. Code read and hand trace of the claimed scenario through the real call chain; no script was run (node_modules is absent, and the logic is short enough to trace exactly). Files read: packages/web/src/lib/editor/structure-edit.ts:144-188, packages/web/src/lib/editor/sequence.ts:56-99 and 142-148, packages/shared/src/course/variants.ts:86-131, packages/web/src/pages/editor/EditorPage.tsx:275-288, 663-666, 1359-1364, 1413-1426, packages/web/src/pages/editor/tools/placement.ts:72-86 and 103-106, docs/course-editor.md:2073-2118, and the unit tests structure-edit.test.ts:213-218 and sequence.test.ts:103-110.

**What is wrong.** For an activated empty alternative, alternativeEndAt (sequence.ts:142) returns the position just after the anchor. In a loop whose other petal is drawn, the path row at that position is the other petal's first control, so slotBefore's `drawnPetal` exception (meant for leg clicks: 'the leg after the anchor stays the drawn petal's') skips the empty active alternative and the `next?.alt` rule inserts into the drawn petal at index 0. docs/course-editor.md §12 'Activating an alternative' says the chain starts at the end of the activated alternative.

**Scenario.** Butterfly authoring: create a variation, tick Loop, place 41 into A, click tab B (empty, now active, orders = [B, A]), arm K with nothing selected and click the map. insertSite(at = 1) on `1 31 [41|] 32 9` returns `1 31 [77 41|] 32 9`: the new control lands in loop A before 41 and B stays empty. Every further K placement keeps going into A. Reproduced with a standalone copy of the logic.

**Proposed fix.** Give the armed-K path an explicit target instead of a path position: an `insertIntoAlternative(s, groupId, label, index)` edit used when focusInsertAt comes from an activated group, or have alternativeEndAt return the slot `{ group, label, index }` and let insertSite accept it. Keep the drawnPetal rule for leg-click phantoms only. Add a test for a loop with one filled and one empty active petal.

**Verifier's note on the fix.** The fix must keep the leg-click behaviour that structure-edit.test.ts:213-218 and docs/course-editor.md:2077-2079 specify: a click on the drawn petal's leg after the anchor stays in that petal. `slotBefore` cannot tell the two cases apart from a position alone, so the K-with-focus path needs to carry an explicit target (group and label), for example through the placement chain and `insertSite`, or by inserting through a `moveToAlternative`-style "end of alternative" slot.

The chain's second placement must also keep targeting the activated petal. After the first control lands in B, the path becomes 31, B0, 31 (anchor visit), 41, and `insertAt + 1` then sits between B0 and the anchor visit; `prev?.alt` resolves that to B index 1, which is correct, but add a test for it.

Queued placements read `latest.current.orders`, so the target label should be captured when the tool is armed, or re-derived consistently. The spec text in §12 needs a matching update, per the project's rule that the spec is written first.

<details><summary>Verifier's evidence</summary>

The claim holds: K into an activated empty petal of a loop inserts into the other, drawn petal.

Trace for structure `1 31 [A:41 | B:] 32 9`, loop=true, B active:

1. **Orders.** `courseViewOrders` (sequence.ts:96) gives `[B, A]` for a loop. `pathOfOrders` (variants.ts:122-123) skips the empty B, so the displayed path is 1, 31, 41 (A index 0), 32, 9.
2. **Insert position.** `focusInsertAt` (EditorPage.tsx:663-666) calls `alternativeEndAt(rows, 2, "B")`. B has no rows, so it returns the anchor's `seqIndex + 1` = 1 (sequence.ts:145-147).
3. **Arming.** `armContext` passes that as `legInsertAt` when a visit tool is armed with nothing selected (EditorPage.tsx:1362-1363). `armPlacement` takes it as `insertAt` (placement.ts:79).
4. **Placement.** `place()` calls `insertSite(s, 1, id, kindOf, orders)` (EditorPage.tsx:1421/1425), which reaches `slotBefore` with t = 2.
5. **Slot choice.** `prev` is the top-level anchor 31 and `next` is 41 in petal A of the same group. The active petal B is empty, but `drawnPetal` (structure-edit.ts:157) is true, so the "fill the empty active alternative" return on line 158 is skipped. Line 161 (`next?.alt`) then returns `{group: 2, label: "A", index: 0}`.
6. **Result.** `1 31 [77 41|] 32 9`: the control lands in A and B stays empty.

Later placements also go into A: `afterPlaced` advances `insertAt` to 2, where `prev` is 77 (A) and `next` is 41 (A), so line 161 picks A index 1.

Nothing in the K path guards against this. `slotBefore` receives only a position and cannot tell a leg click on 31→41 from the K-with-focus position; both are at = 1.

The `drawnPetal` exception is deliberate for leg clicks: the unit test at structure-edit.test.ts:213-218 asserts `1 31 [|40 42] 31 9`, and docs/course-editor.md:2077-2079 documents it. The same doc at 2113-2116 says that activating an alternative "claims K: armed with nothing selected, the chain starts at the end of that alternative (alternativeEndAt), so successive placements fill it". For an empty petal of a loop with another petal drawn, that promise is broken.

It is not listed as pending: the only "petal" mentions in docs/course-editor.md are lines 2077-2078. The existing `alternativeEndAt` test (sequence.test.ts:108) covers only a non-loop group, and the e2e test (e2e/course-editor.spec.ts:783-844) fills B before ticking Loop, so this order of steps is untested.

Severity is medium, not high. The misplacement is immediately visible in the inspector (the row appears under A and B's count stays 0), it is undoable, and nothing is corrupted. Workarounds exist: drag the row onto tab B (`moveToAlternative`, which targets the label directly), or fill B before ticking Loop. Once B has one control, `alternativeEndAt` uses B's own rows and K works. It only bites when a petal is empty while another petal of the same loop is drawn, though that is a natural authoring order for a butterfly.

</details>

### CRS-021 Import can match and revive a soft-deleted control instead of the live one with the same code, leaving two live controls with one code

- **Area:** Course data and course/control API · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/routers/course.ts:1957`
- **Status:** confirmed. Code read only (no reproduction run; no DB available). packages/api/src/routers/course.ts:1939-1962 (controlByKey build), 2061-2117 (match + update), 2149-2154 (courseByName for contrast); packages/api/src/routers/control.ts:156-178 (getControlByCode), 356-365 (codeHolder, live rows only), 780 (create's assertCodeFree), 1091-1102 (delete sets only removed:true), 1184-1228 (restore: comment and CONFLICT guard); Control model in schema.prisma (only @@unique([eventId, seq]), no uniqueness on codes).

**What is wrong.** controlByKey is built from every control of the event, removed rows included, read without orderBy; a code key is first-wins and a name key last-wins, with no preference for live rows (courseByName a few lines below does prefer live rows). control.delete keeps the code on the removed row and control.create only checks live rows, so a removed and a live row with the same code is a normal state (control.restore's own comment says so). The matched row is then written with removed:false and no code-free check.

**Scenario.** The setter deletes control 45 and adds a new control 45 at another feature (editor: delete + add). A later import without replaceAll containing control 45 matches the older removed row (returned first), un-removes it and moves it to the file's position. The event now has two live controls with code 45: imported courses reference the revived row, hand-made courses the other; uuidsOfPublicIds/controlSeqToId take the first by scan order and getControlByCode uses an unordered findFirst, so edits, deletes and setStructure on 'control 45' hit an arbitrary one, and the map shows two circles 45.

**Proposed fix.** Build controlByKey preferring live rows (iterate live rows first, or replace an entry when prev.removed && !c.removed, as courseByName does) and order the query by (removed asc, seq asc). When a removed row is revived, check codeHolder for its codes and fall back to the live holder. Add a test with a removed and a live row sharing a code.

**Verifier's note on the fix.** Prefer live rows when building controlByKey for both the code key and the name key (as courseByName does), and order removed candidates deterministically (e.g. updatedAt desc, as control.restore does). The name key at 1953 is last-wins and has the same flaw for start/finish rows ("Start 1" removed vs live); the isEnd branch at 2102 only reallocates the code, it does not stop two live rows sharing a name. Crossing-point matching at 1976 uses existingControls.find with no live preference either. Severity is medium rather than high: it needs a delete-then-recreate of the same code followed by a non-replaceAll import of a file containing that code, and the result is a recoverable duplicate (delete one of the two), not data loss; it does however give ambiguous code-addressed edits until noticed.

<details><summary>Verifier's evidence</summary>

1. course.ts:1939-1950 reads all controls of the event with `where: { eventId }` (removed rows included) and no orderBy. Lines 1957-1960 key each code first-wins (`if (!controlByKey.has(code)) set`) with no regard to `removed`. Contrast courseByName at 2149-2154, which explicitly replaces a removed entry with a live one.
2. The precondition state is reachable through normal use: control.delete (control.ts:1100-1103) writes only `removed: true` and leaves `codes`; control.create (control.ts:780) calls assertCodeFree -> codeHolder (356-365), which filters `removed: false`, so a new live control with the same code is accepted and inserted as a new row. control.restore's own comments (1185-1187 'when several deleted rows share a code', 1209 'The code may have been reused by a new control in the meantime') acknowledge this state and guard it with a CONFLICT check. The schema has no unique constraint on codes (only [eventId, seq]).
3. On a match, course.ts:2067-2113 writes baseData with `removed: false`, `codes`, and the file's xpos/ypos via a plain control.update. The only code-free check (2102) is gated on `isEnd` (start/finish); a regular control gets none. So if the removed row is the one in the map, it is revived while the live row with the same code stays live -> two live rows with code 45. The import's courses reference the revived row via controlIdMap (2115).
4. Which row wins depends on unordered scan order, so it is not guaranteed, but the older removed row coming first is the likely case in Postgres heap order (it was written before the new row was inserted), and nothing in the code makes the live row win.
5. Downstream: getControlByCode (control.ts:162-173) is an unordered findFirst on live rows by code, so update/delete on 'control 45' picks an arbitrary one of the two.
6. Not handled elsewhere: with replaceAll the wipe at 1928-1931 removes all rows first, so the duplicate does not arise on that path (only one is revived); the claim is correctly limited to imports without replaceAll. I found no 'Pending' entry in docs/course-*.md or docs/map-*.md covering this.
Not verified: the claim's statements about uuidsOfPublicIds/controlSeqToId scan order and the map rendering two circles; they follow plausibly from two live rows but I did not read those functions.

</details>

### CRS-022 importCourses with replaceAll wipes courses, controls and class assignments before a long non-transactional write sequence

- **Area:** Course data and course/control API · **Category:** stability · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/routers/course.ts:1921-1936 (wipe); journal append at :2382`; also `packages/api/src/routers/course.ts:1921`
- **Status:** confirmed. Code read only (no reproduction; needs a DB and a crash mid-request). Read /home/user/oxygen/packages/api/src/routers/course.ts:1896-2409 (the whole write path of importCourses), /home/user/oxygen/docs/course-layer.md:1104-1113, /home/user/oxygen/packages/web/src/components/CourseImportDialog.tsx:22-54,109-110, /home/user/oxygen/packages/api/src/routers/cardReadout.ts:196-199,633, and grepped the post-wipe range for throws and transactions.
- **Found twice:** a second reviewer reported the same defect independently ("The replaceAll wipe and the import are not atomic and nothing is validated before the wipe", Course import/export (IOF XML, OCAD, Purple Pen)); its verifier also confirmed it.

**What is wrong.** The whole import runs on ctx.db outside any transaction (documented in docs/course-layer.md §6.4 as 'repaired by running it again'). With replaceAll the first statements soft-delete every course and control and null every class.course_id; several hundred statements follow (per control, per course persistStructure + syncVariants, objects, token stamps) and the single reference.imported journal entry is appended only at the very end (line 2382). Any failure in between (process restart, DB connection drop, Prisma timeout, an unexpected throw in persistStructure/syncVariants/writeImportedObjects) leaves the event with no live controls or courses, all classes without a course and runners' variant pointers intact but dangling, and no journal entry, so peers and the venue node do not learn of the wipe. Re-running repairs courses only if the operator still has the file and re-supplies the same classMapping; the previous class->course mapping is not recoverable.

**Scenario.** Operator re-imports with 'replace all' at the arena; the API container is restarted (or the DB connection drops) after the wipe and half the controls. Readout now finds class.courseId = null for every class, so every finisher is evaluated without a course until someone notices and re-imports and re-maps the classes.

**Proposed fix.** Run steps 0-4 in one interactive transaction with a generous timeout (the heavy parsing and CRS load already happen before the first write; setStructure already uses a 30 s transaction for comparable volume), or at minimum do the replaceAll wipe last: import/revive first, then soft-delete the rows the import did not touch and null only the classes whose course was removed, and emit the journal entry in the same transaction as that final step. Update §6.4.

**Verifier's note on the fix.** Non-atomicity is a recorded decision (course.ts:2337-2344, course-layer.md §6.4 "Tokens"), so changing it needs the spec text updated and a decision-log row, per the project rule against silent deviation.

A fix must account for:
- **Nested transactions:** the two inner `ctx.db.$transaction` calls at 2103 and 2131 would have to take the outer `tx`.
- **Helpers taking a db handle:** `persistStructure`, `syncVariants`, `syncClassPool`, `writeImportedObjects`, `rebuildCourseLengths`, `clearComputedClimbs`, `clearRemovedVariants`, `appendJournal` and `emitVariantSync` must all accept the `tx`.
- **Timeout:** Prisma's interactive transaction default is 5 s; several hundred statements need an explicit, larger timeout.
- **HLC ordering:** `nextServerHlc` and the token stamps must stay inside the same unit as the journal append.

A cheaper partial fix is to defer the wipe: soft-delete only the rows the import did not touch, and null only unmapped classes, in one short transaction at the end together with the journal append.

<details><summary>Verifier's evidence</summary>

The mechanics are as claimed.

- **Wipe first, on ctx.db:** course.ts:1921-1936 runs three separate `updateMany` calls (courses `removed: true`, controls `removed: true`, every class `courseId: null`) with no transaction.
- **Long non-transactional sequence after it:** per-control update/create (1939-2141), per-course update/create plus `persistStructure`, `syncVariants`, `writeImportedObjects` (2143-2300), `clearComputedClimbs`, class mapping (2314-2334), token stamps (2351-2357). The only `$transaction` calls in the range (2103, 2131) wrap a single start/finish code allocation each.
- **Journal last:** the single `appendJournal` `reference.imported` is at 2382. A crash before it leaves the local DB wiped or half-rebuilt with nothing shipped to peers.
- **Readout effect:** cardReadout.ts:196 and :633 resolve the course as `runner.courseId ?? class.courseId`. In the window, linear-class runners get no course. Runners with a variant pointer still resolve the soft-deleted variant row, because the lookup at :199 is by id.
- **Not handled, not Pending:** the code comment at 2337-2344 and course-layer.md:1108-1110 state the non-atomicity as deliberate ("a crash in between loses only the ship", "repaired by running it again"). It is not in a Pending section. That rationale understates the `replaceAll` case, where the crash loses the event's live courses, controls and class assignments, not just the ship.

What narrows the claim:

- **No deterministic failure after the wipe.** There is no `throw` in course.ts between 1937 and 2400. The F32 `BAD_REQUEST` at 1911 fires before the wipe. Imported courses are linear, so `assertMaterialisable` is not expected to fire. The trigger is therefore only a process kill, DB connection drop or timeout during a window of a few seconds in an operator-initiated admin action.
- **Recovery is cheap.** A re-run restores rows by name (same UUIDs). The dialog rebuilds `classMapping` from the file's class assignments by auto-match (CourseImportDialog.tsx:41-51) and keeps file and mapping in state after a failed mutation. A successful `replaceAll` also nulls every class not in the mapping, so "previous mapping not recoverable" is a property of `replaceAll` itself; only hand-made mappings are truly lost.
- **"Every finisher without a course" is overstated:** it applies only until the re-run, and not to runners with a variant pointer.

Severity: medium. It needs an unusual coincidence (crash inside a seconds-long window of a deliberate operator action), is immediately visible to the operator as a failed import, and is repaired by re-running. Doing a full reference replace during live readout is itself unusual.

</details>

### CRS-023 control.update accepts invalid or empty punch codes that control.create refuses

- **Area:** Course data and course/control API · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/routers/control.ts:931`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the logic is DB-backed). Read packages/api/src/routers/control.ts create (759-780) against update (928-941), getControlByCode (156-185), codesHolding/codeHolder (341-365), packages/shared/src/control-display.ts:7-11 (firstCode), the web callers packages/web/src/pages/ControlsPage.tsx:696-737 and packages/web/src/pages/editor/EditorPage.tsx:2470-2479, docs/course-layer.md:982-984 and packages/api/src/__tests__/integration/start-finish-codes.test.ts:129-136.

**What is wrong.** create validates every ';' part as a positive integer with String(n) === p and requires at least one code for a normal control. update only loops for the uniqueness check and `continue`s on a part that is not a positive integer, then stores input.codes verbatim: "" (a cleared field), "abc", "31a", "31; 32" or "031" are all written. getControlByCode / codesHolding match the stored string exactly, while firstCode() uses parseInt, so the two id resolvers disagree for such a row.

**Scenario.** A setter edits control 31's code and saves "31a" (or clears the field). publicControlId still says 31 (parseInt), but control.update/detail/delete { id: 31 } look for codes = '31' and fall through to seq 31 (another control, or NOT_FOUND), so the row cannot be edited or deleted by its id; assertCodeFree no longer sees 31 as held, so a second control 31 can be created. With "" on a normal control the course position has no accepted code and every runner is a missing punch there.

**Proposed fix.** Extract create's code parsing into one helper (trim parts, positive integer, String(n) === p, at least one code unless the kind is auto-named/code-less) and use it in update, storing the normalised 'a;b' string. Add tests for '', 'abc', '31a' on update.

**Verifier's note on the fix.** - Keep `codes: ""` allowed on update for start/finish rows (and legacy code-less rows): docs/course-layer.md:983-984 and start-finish-codes.test.ts:129-136 depend on it. Refuse an empty code only for a normal control, matching create's `autoNamed` rule.
- Apply create's part validation (`String(n) === p`, positive integer) in update, and store a normalised string (trimmed parts joined by ";") so "31; 32" cannot defeat codesHolding.
- The `else if` branch at control.ts:939-940 (codes unchanged) is harmless, but existing malformed rows stay unreachable by id; decide separately whether they need a repair path.
- ControlsPage.tsx:733 sends the raw value; trimming there is worthwhile but the server check is the real guard.

<details><summary>Verifier's evidence</summary>

The malformed-code part of the claim holds; the empty-code part is only partly a defect.

**Proven from the code**
- **create validates, update does not.** create (control.ts:761-778) rejects any part where `!Number.isFinite(n) || n <= 0 || String(n) !== p` and rejects zero parts for a non-auto-named kind. update (control.ts:931-938) splits the parts, does `if (!Number.isFinite(n) || n <= 0) continue;`, calls assertCodeFree for the rest, then sets `data.codes = input.codes` verbatim. The zod schema is only `z.string().optional()`. So "abc", "31a", "031", "31; 32" and "" are all stored unchanged.
- **The two id resolvers disagree.** firstCode (control-display.ts:7-11) uses parseInt on the first part, so "31a" and "031" give publicControlId 31. getControlByCode (control.ts:161-173) and codesHolding (341-348) match exact strings ('31', '31;…', '…;31;…', '…;31'), so neither finds "31a" or "031".
- **Consequence for the row.** A lookup by id 31 falls through to `seq: 31` (control.ts:176-184). seq is a DB-assigned sequence unrelated to the code (create only sets it for code-less marks, 820-824), so the result is another row or NOT_FOUND. The row cannot be opened, updated or deleted through the id the API itself reports.
- **Duplicate check is bypassed.** codeHolder's seq fallback (control.ts:363-364) requires `firstCode === 0`, which is false for "31a". Code 31 therefore reads as free and a second control 31 can be created.
- **"31; 32" variant.** The stored space means `endsWith ';32'` misses, so 32 is not seen as held.
- **Reachable from the normal UI.** ControlsPage.tsx:733-734 sends the raw input value on blur with no trim or validation (handleSave at 696-698). EditorPage.tsx:2470-2476 trims only and refuses empty.

**Where the claim is overstated**
- **Clearing to "" is documented as allowed** for a start or finish: docs/course-layer.md:983-984 ("clearing it to "" stays allowed — the legacy shape") and the test at start-finish-codes.test.ts:129-136. In that case the resolvers agree (firstCode is 0, so the seq fallback applies) and the seq counts as held.
- **"" on a normal control is a real gap.** update has no kind check, create refuses the same input, and the docs sentence covers only starts and finishes. I did not trace the "every runner is a missing punch" consequence into the matching code.
- **Not a wrong-results bug for malformed codes.** The Controls page matching parses codes with parseInt after trim (ControlsPage.tsx:1145, 1655), so "31a" still reads as 31 there.

**Not listed as pending.** No "Pending" section in docs/course-*.md or docs/map-*.md mentions validation of codes on update.

**Severity: medium.** It needs a typo or stray character in the Controls page code field. The result is a control row that can no longer be addressed by its public id (so it cannot be repaired from the UI) and a possible duplicate code. There is no data loss and no failure in normal use.

</details>

### CRS-024 Map numbers skip unplaced controls while the description sheet counts them, so numbers shift on the printed map

- **Area:** Course data and course/control API · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/shared/src/course/derive.ts:272 (root cause is the filter at derive.ts:53; numberBase at derive.ts:154, not 149)`; also packages/shared/src/course/derive.ts:149 (numberBase)
- **Status:** confirmed. Code read only (no reproduction run: node_modules absent and the logic is a few lines). Read /home/user/oxygen/packages/shared/src/course/derive.ts:30,49-57,144-158,268-279; /home/user/oxygen/packages/shared/src/course-maps/resolve-layout.ts:284-290,337-366; /home/user/oxygen/packages/shared/src/course-maps/description-rows.ts:252-256; /home/user/oxygen/packages/shared/src/course/checks.ts:362-370; /home/user/oxygen/docs/course-layer.md §3.3 (l.194-196), §3.5 (l.389), §9 (l.1543, l.1588). Searched for a positioned filter on the sheet path and for a test or Pending entry covering the case; found none.

**What is wrong.** deriveCourse numbers the controls by counting the entries of sequences[0], which sequenceOf has already filtered to positioned sites (x,y != 0,0). The description sheet (resolve-layout.ts:355, buildDescriptionSheet `sequence: i + 1`) and timing count every course control. docs/course-layer.md §3.5 says the sequence runs 'over the first course's control items'. numberBase for a map-exchange part has the same positioned-only count.

**Scenario.** A course has controls 31, 32, 33(unplaced, e.g. created by a position-less import or not yet placed), 34, 35. The map prints 34 as number 3 and 35 as number 4; the description sheet lists 33 as 3, 34 as 4, 35 as 5. A runner reading the sheet goes to circle '4' on the map and finds code 35. The server's course.checks does not report NUMBER_UNPLACED (derivation is null there), only the editor does.

**Proposed fix.** Number over the structure's control-role items regardless of position: compute a per-item sequence number in sequenceOf (or carry the item's index among control-role items of the unfiltered structure) and use it for both numbers and numberBase; unplaced items consume a number but draw nothing. Add a derive.test.ts case with an unplaced middle control.

**Verifier's note on the fix.** The number must count every control-role item of the structure, including unpositioned ones, while still not drawing them. That means counting before or independently of the `positioned` filter in `sequenceOf`, for both `n` (derive.ts:272) and `numberBase` (derive.ts:154). Keep the leg and part logic on the positioned list: `sectionsOf` and resolve-layout.ts:416 split parts over placed sites only. `allVariationNumbers` (sheet-rows.ts:165-168) takes a `positioned` flag, so check that it stays consistent with the new rule. The spec is silent on which side is right, so per the project rules the answer should be recorded in docs/course-layer.md §3.5 before the code changes. Add a derive test for a sequence with an unplaced control, with and without `viewOptions.section`.

<details><summary>Verifier's evidence</summary>

Map side: `positioned = s.x !== 0 || s.y !== 0` (derive.ts:30) and `sequenceOf` drops such items (`if (!site || !positioned(site) || !isItemSite(site)) continue;`, derive.ts:53). The number loop counts only what survived: `let n = numberBase; for (const e of sequences[0]) { if (e.role !== "control") continue; n++; ... }` (derive.ts:272-278). `numberBase` is computed over the same filtered list (derive.ts:154). An unplaced control therefore takes no number and every later control shifts down by one.

Sheet side: `resolveMapLayout` filters unpositioned rows only for all-controls/setter sheets; for a course it takes `input.course?.controls ?? []` unfiltered (resolve-layout.ts:284-290). `controlRows` is every row of type control (l.337-339) and is passed to `buildDescriptionSheet`, which numbers by index: `{ sequence: i + 1 }` (description-rows.ts:255). An explicit `source.sequence` exists only on the all-variations path (sheet-rows.ts:171). So for 31, 32, 33 (at 0,0), 34, 35 the sheet lists 33=3, 34=4, 35=5 while the map draws 34 as 3 and 35 as 4.

Spec: §3.5 says the sequence runs "over the first course's control items"; §3.3 says an unpositioned site is "skipped, legs connecting the remaining items". Neither states that a skipped site gives up its number, and no "Pending" section lists this. No test pins the positioned-only numbering (derive.test.ts:26 covers legs only).

Checks: NUMBER_UNPLACED runs only when `input.derivation` is set (checks.ts:362-370), and course-layer.md l.1588 states the server's `course.checks` omits it (derivation null). The editor does report it, and all checks are advisory, so nothing blocks printing.

Severity reasoning: the mismatch is real and yields a misleading printed map, but it needs a course that still holds an unplaced control at print time. That map is already visibly defective (control 33 has no circle and the leg runs 32 to 34), and the editor flags the control. That is an unusual case rather than normal use, so medium, not high.

</details>

### CRS-025 A variant key that disappears re-deals finished runners to a different variant

- **Area:** Course data and course/control API · **Category:** functional · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/course-variants.ts:183 (nullRunnersOn call; unfiltered query at :199-202) and packages/api/src/variants.ts:239 (reconcileClassVariants builds DealRunner without `locked`)`; also packages/api/src/variants.ts:219-250 (reconcileClassVariants has no locked rule)
- **Status:** confirmed. Code read only, no reproduction run (node_modules absent; the logic is short enough to trace by hand). Read /home/user/oxygen/packages/api/src/course-variants.ts:111-205 (syncVariants, nullRunnersOn, reconcileAfter), /home/user/oxygen/packages/api/src/variants.ts:118-152 (dealVariants), :219-250 (reconcileClassVariants), :265-311 (distributeClassVariants with RACED/locked), /home/user/oxygen/packages/shared/src/course/variants.ts:205-246 (key derivation from labels), the callers of syncVariants in routers/course.ts and routers/control.ts, the readers in routers/lists.ts:150-175, routers/eventor.ts:1604-1636, routers/cardReadout.ts:154-330 and :802-850, and the specs docs/course-layer.md §12.3 (2133-2163) plus its Pending section (2485-2520) and docs/course-controls-and-matching.md:335-395.

**What is wrong.** When a root's keys change (an alternative's label is renamed, an alternative removed, loop toggled), syncVariants soft-deletes the old child, nulls runner.course_id for everyone on it and reconcileClassVariants (variants.ts:219) deals each of them the least-populated variant of the new pool. Unlike distributeClassVariants, this path has no `locked` rule: runners who have already raced (finish time / result status) are re-dealt too. The key is derived from labels, so a pure rename of label B to C drops child '<root> B' and creates '<root> C' as a new row even though the controls are identical.

**Scenario.** Mid-event the setter renames a fork's alternative label (or reorders/removes one). 40 runners who already finished on variant AB are nulled and dealt round the new pool; half land on a variant with different controls. Result lists and Eventor export that evaluate punches against runner.courseId now show them as missing punch, and split legs are wrong, with only per-runner journal entries as a trace.

**Proposed fix.** In syncVariants, before dropping, map old children to new ones when the variant's item sequence is unchanged (compare the materialised siteId lists) and re-key the existing row instead of delete+create. For runners that still lose their variant, do not re-deal those with finishTime > 0 or a raced status (reuse RACED from variants.ts): leave them on the removed child (readout reads removed courses) or return them in the result so the UI can warn. Add an integration test for label rename with finished runners.

**Verifier's note on the fix.** - Passing `locked` into reconcileClassVariants is not enough: nullRunnersOn has already cleared course_id, and the runner's old course is soft-deleted. The fix has to decide what a raced runner on a vanished key keeps — a pointer to the removed child, or null — neither of which satisfies the invariant "every runner in a pooled class has a course_id in the pool".
- The pure-rename case is better solved by keeping child identity across a rename: match old and new children by group id plus alternative position or control sequence instead of by label key, and update variant_key in place. Then no runner is nulled at all.
- docs/course-layer.md §12.3 and docs/course-controls-and-matching.md:373 specify the current null-then-deal behaviour. Under the project rule (code and spec disagree, or spec silent → ask the user, record in the spec, add a decision-log row) this is a spec change, not a silent code fix.
- Peers replay runner.updated { courseId } from the journal, so any new rule must still emit one change per affected runner.

<details><summary>Verifier's evidence</summary>

The mechanism is real; the claimed consequences are overstated.

What the code does:
- course-variants.ts:168-173 soft-deletes every live child whose key is no longer produced. :183 calls nullRunnersOn, whose filter (:199-202) is only `{ eventId, courseId in dropped }` — no check on finishTime or status.
- reconcileAfter (:216-225) calls reconcileVariants → reconcileClassVariants (variants.ts:219). That maps runners to DealRunner at :239 without `locked` and without selecting finishTime/status, so the `r.locked` guard in dealVariants (:139) never fires on this path.
- distributeClassVariants (variants.ts:290-303) does set `locked: r.finishTime > 0 || RACED.has(r.status)`. The asymmetry is as claimed.
- Keys are label-derived: shared/src/course/variants.ts:205-207 and :235 (`p.key + order.join("")`). syncVariants looks children up by key (course-variants.ts:131, 149). A rename B→C therefore drops '<root> B' and creates a new row for C with the same controls.
- No guard exists: none of the syncVariants callers (course.ts:744, 956, 1031, 1215, 1246, 2283; control.ts:1139) checks for raced runners, and the editor exposes renameAlternative / removeAlternative / setLoop (docs/course-editor.md:358, 2105).

Not a Pending item: the Pending section of course-layer.md (2508-2520) does not list it. The spec does describe the null-then-deal as intended (course-layer.md:2152-2158; course-controls-and-matching.md:373) but has no carve-out for raced runners, while the same chapter says a variant is pre-set before the race and a raced runner "is never re-dealt" (course-controls-and-matching.md:345-347, 390-393). So the code matches the letter of §12.3 and contradicts the stated principle.

Where the claim overstates:
1. Result lists do not flip to missing punch by themselves. lists.ts uses the stored `r.status` (`runnerStatusToValue(r.status)`, ~:170); only runningTimeAdjustment is recomputed against `r.courseId ?? class.courseId` (:150-166). What does go wrong for a mis-dealt finisher: performReadout (cardReadout.ts:195, 248-257) recomputes status against the new variant, so the readout view, receipt and split times (race.ts:156) show MP and wrong legs; the Eventor export's splits use the new variant (eventor.ts:1612-1632); and a card re-read that applies the result (cardReadout.ts:802-850) would persist the wrong status.
2. "Half land on a different variant" does not hold for the simple cases. Traced by hand: in a one-group rename with a balanced pool, every nulled runner goes to the new empty variant (the least populated), which has the same controls. With two groups and an original start-order round-robin deal, the re-deal in start order also reproduces the mapping. Mismatches appear when the pool is unbalanced, or variants were set by the desk, by a random deal, by registration-time assignVariant or by acceptVariant, or when several keys change at once.
3. For remove-alternative and loop toggle, the old variant's controls no longer exist as a live course, so some reassignment is unavoidable; a locked rule alone would not fix those.

Severity: medium, not high. It needs a setter to change a forked root's key set after runners have finished — an unusual mid-event action — and stored statuses are not corrupted directly. The trace is one runner.updated journal entry per runner.

</details>

### CRS-026 Punch-code uniqueness is checked outside the write transaction and has no database constraint

- **Area:** Course data and course/control API · **Category:** stability · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/routers/control.ts:780`; also packages/api/src/routers/control.ts:936 (update), :1182-1218 (restore: only input.id checked, seq-matched rows not checked at all)
- **Status:** confirmed. Code read only (no reproduction: needs Postgres, and node_modules is absent). Read packages/api/src/routers/control.ts:156-186, 341-374, 385-403, 760-830, 928-940, 1182-1232; packages/api/src/trpc.ts:194-198, 316-318; packages/api/prisma/schema.prisma Control model (@@unique([eventId, seq]), @@index([eventId, removed]) only); packages/web/src/pages/editor/EditorPage.tsx:735-748; grepped docs/course-*.md and docs/map-*.md for a Pending entry covering this (none found).

**What is wrong.** control.create runs assertCodeFree on ctx.db before the transaction; control.update does the same (line 936) and control.restore checks only the id it was called with, also outside its transaction. There is no unique index on live codes. Only start/finish allocation takes the per-event advisory lock (allocateStartFinishCode). Two concurrent creates with the same code both pass.

**Scenario.** Two setters work in the editor at once (presence explicitly supports this); both click 'Add control' and their clients pick the same next free series code 47 within the same few hundred ms. Both requests pass assertCodeFree and commit: two live controls with code 47. Every public-id lookup (controlSeqToId, uuidsOfPublicIds first-wins, getControlByCode unordered findFirst) is now ambiguous and CODE_DUPLICATE is only advisory. control.restore { id: 31 } on a removed row '31;131' also revives it while another live control holds 131.

**Proposed fix.** Take the same pg_advisory_xact_lock('control-codes:<eventId>') at the start of the create/update/restore transactions and run assertCodeFree(tx, ...) inside them, for every code of the row (restore: all codes of the restored row). Size S; optionally add a partial unique index later.

**Verifier's note on the fix.** Severity is medium, not high: it needs two setters creating within the same sub-second window (or a restore of a multi-code/seq-matched row), happens during course setting rather than a live race, is surfaced by the advisory CODE_DUPLICATE check, and is repairable by editing one code. A unique index cannot express this because `codes` is a ';'-separated string. The fix is to take the existing per-event advisory lock (`pg_advisory_xact_lock(hashtext('control-codes:<eventId>'))`, as in allocateStartFinishCode) at the start of the create, update and restore transactions and run the code-free check on `tx` after it; codeHolder already accepts a Db/tx. Restore should check every code of the row it found via codeHolder with exceptId (which also covers the code-less-seq holder case), not just input.id. Keep positionToWgs84 outside the transaction, as the comment at :781 requires.

<details><summary>Verifier's evidence</summary>

1. create: control.ts:780 `for (const n of parsed) await assertCodeFree(ctx.db, ctx.event.id, n);` runs on ctx.db; the transaction only opens at :817, after further awaits (positionToWgs84, count, auto-describe) that widen the window. Inside the transaction the code is not re-checked for an explicitly supplied code; `allocateStartFinishCode` (the only caller of pg_advisory_xact_lock, :386) is reached only for a code-less start/finish (:828).
2. update: control.ts:936 `await assertCodeFree(ctx.db, ctx.event.id, n, c.id)` on ctx.db; the transaction opens at :998.
3. No DB backstop: the Control model has `codes String @default("")` (a ';'-separated string) with only `@@unique([eventId, seq])` and `@@index([eventId, removed])`. No unique index on codes, and none is possible as-is for multi-code strings.
4. No serialising middleware: coursesEditRaceProcedure = raceProcedure + requireCapability (trpc.ts:316); raceProcedure only calls assertRaceWritable (trpc.ts:194-198). No per-event lock or queue.
5. Client picks the code itself: EditorPage.tsx:735-744 computes `nextSeriesControlCode(allocation, used, activeSeriesId)` from its local list and sends `control.create.mutate({ codes: String(code), ... })`. Two editors with the same list pick the same code, so the collision is by construction, not coincidence, whenever two setters add a control before either sees the other's write.
6. restore: control.ts:1188-1202 finds the removed row by codes OR `seq: input.id`; the live-duplicate check at :1210-1222 tests only `codeStr` (the id passed in), not the other codes of the found row (removed '31;131' revives while a live row holds 131), and not the row's codes at all when it was matched by seq. It also omits the code-less-seq holder case that codeHolder covers (:361-362). The check is on ctx.db before the transaction at :1227.
7. Consequence is real: getControlByCode (:162) is an unordered findFirst, so after a duplicate every id-addressed call (update, delete, lastChange) resolves to an arbitrary one of the two rows. CODE_DUPLICATE in packages/shared/src/course/checks.ts:316 is an advisory check, so it flags the state but does not prevent it.

Not found: any docs "Pending" entry declaring this unimplemented, or any test covering concurrent creates with an explicit code.

</details>

### CRS-027 course.delete leaves classes and runners pointing at the removed course

- **Area:** Course data and course/control API · **Category:** functional · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/routers/course.ts:1235`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and it needs a database). Read packages/api/src/routers/course.ts:1235-1252 (delete), :1920-1936 (import replaceAll, for contrast), :244/:261/:286/:1352/:1722-1727 (readers filtering removed), packages/api/src/routers/cardReadout.ts:195-208, packages/api/src/routers/lists.ts:122-140 and :240, packages/api/src/routers/classRouter.ts:50-59 and :107-146, packages/api/prisma/schema.prisma:770/:868, packages/web/src/pages/CoursesPage.tsx:240-256, docs/course-layer.md §12 (:2227-2228) and its Pending section (:2485 onward), docs/course-elevation.md:1226-1227.

**What is wrong.** delete only sets removed = true (and drops a root's variants). classes.course_id and runners.course_id that reference the course are neither cleared nor does the call refuse. Readers disagree afterwards: readout (cardReadout.ts:196) and lists keep matching against the removed course because they load it by id without a removed filter, class.list/detail keep showing its name and control count, while course.list, the Courses page, the class course picker, export and controlCoordinates no longer show it. There is no course.restore.

**Scenario.** An operator deletes course 'Lång' by mistake or to replace it with a re-drawn one while class H21 still uses it. H21 keeps silently evaluating against the invisible course; nothing in the Courses page explains it, the IOF export has no assignment for H21, and the class cannot be seen as 'without course' because class.list still returns the deleted course's seq and name.

**Proposed fix.** Refuse the delete with PRECONDITION_FAILED naming the classes (and count of runners with a direct course_id) unless a `force`/`unassign` flag is given; with the flag, null class.course_id and runner.course_id in the same transaction, run syncClassPool and emit class.upserted / runner.updated. Add an integration test.

**Verifier's note on the fix.** Decide the semantics first, because the spec is silent (CLAUDE.md: ask the user and record the answer in docs/course-layer.md before implementing). The options are to refuse with PRECONDITION_FAILED while classes or runners reference the course, or to clear the references.

If clearing, do it in the same transaction as the delete:
- null `classes.course_id` and emit `class.upserted`; drop the `class_course_pools` rows via `syncClassPool`;
- null `runners.course_id` for the root and its variants and emit `runner.updated`, as the variant path already does.

Clearing changes readout for already-read runners (they fall to "no course"), so refusing, or a confirm that names the affected classes, may be the safer choice during a live event.

Also check that the web class form copes with a `courseId` whose seq is missing from `course.list`, and that the venue snapshot and journal carry the change.

<details><summary>Verifier's evidence</summary>

The claim holds as stated.

- **Delete does not clear or refuse.** course.ts:1235-1252 only sets `removed: true` on the course, runs `syncVariants` (soft-deletes a root's variants) and emits journal rows. It never touches `classes.course_id` or `runners.course_id` for the deleted course and has no in-use check. The schema FKs are `onDelete: SetNull` (schema.prisma:770, :868), which never fires on a soft delete.
- **The codebase knows the invariant elsewhere.** Import with `replaceAll` soft-deletes courses and explicitly nulls `class.courseId` (course.ts:1931-1934, UI hint "Class assignments to removed courses are cleared"). Variant removal nulls the runners pointing at variants (docs/course-layer.md:2227-2228 "journaled, runners nulled"). Only the plain or root delete path skips it.
- **Readers that ignore `removed`.**
  - cardReadout.ts:196-208 loads the course with `findUnique({ where: { id: courseId } })`, so readout keeps matching against the deleted course.
  - lists.ts:133-136 and :240 load by id / `include` with no filter.
  - classRouter.ts:51-58 (detail) and :107-146 (list, `include: { course: … }`) still return the deleted course's seq, name and control count.
- **Readers that hide it.** `getCourseBySeq` (course.ts:244, :261), `course.list` (:286), :1352 and :1722-1727 all filter `removed: false`. The Eventor push is documented as "removed courses apart" (docs/course-elevation.md:1227).
- **No guard in the UI.** CoursesPage.tsx:251-255 shows only `window.confirm('Remove course "{{name}}"?')`, with no warning that classes use it.
- **No restore.** There is no `course.restore` procedure in course.ts. The only way back is an import that re-activates a course by name (course.ts:2147-2229).
- **Not documented as pending.** Nothing in the "Pending in this chapter" section of docs/course-layer.md covers this.

**Severity: medium, not high.** Nothing is lost or corrupted, and results stay computed against the course the runners actually ran, which is arguably the safer failure. The operator can still reassign the class, since `class.update` accepts a new course or null. The real harm is inconsistent state after a deliberate, confirmed delete of an in-use course: the class looks assigned to a course that no other view shows, exports and Eventor omit it, and it cannot be undone.

</details>

### CRS-028 OCD object index: deleted and hidden objects are imported

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/ocd-course-parser.ts:126`
- **Status:** confirmed. Code read plus a standalone reproduction. Read /home/user/oxygen/packages/api/src/ocd-course-parser.ts:107-140 (readObjectIndex), 282-287 (only caller), 395-500 (object dispatch) and 503-520 (first-wins control positions); the live caller is /home/user/oxygen/packages/api/src/routers/course.ts:227. Reproduction: copied the parser to the scratchpad, ran it under node 22 --experimental-strip-types on /home/user/oxygen/e2e/test.ocd, then rewrote byte 30 of every 7xx index entry to 0, 3 and 2 and parsed again. Also tallied byte 30 across all .ocd fixtures in the repo.

**What is wrong.** readObjectIndex skips an entry only when filePos, len or sym is 0. The index entry's Status byte (offset 30 in the 40-byte entry: 1 normal, 2 hidden, 0/3 deleted, 3 = deleted for undo) is never read, so objects the course setter deleted but that are still in the file are parsed as live. Control positions are first-wins (lines 512, 518), so a stale object can decide a control's position, and deleted 705/707/708/709/711 objects become leg gaps and import-marked course objects. Offset and values are from the OCAD format description; the repo's own map importer does read a symbol status (shared/src/import/ocad-source.ts:290) but there is no fixture with deleted course objects to confirm how often OCAD leaves them.

**Scenario.** The setter deletes control 45 and places it again 30 m away, and deletes an out-of-bounds area. If the old objects remain with status 3, Oxygen may place 45 at the old position (wrong circle on every printed map, wrong leg lengths) and prints the deleted out-of-bounds area.

**Proposed fix.** Read the status byte in readObjectIndex and keep only status 1 (and decide on 2). Add a synthetic-buffer unit test like ocdWithScaleParameter in ocd-course-parser.test.ts.

**Verifier's note on the fix.** - The status byte at offset 30 exists only in the 40-byte entry (version > 10). The 32-byte entry for older versions has a different layout, so the check must be version-gated.
- Skip status 0 and 3 (deleted, deleted for undo). Status 2 (hidden) is a separate decision: a hidden object is not deleted, and dropping hidden control circles could lose positions, so settle and record that choice in the spec.
- Mask the byte if the high bits can carry flags, and confirm against the OCAD format description that 1 is the only "normal" value. Prefer skipping the known deleted values over keeping only status 1, so files written by other tools are not emptied.
- Add a test that flips byte 30 on a 702 entry in e2e/test.ocd, and one with a stale duplicate control placed ahead of the live one.

<details><summary>Verifier's evidence</summary>

The code behaviour is proven; how often OCAD leaves deleted course objects in a file is not.

- **No status check.** readObjectIndex reads only offsets 0-28 of each entry. Its only filters are `if (filePos === 0 || len === 0 || sym === 0) continue;` and `if (filePos >= buf.length) continue;` (lines 126-127). The file contains no reference to status, deleted or hidden.
- **Reproduction.** With all 30 course objects in e2e/test.ocd set to status 0, 3 or 2, parseOCDCourseData output is byte-identical to the original (30 controls each time). Deleted and hidden entries are treated as live.
- **Offset 30 is the status byte, by the repo's own usage.** packages/api/scripts/demo-map/enrich-ocad.mjs:359 writes `out0.writeUInt8(0, e + 30); // status 0: deleted` and line 387 writes `1` as "status normal". docs/ops/demo-map.md:45-47 relies on readers honouring it.
- **Deleted entries do keep pos/len/sym.** fixtures/okartan/okartan-demo.ocd has 138 entries with status 0 and non-zero filePos, len and sym (symbols 201003 and 202000). readObjectIndex returns all of them; they are harmless there only because they are not 7xx symbols.
- **Downstream effect.** Control positions are first-wins (`if (!controlObjs.has(code))` at lines 512 and 518), so a stale 701/702/706 object earlier in the index beats the re-placed one. The 704/705/707/708/709/711 branches push features with no further filter.
- **No existing handling.** No guard in course.ts:227, and nothing under a "Pending" section of docs/course-*.md or docs/map-*.md mentions object status.

What I could not prove: no fixture has a deleted or hidden 7xx object (e2e/test.ocd is 30/30 status 1), so the claimed scenario depends on OCAD course-setting files retaining such entries. The claim's reference to ocad-source.ts:290 is the symbol status, not the object status; it is only an analogy.

</details>

### CRS-029 OCD start/finish type is guessed from the first letter of the code

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/ocd-course-parser.ts:627`; also packages/api/src/ocd-course-parser.ts:578
- **Status:** confirmed. Code read of /home/user/oxygen/packages/api/src/ocd-course-parser.ts (lines 248-264, 566-579, 624-639, 646-663), /home/user/oxygen/packages/api/src/routers/course.ts (lines 1793-1797, 1911-1917, 2005-2023, 2066-2137, 2262-2281) and /home/user/oxygen/packages/shared/src/course/structure.ts (196-209); plus a standalone node run of the line 627-629 type expression. No OCD fixture with a non-S/M/F finish id was available, so the end-to-end import was not executed. I could not verify OCAD's actual per-language default ids (Z1/D1/A1/L1); that part of the claim rests on the claimant's word, but the defect does not depend on it since OCAD ids are user-editable.

**What is wrong.** A control is typed Start when its code starts with 'S' and Finish when it starts with 'M' or 'F', although the course record states exactly which ids are the start (s token) and finish (f token) and the object symbol (701000 / 706000) says the same. The unresolved-code filter at line 578 uses the same prefixes. OCAD's default ids depend on its language (German finish 'Z1', French 'D1'/'A1', Finnish 'L1'), and a regular control code may start with S, M or F.

**Scenario.** A course file made in German OCAD with finish 'Z1': Z1 enters the control bank as a regular control with punch code 'Z1' and status ok, so no finish site exists; the course's last item is a non-numeric 'control', courses have no finish in structure, prints and matching. Conversely a control coded 'F5' is created as finish 'Mål 5'.

**Proposed fix.** Build the sets of startId and finishId from textRecs.courses and type by membership (optionally cross-check the label's sym). Use the same sets at line 578.

**Verifier's note on the fix.** Type the bank from the set of `startId`/`finishId` values across `textRecs.courses` (optionally backed by the object symbol 701000/706000 in `controlLabels`), and use the same set in the line 578 filter.

- Keep the "STA1"/"FIN1" fallbacks from line 651 typed as Start/Finish when a course has an empty id; note they are never added to `allCodes` today.
- An id used as one course's finish and another course's control (or start) needs a defined rule.
- course.ts:2012 and 2185 derive "Start N"/"Mål N" from the trailing digits of the id; that still works for Z1 but should be checked for ids without digits.
- Re-importing a file previously imported under the bug would leave the stale regular control "Z1" (or the stale "Mål 5" site) in the event; decide whether the fix needs to handle that.

<details><summary>Verifier's evidence</summary>

The defect is real: the control bank's type comes only from the code's first letter, although the parser already knows which ids are the start and finish.

- **Bank typing (ocd-course-parser.ts:627-629):** `type = (code.startsWith("S") || code === "Start") ? "Start" : (code.startsWith("M") || code === "Finish" || code.startsWith("F")) ? "Finish" : "Control"`. Running that expression gives Z1, D1, A1, L1 -> Control; F5, M12 -> Finish; SK3 -> Start.
- **The exact ids are available:** parseRecord reads the `s`/`f` tokens into `startId`/`finishId` (lines 257-258), and they are added to `allCodes` at 568-569, but are not consulted for the bank type. The object symbol (SYM_START / SYM_FINISH) is kept in `controlLabels[].sym` and also unused for typing.
- **Per-course typing is correct but does not rescue it:** lines 658-660 type by position (first = Start, last = Finish), yet the import builds structure items from `siteId` alone (course.ts:2262-2277; `linearStructure` only copies items). A site's role therefore comes from the control row written from the bank type.
- **Effect of a finish id such as Z1 (course.ts:2005-2023, 2130-2137):** the row is created with status ok (value 0), name "" and codes "Z1", so no "Mål 1" finish site exists and the course's last item is a regular control. The `legs` string and `startName` still come out right because they use the position-based per-course type (2166-2168, 2185).
- **Converse case:** a regular control coded F5, M12 or S7 gets status finish/start, name "Mål 5" etc., its own code is dropped (`codes = ""`, then a 3-30 code is allocated), and `circleGaps`/cuts are omitted (parser line 636 only attaches cuts to type Control). Two such codes with the same numeric suffix would merge by name.
- **Line 578:** the same prefixes exclude S/M/F-coded regular controls from the 702000-circle position fallback, so an unresolved one stays at (0,0). This only matters when the object text carries no code.
- **Not documented as pending:** docs/course-layer.md "Starts and finishes on import (F32)" only says file ids like `S1`, `STA1`, `Start 1` are name keys; nothing lists the prefix rule as a known limitation. The parser test file has no case for other prefixes.

Severity: medium rather than high. Swedish (S1/M1) and English (S1/F1) OCAD ids and the parser's own STA1/FIN1 fallbacks all work, and OCAD control codes are normally numeric, so the converse case is rare. The failure needs a file from another OCAD language or with renamed start/finish ids. It writes wrong control rows (wrong role, non-numeric punch code) silently, though the import preview would show `finishControls: 0` (course.ts:1797).

</details>

### CRS-030 IOF and OCD positions are written to the event map with no check of origin or scale

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/course-import-align.ts:174`; also packages/api/src/routers/course.ts:1863; packages/api/src/iof-course-parser.ts:226
- **Status:** confirmed. Code read only (no reproduction needed; the path is a straight early return). Read /home/user/oxygen/packages/api/src/course-import-align.ts:160-220, /home/user/oxygen/packages/api/src/iof-course-parser.ts:203-229, /home/user/oxygen/packages/api/src/ocd-course-parser.ts:542, /home/user/oxygen/packages/api/src/routers/course.ts:1376-1415, 1713-1807, 1837-1890, 1978-2074, /home/user/oxygen/packages/web/src/components/CourseImportDialog.tsx:40,237,250, and /home/user/oxygen/docs/system/ppen-import-export.md:67. Grepped docs/map-*.md and docs/course-*.md for a Pending entry covering IOF/OCD import origin or scale checks: none found.

**What is wrong.** resolveImportAlignment returns 'unknown' for any file without a sourceMap, so IOF MapPosition mm and OCD paper mm are written straight to controls.xpos/ypos. Not even positionsOffMap is run. The IOF file carries what is needed to check: Map/Scale and each control's Position lat/lng; the OCD file carries its own scale and georeference (importCourses already reads its CRS when the event has no map). The comment at course.ts:1863 ('Alignment has already put parsed map-mm coordinates into the event map's paper space') is not true for these formats. MapPosition unit='px' is also read as mm.

**Scenario.** Courses are set in Condes or an OCAD course project at 1:10 000 on a map whose file is 1:15 000 (or with another paper origin) and imported into an event that uses the 1:15 000 map. Every control lands 1.5x off from the map origin, preview reports nothing, and course maps print with circles in the wrong places. lat/lng in the same file were correct.

**Proposed fix.** For IOF: when the event has a CRS and controls carry lat/lng, project them with wgs84ToMapMm and compare with MapPosition; beyond a tolerance, use the projected positions (status 'transformed') or return 'mismatch'. For OCD: compare the file's scale/CRS with the event's and transfer via transferParsedCoordinates. At minimum run positionsOffMap and compare mapScale with the event map's scale, and surface a warning in the preview.

**Verifier's note on the fix.** - Update docs/system/ppen-import-export.md:67 and the header comment at course-import-align.ts:17-18, which currently state the `unknown` behaviour as intended.
- The cheapest guard is to run `positionsOffMap` for source-less files when the event has a calibration. A centroid test will not catch a 1.5x scale error whose centroid stays on the sheet, so also compare `parsed.mapScale` with the event map's scale.
- The IOF parser defaults `mapScale` to 15000 and the OCD parser to 7500 when the file carries none. A scale comparison must tell "absent" from "present", or it will raise false mismatches.
- For IOF, the file's `Position` lat/lng could be projected through `loadEventCrs` and compared with `MapPosition`, or used to derive `xpos`/`ypos`. Files without `Position` (lat/lng parsed as 0) need a fallback.
- Read `MapPosition/@_unit`; reject or convert `px` rather than treating it as mm.
- For OCD, the comment at course.ts:1866-1868 should be corrected, or the file's own CRS (already read at 1873-1886 when the event has no map) used to re-project into the event frame.
- `CourseImportDialog` needs a state for the new warning; today only `transformed` and `mismatch` render.

<details><summary>Verifier's evidence</summary>

The claim holds as stated.

- **No check for IOF/OCD.** `resolveImportAlignment` returns `status: "unknown"` with the parsed data untouched when `parsed.sourceMap` is absent (course-import-align.ts:174-175). Only `ppen-course-parser.ts` sets `sourceMap`; the IOF and OCD parsers never do. `positionsOffMap` is only reached at line 216, after that early return, so it never runs for these formats.
- **Positions written raw.** `importCourses` writes `xpos: pc.mapX, ypos: pc.mapY` directly (course.ts:1983 for crossing points, 2074 for controls).
- **Scale is parsed but never compared.** The IOF parser reads `Map/Scale` into `mapScale` (iof-course-parser.ts:204) and the OCD parser reads its own (ocd-course-parser.ts:542). In course.ts, `parsed.mapScale` is only echoed in the preview response (line 1798); nothing compares it to the event map's scale.
- **Unit ignored.** The parser reads `MapPosition` `@_x`/`@_y` and never reads `@_unit` (iof-course-parser.ts:219-226), so `unit="px"` is taken as mm.
- **Correct lat/lng does not rescue it.** `controlCoordinates` recomputes lat/lng from `xpos`/`ypos` through the event CRS whenever they are non-zero (course.ts:1396-1401), so the wrong paper position overrides the file's correct `Position`.
- **Preview is silent.** The dialog only reacts to `transformed` and `mismatch` (CourseImportDialog.tsx:40, 237, 250); `unknown` shows nothing.
- **Comment is inaccurate for OCD.** The comment at course.ts:1866-1868 says alignment has already put the coordinates into the event map's paper space; for OCD, alignment is a no-op.

This is a documented design choice rather than an oversight: docs/system/ppen-import-export.md:67 says "`unknown` | Nothing to check; unchanged behaviour (IOF XML and OCAD always land here)", and the header of course-import-align.ts:17-18 says the same. It is not listed under any "Pending" section of docs/map-*.md or docs/course-*.md, so the refutation rule does not apply.

Severity is medium, not higher. It needs a course file authored against a different map file, scale or paper origin than the event's map. A file set on the event's own map imports correctly, including Oxygen's own IOF export, which writes raw paper mm. The misplacement is silent at import, but a 1.5x displacement is visible in the course editor and on any proof before printing. Nothing is lost: re-importing, or importing with `skipPositions`, recovers.

</details>

### CRS-031 A Purple Pen file set on another map is reported 'aligned' when its centroid falls on the event map

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/course-import-align.ts:211-219 (test at 69-93); UI at packages/web/src/components/CourseImportDialog.tsx:40,237-275`
- **Status:** confirmed. Code read of /home/user/oxygen/packages/api/src/course-import-align.ts:69-93 and 187-219, /home/user/oxygen/packages/web/src/components/CourseImportDialog.tsx:40 and 237-275, /home/user/oxygen/packages/api/src/routers/course.ts:1837-1843 and 2074, and /home/user/oxygen/docs/system/ppen-import-export.md:60-82. Also ran a standalone node copy of positionsOffMap in the scratchpad.

**What is wrong.** When the recorded map name differs from the event's and the club library has no match, the status is 'aligned' whenever the centroid of the placed controls lies inside the event map's extent plus 5 %. Two maps of the same terrain with paper origins a few centimetres apart, or a PDF/bitmap map whose coordinates run 0..300 mm, pass this test. The UI then shows the same state as a true same-file match, with no warning and skipPositions unticked.

**Scenario.** Courses set on 'Brotorp utsnitt.ocd' are imported into an event on 'Brotorp 2026.ocd' whose origin is 40 mm away. Centroid is on the map, status 'aligned', all controls are stored 40 mm (400 m at 1:10 000) off and print there.

**Proposed fix.** Return a distinct status (for example 'unverified') for the name-mismatch-but-on-map case and show the preview warning with both map names; keep 'aligned' for a name match only. Update docs/system/ppen-import-export.md table.

**Verifier's note on the fix.** The fallback is a deliberate, documented feature for a renamed copy of the same file, so a fix must not turn that case into a hard mismatch. A distinct status (for example "unverified" or "assumed") with an informational banner and an optional skipPositions checkbox would fit, with `aligned` reserved for the name match. PDF/Bitmap sources (`sourceMapKind`) and a scale mismatch between `sourceMap.scale` and the event map are cheap extra signals. Any change needs matching updates to docs/system/ppen-import-export.md (the status table), course-import-align.test.ts, ppen-import.test.ts, the i18n strings, and the `coordinateAlignment` consumers in the preview and import results (course.ts:1803, 2409). CLAUDE.md requires asking the user before deviating from documented behaviour.

<details><summary>Verifier's evidence</summary>

The mechanism is real, but it is a documented design heuristic rather than an oversight.

- **Fallback branch:** when the names differ (`sameMapFile` false, line 187) and the club library has no match (line 193), lines 212-219 return `aligned` unless `positionsOffMap` is true.
- **What the test checks:** `positionsOffMap` (lines 69-93) only tests whether the centroid of the placed controls lies outside the event map's calibration bounding box padded by 5% of its longer side.
- **Reproduction:** with an event extent of x -150..150, y -100..100, controls shifted by 40 mm returned false (so `aligned`). Controls in a 0..300 mm PDF-style frame, e.g. (40,30), (120,90), (140,60), also returned false.
- **UI:** `CourseImportDialog.tsx` shows a banner only for `transformed` (line 237) and `mismatch` (line 250). Line 40 pre-ticks `skipPositions` only on `mismatch`, and the checkbox is rendered only inside the mismatch banner. A fallback `aligned` is therefore indistinguishable from a true same-file match.
- **Server:** `importCourses` does not gate on the status. `course.ts:2074` writes `xpos`/`ypos` from the file whenever `skipPositions` is false, including onto existing controls.
- **No other guard:** `sourceMap.scale` and `kind` are parsed (`ppen-course-parser.ts:122-128`) but never used to sanity-check the fallback.

Against the claim:

- **Documented as intended:** `ppen-import-export.md:65` lists "Source map unavailable, but positions land on the event map -> aligned ... covers a renamed copy of the same file". Lines 80-82 say a PDF/Bitmap `.ppen` "either lands plausibly on the event map or gets the mismatch warning".
- **Not listed as Pending:** it is not under any "Pending" section of `docs/map-*.md` or `docs/course-*.md`, so that does not refute it.
- **Narrow trigger:** it needs a different file name, no library match, and an origin offset small enough to keep the centroid on the map. An OCAD partial-map export normally keeps the parent's georeference, in which case `aligned` is correct.
- **Visible and recoverable:** the misplacement shows in the course editor on the map before printing, and re-importing or re-placing fixes it. Nothing is lost beyond overwritten positions of existing controls.

</details>

### CRS-032 IOF file without Length/LegLength overwrites the stored course length and legs with 0

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/routers/course.ts:2215 (legs at :2219; create branch :2236 and :2239; root cause packages/api/src/iof-course-parser.ts:239 and :275)`; also packages/api/src/routers/course.ts:2236
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent). Followed packages/api/src/iof-course-parser.ts:162-168, 239, 253, 275 into packages/api/src/routers/course.ts:2162-2168, 2209-2227, 2233-2246, 2304-2308, then packages/api/src/course-geometry.ts:270-303, packages/api/src/course-export.ts:213-219, packages/api/src/iof-course-export.ts:132, 153-159, and the specs docs/course-layer.md:1041-1046 and docs/course-controls-and-matching.md:444-448. Searched docs/*.md for a Pending entry or decision covering a file without Length: none found.

**What is wrong.** lengthM is set to Math.round(pc.length) and legs to the file's LegLength values unconditionally, with lengthSource 'file'. Length and LegLength are optional in IOF 3.0 (Oxygen's own exporter omits Length when 0 and LegLength for free order), and safeFloat turns a missing element into 0. No derivation from the imported positions is run (rebuildCourseLengths is called only for skipPositions).

**Scenario.** Re-import of an IOF file that has positions but no <Length>: an existing 5 400 m course is stored as length_m = 0, legs '0;0;0;', length_source 'file'. Start lists, results and print templates show 0 km until someone edits the course.

**Proposed fix.** When pc.length is 0 (or all leg lengths are 0) and positions were imported, call rebuildCourseLengths for that course (derived length and legs) instead of storing zeros; on update keep the stored length when neither is available.

**Verifier's note on the fix.** - The parser must distinguish "absent" from 0: `safeFloat` collapses both, so `ParsedCourse.length` and `legLength` need an undefined state, or the importer must treat 0 as "not stated" as it already does for climb at course.ts:2217.
- When the file states no Length but positions are imported, either keep the stored `length_m`/`legs` or derive them with `rebuildCourseLengths`. That function sets `length_source` to 'derived', which changes export and Eventor-sync behaviour per docs/course-controls-and-matching.md:444-448, so the choice is a spec decision for docs/course-layer.md §6.4 rather than a silent change.
- Handle Length and LegLength independently, since a file may carry one without the other.
- Free-order courses must keep a typed length.
- The same importer code path serves Purple Pen and OCD parsers; check that their computed lengths are not affected by the guard.
- The create branch (:2236) has the same 0 result for a new course and could derive instead.

<details><summary>Verifier's evidence</summary>

The mechanism is as claimed.

- **Parser:** `safeFloat` returns 0 for undefined/null/"" (iof-course-parser.ts:162-168). `const length = safeFloat(rc.Length)` (:239) and `legLength: safeFloat(cc.LegLength) + ...` (:275) carry no "absent" marker.
- **Update of an existing course:** course.ts:2215 writes `lengthM: Math.round(pc.length)` and :2219 writes `legs: legsStr` unconditionally. `legsStr` is built at :2162-2168 from `Math.round(cc.legLength)`, so a file without LegLength gives "0;0;...;".
- **Contrast with climb:** the next line (:2217) guards climb with `Math.round(pc.climb) > 0` and the comment "a file without one leaves a typed climb alone". Length has no such guard.
- **Create branch:** :2236 and :2239 do the same.
- **No derivation afterwards:** the only `rebuildCourseLengths` call in the import is inside `if (skipPositions)` (:2304-2308), and it passes `updateLength: false`. `persistStructure` and `syncVariants` only rebuild variants.
- **Provenance:** `lengthSource: geom ? "file" : undefined` (:2225), so 'file' is set only when the parser produced geometry for that course; otherwise it is left as it was. `length_m` and `legs` are zeroed either way.
- **Spec:** docs/course-layer.md:1041-1046 says an IOF/PPen re-import "writes the file's positions, length". It does not address a file that states no length, and no Pending section lists it.

Mitigations that limit the impact:

- Export falls back to the derived length when the stored one is 0 (course-export.ts:213-219).
- The Eventor sync overwrites non-derived lengths.
- Any course edit re-derives length and legs.
- The value is recomputable from the positions; no competitor or result data is touched.

Display paths read `lengthM` raw and would show 0: lists.ts:255, classRouter.ts:77, cardReadout.ts:310, race.ts:75.

The trigger is unusual. Purple Pen, OCAD and Condes write `<Length>` for ordinary courses. Oxygen's own exporter omits Length only when both the stored and the computed length are already 0 (iof-course-export.ts:132), and omits LegLength only for free-order courses, whose legs are not meaningful. An Oxygen round trip therefore does not turn a 5,400 m course into 0; it takes a third-party or hand-trimmed file that has positions but no Length.

</details>

### CRS-033 Purple Pen export writes a free-order course as an ordered kind="normal" course

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/ppen-course-export.ts:132`; also packages/api/src/ppen-course-parser.ts:309
- **Status:** confirmed. Code read only, no reproduction run (node_modules absent, and the logic is unconditional so there was nothing to exercise). Read packages/api/src/ppen-course-export.ts:108-158, packages/api/src/course-export.ts:158-226, packages/api/src/ppen-course-parser.ts:220-225 and 309-314, packages/api/src/routers/course.ts:2175-2259, packages/shared/src/readout.ts:316-329, docs/system/ppen-import-export.md:109-141 and docs/system/free-order-courses.md:80-100. Searched docs/map-*.md and docs/course-*.md for a Pending entry covering this; found none.

**What is wrong.** buildPpenXml ignores ExportCourse.orderMode: every course is kind="normal" with a linked sequence. The parser sets no orderMode either, and importCourses then writes orderMode 'ordered' over the existing course (course.ts:2218). Climb is also neither written nor read (parser sets climb: 0), which only the import path survives because a 0 climb leaves the stored one. docs/system/ppen-import-export.md does not list free order under what is lost.

**Scenario.** A free-order course is exported to .ppen for printing: Purple Pen prints legs and sequence numbers 1..n. If the file is imported back mid-event, the course becomes ordered and every runner who took the controls in another order is MP.

**Proposed fix.** Either write kind="score" for free_order courses and read it back as free_order, or leave free-order courses out of the ppen export with a documented note; in importCourses do not overwrite orderMode of an existing course from a format that cannot express it.

**Verifier's note on the fix.** - Writing `kind="score"` on export is not enough on its own: the parser rejects every non-normal kind (ppen-course-parser.ts:220-225), so the parser must accept score and set `orderMode: "free_order"` for a round trip.
- Independently of the format, course.ts:2218 resets `orderMode` to "ordered" whenever the parsed file is silent. Consider keeping the stored mode when the format cannot express it (always for `.ppen`), or warning in the import preview.
- The Purple Pen score-course vocabulary is not verified in this repo. ppen-import-export.md already notes that the `<leg>` vocabulary beyond bends was unverified against Purple Pen's source, so the same caution applies here.
- At minimum, add free order and climb to the "what is lost" list in docs/system/ppen-import-export.md.

<details><summary>Verifier's evidence</summary>

The claim holds on every point I checked.

- **Export ignores order mode.** course-export.ts:158-159 and :226 compute `orderMode` and put it on `ExportCourse`. `buildPpenXml` never reads it: ppen-course-export.ts:132 hard-codes `"@_kind": "normal"`, :134 sets `labels label-kind="sequence-and-code"`, and :153-161 link every control with `<next>`. The IOF writer does branch on it (iof-course-export.ts:134, `randomOrder="true"`).
- **Parser sets no order mode.** ppen-course-parser.ts:309-314 pushes `{ name, length, climb: 0, controls }` with no `orderMode`. It also rejects any kind other than "normal" (:220-225), so writing `kind="score"` instead would not round-trip either.
- **Re-import overwrites the stored mode.** course.ts:2218 writes `orderMode: pc.orderMode ?? "ordered"` on the existing course matched by name, and :2259 builds an ordered structure with legs. Nothing in that path warns or guards.
- **Readout depends on it.** readout.ts:316-329 only uses the free-order matcher when `orderMode === "free_order"`, so a course flipped to ordered is matched in sequence.
- **Climb.** The parser returns `climb: 0`; course.ts:2217 only writes climb when it is above 0, so an existing stored climb survives, as the claim says. I did not separately grep the exporter for a climb field; the parts of it I read write none.
- **Docs.** ppen-import-export.md:109 says "Every course is a kind="normal" course", and the "not supported" list (:130-141) covers score courses on import but not the loss of free order on export or round trip. free-order-courses.md:99 lists only "Purple Pen kind="score" import" as out of scope. No Pending section covers it.

**Severity: medium, not high.** The direct effect is a `.ppen` that Purple Pen shows with legs and sequence numbers for a free-order course, which is a visible, undocumented fidelity loss. The MP outcome needs an unusual chain: a free-order course, exported to `.ppen`, re-imported over the same event after runners have started. The mode can be set back in the UI and results are re-evaluated from punches, so nothing is lost permanently.

</details>

### CRS-034 Parsers are tested only against Oxygen's own output and one OCD fixture

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** tests · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/iof-course-parser.ts:148 (parser with no dedicated test file); packages/api/src/__tests__/ocd-course-parser.test.ts:8 (single OCD fixture)`
- **Status:** confirmed. Code read only (no reproduction needed for a coverage claim). Listed packages/api/src/__tests__ and grepped every test and e2e file for parseIOFCourseData / parseOCDCourseData, CourseData, fixture reads and the named scenarios; searched the repo for .ocd/.xml/.ppen fixtures; read the XMLParser options at packages/api/src/iof-course-parser.ts:148-160 and the RaceCourseData handling at :197-209.

**What is wrong.** There is no iof-course-parser test file: the IOF reader is exercised through round trips of buildCourseDataXml and small hand-written strings, and no fixture exported by OCAD, Condes or Purple Pen exists in the repo. The OCD parser has one real fixture (e2e/test.ocd) and synthetic buffers for scale only. Untested behaviour includes: several RaceCourseData, several Control per CourseControl, unknown control references, a file without Length, zero courses with replaceAll, forked OCD course records, deleted OCD objects, start/finish ids other than S*/M*/F*, re-import over multi-code or voided controls, one class under several courses.

**Scenario.** Each of the import findings above passed the current suite; a change to parser options (for example parseTagValue) would also pass while changing real-file behaviour.

**Proposed fix.** Add packages/api/src/__tests__/iof-course-parser.test.ts with small anonymised CourseData samples in the shape other tools write (not from the excluded club map), synthetic OCD record tests for variation tokens/status/start-finish ids, and integration tests for the re-import cases listed.

**Verifier's note on the fix.** A fix should add a dedicated iof-course-parser test file with real exports from OCAD, Condes and Purple Pen as fixtures, not more hand-written strings. Real third-party files may contain event or club names, so check the fixtures are licence-clean and anonymised before committing. The several-RaceCourseData case needs a spec decision first (CLAUDE.md: spec silent means ask the user) because the parser currently returns zero controls silently for it.

<details><summary>Verifier's evidence</summary>

The claim holds as a test-coverage gap.

- No iof-course-parser test file exists. __tests__ has iof-course-export.test.ts, ocd-course-parser.test.ts and ppen-course-parser.test.ts only. parseIOFCourseData is called from iof-course-export.test.ts (round trips of buildCourseDataXml, plus one hand-written "foreign file" block at :348-385) and from integration/course-export.test.ts.
- No IOF XML fixture file is in the repo. The find for *.xml outside node_modules returned nothing; the only course fixtures are e2e/test.ocd, e2e/test-data.ocd, e2e/colour-layers.ocd, fixtures/okartan/*.ocd and two .ppen files (which feed the Purple Pen parser, not the IOF reader). The only creator strings in tests are "Oxygen" and "Eventor" (the latter in an unrelated Eventor length test); none from OCAD, Condes or Purple Pen.
- OCD parser: ocd-course-parser.test.ts reads only e2e/test.ocd (:8, :44); the scale tests (:28-40) use synthetic buffers. The integration tests (course-import-coords, course-import-structure, course-import-class-fallback, course-export) all reuse the same e2e/test.ocd.
- A grep of the tests for several RaceCourseData, unknown control references, missing Length, deleted OCD objects and forked OCD records found nothing; the only "fork" hits are the export-side forked() helper in iof-course-export.test.ts:252.
- One listed gap is visibly unguarded in code: the isArray list (iof-course-parser.ts:151-159) does not include CourseData.RaceCourseData, so a file with two RaceCourseData elements makes raceCourseData an array and raceCourseData.Control (:208) undefined, giving zero controls with no error. No test covers this.

Limits: I did not check each of the ten listed behaviours individually (for example zero courses with replaceAll, or one class under several courses, may have partial integration coverage in course-variants.test.ts or ppen-import.test.ts), and I did not verify the claimed scenario that the other import findings "passed the current suite", since the suite cannot run here. The parseTagValue point is partly softened by the hand-written foreign-file test and the round trips, which would catch some option changes.

Severity: this is missing tests, not a behavioural defect in itself, so medium (real maintenance cost; lets real-file import bugs through unnoticed).

</details>

### CRS-035 Server print timeout is a fixed 10 minutes for the whole job, and the worker it kills is reused by the next queued print

- **Area:** Course map printing and PDF · **Category:** stability · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/course-maps/print-worker-host.ts:106-109 (same pattern at 189-192; stale reuse at 86 and 185)`; also packages/api/src/course-maps/print-worker-host.ts:86, 189-192 (askWorker timeout)
- **Status:** confirmed. Code read of /home/user/oxygen/packages/api/src/course-maps/print-worker-host.ts (lines 63-79, 85-131, 139-154, 180-213), the Semaphore in packages/api/src/map-render-limits.ts:32-65, the route in packages/api/src/course-maps/routes.ts:442, and docs/course-print.md (§8.2 lines 919-927, §11.5 lines 1941-1946, Pending at 1964). Then a standalone reproduction with real worker_threads: /tmp/claude-0/-home-user/955a9e60-b445-5cf6-b5b3-72ae6a31a60f/scratchpad/repro.mjs copies send / renderCoursePagesInWorker / startWorker / Semaphore verbatim with a stub worker and shortened timeouts. The real test suite could not be run (no node_modules).

**What is wrong.** (1) `PRINT_WORKER_TIMEOUT_MS` is armed once per job and never reset by `page` messages, while a job may hold 200 composed pages at seconds each (docs §11.5): a cap-sized export on a slow laptop loses everything at minute 10 and a retry does the same. The browser client already uses a per-message silence watchdog. (2) On timeout the handler calls `finish(reject)` then `worker.terminate()` but leaves `slot.worker` and `slot.keys` pointing at the dying worker until the asynchronous `exit` event. The rejection releases `slot.busy` and the print gate in microtasks, so the next queued request runs `const worker = slot.worker ?? startWorker(slot)` (line 86) and gets the terminating worker: with a known document key it posts at once and is failed by the exit event ('print worker exited with code 1'); with an unknown key it awaits `document.bytes()`, the exit fires meanwhile (slot.fail is null), and the request then waits on a dead worker for another 10 minutes while holding the only worker slot (PRINT_WORKERS default 1), blocking every print, thumbnail, print.png and SVG upload.

**Scenario.** Organiser exports all courses (180 A3 pages) on the arena laptop; it reaches page 170 at 10:00 -> 400 'print exceeded 600000 ms'. A colleague's single-course export queued behind it fails immediately with 'print worker exited with code 1', or hangs 10 minutes.

**Proposed fix.** Make the timer a silence watchdog: re-arm it in `onMessage` for every `page` message (e.g. 120 s without progress), keep an overall generous cap. In the timeout handlers of both `send` and `askWorker`, detach the worker before settling: `if (slot.worker === worker) { slot.worker = null; slot.keys = []; }` then `finish(reject)` and `terminate()`. In `send`, obtain the worker after `await opts.document.bytes()` (or re-check `slot.worker === worker` after the await and restart). Add tests in print-worker.test.ts with a small `timeoutMs`: the next print after a timeout succeeds; progress keeps a slow job alive.

**Verifier's note on the fix.** - On timeout, detach the worker from the slot synchronously before rejecting (`slot.worker = null; slot.keys = []` if `slot.worker === worker`), in both `send` and `askWorker`, so the next request starts a fresh worker as the spec says.
- Separately, `send` captures `worker` before `await opts.document.bytes()` (lines 86-89). A worker that dies for any reason during that await (crash, OOM, not only timeout) leaves the request posting to a dead worker for the full timeout. After the await, re-check `slot.worker === worker` and restart or fail, or set `slot.fail` before the await.
- If the timer is made a silence watchdog re-armed on `page`, the first page still includes document decode and prepare, so the first interval needs a generous budget. Changing the fixed 10 min is a spec change to docs/course-print.md §8.2 and needs the user's decision per the project rules.
- Add a test with a small `timeoutMs` and a second request queued behind it.

<details><summary>Verifier's evidence</summary>

Part 2 (dying worker reused) is reproduced.
- Timeout handler, lines 106-109: `finish(reject)` then `void worker.terminate()`. `finish` sets `slot.fail = null` but nothing clears `slot.worker` or `slot.keys`; only `drop` does (lines 66-73), and it runs on the asynchronous `exit` event.
- The rejection releases `slot.busy` (line 152), the render gate and the print gate (Semaphore.release calls the next waiter directly) in microtasks, so a queued request reaches line 86 `slot.worker ?? startWorker(slot)` before `exit` fires.
- Repro, known key (no await before postMessage, line 89): big job rejects "print exceeded 300 ms" at 336 ms, queued job rejects "print worker exited with code 1" at 340 ms.
- Repro, unknown key (awaits `document.bytes()`): `exit` fires during the await while `slot.fail` is null; the request then posts to the dead worker and only settles at its own full timeout ("print exceeded 3000 ms" at 3358 ms; 10 min in production). One worker was started in total in both runs.
- During that wait it holds `slot.busy` and the only print-gate permit (PRINT_WORKERS default 1, line 28), so maps.pdf, print.png (routes.ts:556, 601, 604) and SVG upload trim (routers/graphics.ts:107) queue behind it.
- `askWorker` (lines 185-192) has the same pattern; it posts synchronously, so a queued raster/trim fails at once with the exit error.
- This contradicts the spec, docs/course-print.md:925-927: "the worker is terminated and the request fails; the next one starts a fresh worker." It is not listed under Pending (line 1964 onward).
- No test covers the timeout path; print-worker.test.ts:141-150 only covers `resetPrintWorkers`, which nulls `slot.worker` itself.

Part 1 (fixed whole-job timer) is true from the code, but it is documented design.
- The timer is armed once at line 106; the `page` branch at line 112 only calls `onPage`.
- docs/course-print.md:925-926 states the 10 min request timeout deliberately ("as the import worker"), so this half is a design limit rather than a spec violation.
- It is reachable in principle: docs lines 1941-1946 give 0.28-0.81 s compose plus 1.3-3.5 s write per Club-full A3 page on the dev machine as "the per-page cost the worker now carries". At the 200-composed-page cap that is roughly 320-860 s against a 600 s limit.
- Those timings predate C13 frame culling and were not re-measured, so the claim's "page 170 at 10:00" is an extrapolation, not a measurement.
- The device path's watchdog is per-message (docs lines 1171-1174, 60 s silence), and jobs above the device cost limit go to maps.pdf, so the largest jobs are the ones under the fixed cap.

Severity: medium. Part 2 only triggers after a 10-minute timeout with another request already queued at that moment, which is an unusual case. Nothing is lost or corrupted, and the pool recovers after one failed request or one further 10-minute stall. Part 1 needs a near-cap job on a heavy map or slow machine.

</details>

### CRS-036 Printed description block never carries the start's description (columns C-H of the start row)

- **Area:** Course map printing and PDF · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/shared/src/course-maps/resolve-layout.ts:350`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the logic is a plain missing argument). Followed buildDescriptionSheet's callers, the print renderer, the editor's action bar, the control router and the docs' wording.

**What is wrong.** `buildDescriptionSheet` takes `startDescription` and puts it on the start row, and the editor's on-map sheet passes it (packages/web/src/components/MapViewer.tsx:3612). `resolveMapLayout`, the function every printed sheet and descriptions.pdf resolve through, calls `buildDescriptionSheet` without `startDescription`, although `input.course.start` (a LayoutControlSource with `description`) is at hand. The resolve-layout test even pins `description: null` for the start row.

**Scenario.** The start control has an IOF description (e.g. 'path junction'). The course editor's description sheet shows it on the start row; maps.pdf and descriptions.pdf print the start row with only the triangle. Runners get a description that differs from what the setter proofed on screen.

**Proposed fix.** Pass `startDescription: (input.course.start?.description ?? null) as ControlDescription | null` in the `buildDescriptionSheet` call (only when the start is the course's start, i.e. `input.kind === "course"`), update the unit test expectation and the PDF/print-job fixtures (bytes change for courses whose start has a description).

**Verifier's note on the fix.** Pass `startDescription: (input.course.start?.description ?? null) as ControlDescription | null` in resolve-layout.ts's buildDescriptionSheet call. The row mapping at lines 378-385 already forwards `description`, and print/description.ts already draws C-H on a start row. Add a resolve-layout test with a described start (the existing test at line 76 only covers the null case). Check that every resolveMapLayout caller passes a start row that includes `description` (courseMap.ts:348 and auto-sheets.ts:500 use layoutCourseEnds over control rows; verify their selects include the column). The block's row count is unchanged, so descriptionBlockSize / description_outside_page are unaffected.

<details><summary>Verifier's evidence</summary>

1. /home/user/oxygen/packages/shared/src/course-maps/description-rows.ts:94 declares `startDescription?: ControlDescription | null`; line 239 puts it on the start row: `description: input.startDescription ?? null`.
2. /home/user/oxygen/packages/shared/src/course-maps/resolve-layout.ts:350-376 calls buildDescriptionSheet with eventName, classNames, courseName, lengthM, climbM, orderMode, controls, instructions, finishLengthM, crossings, exchanges - no startDescription. A repo-wide grep for `startDescription` finds only description-rows.ts:94/239 and MapViewer.tsx:3612, so no print path supplies it.
3. The data is at hand: `input.course.start` is a LayoutControlSource (resolve-layout.ts:80) whose `description` field is the controls.description JSONB (line 48-49); line 318 already reads `input.course?.start` for the overlay. descriptions-pdf.ts:152-166 passes `start: ends.start` taken from full `db.control.findMany` rows, so the description is loaded and then dropped.
4. The print renderer would draw it if present: /home/user/oxygen/packages/shared/src/print/description.ts:232-238 draws the start pictogram and then falls through to `if (!row.description) return; ... C..H cellContent` for the start row too. So the only gap is the missing argument.
5. The editor does show it: /home/user/oxygen/packages/web/src/components/MapViewer.tsx:3584-3612 passes `startDescription: startOverlay?.description ?? null`, and 3847-3856 renders 'Start: triangle in column A, optional C-H description'.
6. A setter can give a start a description: /home/user/oxygen/packages/web/src/pages/editor/ActionBar.tsx:113 offers the 'description' action for any selected non-mark control including start/finish (the startFinish guards above it do not cover it), and control.update (packages/api/src/routers/control.ts:890-952) accepts a description regardless of kind.
7. The test pins the gap only by omission: /home/user/oxygen/packages/shared/src/__tests__/resolve-layout.test.ts:76 expects `{ kind: "start", code: "", description: null, symbolKey: "start" }` with a start fixture that has no description, so it does not assert that a described start is dropped.
8. Not listed as pending: docs/course-maps.md:381-388 states print and the editor's on-map sheet are 'the same sheet' / 'identical block'; no Pending entry about the start row's description was found in docs/course-print.md or docs/course-maps.md.

Severity: medium, not high. A start description is optional and only exists when the setter enters one by hand (control.ts:800-806 skips autodetect for auto-named starts), so the default flow is unaffected; nothing about results or timing is wrong. When it is set, the printed sheet silently differs from what was proofed on screen.

</details>

### CRS-037 `number_hidden` is dropped on printed course and variant pages

- **Area:** Course map printing and PDF · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/shared/src/course-maps/resolve-sheet.ts:114-121`; also packages/shared/src/course-maps/sheet-rows.ts:54, packages/shared/src/course-maps/resolve-layout.ts:145
- **Status:** confirmed. Code read only (no reproduction run; the logic is a straight omission). Read packages/shared/src/course-maps/resolve-sheet.ts:63-135 (legPropsByIndex, courseInputOfLayout), :146-183 (allVariationsInput), :224-250 (resolveSheet); sheet-rows.ts:54; resolve-layout.ts:145-158; packages/api/src/course-maps/routes.ts:40-51; packages/shared/src/course/derive.ts:268-286; packages/web/src/lib/course-layer-request.ts:249; docs/course-print.md §5.2 and its Pending section; docs/course-layer.md Pending; docs/course-editor.md:905. Grepped the whole repo for numberHidden/number_hidden to look for any other print-side carrier or test.

**What is wrong.** `courseInputOfLayout` rebuilds the structure's items from `layout.controls` and copies only the stored `leg` (via `legPropsByIndex`); `numberHidden` is never set. `PrintMapRow.course.courseControls` (sheet-rows.ts:54) and `layoutControlsFromCourseControls` do not carry `course_controls.number_hidden` either, although `mapRowInclude` loads the column. The course layer honours `item.numberHidden` (course/derive.ts:277) and the editor offers 'Hide the number on this course' (docs/course-editor.md §6.6). Only the all-variations branch copies the flag (line 169) — where the spec says it is ignored.

**Scenario.** On a butterfly or a tight sprint the setter hides the number of a control visit in Course mode because it collides with another number. The canvas shows it hidden; maps.pdf prints the number again, overlapping the other one on every runner's map.

**Proposed fix.** Carry the flag: add `numberHidden?: boolean` to the `courseControls` entry type and to LayoutControlSource (set in `layoutControlsFromCourseControls`), expose it on the layout control, and in `courseInputOfLayout` set `item.numberHidden = true` when the layout control has it (or read it from the aligned stored item alongside `leg`). Add a sheet-rows unit test and state it in docs/course-print.md §5.2.

**Verifier's note on the fix.** Take numberHidden from the stored structure's items using the same first-shared-site alignment as legPropsByIndex, but without its `j > 0 && i > 0` guard, which is leg-specific. Fixing courseInputOfLayout also covers variant pages, since the child structure keeps the flag. A course with a NULL structure has the flag only in course_controls.number_hidden, so either carry that column through PrintMapRow.courseControls / layoutControlsFromCourseControls or accept structure-only. Leave All variations as is (the spec says ignored; line 169 is harmless because derive ignores it for multiple structures or explicit labels). The description block must still list the control. Add a resolve-sheet test and state the behaviour in course-print.md §5.2.

<details><summary>Verifier's evidence</summary>

1. resolve-sheet.ts:114-121: on a course sheet each item is built as `{ siteId: c.id, role }` plus `item.leg = legs.get(i)`. Nothing else is copied from the stored structure. legPropsByIndex (63-76) returns only `item.leg`.
2. A repo-wide grep finds `numberHidden` in the print path only at resolve-sheet.ts:169, which is the all-variations branch. No occurrence in sheet-rows.ts, resolve-layout.ts, pdf-page.ts or packages/shared/src/print.
3. The column cannot arrive another way: `PrintMapRow.course.courseControls` is typed `{ control, labelDx?, labelDy? }` (sheet-rows.ts:54) and `layoutControlsFromCourseControls` (resolve-layout.ts:145-158) maps only the label offset, although mapRowInclude (routes.ts:45-48) loads full course_controls rows.
4. The layer would honour the flag if it were passed: derive.ts:277 skips the number when `e.item.numberHidden`, and 281-286 hides code labels for a single structure. The editor canvas passes it (course-layer-request.ts:249 from `hiddenNumbers`), so screen and paper disagree.
5. Variant pages go through the same courseInputOfLayout with the child's structure (sheet-rows.ts:106), so they drop it too, even though materialiseVariants keeps the flag (variants.ts:97).
6. Not documented as pending: course-print.md §5.2 says a course sheet item carries "`role` = its type, each item's whole stored leg" and is silent on numberHidden; its Pending section (line 1964 on) does not mention it. course-layer.md Pending says the layer reads numberHidden since D1. The only documented "ignored" case is All variations (course-print.md:414, course-layer.md §12.7).
7. No test covers it: resolve-sheet tests have no numberHidden case, and the E2E (course-editor-tools.spec.ts:279) only asserts the checkbox and canvas.

Severity: medium, not high. The printed map shows a number the setter chose to hide, which is a legibility defect on a rarely used per-control option. Numbering, descriptions, punching and results are unaffected, and moving the label offset is a workaround. The claim's "overlapping on every runner's map" applies only to courses where the option was used.

</details>

### CRS-038 maps.pdf keeps composing after the client disconnects; repeated clicks queue full jobs behind the single worker

- **Area:** Course map printing and PDF · **Category:** performance · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/course-maps/routes.ts:442`; also packages/api/src/course-maps/print-worker.ts:72 (no cancel path), packages/api/src/course-maps/pdf-page.ts:86 (yield hook)
- **Status:** confirmed. Code read only (no reproduction; node_modules absent). Server: packages/api/src/course-maps/routes.ts:427-469, print-worker-host.ts:25-28,58-61,86-131,139-154, print-worker.ts:5-15,69-124, map-render-limits.ts:29-63, pdf-page.ts:86-96. Client: packages/web/src/pages/editor/ExportMenu.tsx:93-112,126, hooks/useCourseMapsOverview.tsx:81-94,135-139, pages/CoursesPage.tsx:510-704, print/client.ts:264-284,313-346, print/capability.ts:37-45, lib/download-api.ts:8-21. Docs: docs/course-print.md §8.2 (lines 920-941) and "Pending in this chapter" (1964 onward).

**What is wrong.** The route awaits `printGate(() => renderGate().run(() => renderVectorPages(...)))` with no link to the request's lifetime. The gate queue is unbounded by design and PRINT_WORKERS defaults to 1, and the job also holds one of the two render-gate permits for its whole duration. There is no cancel message in the worker protocol, and no de-duplication of identical in-flight queries.

**Scenario.** On a slow arena laptop the organiser clicks 'All courses' (150 pages, several minutes), sees no download, clicks twice more, then cancels and picks one course. The server composes the three abandoned 150-page jobs one after another; the single-course export, thumbnails, print.png for device prints and SVG uploads (all behind printGate) wait many minutes.

**Proposed fix.** Listen for `req.raw.on('close')` (when `!reply.sent`): if the job is still waiting in the gate, skip it (check an `aborted` flag at the start of the gated task); if it is running, add an `abort` message to the worker (checked in `yieldToHost` between pages, throwing a typed error) or terminate and replace the worker using the corrected detach logic. Optionally coalesce identical in-flight (nameId, query) jobs onto one promise.

**Verifier's note on the fix.** - **Queued jobs:** the cheapest effective fix is to check `req.raw.destroyed` (or a close listener) after acquiring `printGate` and before posting to the worker, so abandoned queued jobs are skipped. This needs no protocol change.
- **In-flight job:** cancelling it needs either a cancel message checked at the per-page yield in the shared `renderCoursePages` (course-pages.ts:160, `yieldToHost`), or `worker.terminate()`. Terminating drops the worker's prepared-document cache (`slot.keys`), so the next print re-sends and re-decodes the document.
- **Shared worker queue:** raster and trim requests share the worker's promise queue, so a cancel must not drop them.
- **Docs:** §8.2 of docs/course-print.md must be updated first, since the spec is normative and currently silent on disconnects.
- **Client:** it already serialises and disables per tab, so client de-duplication adds little.

<details><summary>Verifier's evidence</summary>

The server-side mechanism is real; the claimed click scenario is overstated because the stock UI blocks repeat clicks.

**What holds (server):**
- routes.ts:442 awaits `printGate(() => renderGate().run(() => renderVectorPages(...)))` with no `req.raw` close/aborted listener and no AbortSignal. A grep for `aborted`, `'close'` and `signal` across course-maps/ finds nothing.
- `Semaphore.acquire` (map-render-limits.ts:47-53) pushes onto an unbounded `waiting` array, and a waiter cannot be removed.
- `PRINT_WORKERS` defaults to 1 (print-worker-host.ts:28).
- The worker protocol has only `print`, `raster` and `trim` messages (print-worker.ts:5-15,120-124), chained on one promise queue. There is no cancel message.
- The only way a job stops is the 10-minute timeout, which terminates the worker (print-worker-host.ts:25,104-108).
- There is no de-duplication of in-flight queries on the server.
- `print.png` rasters (routes.ts:556,601,604) and SVG upload rasterise/trim (graphics.ts:219) take the same `printGate`, so they wait behind an abandoned print.
- Nothing in the "Pending" section of course-print.md covers cancellation. §8.2 documents the uncapped queue as deliberate, but says nothing about disconnects.

**What does not hold (the scenario):**
- Export ▾ sets `busy` and disables the button for the whole download (ExportMenu.tsx:93,126).
- The Courses page does the same through `guarded` and `overview.busy` (useCourseMapsOverview.tsx:81-94; CoursesPage.tsx:510,563,576,623,677).
- All exports go through a per-tab queue, one at a time (client.ts:313-346), and use `fetch` with no cancel UI.
- So "clicks twice more, then cancels and picks one course" cannot happen in one tab. Stacking abandoned jobs needs a page reload or close followed by a retry, several tabs, several users, or direct URL hits.

**Reach and bounds:**
- The server path is reached for big jobs: the device composes only up to 8/24/64 A4-equivalents (capability.ts:37-45), so a 150-page export does go to `maps.pdf` (client.ts:284).
- Each abandoned job is bounded at 10 minutes.
- Composing runs in a worker thread, so the event loop (card readout) is not blocked. Only other prints, logo rasters and SVG uploads are delayed.

The "holds one of the two render-gate permits" point is immaterial: since E4a nothing else takes the render gate (course-print.md:937-940).

</details>

### CRS-039 Receipt position ignores no-timing deductions, can exclude the runner from the total, and is given in no-timing classes

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/routers/race.ts:218-252`; also packages/web/src/context/DeviceManager.tsx:498; packages/web/src/pages/KioskPage.tsx:788
- **Status:** confirmed. Code read only, no reproduction run (node_modules absent). Read packages/api/src/routers/race.ts:211-256 (position calc), packages/api/src/routers/cardReadout.ts:252-254 and 805-855 (performReadout timing, applyResult), packages/api/src/routers/lists.ts:147-200 (result list ranking), packages/web/src/context/DeviceManager.tsx:496-520, packages/web/src/pages/KioskPage.tsx:725-803 and 349-354, packages/web/src/pages/CompetitionShell.tsx:271-280, packages/web/src/lib/receipt-printer/escpos.ts:421-423. Grepped docs/map-*.md and docs/course-*.md for a Pending entry about receipt position: none.

**What is wrong.** `myRunningTime` is raw `finishTime - startTime` and the SQL compares raw `finish_time - start_time`, while `r.timing.runningTime` and the result list subtract `runningTimeAdjustment`. `total` (line 251) counts only rows already persisted with status ok, but the kiosk message is broadcast before `applyResult` is awaited (DeviceManager.tsx:498-505) and the kiosk prints as soon as the card-derived finish time is present (KioskPage.tsx:796-802), so the runner may not be counted yet. `class.noTiming` is not checked. The absolute subtraction also goes negative across midnight, giving no position.

**Scenario.** (a) Course with a NoTiming road-crossing leg: A is 40:00 raw with 3:00 deducted, B is 38:00 raw with 0:30 deducted. The result list has A first; B's receipt says 1/2. (b) applyResult is slow or queued offline: the fifth OK finisher's receipt prints 'Position: 5/4', and the first finisher of a class gets no position (total 0 -> null).

**Proposed fix.** Compute position with the shared helper used by the result list (per-class adjusted times), or at minimum: use relative DB times, set `total = max(total, rank)` or add the runner when not yet persisted, and return null when the class is noTiming. Have the kiosk print after applyResult resolves (or have the admin tab print from its own flow after applyResult).

**Verifier's note on the fix.** The adjustment is not stored on the runner row, so the SQL count cannot simply be changed. Either rank through the same adjusted computation as lists.ts resultList (matchPunchesToCourse per class peer), ideally sharing one helper so the two cannot diverge, or persist the adjusted running time. Use r.timing.runningTime (adjusted) for the runner. To make rank/total self-consistent before applyResult commits, exclude the runner's own row from the peer counts and add 1 to total. Skip position when class.noTiming is true (the select at race.ts:152 must fetch it). Kiosk on-screen position (KioskPage.tsx:957) and the offline path (packages/web/src/lib/offline/local-readout.ts) should be kept consistent with the server.

<details><summary>Verifier's evidence</summary>

Part (a) is proven from the code.
- cardReadout.ts:252-254: `rawRunningTime = finishTime - startTime`; `runningTime = max(0, rawRunningTime - runningTimeAdjustment)`.
- lists.ts:160-180: the result list recomputes `runningTimeAdjustment` per runner and sorts/places on `raw - adj`.
- race.ts:218-220: `myRunningTime` is raw finish minus start. race.ts:244: the SQL counts peers with `(finish_time - start_time) < myRunningTime`, also raw. applyResult (cardReadout.ts:833-841) persists only raw start/finish, so no adjusted value exists in the row.
- Claimed scenario checks out: A raw 40:00 adj 3:00 = 37:00, B raw 38:00 adj 0:30 = 37:30. Result list puts A first. B's receipt counts peers with raw < 38:00 = 0, so rank 1, printed as "Position: 1/2" (escpos.ts:421-423). A's receipt says 2/2. The receipt contradicts the result list whenever NoTiming/BadNoTiming deductions differ between runners enough to reorder them.

Part (b) is structurally real but I could not prove it happens in practice.
- The gate at race.ts:213-216 uses the matcher's card-derived status, while `total` (race.ts:251, baseWhere status ok) counts persisted rows only. Kiosk recordFinish (KioskPage.tsx:744) writes finish time without status (race.ts:346-347). So before applyResult commits, the runner is not in `total`: rank N with total N-1, or total 0 -> null for a first finisher.
- DeviceManager.tsx:498-505 does broadcast before awaiting applyResult. But the print path needs several sequential round trips first: kiosk findByCard, then kiosk finishReceipt, then a broadcast to the admin tab, then a fresh finishReceipt fetch there (CompetitionShell.tsx:280). applyResult is a single mutation started immediately, so it normally wins. The window is real when applyResult is slow or fails (catch at DeviceManager.tsx:519 queues it offline while the server stays reachable).
- The "queued offline" variant is weaker than claimed: when navigator.onLine is false the server receipt fetch fails too.

noTiming class: race.ts finishReceipt selects only `id, classId` (line 152) and never checks `class.noTiming`, so a position is computed and printed for no-timing classes. True as stated; lists.ts resultList does not check it either.

Midnight: overstated. A negative raw time already zeroes `r.timing.runningTime` (cardReadout.ts:252-254), so the gate at race.ts:215 fails. That is a general cross-midnight timing limitation, not specific to receipt position.

Severity: medium, not high. Official results (lists.ts) are correct. The wrong value is the informational position on the finish receipt and kiosk screen, and only on courses with NoTiming/BadNoTiming legs where deductions reorder runners, or in a narrow timing race.

</details>

### CRS-040 Result list running time is zero for runs that cross midnight

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/routers/lists.ts:174`; also packages/api/src/routers/race.ts:117 (recentActivity uses the same pattern)
- **Status:** confirmed. Code read of packages/api/src/routers/lists.ts:170-227, packages/api/src/routers/race.ts:115-121, packages/api/src/timeConvert.ts:15-26, and the toRelative writers (cardReadout.ts:837-839, 912-913; runner.ts:121-133). Arithmetic traced by hand for the claimed scenario; no script run and no test suite available.

**What is wrong.** Start and finish are first converted with `toAbsolute` (which wraps modulo 24 h, timeConvert.ts:24) and then subtracted with `Math.max(0, finishAbs - startAbs)`. For a run that crosses midnight the difference is negative and clamps to 0. The stored ZeroTime-relative values subtract correctly, and the receipt's SQL rank already uses them.

**Scenario.** Night event, zero time 22:00. Runner starts 23:30 and finishes 00:20 with status OK. `runningTime` is 0, so the runner sorts to the top of the class (line 185 sorts OK runners by time), is pushed through the else branch with place 0 and time '-', and does not set the class winner time.

**Proposed fix.** Compute `raw = r.finishTime - r.startTime` on the relative values when both are non-zero (add 864000 if negative) and keep the absolute values only for display. Add a unit test with a midnight-crossing runner.

**Verifier's note on the fix.** Subtracting the stored relative values is not enough: Oxygen-written rows store a post-midnight finish as a negative relative value because `toRelative` does not wrap. Use a wrap-aware difference instead, e.g. `(finishAbs - startAbs + 864000) % 864000` when both are > 0. That would turn a genuinely earlier finish (bad data) into a ~24 h time instead of 0, so decide how to treat that case. Apply the same change at lists.ts:174-175 and race.ts:117-120, and check other `finishAbs - startAbs` sites (receipt, split times, the `matchPunchesToCourse` punch times at lists.ts:156-160), which have the same wrap exposure.

<details><summary>Verifier's evidence</summary>

The defect is real: no guard handles a finish that wraps past midnight.

- **Wrap:** `toAbsolute` (timeConvert.ts:24-26) returns `((rel + zeroTime) % 864000 + 864000) % 864000`, so any time past 24:00 lands back in 0..863999.
- **Clamp:** lists.ts:172-177 computes `startAbs`/`finishAbs` with `toAbsolute`, then `raw = startAbs > 0 && finishAbs > 0 ? Math.max(0, finishAbs - startAbs) : 0`.
- **Scenario traced:** zero time 22:00 = 792000 ds. Start 23:30 gives `startAbs` 846000. Finish 00:20 gives `finishAbs` 12000. The difference is -834000, clamped to 0.
- **Effect in the list:** line 185 sorts OK runners by `runningTime`, so the 0 sorts first. Line 194 requires `e.runningTime > 0` for a place, so the runner falls to the else branch (`runningTime: 0` at line 227) with no place and no winner time set, despite status OK.
- **Second site:** race.ts:115-121 (`recentActivity`) uses the identical expression and reports `runningTime` 0.

Nothing upstream prevents the case. timeConvert.ts documents midnight-crossing events as supported ("Handles wraparound for events crossing midnight") and `__tests__/timeConvert.test.ts:51-77` tests it. No docs/map-*.md or docs/course-*.md "Pending" section covers this; it is not map/course work.

One part of the claim is overstated. "The stored ZeroTime-relative values subtract correctly" holds only for rows written by MeOS. Oxygen's own writers use `toRelative` (`abs - zeroTime`, no wrap), so a 00:20 finish is stored as 12000 - 792000 = -780000 while the 23:30 start is +54000. Subtracting those also gives a negative number.

Severity is medium, not high: it gives a wrong result (an OK runner with no time or place), but only when an individual run straddles local midnight, which is unusual. No data is corrupted; stored times are untouched and the error is visible on the list.

</details>

### CRS-041 Start list 'has started' uses the server's local clock, which is UTC in the Docker image

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/routers/lists.ts:50`; also packages/api/src/routers/race.ts:87 (serverTime has the same assumption)
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the logic is a direct Date.getHours() call). Read packages/api/src/routers/lists.ts:50-72, packages/api/src/routers/race.ts:87-93, Dockerfile (ENV lines), all docker-compose*.yml, and the consumers in packages/web. Grepped the whole repo (excluding binaries) for TZ / tzdata / timeZone / localtime in Dockerfile, docker/, compose files, scripts, docs and AGENTS.md.

**What is wrong.** `meosNow` is built from `new Date().getHours()` on the API host and compared with event-local start times. The Dockerfile (node:24-slim) and docker-compose.host-db.yml set no TZ, so in the documented Docker deployment the clock is UTC. `hasStarted` feeds the start list's in-forest / not-started filter (start-list-anchors.ts:160).

**Scenario.** Swedish summer event run from the Docker stack. A runner with start 10:00 who has not been read out or radio-punched is reported 'not started' until 12:00 local, so the in-forest filter used to see who is still out misses them for two hours. Not verified: whether the host deployment passes TZ some other way.

**Proposed fix.** Derive 'now' in the event's time zone (store an IANA zone on the event, or accept the client's current deciseconds as query input as the finish station already does), or set TZ in the image and document it. Cover with a test that injects the clock.

**Verifier's note on the fix.** Fixing only lists.ts leaves the same server-local-clock computation in event.ts:401, runner.ts:355, timeConvert.ts:45 (nowMeosTime) and race.ts:87 (serverTime.deciseconds, used by the start kiosk countdown and the start/finish station clocks). A fix should go through one shared helper that derives time-of-day in the event's timezone (the event has no timezone field that I saw, so either add one or set TZ in the Dockerfile/compose files and document it). Setting TZ in compose alone would not cover the `cloud` Dockerfile target or the venue/release compose files unless each is updated. Severity is medium rather than high because no stored data or results are wrong and punches/readouts still mark runners as in forest; the error is a 1-2 hour lag in a derived status filter and count, plus a wrong kiosk clock, in Docker deployments outside UTC.

<details><summary>Verifier's evidence</summary>

1. lists.ts:50-52 builds `meosNow` from `now.getHours()/getMinutes()/getSeconds()` on the API process; lists.ts:69-72 sets `hasStarted` when `meosNow >= toAbsolute(r.startTime, zeroTime)`. Start times are event-local deciseconds since midnight, so the comparison is only right when the process timezone equals the event's.
2. No timezone is configured anywhere for the container: the Dockerfile is `FROM node:24-slim` with ENV lines only for OXYGEN_BUILD_ID, OXYGEN_DEPLOY_REF, OXYGEN_VERSION, NODE_ENV, PORT, HOST, WEB_DIST_DIR; docker-compose.host-db.yml's api environment has DATABASE_URL, PORT, HOST, NODE_OPTIONS, AUTH_*, OXYGEN_ADMIN_EMAILS, LEADER_LEASE_SCOPE and no TZ, and mounts no /etc/localtime. A grep for TZ/tzdata/localtime across Dockerfile, docker/, all compose files (including venue and release), scripts, docs and AGENTS.md found nothing. node:24-slim (Debian) defaults to UTC, so getHours() returns UTC hours in every Docker deployment in the repo. I did not run a container to observe this; it rests on the image default.
3. Consumer: packages/web/src/lib/structured-search/anchors/start-list-anchors.ts:160-161 — `in-forest` = `hasStarted || hasPunches`, `not-started` = `!hasStarted && !hasPunches`. So in CEST a runner with a 10:00 start and no punches stays 'not started' until 12:00 local (1 hour off in winter).
4. The same pattern is wider than the claim states: event.ts:401/437 (dashboard in-forest status count), runner.ts:355/368 (runner list status filter), timeConvert.ts:45 `nowMeosTime` (documented as feeding EntryTime), and race.ts:87-93 `serverTime.deciseconds`, whose own doc comment says 'in the event's local timezone'. serverTime.deciseconds is displayed as the clock on StartStation.tsx:53 and FinishStation.tsx:257 and drives the start kiosk countdown `runner.startTime - currentTime` (StartStation.tsx:140), which would be off by the UTC offset.
5. Limits on the damage: recorded finish times are not affected — FinishStation.tsx:221-226 takes the time from the browser clock, not the server. The start-list filter still catches anyone with a radio punch or readout via `hasPunches`. Nothing is stored wrongly by the lists.ts path; it is a derived, read-time flag.
6. Not a Pending item: this is not map/course spec territory, and no doc mentions a timezone requirement for deployment.
Not checked: whether a real production host injects TZ outside the repo (e.g. an operator's .env or a cloud run setting); nothing in the repo does.

</details>

### CRS-042 Results page in-forest / not-started filters never match: resultList does not return hasPunches or hasStarted

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/routers/lists.ts:232 (both result.push literals, ~:232-262); consumer at packages/web/src/lib/structured-search/anchors/result-anchors.ts:86-91`; also packages/web/src/lib/structured-search/anchors/result-anchors.ts:86
- **Status:** confirmed. Code read only (no reproduction run; the logic is a plain field omission). Read packages/api/src/routers/lists.ts:77-275 (resultList), packages/web/src/lib/structured-search/anchors/result-anchors.ts:81-107 and :172-195, packages/web/src/pages/ResultsPage.tsx:28-39, packages/shared/src/types.ts:98-104 and :602-622, and grepped the whole packages tree for hasPunches/hasStarted.

**What is wrong.** `ResultEntry` declares `hasPunches` and `hasStarted` (shared/types.ts:621-622) and `matchStatus` in result-anchors.ts:86-91 depends on them, but `resultList` sets neither field (only `startList` does).

**Scenario.** On the Results page the operator filters status 'in-forest' at the end of the event to find runners still out. The list is empty, and every unfinished runner, including those with radio punches, shows under 'not-started'.

**Proposed fix.** Compute both flags in `resultList` the same way `startList` does (extract a shared helper), or remove the two filter values from the result anchors.

**Verifier's note on the fix.** Set hasPunches and hasStarted in both result.push branches of resultList, using the same definitions as startList (lists.ts:43-51 and :68-72): a punch.groupBy on cardNo for the event with removed:false, and the startTime vs meosNow check. Keep the definitions consistent with runner.ts:367-382 and event.ts:436-445, ideally via one shared helper, since there are now three or four copies. Add an API-level test for resultList, because the existing anchor tests use hand-built fixtures and would not have caught this.

<details><summary>Verifier's evidence</summary>

1. resultList never sets the fields. Both result.push object literals in lists.ts (ranked branch ~:232-246, unranked branch ~:248-262) contain only id, place, name, clubId, clubName, className, classId, startTime, finishTime, runningTime, timeBehind, status, startNo. A grep for hasPunches/hasStarted in packages/api finds them in lists.ts only at :68-69, which is startList. resultList does not query the punch table at all.

2. The filter depends on them. result-anchors.ts:86-91: 'not-started' returns `!finished && !entry.hasPunches && !entry.hasStarted`; 'in-forest'/'started' returns `!finished && (!!entry.hasPunches || !!entry.hasStarted)`. With both undefined, in-forest is always false and not-started is true for every unfinished row.

3. The path is live and unguarded. ResultsPage.tsx:28-39 builds the anchors with createResultAnchors, fetches trpc.lists.resultList.useQuery() and filters client-side with filterItems(entries); nothing in between adds the fields. The status anchor's suggestions offer both 'Not started' and 'In forest' (result-anchors.ts ~:193-194), so the operator is invited to use them.

4. Unfinished runners are in the list. resultList's where clause is only eventId + removed:false (lists.ts:80-83), so status-Unknown runners are returned and are the rows these filters are meant to split.

5. Tests do not cover it. new-anchors.test.ts:453-503 hand-builds ResultEntry fixtures with hasPunches/hasStarted set, so the anchor passes its tests while the API never supplies the fields.

6. Not a documented pending item. docs/bugfixes/cancellation-handling.md:41,115,126 describes these filters as working features; the only map-*/course-* 'Pending' relevance is none.

Severity reasoning: the claimed scenario holds as stated (in-forest is empty; all unfinished runners, including those with radio punches or past their start time, show under not-started). I rate it medium rather than high: no stored data or published results are wrong, only one client-side filter view on the Results page. The same in-forest/not-started split works on the start list (start-list-anchors.ts:160-161 with lists.ts:68-69), in the server-side runner list filter (runner.ts:367-382) and in the dashboard counts (event.ts:436-445), so the operator has working alternatives. The risk is an operator trusting an empty 'in forest' result at event close as meaning nobody is still out, which is a safety-relevant check, but it is one filter among several ways to get that answer.

</details>

### CRS-043 resultList picks the card for time adjustment differently from performReadout

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/routers/lists.ts:108-120 (card pick) and 152-167 (matching without free punches)`
- **Status:** confirmed. Code read of packages/api/src/routers/lists.ts:104-168, packages/api/src/routers/cardReadout.ts:176-248 and 556-592, packages/shared/src/readout.ts:271-286, the Card model in schema.prisma (lines ~936-951) and docs/course-controls-and-matching.md:303. Also ran a standalone node copy of computeRunningTimeAdjustment for the manual-punch case.

**What is wrong.** Cards are fetched by `cardNo in (...)` with no ordering and reduced to a `Map<cardNo, punchesRaw>` (last row wins). `performReadout` (cardReadout.ts:177-193) prefers the runner's linked `cardId`, otherwise the most recently updated card, and merges free punches (radio, manual). The list ignores all three, so its `runningTimeAdjustment` can differ from the one on the receipt and kiosk.

**Scenario.** A rental card is read twice (or reused), leaving two card rows with the same number on a course with a NoTiming leg. The list deducts the leg computed from an arbitrary row; the kiosk and receipt show 41:30, the result list 43:10, and the placing changes with it. Same effect if one of the no-timing controls was supplied as a manual punch.

**Proposed fix.** Extract the card and punch selection from `performReadout` into a shared bulk helper (cardId first, else latest by updatedAt, plus free punches) and use it in both places.

**Verifier's note on the fix.** The fix should share one card-and-punch resolution with performReadout: prefer `runner.cardId`, else the newest non-removed card by `updatedAt`, and merge `punch` rows for the runner's `cardNo` (sorted by time) before matching. Fetch free punches in bulk for the list rather than per runner. `runner.list` and the Eventor export (routers/eventor.ts:~1634) compute the same adjustment and should be checked for the same card-only pattern. A unique constraint on (eventId, cardNo) is not safe to add without checking migrated MeOS data and removed rows.

<details><summary>Verifier's evidence</summary>

The divergence is real, but the claim's headline scenario (card read twice) does not produce it.

**What holds**
- lists.ts:108-120 fetches cards by `cardNo in (...)` with no `orderBy`, selects only `cardNo, punchesRaw`, and builds `new Map(cards.map(c => [c.cardNo, c.punchesRaw]))`, so the last row returned wins.
- lists.ts:152-167 runs `matchPunchesToCourse` on the card punches only. It never reads `runner.cardId` and never queries `db.punch`.
- performReadout (cardReadout.ts:177-193) uses `runner.cardId` first, else `findFirst … orderBy updatedAt desc`, then merges free punches (cardReadout.ts:186-193, 212-222) before matching.
- computeRunningTimeAdjustment (readout.ts:271-286) only deducts a noTiming leg when that position's match is `ok`. If the no-timing control exists only as a manual or radio punch, the readout deducts the leg and the list deducts nothing.
- Standalone run of that function: with the free punch the adjustment is 1000 ds; card-only it is 0. The receipt and kiosk would show a time 1:40 shorter than the result list, and since the list sorts on its own `runningTime` (lists.ts:181-187), placing can change.
- `addPunch` (cardReadout.ts:1295-1325) writes such manual punches to the `punch` table, so the state is reachable through the normal UI.
- The stored status comes from the readout (free punches included), so the runner is OK in the list while the time is unadjusted.
- Not listed as pending: docs/course-controls-and-matching.md:303 states `resultList` computes the adjustment as implemented.

**What is overstated**
- "A rental card is read twice, leaving two card rows" does not happen through the readout path. storeReadout (cardReadout.ts:556-581) does `findFirst` by `eventId + cardNo + removed:false` and updates the existing row.
- The schema has only `@@index([eventId, cardNo])`, no unique constraint, so duplicates are possible, but only from other writers: `scripts/migrate-mysql-to-pg.ts:611` (MeOS import), `testLab.ts:159`, or two concurrent first reads of the same card.
- A third divergence the claim does not name: a runner whose `cardId` points at a card with a different number than the current `runner.cardNo` gets different cards in the two paths.

**Severity**
Medium. It needs a course with a NoTiming leg (or BadNoTiming) and either a no-timing control supplied only as a free punch, or duplicate card rows from migration or a race. When it occurs the result list shows a wrong time and possibly a wrong placing, but nothing is corrupted.

</details>

### CRS-044 ESC/POS encoder maps CP850-only characters but never selects CP850

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/web/src/lib/receipt-printer/escpos.ts:74 (map entries 74-101; init at :128)`; also packages/web/src/lib/__tests__/escpos.test.ts:55
- **Status:** confirmed. Code read of /home/user/oxygen/packages/web/src/lib/receipt-printer/escpos.ts (lines 9-13, 65-115, 127-128, 154-164, 310-315, 483-486), /home/user/oxygen/packages/web/src/lib/__tests__/escpos.test.ts:55-61, /home/user/oxygen/packages/web/src/context/PrinterContext.tsx:187-188 and 208-209, and drivers/webusb.ts:84-142. Grepped the receipt-printer directory and docs for any ESC t / code page selection (none). Decoded the emitted bytes with Python's cp437 and cp850 codecs as a standalone reproduction. Not verified on hardware.

**What is wrong.** The header comment and `init()` rely on PC437 being the default after ESC @, yet `UNICODE_TO_ESCPOS` (lines 74-105) uses CP850 positions for Ø (0x9D), ø (0x9B), À Á Â (0xB7, 0xB5, 0xB6), Ë, Í, Ó, Ô, Ú. In PC437 those bytes are ¥, ¢, box-drawing and Greek glyphs. No `ESC t` is sent, and escpos.test.ts:55 asserts that it is not. For generic class-7 printers accepted by the `classCode: 7` filter the power-on code page is not guaranteed at all, which puts å ä ö at risk too.

**Scenario.** A Norwegian runner 'Bjørn Ødegård' on a printer in PC437: the receipt and the class results print 'Bj¢rn ¥degård'. Not verified on hardware; this follows from the code-page tables.

**Proposed fix.** Send `ESC t 2` (0x1B 0x74 0x02, CP850) right after `init()` in both builders; the whole table, including the box-drawing bytes, is valid in CP850. Replace the test at escpos.test.ts:55 with one asserting the selection and the Ø/ø bytes. Also normalise input with `s.normalize('NFC')` in `text()` so decomposed accents do not print as 'e?'.

**Verifier's note on the fix.** Send ESC t 2 (0x1b 0x74 0x02, CP850 on Epson-compatible and Citizen printers) straight after ESC @ in init(). Both buildFinishReceipt and buildRegistrationReceipt call init(), so one change covers both. Box-drawing bytes are the same in CP850, so the layout is safe. The test at escpos.test.ts:55-61 must be inverted, and the comments at escpos.ts:13 and :127 corrected. Tests that assert bytes[0..1] are ESC @ still hold. The ESC t table number for CP850 is vendor-specific on some generic printers, so confirm on the Citizen CT-S310II. Do not touch the star-raster path (its init() is a no-op).

<details><summary>Verifier's evidence</summary>

The map sends Ø=0x9D, ø=0x9B, À/Á/Â=0xB7/0xB5/0xB6, Ë=0xD3, Í=0xD6, Ó=0xE0, Ô=0xE2, Ú=0xE9 (escpos.ts:74-101). These are CP850 positions. The file's own comment at line 73 says "present in CP850 but not always in PC437".

init() sends only ESC @ (line 128), and the header (line 13) and the init comment state that PC437 is the assumed code page. No 0x1b 0x74 exists anywhere in the receipt-printer directory, and escpos.test.ts:55-61 asserts its absence.

Decoding the bytes produced for "Bjørn Ødegård" plus the other characters as cp437 gives "Bj¢rn ¥degård" followed by "╖╡╢╙╓αΓΘ". Decoded as cp850 they are correct. The box-drawing bytes the receipt uses (0xC4, 0xB3, 0xDA, 0xBF, 0xC0, 0xD9, 0xC3, 0xB4) are identical in CP850, so selecting CP850 would not break the layout.

The path is live: PrinterContext.tsx:187-188 and 208-209 use buildFinishReceipt / buildRegistrationReceipt for every printer whose protocol is "escpos", which is the Citizen and any unknown class-7 device (webusb.ts:101, 139-142). Star TSP100 printers go through the raster encoder and are unaffected. No docs mention code page setup, and nothing under a "Pending" section covers this.

Limits on the claim:
- Swedish å ä ö Å Ä Ö, and also æ é ü ñ and similar, share positions in both code pages and print correctly under PC437. Only Ø, ø and the accented capitals at 0xB5-0xB7, 0xD3, 0xD6, 0xE0, 0xE2, 0xE9 are wrong.
- The part about å ä ö being at risk on generic printers with another power-on code page is speculative and was not proven.
- I did not check whether "class results" are printed through this encoder; only the finish and registration receipts were traced.
- The effect is a wrong glyph on a paper receipt. Stored data and results are untouched.

Severity: medium. It is a cosmetic misprint limited to names or clubs with Ø/ø or certain accented capitals (Norwegian and Danish runners), in software aimed at Swedish events.

</details>

### CRS-045 Offline finish receipt ranks against non-OK runners and prints a position whatever the status

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/web/src/lib/offline/local-readout.ts:100-114 (same pattern at 246-260 in computeCardReadout); shared filter at packages/shared/src/results.ts:43-44`; also packages/web/src/pages/FinishStation.tsx:197
- **Status:** confirmed. Code read only, no reproduction run (the logic is a short pure function, traced by hand). Files: /home/user/oxygen/packages/web/src/lib/offline/local-readout.ts:88-116, /home/user/oxygen/packages/shared/src/results.ts:35-72, /home/user/oxygen/packages/web/src/pages/FinishStation.tsx:153-209, /home/user/oxygen/packages/web/src/lib/receipt-printer/escpos.ts:421-426 and star-raster.ts:557-562, and the online counterpart /home/user/oxygen/packages/api/src/routers/race.ts:211-256. Also checked that runner.list is actually cached on station pages (packages/web/src/hooks/useStationSync.ts:59, useProjectionSync.ts:18) and grepped docs for a 'Pending' entry covering offline receipts (none found).

**What is wrong.** `computeLocalReadout` builds `classRunners` from every cached runner of the class with no status filter, and `computePosition` (shared/results.ts:43) only requires start and finish times. `position` is computed even when the runner's own status is not OK, and FinishStation.tsx:197-203 prints it with the top five as `classResults` ranked `i + 1` (which also ignores ties).

**Scenario.** Network is down at the finish station. A mispunched runner with a 30:00 time is in the cached list. An OK runner finishing in 32:00 gets a receipt saying 'Position: 2/2' with the disqualified runner listed first; a runner who is over max time still gets a position line.

**Proposed fix.** Filter `classRunners` to `status === RunnerStatus.OK`, return `position: null` unless the computed status is OK and the class is not noTiming, and derive `classResults` ranks with `computeClassPlacements`. Add unit tests in the existing local-readout tests.

**Verifier's note on the fix.** - **Filter peers by status:** keep only `RunnerStatus.OK` peers when building `classRunners`, in both `computeLocalReadout` and `computeCardReadout` (lines 246-260 have the identical pattern), or add an optional status to `ClassRunnerForPosition` and filter inside `computePosition`.
- **Gate on own status:** return `position = null` and empty `classResults` unless the runner's own computed status is OK, mirroring race.ts:212-216.
- **Do not break the server caller:** `computePosition` is also re-exported through packages/api/src/results.ts and has tests in packages/api/src/__tests__/results.test.ts, so any signature change must stay backward compatible.
- **Ties:** if fixing them, derive each `classResults` rank from strictly-faster counts instead of `i + 1`.
- **Stale statuses:** cached peer statuses can be out of date while offline, so the offline position stays best-effort even after the fix.

<details><summary>Verifier's evidence</summary>

The claim holds as stated.

- **No status filter on peers:** local-readout.ts:100-107 builds `classRunners` from every cached runner of the class, filtering only on `classId` and `id !== runnerId`. `RunnerItem.status` exists but is never mapped into `ClassRunnerForPosition`, which has no status field at all (results.ts:10-21).
- **Ranking ignores status:** `computePosition` (results.ts:43-44) filters only on `finishTime > 0 && startTime > 0`, so mispunched, disqualified or over-max-time runners with times are ranked and counted in `total`.
- **Own status ignored:** `computeLocalReadout` computes `status` at lines 88-97 but calls `computePosition` unconditionally at 109-114. The only guard is `selfRunningTime <= 0`. An over-max-time runner (computeStatus returns OverMaxTime when `runningTime > classMaxTime`, shared/readout.ts:564) still gets a position.
- **Printed unguarded:** FinishStation.tsx:197-203 passes `position` and the top five as `classResults` with `rank: i + 1`. Both printer back ends print the line on `if (data.position)` alone (escpos.ts:421-423, star-raster.ts:557-559).
- **Online path does it correctly:** race.ts:212-216 computes a position only when `r.timing.status === 1`, and counts only peers with `status = 'ok'` (race.ts:224-250). The offline path therefore diverges from the server; it is not intended behaviour.
- **Scenario check:** a cached mispunched runner at 30:00 and an OK runner finishing offline at 32:00 gives `withTimes = [MP 30:00, self 32:00]`, so rank 2, total 2, with the mispunched runner listed first.

The tie point is also true but minor: `rank: i + 1` numbers equal times 1, 2, while `position.rank` shares ranks.

Limits on impact: this needs the station offline, a receipt printer connected, and a non-OK runner with a time in the same class (or the runner themselves over max time). It affects only the printed courtesy receipt. Nothing wrong is persisted: only the `finish.recorded` event is queued, and official results are computed server-side by `computeClassPlacements`, which is status-aware.

</details>

### CRS-046 A print with no timeout leaves `printing` true forever and disables reprint

- **Area:** Start/result lists and receipts · **Category:** stability · **Severity:** medium · **Size:** M
- **Location:** `packages/web/src/lib/receipt-printer/drivers/webusb.ts:304`; also packages/web/src/context/PrinterContext.tsx:178-218; packages/web/src/lib/receipt-printer/drivers/webusb.ts:336,383 (transferIn has the same problem; the 'bounded' loops only count returned chunks)
- **Status:** plausible. Code read only; no reproduction (needs a real USB printer, and node_modules is absent). Read packages/web/src/lib/receipt-printer/drivers/webusb.ts:160-170, 301-308, 323-358, 368-405; packages/web/src/context/PrinterContext.tsx:178-218; packages/web/src/pages/FinishStation.tsx:127, 208, 236-243, 369; packages/web/src/pages/RunnerManagement.tsx:57, 105, 357, 369; packages/web/src/components/RegistrationDialog.tsx:663-682. Grepped the receipt-printer library and docs/ops/receipt-printer-setup.md for any timeout, abort or paper-status handling and found none.

**What is wrong.** `sendBytes` awaits `device.transferOut` with no timeout or abort. PrinterContext sets `printing` true around it (PrinterContext.tsx:182-196), and FinishStation.handleReprint returns early while `printer.printing` (FinishStation.tsx:238), as do the RunnerManagement print buttons. Later jobs queue behind the pending transfer. A failed transfer also leaves the driver status 'connected'.

**Scenario.** Paper runs out mid-event at the finish. The pending transfer never settles, the reprint buttons stay disabled, every later receipt queues silently, and when paper is loaded the whole backlog prints at once. The operator gets no error because `lastError` is only set when the promise rejects. Readouts themselves are not blocked (prints there are not awaited). Not verified on hardware.

**Proposed fix.** Race `transferOut` against a timeout; on timeout reject, set `lastError`, and reset the device (close and reopen, or `device.reset()`) so queued data is dropped. Keep a single in-flight job in PrinterContext and reject or replace new jobs while one is pending.

**Verifier's note on the fix.** - A timeout that only rejects the JS promise does not cancel the USB transfer. The fix must also abort it (close and reopen the device, or reset the endpoint), otherwise the stale job still prints later and later transfers queue behind it.
- `printing` is a single boolean shared by overlapping prints: the first to settle clears it while others are still pending. Use a counter or a serialised queue.
- RegistrationDialog.tsx:668 awaits `printRegistration` inside the submit flow. The registration is already saved by then, but a hung transfer would stall the rest of the dialog (recent list, close). The claim does not mention this caller; cover it in the fix.
- Apply the same timeout to `transferIn` at webusb.ts:336 and :383.
- Surface the timeout through `lastError` so the operator sees it.

<details><summary>Verifier's evidence</summary>

The structural part is proven from the code; the trigger is not.

Proven:
- webusb.ts:304 awaits `device.transferOut` with no timeout, no abort and no race against a timer. WebUSB itself has no transfer timeout.
- PrinterContext.tsx:182-196 and 203-217 set `printing` true and clear it only in `finally`, so it stays true as long as that promise is pending. `lastError` is set only in `catch`, so a pending transfer shows no error.
- FinishStation.tsx:238 returns early while `printer.printing`, and the reprint button at :369 is disabled. RunnerManagement.tsx:357 and :369 are disabled the same way.
- Readouts are not blocked: FinishStation.tsx:127 and :208 fire `printer.print` without awaiting it.
- `readBytes` (:336) and `readMemorySwitch` (:383) only bound the number of returned chunks. A `transferIn` that never returns hangs them, despite the comments saying they are bounded.
- `sendBytes` does not change `_status` when a transfer fails, so the driver stays 'connected'.

Not proven:
- Whether `transferOut` actually stays pending on paper-out. That depends on the printer NAKing the bulk OUT endpoint once its input buffer is full. A text ESC/POS receipt of 1-2 KB may fit in the buffer and resolve 'ok' even with no paper. In that case `printing` clears normally and the receipt prints when paper is loaded. A hang is more likely with the large Star raster jobs or logo rasters. The claim itself says it was not verified on hardware.

Overstated:
- "Forever" is wrong. The pending promise settles when paper is reloaded and the printer drains, or when the printer is unplugged or powered off (the transfer then rejects, `finally` runs, and :164-170 marks it disconnected). A page reload also clears it.
- There is no application-level queue. The "backlog" is only the automatic prints from later readouts, which pend at the USB level.
- The reprint guard only blocks while the transfer is pending. Reprint could not succeed in that state anyway.

Not listed under any Pending section; the map and course specs do not cover receipt printing.

Severity medium: it needs a hardware fault condition, the effect is limited to receipt printing (timing and results are untouched), and it recovers by itself when the printer is serviced. The real defect is that the operator gets no feedback.

</details>

### CRS-047 No test covers lists.resultList or lists.startList output

- **Area:** Start/result lists and receipts · **Category:** tests · **Severity:** medium · **Size:** M
- **Location:** `packages/api/src/routers/lists.ts:77`
- **Status:** confirmed. Code read plus repo-wide grep (excluding node_modules/.git/dist) for resultList / startList / lists. across all .ts/.tsx/.js/.mjs and docs. Read packages/api/src/routers/lists.ts:19-235, the two test hits, e2e/phase2.spec.ts:195-237 and packages/web/src/pages/ResultsPage.tsx. No test run (node_modules absent).

**What is wrong.** A search of packages/api/src/__tests__ finds no test that calls `resultList`; `startList` is touched only for `variantKey` (runner-variants.test.ts). Placing, time behind, tie handling, adjustment, class filter and ZeroTime conversion in the endpoint that produces the official result list are untested, while the unused `computeClassPlacements` has its own tests (results.test.ts).

**Scenario.** The tie, no-timing, midnight and missing-flag defects in this report all ship without any failing test.

**Proposed fix.** Add an integration test alongside kiosk-finish.test.ts that seeds two classes (one noTiming), a tie, an MP runner, a NoTiming-leg course and a non-zero zeroTime, and asserts place, runningTime, timeBehind and flags.

**Verifier's note on the fix.** Add integration tests through `caller.lists.resultList` and `caller.lists.startList`, following the pattern in packages/api/src/__tests__/integration/runner-variants.test.ts. Cover ties, non-OK status, OK with zero time, running-time adjustment, the classId filter (including an unknown class returning []), and ZeroTime conversion. Consider having resultList reuse `computeClassPlacements` from packages/shared/src/results.ts rather than testing a second placing implementation. Correct the wording: the function is used by eventor.ts:1656, and e2e/phase2.spec.ts already gives smoke-level coverage.

<details><summary>Verifier's evidence</summary>

The claim holds for value-level coverage, but two details are overstated.

**What holds**
- No file under packages/api/src/__tests__ calls `lists.resultList`. The only test-side references to the lists router are `caller.lists.startList` at packages/api/src/__tests__/integration/runner-variants.test.ts:361 and :366 and packages/api/src/__tests__/integration/variant-accept.test.ts:204, and all three assert only `variantKey`.
- The placing logic is inline in the procedure (packages/api/src/routers/lists.ts:77 onward: adjustment loop, sort, place and timeBehind per class), not in a helper that is tested elsewhere.
- The inline loop increments `entry.place++` for every OK runner, so two equal running times get places 1 and 2. No assertion anywhere would catch this.

**What is overstated**
- "No test covers" is too strong. e2e/phase2.spec.ts:196-237 loads the Start List and Results pages, which call these endpoints. It asserts class headings, the Place/Time/Behind headers, OK and MP badges, and that at least one cell matches `+m:ss`. That is a smoke test of the output; it asserts no place value, tie, adjustment, class filter or ZeroTime conversion.
- `computeClassPlacements` is not unused. packages/api/src/routers/eventor.ts:1656 calls it for the Eventor upload, and the comment at :1651 says it is shared with web/admin clients. It is only unused by lists.ts, so the result list and the Eventor upload compute placings with two different implementations and only the second is unit-tested.
- The variant-accept.test.ts:204 call was missed by the claim, though it is another `variantKey`-only assertion.

**Severity**
Medium. A test gap is not itself a wrong result; it is a maintenance cost and lets real defects in the result list go unnoticed.

</details>

### CRS-048 A course that starts running a pair while its route is being searched keeps a climb read along the old polyline

- **Area:** Elevation, climb, leg routes, route finder (PR #254) · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/api/src/leg-routes-auto.ts:214`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the race needs a database). Files: /home/user/oxygen/packages/api/src/leg-routes-auto.ts:99-128, 168-231, 236-256; /home/user/oxygen/packages/api/src/course-climb.ts:89-130; /home/user/oxygen/packages/api/src/course-geometry.ts:321-327; /home/user/oxygen/packages/api/src/trpc.ts:169-184; /home/user/oxygen/packages/api/src/routers/legRoute.ts:60; /home/user/oxygen/packages/api/src/leg-routes.ts:37-47. Checked docs/course-elevation.md "Pending in this chapter" and §7.5 for an accepted limitation: none found.

**What is wrong.** refreshAutoRoutes snapshots each pair's courses once in pairsOf (line 99-125) and, when a chosen automatic route's vertices change, clears only `p.courses`. A refresh runs chunk by chunk for minutes after an import or map change. A course that gains the pair meanwhile (new course, a copy, variants materialised by setStructure) has its climb computed at its own edit along whatever is stored then. When the route lands it is not in `p.courses`, so it is not cleared. The rerun (`again`) finds the pair's basis current, because the basis does not include the course set unless a course-scoped obstacle exists, so nothing is searched or cleared. legRoute.save/choose/delete do it correctly with coursesRunningPair inside the transaction.

**Scenario.** Import 30 courses; the refresh starts with a few hundred pairs. While it runs the setter adds a forking to course A (variants A1..A4 are created and run pair 31>32). Their climbs are computed along the straight line across a lake. A minute later the automatic route round the lake is written and chosen; only the courses seen at the start are cleared. A1..A4 keep the line's climb with source 'computed' until someone edits their geometry; the wrong climb is printed and exported for them.

**Proposed fix.** Inside the write transaction replace `p.courses` with `await coursesRunningPair(tx, eventId, p.fromId, p.toId)` (packages/api/src/leg-routes.ts:36), as routers/legRoute.ts:60 does. Add an integration test with an injected `search` that adds a second course running the pair before resolving.

**Verifier's note on the fix.** Replace `p.courses` at line 214 with `await coursesRunningPair(tx, eventId, p.fromId, p.toId)` inside the transaction, as legRoute.ts:60 does.

Things the fix must account for:
- A residual window remains. A course edit that commits after the route transaction's read, but whose climb compute read the routes before the route committed, is still missed. Closing it fully needs either the unscoped compute at line 227 to re-clear, or course rows locked in the transaction.
- coursesRunningPair loads every course sequence of the event on each call. Per changed pair over a few hundred pairs that is heavy; consider one load per chunk, or clearing all courses of the event that run any changed pair of the chunk.
- coursesRunningPair does not skip marked-route legs. Clearing those courses too is harmless, since the recompute keeps the line for them.
- When course-scoped obstacles exist, the snapshot's obstacle set and basis may also be out of date for the new course set. The rerun handles that case because the basis changes.

<details><summary>Verifier's evidence</summary>

The defect is real, but narrower than the claimed scenario.

1. The course set is a snapshot. pairsOf (leg-routes-auto.ts:102-125) reads the courses once and freezes `courses: [...p.courses]` per pair. refreshAutoRoutes calls it once at line 169, then loops over chunks of 20 pairs, each awaiting a worker search (timeout 5 min per chunk, line 33).

2. Only the snapshot is cleared. In the write transaction, line 213-214 runs `clearComputedClimbs(tx, eventId, p.courses)`. Nothing in the transaction re-reads which courses run the pair; it only re-checks that the two controls exist (line 201).

3. A course edited meanwhile gets its climb from what is stored then. The eventProcedure middleware (trpc.ts:174-175) runs refreshMarkedClimbs right after the edit commits. computeMissingClimbs reads `chosenLegRoutes(tx, eventId)` at that moment (course-climb.ts:120), so it uses the straight line, or the old route, while the new route is still being searched.

4. The follow-up compute cannot repair it. Line 227 calls `refreshComputedClimbs(db, eventId)` for the whole event, but computeMissingClimbs only takes courses matching OPEN_CLIMB (climbM = 0 and source not 'computed', course-climb.ts:89, 100, 111-116). The late course already has a non-zero 'computed' climb, so it is skipped.

5. The rerun does not repair it either. The edit sets `again` (line 242), but the rerun's pairsOf yields the same basis for the pair: autoRouteBasis (lines 70-76) hashes document, patch, scale, endpoints, via and obstacles, not the course set. The pair is not stale (line 173), so nothing is searched or cleared.

6. The manual paths do it correctly: legRoute.ts:60 calls coursesRunningPair inside the transaction.

Correction to the claimed scenario: if the fork creates a pair that no course ran before (as "31>32" suggests), the running refresh never had it. The rerun finds no row for it, searches it with a fresh course set that includes A1..A4, and clears them correctly. The bug needs the new course to gain a pair that is already in the running refresh's stale list and not yet written: for example a copied course, a new course sharing legs with imported ones, or variants that keep the parent's common legs.

The same hole exists when a pair has an old chosen automatic route that the refresh is about to replace.

The wrong climb stays as 'computed' until something else clears that course: a geometry edit, a map change, a manual route choice on one of its pairs, or a later refresh that changes one of its routes.

Severity is medium, not high. It needs an edit inside the refresh window on a shared pending pair. The result is a wrong climb figure on some courses, with no data loss and no wrong race results, but it is silent and can reach print and export.

</details>

### CRS-049 Structure edits are built on `course.detail` but sent with a token that `course.list` may already have advanced

- **Area:** Web course editor: pages · **Category:** stability · **Severity:** medium · **Size:** S
- **Location:** `packages/web/src/pages/editor/EditorPage.tsx:446 (currentStructure) with packages/web/src/lib/editor/write-client.ts:187; desync sources at EditorPage.tsx:206, 501, 517, 1898, 1977`; also packages/web/src/lib/editor/write-client.ts:187-196; packages/web/src/pages/editor/EditorPage.tsx:446-451
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent). Traced packages/web/src/pages/editor/EditorPage.tsx:186-208, 252-263, 323-363, 440-473, 495-517; packages/web/src/lib/editor/write-client.ts:167-196; packages/web/src/lib/version-book.ts:27-32; packages/web/src/hooks/useExternalChanges.ts; packages/web/src/main.tsx:18-46; packages/api/src/course-structure.ts:429-437; docs/course-editor.md "Tokens" and "Pending".

**What is wrong.** `applyStructure` builds `next` from `currentStructure()` (the `course.detail` data, lines 446-451), but `writeStructure` → `EditorWrites.setStructure` takes `baseVersion` from the VersionBook, which is also seeded from `course.list` (line 206). The two queries are refetched independently (the 5 s external-changes poll and every `invalidate()`). When the list has answered and the detail has not, or its refetch failed and stale data is kept, the edit is computed from the old structure but carries the new token.

**Scenario.** B changes course Lång (v6). A's poll refetches both queries; `course.list` answers and seeds v6, `course.detail` is still in flight or errored on weak Wi-Fi. A clicks to insert a control: `insertSite` runs on the v5 structure, `setStructure` is sent with baseVersion v6 and accepted. B's change is overwritten without the refresh notice.

**Proposed fix.** Carry the version with the structure: `currentStructure()` returns `{ structure, version }` (detail's version or `localStructure.version`), and `writeStructure(courseId, next, baseVersion)` passes it through `setStructure` via `withToken`'s explicit `baseVersion` parameter. Keep the book only for chaining this client's own back-to-back writes.

**Verifier's note on the fix.** - Send the version of the snapshot the edit was computed from, not the book's newest token. `currentStructure()` should return the structure with its version (`detail.data.version`, or `localStructure.version` when that is newer), and `setStructure` should take it as an explicit `baseVersion`, as `updateControl` already does through `opts.baseVersion`.
- Queued back-to-back writes, undo and redo must still work. They rely on `localStructure` carrying the predecessor's result version (docs/bugfixes/editor-overlapping-course-writes.md), so use that version when the local structure is the base.
- Undo and redo closures replay a captured `prev` / `next` with whatever token is current. Decide deliberately whether they keep the book's token.
- `setInstructions` and `setWinnerPace` have the same shape: the value comes from `course.list`, the token from the book. Check them too.
- Adding `course.detail` to the list-only invalidations narrows the window but does not close the cached-detail-on-course-switch case.
- The fix needs a write-client unit test plus an E2E, per AGENTS.md.

<details><summary>Verifier's evidence</summary>

The defect is real, but the claimed trigger (the 5 s poll) is mostly not how it happens.

**Mechanism, proven from the code**
- The structure an edit starts from is `course.detail` data only: `detailStructure` (EditorPage.tsx:258) is read by `currentStructure()` (446-451), and `applyStructure` (466-476) builds `next` from it.
- The token is taken separately: `EditorWrites.setStructure` sends `this.versions.get("course", id)` (write-client.ts:176, 187-196).
- The VersionBook keeps the highest token from either `course.list` (EditorPage.tsx:206) or `course.detail` (208); `seed` is max-wins (version-book.ts:27-32).
- Nothing ties the token to the snapshot the edit was computed from. No `detail.isFetching` / `isError` / version-equality guard exists anywhere in EditorPage.tsx (grep found none).
- The server only checks equality with the current version (`assertCourseVersion`, course-structure.ts:435-437), so a new token with an old structure is accepted and replaces B's structure whole.
- It is not listed under Pending in docs/course-editor.md. The "Tokens" paragraph (around line 279) documents the three seed sources without addressing the mismatch.

**Where the claim is overstated**
- The poll invalidates the whole `course` router in one tick (useExternalChanges.ts:10-19, 73-80), and the client uses `httpBatchLink` (main.tsx:46). `course.list` and `course.detail` therefore travel in one HTTP request and settle together, and a network failure fails both. The same holds for `invalidate()` (EditorPage.tsx:323-333).
- "List answered, detail still in flight" from the poll therefore needs a per-procedure server error on `detail` only. That is rare.

**Triggers that do exist**
1. List-only invalidations at EditorPage.tsx:501 (an auto route landed, on a separate 8 s poll), 517 (`afterRouteWrite`), 1898, 1977 (`refreshClimbs`) and 2487. Each refetches `course.list` without `course.detail`. If B wrote the course since A's last detail fetch and A's 5 s counter poll has not fired yet, the token moves to v6 while the detail stays v5, for up to about 5 s.
2. Cached detail on course switch. `gcTime` is 24 h, `staleTime` 5 s, and the cache is persisted (main.tsx:18-26). The poll does not refetch an inactive `course.detail`. On reselecting a course A opened earlier, `detail.data` is immediately the cached v5 structure while the refetch is in flight; with `retry: 1`, a failed refetch keeps the stale data. `course.list`, always active, has already seeded v6. An edit in that window is built on v5 and sent with v6.

**Outcome**
B's structure change is overwritten with no CONFLICT and no "refresh" notice. The D11 "changed elsewhere" banner (EditorPage.tsx:238-249) may appear because the list version moved, but it does not block the edit.

</details>

### CRS-050 Undo/redo are not serialised: a held or double Ctrl+Z runs entries concurrently and scrambles the redo order

- **Area:** Web course editor: pages · **Category:** stability · **Severity:** medium · **Size:** S
- **Location:** `packages/web/src/pages/editor/EditorPage.tsx:2192-2205 (keydown 2240-2259); packages/web/src/lib/undo-stack.ts:72-87`; also packages/web/src/lib/undo-stack.ts:79-95
- **Status:** confirmed. Code read plus a standalone reproduction. Read /home/user/oxygen/packages/web/src/lib/undo-stack.ts:72-87, /home/user/oxygen/packages/web/src/pages/editor/EditorPage.tsx:336-362 (run), 459-478 (writeStructure/applyStructure), 727-767 (createSite), 2190-2205 (runUndo/runRedo), 2231-2260 (keydown), and /home/user/oxygen/packages/web/src/lib/editor/write-client.ts:144-165, 185-195, 260-265. Then ran a node simulation (/tmp/claude-0/-home-user/955a9e60-b445-5cf6-b5b3-72ae6a31a60f/scratchpad/v/u.mjs) that copies UndoStack and EditorWrites.serial and models the two entries with timed network calls.

**What is wrong.** `runUndo` / `runRedo` do `void run(async () => { await undoStack.undo(); ... })` with no queue and no `e.repeat` guard (keydown at 2245-2259). `UndoStack.undo()` pops synchronously and pushes to `future` only when its async undo settles, so two overlapping undos push in completion order. Entries have different numbers of awaits (a placement's undo is `setStructure` then `control.delete`), so a later-popped entry can finish first. Redo then replays whole-structure snapshots in the wrong order. `EditorWrites.serial` orders tokens per row, not the stack.

**Scenario.** Edit B (reorder, S0→S1), then placement A (S1→S2). Hold Ctrl+Z: A's undo (two requests) and B's undo (one) overlap; B settles first, so `future = [B, A]`. Ctrl+Y twice now redoes A (writes S2) and then B (writes S1). The course ends at S1 without the placed control while the stack shows everything redone. Reproduced with a copy of the UndoStack logic in /tmp/claude-0/-home-user/955a9e60-b445-5cf6-b5b3-72ae6a31a60f/scratchpad/undo.mjs (prints `future order: [B, A]`, `after 2 redos: S1 (expected S2)`). In Layout mode overlapping undos also conflict with each other (see the Layout finding) and are dropped.

**Proposed fix.** Chain undo/redo on one promise queue in EditorPage (`historyQueue.current = historyQueue.current.then(() => run(...))`), or make `UndoStack.undo/redo` themselves sequential. Add a unit test with two overlapping undos of different duration.

**Verifier's note on the fix.** Serialise at the stack or page level: chain undo/redo on a single promise tail so the pop, the await and the push to the other branch are atomic per entry. A per-row queue cannot fix this, because the multi-request entries (`setStructure` + `control.delete`/`restore`) span rows. A failed entry must not block the chain (keep the drop-and-continue behaviour documented in undo-stack.ts). `undoStack.top`/`nextRedo` are read synchronously for `undoable`/`redoable` and for the placement-chain step at 2251-2255, so they need to stay consistent with queued operations. An `e.repeat` guard alone is not enough: a fast double tap or toolbar clicks still overlap.

<details><summary>Verifier's evidence</summary>

No guard exists against overlapping undo/redo.

- `run` (EditorPage.tsx:336-362) only counts `pendingOps`; it has no queue. `runUndo`/`runRedo` (2192-2205) fire `void run(async () => { await undoStack.undo(); ... })` and check only `undoable`/`redoable`, not `pendingOps`. The keydown handler (2240-2259) has no `e.repeat` check for Z/Y, though one exists for D/V at 2269.
- `UndoStack.undo()` (undo-stack.ts:72-78) pops synchronously and pushes to `future` only after `await entry.undo()`, so overlapping undos push in completion order.
- A placement entry's undo is `await writeStructure(course.id, prev); await writes.deleteControl(id)` (EditorPage.tsx:763); a plain structure edit's undo is one `writeStructure` (476).
- `EditorWrites.serial` (write-client.ts:157-164) orders the two `setStructure` calls on the same course row, so the undos themselves land correctly (server ends at S0). `deleteControl` (260-265) is not serialised and runs in parallel with the second entry's `setStructure`. If that `setStructure` settles first, `future = [B, A]`.

Simulation output (two overlapping undos, then two sequential redos):
- equal latency: `future:[B,A]`, after redos `S1` (expected S2)
- slow delete: `future:[B,A]`, after redos `S1`
- fast delete: `future:[A,B]`, after redos `S2` (correct)

So the scramble happens whenever `control.delete` is not faster than the queued `setStructure`. The client uses `httpBatchLink` (packages/web/src/main.tsx:46), and the two requests are issued within a few microtasks of each other, so they will often share a batch; I did not trace how the link orders batched replies. In the bad case the redo runs A (restore control, write S2) then B (write S1): the course ends at S1 without the placed control, the control is left restored but outside the course, and `past` is `[A, B]`, so later undos are misordered too.

docs/bugfixes/editor-overlapping-course-writes.md covers only the per-row token problem with a double Ctrl+Z, not stack ordering. I did not search the Pending sections of docs/course-*.md in full; a grep of docs/course-editor.md for undo/redo serialisation found nothing.

Limits on the claim:
- The undo phase itself is correct; only a later redo goes wrong.
- It needs adjacent entries with different await counts (for example placement over a structure edit) and a second keypress inside one network round trip.
- The wrong result is visible on screen at once and can be repaired by hand; nothing is lost on the server beyond one course structure write.
- I did not verify the Layout-mode part of the claim.

</details>

### CRS-051 Undo of a control delete does not restore variation courses, and aborts part-way on a materialised variant

- **Area:** Web course editor: pages · **Category:** functional · **Severity:** medium · **Size:** M
- **Location:** `packages/web/src/pages/editor/EditorPage.tsx:868-877`
- **Status:** confirmed. Code read only; no reproduction was run (node_modules is absent and the path needs a database). Traced the client delete/undo path in packages/web/src/pages/editor/EditorPage.tsx:861-881 and 2192-2198, packages/web/src/lib/undo-stack.ts:72-77 and packages/web/src/lib/editor/write-client.ts:184-193, against the server in packages/api/src/routers/course.ts:463-549 (list) and 973-983 (setStructure), packages/api/src/routers/control.ts:1091-1173 (delete) and 1180-1246 (restore), packages/api/src/course-structure.ts:147-200 (persistStructure), packages/api/src/course-variants.ts:71-78 and 110-165.

**What is wrong.** `deleteControls` decides which course structures to snapshot from `course.list` rows: `c.controls` plus start/finish. For a root with variations `course.list` carries only the first alternatives, so a control used only in another alternative, or only as a leg's `crossing`, does not mark the root as affected. The materialised variant rows (`parentCourseId != null`) do contain it and are included. The server cascade (packages/api/src/routers/control.ts:1126-1139) prunes the root's structure in every alternative. The undo (lines 874-877) then calls `writeStructure(variantId, …)`, which `course.setStructure` refuses (`assertNotVariant`, packages/api/src/routers/course.ts:983). The loop throws, the entry is dropped, and every course after it in the list is not restored either.

**Scenario.** Control 52 is in alternative B of relay course R and in plain course Kort. Delete 52, then Ctrl+Z: the control is restored, the first `writeStructure` on variant `R (B…)` fails with COURSE_IS_VARIANT, the undo entry is dropped with an error line. R's alternative B, and Kort if it sorts after the variant, are left without control 52. The printed courses miss a control unless the setter notices and re-adds it by hand.

**Proposed fix.** Build the snapshot list from roots only: skip rows with `parentCourseId != null` and map them to their root. Detect membership from each root's `course.detail` structure (all alternatives and leg crossings), or have `control.delete` return the pre-delete structures of the courses it rewrote (it already returns their ids and versions). Restore all structures even if one fails, then report.

**Verifier's note on the fix.** Two changes are needed, not one. (a) Exclude variant rows (`parentCourseId != null`) from the snapshot/restore set; restoring the root re-materialises them. (b) Include every root whose structure names the control in any alternative or as a leg crossing, which `c.controls` cannot show. Either map affected variants to their `parentCourseId`, or use the `courses` list returned by `control.delete` (control.ts:1159-1172 returns the visited non-variant courses), though the snapshot must be taken before the delete. Crossing-only references on plain courses are missed by the same filter; `c.legs` from `course.list` (used at EditorPage.tsx:312) can cover them. Consider making the restore loop continue past a failed course so one failure does not leave the rest unrestored.

<details><summary>Verifier's evidence</summary>

Every step of the claim holds, and I found no guard that prevents it.

1. `course.list` returns variant rows too: the query filters only `{ eventId, removed: false }` (course.ts:465-468), and `controls` comes from `course_controls` (course.ts:484-488, 526).
2. A root's `course_controls` hold only the first alternative of each group: `persistStructure` writes `splitStructure(course.structureControlItems(s))` (course-structure.ts:148, 188-190), and `structureControlItems` is documented as "a group by its first alternative" (shared/src/course/structure.ts:211). A control only in alternative B, or only a leg `crossing`, is therefore not in the root's `controls`.
3. Each variant gets its own flat `course_controls` through `syncVariants` -> `persistStructure` (course-variants.ts:158-164), so the variant row does match the filter at EditorPage.tsx:868-869. That filter has no `parentCourseId` check.
4. The server delete skips variant rows (`if (row.parentCourseId) continue`, control.ts:1131) and prunes the root in every alternative (control.ts:1132-1139). It reaches the root through `coursesNamingInStructure` even though the client did not snapshot it.
5. The undo runs `writeStructure(c.id, c.structure)` for each snapshot (EditorPage.tsx:874-877) -> `writes.setStructure` -> `course.setStructure`, which calls `assertNotVariant(c)` right after the lookup (course.ts:982-983) and throws PRECONDITION_FAILED "COURSE_IS_VARIANT" (course-variants.ts:71-78). There is no client-side filter in write-client.ts.
6. `UndoStack.undo` pops the entry before awaiting it and a throw drops it (undo-stack.ts:73-75). `run` catches and only sets the error line (EditorPage.tsx:336-361). The `for` loop at line 876 stops at the first throw, so later courses are not restored.
7. `control.restore` only un-removes the control; it re-attaches nothing to course structures (control.ts:1227-1244).

The defect is wider than the claim states. Every variant contains the spine controls, so deleting any control on a course with variations puts variant rows in `affected`, and the undo always throws at the first variant. `course.list` is ordered by name (course.ts:467) and variants are named `${root.name} ${key}` (course-variants.ts:137), so the root sorts before its variants. When the control is in a first alternative or the spine, the root is restored (which re-materialises its variants) before the throw; courses sorting after the first variant are still left without the control, and the undo/redo entry is lost. In the claimed case (control only in a non-first alternative, or a crossing) the root is never snapshotted, so its alternative is not restored even if the loop did not throw.

Not a documented gap: docs/course-layer.md:2211 and 2511 list COURSE_IS_VARIANT as the intended refusal for writes on a child, and nothing in a Pending section covers delete-undo with variants. The E2E row at docs/course-editor.md:3272 covers delete + Ctrl+Z only for plain courses.

Severity: medium, not higher. It needs an event with variation courses plus delete-then-undo. The failure is not silent (an error line shows), and nothing beyond the confirmed delete is destroyed; the setter must re-add the control by hand. The risk is that a missed re-add prints a course without the control.

</details>

### CRS-052 Class view of a course with variations draws one variant but maps clicks and edits through another path

- **Area:** Web course editor: pages · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/web/src/pages/editor/EditorPage.tsx:277`; also packages/web/src/pages/editor/EditorPage.tsx:284-286, 835-840, 2091-2096
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the logic is short enough to prove by reading). Files: /home/user/oxygen/packages/web/src/pages/editor/EditorPage.tsx:275-287, 482-489, 835-840, 2091-2103, 2164; /home/user/oxygen/packages/web/src/lib/editor/state.ts:102-127; /home/user/oxygen/packages/web/src/lib/editor/sequence.ts:90-99, 191-212; /home/user/oxygen/docs/course-editor.md §6.7 (line 914) and §12 (lines 2152-2165), plus its Pending list (3423-3431).

**What is wrong.** `orders`, which drives `rows`, `handleLegClick` → `insertIndexForLeg(rows, legIndex)`, `selectedLeg`, the gap target, the provisional visit and the sequence list, uses a variant's orders only when `state.view === "variant"`; otherwise `courseViewOrders(structure, state.activeAlternatives)`. In Class view the canvas is drawn from `sheetVariant` (lines 284-286, `courseOverride` at 2093-2096), which is the key picked with Variant ▾ in Class view (the reducer sets `variantKey` alone) or the first key, while `activeAlternatives` keeps whatever tab was last active in Course view. Class view keeps Course mode's tools live (ClassView.ts header), so drawn leg indexes are resolved against a different path.

**Scenario.** Relay course with a fork: A = 31,32 and B = 41,42,43. In Class view choose Variant ▾ "B" (or activate tab B in Course view, then open Class view, which draws the first variant). Click the drawn leg 42→43 and choose *Insert control here*, add a bend, or cut a gap. The leg index is looked up in the A path, so the edit lands on a different leg or item (after the fork every index is off by one) of an alternative that is not on screen. The printed variant differs from what was edited.

**Proposed fix.** Compute `orders` from the drawn variant whenever one is drawn: when `sheetVariant !== null && state.view === "class"`, use `variants.find(v => v.key === sheetVariant).orders`, as Variant view does. Add a unit/E2E case: Class view with a non-first variant, leg click selects the drawn leg's item.

**Verifier's note on the fix.** The fix must make `orders` follow `sheetVariant` whenever it is non-null in Course mode (Class view), not just in Variant view; otherwise rows, selectedLeg, the provisional visit, the gap target and the sequence list still diverge from the canvas. Check what Layout mode should do (sheetVariant is also set there, but Layout drops the phantom). Consumers gated on `state.view === "course"` (variationHere at line 617, alternativeEndAt at 665, elevation at 1832) and the inspector's `blocks` (built from `orders`, line 288) need a decision on whether tabs in Class view then show the sheet variant's alternatives. For loop groups a variant's orders list several alternatives in a variant-specific order, so substituting only the first alternative is not enough. The spec is silent on this, so per project rules the behaviour needs to be recorded in docs/course-editor.md §12 before implementing.

<details><summary>Verifier's evidence</summary>

The mismatch is real and nothing guards it.

1. Rows side: EditorPage.tsx:277-278 takes a variant's orders only when `state.view === "variant"`; in Class view `orders = courseViewOrders(structure, state.activeAlternatives)` (sequence.ts:90-99: the active alternative per group, else the first). `rows = displaySequence(structure, sites, orders)` (line 287).

2. Canvas side: EditorPage.tsx:284-286 sets `sheetVariant` in Class view to `state.variantKey` if valid, else `variantKeys[0]`. `courseOverride` (2093-2096) draws `displayPath(explicit, kindOf, v.orders)` for that variant, never consulting `orders`/`activeAlternatives`.

3. The two states are independent: state.ts:110-114, the `variant` action in Class view sets `variantKey` alone; state.ts:107-109, the `class` action and `view: "class"` leave `activeAlternatives` untouched (it is only cleared on a course change, line 200). So both claimed routes produce a mismatch: Variant ▾ "B" in Class view (canvas B, rows A), or tab B activated in Course view and then Class view opened (canvas first variant, rows B).

4. Clicks are live in Class view: line 2164 passes `onLegClick` for every view except `all` and `all-variations`; `handleLegClick` (835-840) calls `insertIndexForLeg(rows, legIndex)` with the drawn leg index (MapViewer.tsx:1753/2173 pass `leg.index` of the drawn overlay, which is the override). `selectedLeg` (482-489) excludes only `all`/`all-variations` and resolves `legForInsert(rows, insertAt)` -> `itemAtPath(explicit, leg.path)`; docs/course-editor.md:914 explicitly says a selected leg exists "in Course or Class view".

5. Effect, with A = 31,32 and B = 41,42,43 drawn as B, rows as A: drawn leg 42->43 is leg index 2 (S->41 = 0). `insertIndexForLeg` picks positioned rows[3] of the A path, which is the control after the fork (or the finish), so the insert/bend/gap goes on the fork's exit leg, not 42->43. With equal-length alternatives the index matches but the path still names the A item, so the edit lands in the alternative that is not on screen.

Not excused by the docs: the Pending entry at course-editor.md:3423-3426 is only about the phone lacking Variant ▾; §12 (2152-2165) specifies drawing one variant in Class view and says nothing about edits resolving through another path.

Limits on the claim: the default case is consistent (no Variant ▾ pick, no non-first tab activated: first key vs first alternatives), so it needs a course with variation groups, Class view, and a non-default variant or tab. The sequence list in the inspector also follows `rows`, so the wrong target is visible there, and the edit is undoable. The claim's "printed variant differs from what was edited" is true but is a wrong-leg edit the setter can see and undo, not silent corruption.

</details>

### CRS-053 Layout mode writes are not serialised: a second gesture inside one round trip gets a false "changed elsewhere" and is lost

- **Area:** Web course editor: pages · **Category:** stability · **Severity:** medium · **Size:** S
- **Location:** `packages/web/src/pages/editor/modes/LayoutMode.tsx:217`; also packages/web/src/pages/editor/layout/SheetActions.tsx:62; packages/web/src/pages/editor/modes/LayoutMode.tsx:232, 244-247
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the logic is plain from the source). Followed LayoutMode save/commit -> EditorPage run/record/runUndo -> UndoStack -> VersionBook -> server courseMap.saveLayout / courseMap.update, and compared with EditorWrites.serial in write-client.ts and docs/bugfixes/editor-overlapping-course-writes.md. Checked docs/course-layout.md for a Pending entry covering it: none found.

**What is wrong.** `save` reads `versions.get("sheet", id)` when called and sends at once; there is no per-row queue like `EditorWrites.serial`. `courseMap.saveLayout` / `mapTemplate.update` compare tokens strictly (packages/api/src/routers/courseMap.ts:730, 780). Two commits, or two undos, issued before the first reply carry the same `baseVersion`; the second is refused, surfaces as an `EditorConflict` refresh notice, `commit` drops the optimistic snapshot (`setLocal(null)`), and an undo entry is dropped. This is the bug docs/bugfixes/editor-overlapping-course-writes.md fixed for courses, still present for sheets and templates (also `SheetActions.rename`, SheetActions.tsx:62).

**Scenario.** On arena Wi-Fi (about 1 s round trip) the setter commits the print-scale field by clicking the canvas (blur → write 1) and drags the description block (release → write 2 within the second). Write 2 is refused as stale, the block jumps back, and the page says "Changed elsewhere — reloaded. Redo your edit." although nobody else edited. Ctrl+Z pressed twice loses the second undo entry the same way.

**Proposed fix.** Queue sheet/template writes per row, e.g. a small `serial(kind, id, op)` shared with EditorWrites, and read the token inside the queued op. Also keep `local` at the newest pending snapshot when an earlier write resolves (line 232 overwrites it with the older one). Add a test for two back-to-back saves.

**Verifier's note on the fix.** Queue per row key (sheet:id / template:id) around the whole read-token -> send -> seed sequence, as EditorWrites.serial does, and share that queue (or the VersionBook owner) with SheetActions.rename and recalculate, which write the same sheet row through the same VersionBook. Serialising save alone is not enough for snapshots: each write sends the whole snapshot, so queued write 2 must be built on write 1's result (it already is, via `stored` with at=+Infinity) and a failed write 1 must not let write 2 persist a snapshot containing write 1's unsaved change without that being intended. Also note commit's `setLocal(null)` on failure discards the optimistic state of any other still-in-flight write for that key.

<details><summary>Verifier's evidence</summary>

1. No queue on the layout path. /home/user/oxygen/packages/web/src/pages/editor/modes/LayoutMode.tsx:209-237 `save` reads `versions.get("sheet", id)` (217) or `versions.get("template", id)` (221) at call time and sends at once; the token is only raised after the await (219, 222). It calls `client.courseMap.saveLayout.mutate` / `client.mapTemplate.update.mutate` directly, not through EditorWrites. `serial` exists only in /home/user/oxygen/packages/web/src/lib/editor/write-client.ts:155 and is used for kinds course/control/object (185-342), never sheet/template.

2. Nothing upstream serialises either. EditorPage.tsx:336-362 `run` only counts pendingOps and awaits the op; it does not chain. runUndo/runRedo (EditorPage.tsx:2192-2205) fire `void run(() => undoStack.undo())` per keypress with no in-flight guard. LayoutMode has no busy/pending gate on `commit`/`change` (grep for pendingOps/busy in LayoutMode.tsx and layout/*.tsx: none).

3. Second gesture really is issued with the old token. `commit` (LayoutMode.tsx:241-248) sets `local` with at=+Infinity, so `stored` (162) becomes the new snapshot at once and a second `change` (257) is accepted and sent while write 1 is in flight; VersionBook (/home/user/oxygen/packages/web/src/lib/version-book.ts:27-40) still holds the pre-write token.

4. Server refuses strictly. /home/user/oxygen/packages/api/src/routers/courseMap.ts saveLayout: `SELECT version ... FOR UPDATE` then `now !== BigInt(input.baseVersion)` -> versionConflict (about lines 776-783); same check in courseMap.update (about 727-733). The row lock makes write 2 wait for write 1's commit and then see the new version, so the refusal is deterministic, not a race.

5. Consequence on the client. save's catch (LayoutMode.tsx:224-231) throws EditorConflict{kind:"refresh"}; `run` turns it into the refresh notice (EditorPage.tsx:354) and returns undefined; `commit` then does `setLocal(null)` and returns without recording (246), so the second gesture is reverted and has no undo entry. For a double Ctrl+Z, UndoStack.undo pops the entry before awaiting and a throw drops it (/home/user/oxygen/packages/web/src/lib/... UndoStack `undo`: `const entry = this.past.pop(); await entry.undo(); // a throw drops the entry`), so the second undo entry is lost.

6. SheetActions.rename (/home/user/oxygen/packages/web/src/pages/editor/layout/SheetActions.tsx:60-76) has the same read-token-then-send shape against courseMap.update on the same "sheet" row, so a rename overlapping a layout write collides too.

7. The bugfix doc describes exactly this mechanism for courses ("A user who presses Ctrl+Z twice faster than a reply comes back gets the same refusal") and its fix (EditorWrites.serial) was not extended to sheets/templates.

Limits of the claim: the two writes must hit the same row (a sheet-scope write and a template-scope write do not collide). The first write always lands; only the later gesture is lost, visibly, with a notice telling the user to redo. No silent loss, no corruption. The print-scale field does commit on blur (layout/fields.tsx:23), so the stated scenario is reachable, but it needs two commits within one round trip; Layout mode has no key-repeat gesture (no arrow nudges) that would trigger it on a fast link. Double Ctrl+Z is the most likely trigger and permanently drops one undo entry.

</details>

### CRS-054 Programming panel accepts code-less sites as target and programs station code 0

- **Area:** Web course editor: pages · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/web/src/pages/ControlsPage.tsx:1170`
- **Status:** confirmed. Code read plus a one-line node reproduction of the NaN arithmetic. Followed the path from the target picker through programStation into programControl/encodeStationCode, and the API side (control.list, control.create, course import, recordProgramming). No hardware run.

**What is wrong.** `targetCode = parseInt(matchedControl.codes.split(";")[0].trim(), 10)` is NaN for a control without codes. The target picker (1409-1413) lists every row of `control.list`, including the editor's code-less start/finish ("Start 1", "Mål 1"), crossing points and map-issue points. `encodeStationCode(NaN)` yields code byte 0 (`NaN & 0xff`, lib/si-protocol.ts:1389), so the station is written with code 0 and the result row is added with `success: true`. `recordProgramming` then receives a non-numeric code and only that step reports an error.

**Scenario.** The organiser selects "— Start 1 (Start)" or a crossing point as *Target control* and places a unit on the coupling stick: the unit is programmed to code 0 (a crossing point has normal status, so it becomes a code-0 control unit) and may be powered off automatically. The list shows a green result with code NaN.

**Proposed fix.** Before `reader.programControl`, refuse a target whose first code is not a positive integer: add a failed result with a clear message and leave the station untouched. Filter the picker to sites that have codes (or a programmable status). Unit-test the guard.

**Verifier's note on the fix.** Two places need the guard. In `programStation`, refuse before `programControl` when the first code is not a finite integer above 0, with a failed result row and no station write. In the picker, exclude rows with no numeric code (crossing_point / map_issue kinds, and any legacy code-less start/finish). The auto-match at ControlsPage.tsx:1144-1147 is already safe. A defensive check in `programControl` or `encodeStationCode` for non-finite or out-of-range (1-1023) codes would cover other callers.

<details><summary>Verifier's evidence</summary>

The defect is real for crossing points and map-issue points; the start/finish part of the claim is overstated.

- **Picker is unfiltered.** `pickerControls = sortByControlNumber(controls)` (packages/web/src/pages/ControlsPage.tsx:1076) is rendered whole at 1409-1413. `controls` is `control.list` data (ControlsPage.tsx:290), and `control.list` returns every non-removed row with no kind filter (packages/api/src/routers/control.ts:577-580, `codes: c.codes` at 640).
- **Code-less rows exist by design.** `control.create` documents "crossing and map-issue points are code-less" (control.ts:721-726) and gives them only a seq above MARK_SEQ_BASE (control.ts:818-824). The IOF import creates crossing points with `codes: ""` (packages/api/src/routers/course.ts:1981).
- **No guard on the target code.** With an explicit target, `matchedControl` is found by id (ControlsPage.tsx:1141-1142) and `targetCode = parseInt(matchedControl.codes.split(";")[0].trim(), 10)` (1170) is used unchecked. It goes to `reader.programControl({ code: targetCode, ... })` (1212-1220).
- **NaN becomes code 0.** `programControl` does not validate `config.code` (packages/web/src/lib/webserial.ts:891-963). `encodeStationCode` does `code & 0xff` and `(code >> 2) & 0xc0` (packages/web/src/lib/si-protocol.ts:1389-1390), and the byte is written at webserial.ts:978 (`buf[SYSVAL.STATION_CODE - 0x10] = codeByte`). Node run: `parseInt("")` gives NaN, `NaN & 0xff` gives 0, `(NaN >> 2) & 0xc0` gives 0.
- **Mode and result.** A crossing point has normal status, so `stationMode` stays undefined (ControlsPage.tsx:1186-1203) and the unit becomes CONTROL/BC_CONTROL with code 0. Power-off runs if enabled (1226-1236), and the result row is pushed with `success: true, code: NaN` (1253-1264).
- **Only the record step errors.** `recordMutation.mutate` receives `programmedCode: NaN`. `JSON.stringify` turns that into null, which `z.number().int().optional()` rejects (control.ts:1579), so only `recordProgrammingFailed` is shown, after the station is already written.
- **Start/finish overstated.** Since F32, a start or finish created without a code is allocated one in 3-30 (control.ts:826-828; import at course.ts:2106 and 2133; update at control.ts:1042-1044). "Start 1" / "Mål 1" are therefore normally not code-less; only legacy rows could be.
- **Not listed as pending.** No "Pending" entry in docs/map-*.md or docs/course-*.md covers the programming panel; the only mention is the picker ordering in docs/guide/event-setup.md:40.

Severity is medium, not high: it needs the organiser to explicitly pick a point that has no physical station as the target (auto mode never matches a code-less row, since `[NaN].includes(readCode)` is false). The mis-programmed unit is recoverable by reprogramming, and an error banner does appear, though it contradicts the green result row.

</details>

### CRS-055 Courses page silently drops or truncates mistyped control codes when saving a sequence

- **Area:** Web course editor: pages · **Category:** functional · **Severity:** medium · **Size:** S
- **Location:** `packages/web/src/pages/CoursesPage.tsx:806`; also packages/web/src/pages/CoursesPage.tsx:1098, 1100
- **Status:** confirmed. Code read only, no reproduction run. Read packages/web/src/pages/CoursesPage.tsx:796-815 (edit), 951-972 (input/onBlur), 1087-1105 (create), 1152-1158 (maps input), and the server side in packages/api/src/routers/course.ts:279-300 (controlSeqToId), 601-616 (create schema), 769 and 853-859 (update).

**What is wrong.** `controlIds: codes.map((c) => parseInt(c, 10)).filter((n) => !isNaN(n))`: a token that is not a number is dropped without a message, and a token with a numeric prefix is truncated (`parseInt("32a") === 32`, `parseInt("4O") === 4`). The same code is in the create form (line 1098), where `parseInt(numberOfMaps) || 1` also turns a typed 0 into 1 (1100).

**Scenario.** Editing course H21 the user types `31;32;l33;34` (stray letter) and tabs out: the course is saved as 31;32;34 with no error. The control is missing from the printed course and from punch checking. Typing `31;3 2;33`, or `4O` for 40, saves control 3/2 or 4 if such codes exist, otherwise shows a confusing not-found error.

**Proposed fix.** Validate every token with `/^\d+$/` before sending. If any token fails, set `controlsError` / `createError` naming the token and do not mutate. Share one parser between the two forms and unit-test it.

**Verifier's note on the fix.** Validate each token strictly (e.g. `/^\d+$/`) in both the edit handler (line 806) and the create form (line 1098), and refuse the save with a message naming the bad token instead of filtering. On a refused edit, keep the user's text in the field: onBlur currently calls `setEditControls(null)` unconditionally (line 963), which would discard it. For the maps field use a NaN check rather than `|| 1` so 0 survives; the detail editor at lines 907-909 already does this. The `seq` fallback in `controlSeqToId` (course.ts:294) lets a wrong number resolve to an unrelated control; that is server behaviour to review separately, not something to change in this fix.

<details><summary>Verifier's evidence</summary>

The claim holds; nothing on the client or server catches a mistyped token.

- **Edit path:** `handleSaveControlCodes` (CoursesPage.tsx:799-815) splits on `/[;,\s]+/`, then sends `controlIds: codes.map((c) => parseInt(c, 10)).filter((n) => !isNaN(n))` (line 806). There is no validation before it. It runs on blur (lines 958-963) whenever the text differs from the stored sequence.
- **Dropped token:** `l33` parses to NaN and is filtered out, so `31;32;l33;34` is sent as [31, 32, 34]. The server only sees valid integers (`z.array(z.number().int())`, course.ts:769) and saves the shorter sequence with no error; `controlsError` is set only in `onError`.
- **Truncated token:** `parseInt("32a", 10)` is 32 and `parseInt("4O", 10)` is 4. `31;3 2;33` splits on whitespace into 31, 3, 2, 33.
- **Server makes truncation more likely to succeed:** `controlSeqToId` (course.ts:279-300) matches the first code and then falls back to `seq === publicId`. A truncated value such as 4 can therefore resolve to an unrelated control by internal seq even when no control has code 4. Otherwise the user gets "Control 4 not found" (line 298), which names a value they never typed.
- **Create path:** line 1098 has the identical expression. Line 1100, `parseInt(numberOfMaps, 10) || 1`, turns a typed 0 into 1, although the input declares `min={0}` (line 1157) and the server accepts 0 (schema default 0, course.ts:601).

Mitigations are weak. After the save the field re-renders from server data (`setEditControls(null)`, line 963), so the missing code is visible in the field, but no message is shown. The field is disabled for courses with variations and for read-only variants (line 952), so only plain courses are affected.

Severity: medium. It needs a typing mistake, but the result is a silently wrong course definition that feeds printing and punch evaluation. It is not high, because it does not occur in normal correct use and the saved value is shown straight away.

</details>

### CRS-056 Field-mode writes sent directly are not persisted until the request fails, so a hung request loses the move

- **Area:** Web course editor: lib/editor · **Category:** stability · **Severity:** medium · **Size:** M
- **Location:** `packages/web/src/pages/editor/useFieldOutbox.ts:112`; also packages/web/src/lib/offline/control-outbox.ts:180 (isNetworkFailure only sees a rejected request)
- **Status:** confirmed. Code read only (no reproduction run; the logic is a plain await ordering). Read /home/user/oxygen/packages/web/src/pages/editor/useFieldOutbox.ts:105-122, /home/user/oxygen/packages/web/src/lib/offline/control-outbox.ts:179-184, /home/user/oxygen/packages/web/src/lib/editor/write-client.ts:155-162 and 229-240, the tRPC client setup in /home/user/oxygen/packages/web/src/main.tsx:42-66 and /home/user/oxygen/packages/web/src/lib/trpc.ts:40-63, /home/user/oxygen/packages/web/src/lib/node-discovery.ts:218-227, the Workbox config in /home/user/oxygen/packages/web/vite.config.ts:58-77, and docs/course-editor.md §9 "Offline" (1746-1800) plus its Pending list for D9c (3553-3582).

**What is wrong.** write() queues to Dexie only when navigator.onLine is false, entries already wait, or the direct request has failed with a network error. With navigator.onLine true but no real connectivity (the normal state in terrain with one bar), the direct request hangs with no timeout (the tRPC link sets no AbortSignal). Until it rejects nothing is in the outbox, and later nudges of the same control also go direct and wait behind it in EditorWrites.serial. The canvas already shows the new position (`nudged`, the viewer's pending move).

**Scenario.** Setter in Field mode nudges control 47 to its real position; the phone reports online but the request hangs. The setter locks the phone or the browser discards the tab. On reopening, the outbox is empty and the control is back at its old position: the field correction is lost although docs/course-editor.md §9 'Offline' says moves that could not go out wait on the device.

**Proposed fix.** Write-ahead: always enqueue first, then drain (the drain already handles 'landed but answer lost' and the conflict rules), or keep the direct path but bound it with an AbortSignal timeout of a few seconds that falls through to queue(). Add a hook or outbox test with a never-resolving client.

**Verifier's note on the fix.** A fetch timeout (AbortSignal) alone only shortens the window; it does not cover a tab discarded mid-request. A durable fix writes the entry to the outbox before sending (write-ahead) and removes it on the server's answer. That has to account for:

- **In-flight and merge rules** in control-outbox.ts: an entry in flight is never dropped, a newer value goes out after it, and a drain start clears a stale flight flag.
- **The drain's single-tab lock** (`navigator.locks`), so a direct send and a drain cannot both send the same entry.
- **Replay after a timed-out or aborted request that did reach the server**: the entry replays on its old token and gets a CONFLICT against the setter's own write, which must settle as sent or rebased, not as a "moved elsewhere" notice.
- **The direct-send contract**: conflicts on a direct send currently throw as `EditorWrites` does (§9, "its conflicts are §3's"). Changing that is a spec change, to be recorded in docs/course-editor.md §9 first.

<details><summary>Verifier's evidence</summary>

The claim holds as written.

- **Nothing is persisted before the send.** useFieldOutbox.ts:112-121 calls `enqueue` only when `!navigator.onLine`, when entries already wait, or in the `catch` after `await writes.updateControl(...)` rejects with `isNetworkFailure`. While the direct request is pending, Dexie holds nothing for that move.
- **No timeout anywhere on the path.** The `httpBatchLink` in main.tsx:45-65 passes no AbortSignal. `eventScopedTrpcFetch` -> `fetchJsonApi` -> `venueAwareFetch` (trpc.ts:40-63, node-discovery.ts:218-227) is a bare `fetch(input, init)`. The Workbox `/trpc/` route with `networkTimeoutSeconds: 3` (vite.config.ts:66-70) declares no method, so it covers GET only; mutations are POST and bypass it.
- **Later writes also stay unpersisted.** `waiting` is read from the store (line 112), which is still empty, so a second nudge of the same control goes direct and chains behind the hung one in `EditorWrites.serial` (write-client.ts:155-162, 233). Moves of other controls during the hang are equally unpersisted.
- **No unload guard.** There is no `pagehide` or `beforeunload` handler in pages/editor or lib/offline.
- **Not a documented gap.** The Pending list (course-editor.md:3553-3582) covers no drain outside the editor, uncapped retries of entries already pending, and others, but not this window. §9 says the outbox "survives a reload and a browser restart" and §3 says moves "that could not go out wait in the device's outbox"; neither is true for a move whose request has not yet rejected.

**Limits on the scenario, which is why I rate it medium, not high:**
- Loss needs two things together: a request that hangs rather than failing, and the page being discarded, closed or reloaded before the fetch rejects.
- If the tab survives (a plain screen lock and resume), the fetch eventually rejects with a TypeError, which becomes a TRPCClientError without `data`, and the write is queued then.
- During the window the save indicator shows `saving`, not `saved`, so the state is not misreported.
- The loss is bounded to the moves and check-offs made in that window. Nothing on the server is corrupted.

</details>

### CRS-057 Course export emits class assignments for deleted classes

- **Area:** Course data and course/control API · **Category:** functional · **Severity:** medium (reviewer said low, verifier corrected) · **Size:** S
- **Location:** `packages/api/src/course-export.ts:239`; also `packages/api/src/course-export.ts:240`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and no DB access). Read /home/user/oxygen/packages/api/src/course-export.ts:232-247, the class delete mutation in /home/user/oxygen/packages/api/src/routers/classRouter.ts:444-457, the import-side matching in /home/user/oxygen/packages/api/src/routers/course.ts:164-189 and 1721-1762, and packages/api/src/db.ts for any global soft-delete filter. Grepped docs/course-*.md and docs/map-*.md for a Pending entry covering this.
- **Found twice:** a second reviewer reported the same defect independently ("IOF/ppen export emits ClassCourseAssignment for removed classes", Course import/export (IOF XML, OCAD, Purple Pen)); its verifier also confirmed it.

**What is wrong.** classRows is read with `where: { eventId, courseId: { not: null } }` without `removed: false`, so soft-deleted classes that still carry a course_id are written as ClassCourseAssignment (IOF) and into the .ppen.

**Scenario.** Class 'Öppen 7' was deleted after the course import. The exported CourseData XML still assigns 'Öppen 7' to its course; importing that file into Eventor/OCAD/another Oxygen event (deriveClassAssignments + findBestClassMatch) recreates or mis-matches the class.

**Proposed fix.** Add `removed: false` to the class query; add a case to course-export.test.ts.

**Verifier's note on the fix.** Add `removed: false` to the class query at course-export.ts:240. Add an integration case to packages/api/src/__tests__/integration/course-export.test.ts with a soft-deleted class that still has course_id, covering both IOF XML and .ppen output. Do not clear courseId on delete as the fix: other code may rely on it for a removed class.

<details><summary>Verifier's evidence</summary>

The defect is real, but the claimed downstream consequence is overstated.

- **Missing filter:** course-export.ts:239-243 reads `db.class.findMany({ where: { eventId: event.id, courseId: { not: null } }, ... })` with no `removed: false`. The same function filters `removed: false` for controls (line 81) and courses (line 119).
- **Deletion keeps the course link:** classRouter.ts:449-452 soft-deletes with `data: { removed: true }` only; `courseId` is not cleared.
- **No global guard:** db.ts has no Prisma extension or middleware that filters removed rows; its only `removed` handling is the event lookup at lines 59-67.
- **Result:** a deleted class with a non-empty name whose course still exists is emitted at course-export.ts:244-248 into `classAssignments`, which feeds both `buildCourseDataXml` and `buildPpenXml` (lines 265-281).
- **Not listed as pending:** no "Pending" entry in the docs covers this; docs/course-layer.md:1395 only describes import-side matching of removed classes.

Limits on the impact:
- Re-import into Oxygen does not recreate the class. The import reads `dbClasses` with `removed: false` (course.ts:1721-1724), and an unmatched name becomes `matched: false, matchType: 'none'` (course.ts:1754-1761).
- A mis-match is possible only through the substring fallback (course.ts:180-188), and only when another live class's normalised name contains or is contained in the deleted name. That could attach the deleted class's course to that live class, and it is visible in the import preview.
- For external consumers (Eventor, OCAD, Purple Pen) the file carries a stale ClassCourseAssignment for a class that no longer exists.
- Only arises when a class is deleted while still assigned to a live course and the courses are then exported.

</details>

### CRS-058 course.update {controlIds} drops numberHidden and resolves each control with a full-table read

- **Area:** Course data and course/control API · **Category:** engineering · **Severity:** medium (reviewer said low, verifier corrected) · **Size:** S
- **Location:** `packages/api/src/routers/course.ts:914`; also packages/api/src/routers/course.ts:614, :1107
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the path needs Prisma). Files: /home/user/oxygen/packages/api/src/routers/course.ts lines 278-300, 609-617, 851-859, 892-937, 1107; /home/user/oxygen/packages/api/src/course-structure.ts lines 54-71, 81-97, 206-258, 288-300; /home/user/oxygen/packages/api/prisma/schema.prisma line 557; /home/user/oxygen/packages/web/src/pages/CoursesPage.tsx lines 796-808; /home/user/oxygen/docs/course-layer.md lines 859, 882-885 and the Pending section at 2485.

**What is wrong.** (1) The linear shortcut deletes course_controls and recreates them with position/controlId/label offsets only; number_hidden is not carried, and rewriteStructureFromColumns then rebuilds the structure from those rows, so every hidden number of the course becomes visible after any sequence edit through course.update. (2) controlSeqToId is called once per control id and each call loads all controls of the event (also in course.create line 614 and setControlLabelOffset): a 30-control save runs 30 identical findMany queries. (3) controlSeqToId reimplements uuidsOfPublicIds.

**Scenario.** A course has two controls with hidden numbers (set in the new editor). The setter reorders the course on the Courses page (course.update controlIds): both numbers print again. Saving a 30-control sequence issues 30 full control reads before the transaction.

**Proposed fix.** Replace the Promise.all(controlSeqToId) calls with one uuidsOfPublicIds call (throw NOT_FOUND for missing ids) and delete controlSeqToId; in the update transaction read numberHidden with the existing rows and carry it per controlId (as label offsets are), or build the next structure with carryLegs-style carry of numberHidden.

**Verifier's note on the fix.** Carry numberHidden per visit, not just per control: the flag is per course_controls row (a control visited twice can differ), whereas the existing offset carry is keyed by controlId with first visit winning. Decide the rule for a reordered sequence (for example match by controlId and occurrence index) and record it in docs/course-layer.md §6, since the spec is silent. Check course.bulkUpdate and control.delete for the same delete/recreate pattern. If controlSeqToId is replaced by uuidsOfPublicIds, keep the NOT_FOUND error for unknown ids (uuidsOfPublicIds silently omits them) and note the string-compare versus parseInt difference on the first code.

<details><summary>Verifier's evidence</summary>

(1) numberHidden loss: proven. course.update with controlIds reads the existing course_controls selecting only controlId/labelDx/labelDy (course.ts:895-898), deletes all rows (:912) and recreates them with courseId, position, controlId and the label offset only (:914-924). The schema default for number_hidden is false (schema.prisma:557), so every recreated row is unhidden. rewriteStructureFromColumns (course-structure.ts:244-258) then sets structure to NULL and rebuilds it via loadExplicitStructure -> structureFromColumns, which takes numberHidden only from the course_controls rows (:221-224, :66). carryLegs (:81-97) carries `leg` from the previous structure and nothing else, so the old structure's numberHidden is not restored. No guard prevents this for an ordinary course: only variants and roots with variation groups are refused (course.ts:787-802). The Courses page calls this path on every control-code save (CoursesPage.tsx:803-808), and the editor sets the flag through setStructure (docs/course-editor.md:905-906). The spec does not sanction the drop: course-layer.md:882-885 describes the linear shortcut as keeping an item's leg and is silent on numberHidden, and the Pending section (2485 onwards) does not list it. Label offsets are deliberately carried over the same delete/recreate, which makes the missing flag an oversight. A course.update without controlIds (start/finish, orderMode) does not delete the rows and keeps the flag, so the loss is limited to sequence edits. It is also coarse: even a control that stays in the sequence loses its flag.
(2) Repeated full reads: proven. controlSeqToId (course.ts:278-300) runs control.findMany for all live controls of the event on every call, and is called once per id inside Promise.all in course.create (:611-616) and course.update (:853-858). A 30-control save issues 30 identical queries, outside the transaction. setControlLabelOffset (:1107) calls it once, so there is no N-fold cost there; the claim's mention of that line is only another call site.
(3) Duplication: proven. uuidsOfPublicIds (course-structure.ts:288-300) does the same first-code-else-seq resolution in a single query and is already imported in course.ts (:87) and used at :992. Minor behavioural difference: controlSeqToId compares the trimmed first code as a string, uuidsOfPublicIds uses parseInt.

</details>

### CRS-059 XML parsers coerce element text to numbers, changing course, class and control names

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium (reviewer said low, verifier corrected) · **Size:** S
- **Location:** `packages/api/src/iof-course-parser.ts:148`; also packages/api/src/ppen-course-parser.ts:26
- **Status:** confirmed. Code read plus a standalone reproduction. Read /home/user/oxygen/packages/api/src/iof-course-parser.ts:148-177 and ppen-course-parser.ts:26-62 (parser options and safeStr), routers/course.ts:2145-2193 (course matching on re-import) and iof-course-export.ts:130,169 (names written verbatim). Installed fast-xml-parser@5.12.1 (the version pinned in pnpm-lock.yaml) in the scratchpad and parsed a sample CourseData with the exact options of the IOF parser. Could not run the repo's own tests (no node_modules).

**What is wrong.** Both XMLParser instances use the default parseTagValue: true (fast-xml-parser 5.12.1, leadingZeros/eNotation/hex enabled), and safeStr then stringifies the number. Names are identifiers here: courses are matched by name, controls by id.

**Scenario.** Course <Name>007</Name> or <Name>1.0</Name> is imported as '7' / '1'; on a re-import of Oxygen's own export the course '007' is not matched and a second course '7' is created. A class named '1E2' becomes '100' and fails to match.

**Proposed fix.** Set parseTagValue: false (and keep parseAttributeValue false) on both parsers; numeric fields already go through safeFloat. Add a round-trip test with a zero-padded course name.

**Verifier's note on the fix.** Set parseTagValue: false on both parsers (attributes are already left as strings). safeFloat already does parseFloat(String(val)), so numeric fields keep working; check every other read of a tag value that relies on a number type (e.g. Length, Climb, Scale, MapPosition is attributes, and the Extensions 'true' marker which already goes through safeStr) and any boolean-like comparisons. Courses already imported under a coerced name ('7' for '007') will not be renamed by the fix and will stop matching the file's '007' on the next re-import, so a duplicate can appear once in the other direction. Add a round-trip test with a zero-padded course name, a '1E2' class name and a '1.0' name.

<details><summary>Verifier's evidence</summary>

Neither XMLParser sets parseTagValue or numberParseOptions (grep over packages finds no occurrence), so the defaults apply. Reproduction output with fast-xml-parser 5.12.1 and the IOF parser's options: <Name>007</Name> -> 7, <Name>1.0</Name> -> 1, <Name>1E2</Name> -> 100, <Name>+5</Name> -> 5, <Name>10.50</Name> -> 10.5, <Id>031</Id> -> 31, <Id>0x1F</Id> -> 31, <ClassName>1E2</ClassName> -> 100; 'H21' stays a string. safeStr (iof-course-parser.ts:171-177) only does String(val), so the original text is lost.

Affected element reads: IOF rc.Id (215), rc.Name (236), cc.Control (257, 273), CourseFamily (292), ClassName/CourseName (300-301); PPen raw.code (176) and raw.name (217). PPen ids are attributes and are NOT affected (parseAttributeValue defaults to false).

Consequence on import: routers/course.ts:2149-2154 builds courseByName from the stored names, lowercased, and 2193 looks up pc.name.toLowerCase(). A stored course '007' (course names are free strings, z.string().min(1) at course.ts:598/676/760; the export writes Name: course.name verbatim at iof-course-export.ts:130) comes back from the parser as '7', misses the lookup, and a second course is created. Class matching (findBestClassMatch, course.ts:165-175) compares against the coerced '100' for a class '1E2', so it does not match.

Limits on the claim: control ids are coerced the same way in the definition and in the reference within one file, so course-to-control linking inside a file still works; only matching against stored controls with a zero-padded or hex-like code would be affected, and real punch codes (31-255) have no such form. Purely alphabetic or mixed names (H21, D16, 'Bana 1', A, B) and plain integers without leading zeros are unaffected. The trigger needs an all-numeric-looking name with a leading zero, a trailing decimal zero, an exponent form, a leading '+', or a hex form. Not listed as pending in docs/map-*.md or docs/course-*.md (grep found nothing).

</details>

### CRS-060 Duplicate ids inside one file create duplicate controls and courses

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** medium (reviewer said low, verifier corrected) · **Size:** S
- **Location:** `packages/api/src/routers/course.ts:2060 (control match against the stale snapshot; create at 2119-2140); also 1976 (crossing points) and 2192 (courses)`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the path needs a database). Read /home/user/oxygen/packages/api/src/routers/course.ts:1836-2290 (importCourses), /home/user/oxygen/packages/api/src/iof-course-parser.ts:191-294, /home/user/oxygen/packages/api/src/ocd-course-parser.ts (grep of its Map usage), /home/user/oxygen/packages/api/prisma/schema.prisma:483-484 and 539-542, and grepped the migrations for unique indexes on controls/courses and docs/course-*.md / docs/map-*.md for a Pending or documented-limitation entry.

**What is wrong.** controlByKey and courseByName are snapshots taken before the loops and are not updated when a row is created. A second parsed control with the same id (or two starts whose ids end in the same digits, for example 'S1' and 'STA1', both named 'Start 1'), a second crossing point with the same Id, or a second course with the same name each create another row; the id maps keep the last one.

**Scenario.** An IOF file listing control 45 twice produces two live controls with code 45; the first stays in the bank unused, and code lookups (controlSeqToId, matching) become ambiguous.

**Proposed fix.** After each create, add the new row to controlByKey / existingControls / courseByName; or reject duplicate ids in the parsed data up front.

**Verifier's note on the fix.** - Either refuse or collapse duplicates before anything is written (the F32 check at 1897-1917 is the natural place), or register each created/updated row in the lookup inside the loop.
- For controls, register under both the lowercased `pc.id` and the synthesized name, so 'S1'/'STA1' collapse to one 'Start 1'.
- Crossing points use `existingControls.find`, not `controlByKey`, so they need their own handling.
- `courseByName` entries carry `{id, name, removed}`; a row added mid-loop needs that shape.
- A second course with the same name would then update the first and rewrite its structure (last wins); decide whether that or a BAD_REQUEST is wanted.
- `controlsCreated`/`controlsUpdated` and the `previewImport` counts (1782-1789) count parsed rows, so they would be off unless the dedup happens before both.
- Per CLAUDE.md, the spec (course-layer.md §6.4) is silent on duplicate ids, so the behaviour needs a user decision recorded there first.

<details><summary>Verifier's evidence</summary>

The claim holds as stated; I found no guard that prevents it.

- **Controls:** `controlByKey` is built once from `existingControls` (course.ts:1936-1960) and never written inside the loop. The match at 2060-2062 reads only that snapshot. The create branch (2119-2140) does `controlIdMap.set(pc.id, created.id)` and nothing else, so a second parsed control with the same id finds no match and creates a second row with the same `codes`. `controlIdMap` keeps the last one, so courses point to the second row and the first stays live (`removed: false`) and unused.
- **Starts/finishes:** 'S1' and 'STA1' both get the name 'Start 1' (2012-2016). They have different `pc.id`, neither is in the snapshot on a first import, so two 'Start 1' rows are created, each with its own allocated code.
- **Crossing points:** the lookup is `existingControls.find(...)` on the same pre-loop array (1976); a repeated Id creates a second `crossing_point` row (1993-1998).
- **Courses:** `courseByName` is built once (2148-2153) and not updated after `course.create` (2233-2250); a second course with the same name (case-insensitively) creates a second row, and `courseIdMap.set(pc.name, ...)` keeps the last.
- **No dedup upstream:** the IOF parser pushes every `<Control>` and `<Course>` without checking ids or names (iof-course-parser.ts:208-229, 233-293). The pre-write check at course.ts:1897-1917 only refuses codes held by a live start/finish.
- **No DB constraint:** controls have only `@@unique([eventId, seq])` (schema.prisma:483); courses have `[eventId, seq]` and `[parentCourseId, variantKey]` (539-540). No migration adds a unique index on control codes or course names.
- **Not documented as pending:** nothing in docs/course-*.md or docs/map-*.md lists duplicate ids in an import file as unimplemented.

Limits on the claim's reach:
- OCD imports cannot produce duplicate control ids: that parser keys controls and courses by Map (ocd-course-parser.ts:213, 293). It could still yield two courses whose names differ only by case.
- I did not check the Purple Pen parser for dedup.
- Re-importing the same file does not add more rows: both duplicates then resolve to an existing row via the snapshot.
- The trigger is a malformed file (repeated Control Id or Course Name), which standard exporters do not write.
- I did not trace the claimed downstream ambiguity in `controlSeqToId` or matching; the duplicate live rows themselves are proven.

</details>

### CRS-061 Finish-row distance is the straight line from the last control, even with a bent/marked finish leg or an unplaced last control

- **Area:** Course map printing and PDF · **Category:** functional · **Severity:** medium (reviewer said low, verifier corrected) · **Size:** S
- **Location:** `packages/shared/src/course-maps/resolve-layout.ts:343`
- **Status:** confirmed. Code read only (no reproduction run; the logic is a single expression). Read /home/user/oxygen/packages/shared/src/course-maps/resolve-layout.ts:252-262, 285-349; description-rows.ts:269-281; resolve-sheet.ts:63-121; course/derive.ts:73-82 and 217; callers packages/api/src/routers/courseMap.ts:347-366 and packages/api/src/course-maps/descriptions-pdf.ts:157-168; the editor twin packages/web/src/components/MapViewer.tsx:3587-3603; specs docs/course-editor.md:394-395, docs/course-maps.md:381-385, docs/course-print.md:684-688, docs/course-layer.md:624-632.

**What is wrong.** `finishLengthM` is `hypot(finish - lastControl) * mapScale / 1000` using `controlRows[last]` without checking that the control is placed, and without the stored leg's bends (`LegProps.bends`), which the course layer draws for a marked route to the finish.

**Scenario.** The last leg is a taped route with two bends (real length 180 m): the block prints '120 m' on the 14.1/14.2 finish row. If the last control is still at (0,0), the row prints the distance from the map origin (hundreds or thousands of metres).

**Proposed fix.** Skip the measurement when the last control is unplaced, and measure along the stored leg into the finish when the structure has bends for it (reuse the layer's leg-length helper used for `lengthM`), else the straight line. Unit test in resolve-layout.test.ts.

**Verifier's note on the fix.** resolveMapLayout has no access to the stored structure, so a fix must either pass the last leg's props (bends and crossing point `via`) in, or compute the length where the structure is available, using `legPolylineOf` + `legLengthMm` so curved bends are flattened the same way as the layer. The same straight-line formula is duplicated in packages/web/src/components/MapViewer.tsx:3587-3603 and must change together, or screen and print diverge. Add a placed check on the last control (xpos/ypos not both 0), and pick the last placed control of type control. The existing test packages/shared/src/__tests__/resolve-layout.test.ts:80 expects 600 for a straight leg and should stay valid. The spec is silent on bends for the finish row, so per the project rules the intended behaviour should be confirmed with the user and written into docs/course-editor.md §4 / docs/course-maps.md before implementing.

<details><summary>Verifier's evidence</summary>

Both halves hold in the code.

1. Bends ignored. resolve-layout.ts:343-349 computes `Math.hypot(finish.x - lastControl.x, finish.y - lastControl.y) * mapScale / 1000`. ResolveMapLayoutInput.course carries no structure, so the function cannot see `LegProps.bends`. The stored leg is only attached afterwards in resolve-sheet.ts:63-121 (`legPropsByIndex` / `courseInputOfLayout`) for drawing. The course layer measures the same leg along its bends and crossing point (derive.ts:217 `legPolylineOf(a, ... leg?.bends, b)`, `legLengthMm` at derive.ts:73), and docs/course-layer.md:627-628 says a leg's length is measured along its bends. So the printed finish-row figure can disagree with the leg length the editor shows and with the course length. description-rows.ts:269-281 rounds the value and prints it whenever `instructions.finish.lengthM` is blank, for every finish kind (14.1/14.2/14.3). The editor's on-map sheet has the same straight-line formula (MapViewer.tsx:3599-3601), so screen and print agree with each other but not with the bent leg.

2. Unplaced last control. `endControl` (resolve-layout.ts:253-254) returns null for a finish at (0,0), but course controls are not filtered: `rawControls = input.course?.controls` (line 290; the placed filter at 287-289 is only the all-controls/setter branch) and `layoutControlsFromCourseControls` (145-158) passes every row through. With the last control at (0,0), `lastControl` is truthy and the distance is measured from the map origin.

Not refuted by the specs: no 'Pending' entry covers this. The docs only say 'measured last-control -> finish distance' (course-editor.md:394-395, course-maps.md:384-385, course-print.md:686-687) and are silent on bends, so the straight line is arguably the documented behaviour for an unbent leg; the defect is the silent mismatch with the bends rule.

Mitigations that limit severity: an explicit finish length in the description instructions overrides the measured value (`finish.lengthM ?? measured`); the figure is informational on the description sheet and does not affect results or timing; a course with an unplaced control already prints visibly wrong (circle and legs drawn at the origin), so the wrong finish distance there is a secondary symptom.

</details>

### CRS-062 courseMap.list builds its own resolveMapLayout input and validates a different block than the one printed

- **Area:** Course map printing and PDF · **Category:** engineering · **Severity:** medium (reviewer said low, verifier corrected) · **Size:** S
- **Location:** `packages/api/src/routers/courseMap.ts:350-374 (descriptionRowCount at :386, consumed at :403)`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the logic is direct). Read packages/api/src/routers/courseMap.ts:330-407 (list), :227-271 and :500-570 (resolved/editorSheet path), packages/shared/src/course-maps/sheet-rows.ts:98-115 and :219-266 (rowForVariant, sheetInputForMapRow), resolve-layout.ts:94-108 and :340-381, description-rows.ts:144-270, validate.ts:168-191, and grepped docs/map-*.md and docs/course-*.md for a Pending entry (none found).

**What is wrong.** `list` hand-assembles the layout input instead of `sheetInputForMapRow` (which maps.pdf and resolveSheet use): it omits `crossings` (derived 13.3/13.4 rows) and always resolves the root's first-alternative controls, so `descriptionRowCount` passed to `validateCourseMap` is smaller than the printed block for courses with crossing legs and for variants with more controls than the first alternative. The 'description_outside_page' check can therefore pass while the printed block runs past the margin; any future field added to sheetInputForMapRow will drift the same way.

**Scenario.** A course with two crossing-point legs prints two extra 13.3 rows; the block ends 12 mm below the printable area on the variant page, but the sheet list shows it as valid.

**Proposed fix.** Resolve each row through `sheetInputForMapRow(row, ctx)` + `resolveMapLayout` (as resolveSheet does for siblings), and for a root take `max(descriptionRows.length)` over its live variants (rowForVariant) for the validation. Removes ~30 duplicated lines.

**Verifier's note on the fix.** Passing `crossings: layoutCrossings(row.course.structure, controlsForAll)` in `list`, or routing `list` through `sheetInputForMapRow`, fixes the crossing undercount only. For a root with variants the row count must be the maximum over each variant's resolved block (child courseControls and descriptionInstructions via `rowForVariant`), and arguably the all-variations page too. `sheetInputForMapRow` throws when the template is missing and parses overrides/objects with zod, so keep the `template_missing` branch ahead of it. `list` filters `allControls` for setter rows, which `setterSheetInput` already does. `list` currently passes `event` and `mapInfo` conditionally (nullable), whereas `MapRowContext` requires them.

<details><summary>Verifier's evidence</summary>

The claim holds for crossings, proved from the code.

- **List omits crossings.** `list` calls `resolveMapLayout` with a hand-built `course` object (courseMap.ts:350-374) containing name, lengthM, climbM, orderMode, ends, classes, controls and descriptionInstructions, but no `crossings`.
- **The printed path includes them.** `sheetInputForMapRow` passes `crossings: layoutCrossings(row.course.structure ?? null, ctx.allControls)` (sheet-rows.ts:252). It is the input for courseMap.resolved (courseMap.ts:521, :564) and for `sheetForMapRow` (sheet-rows.ts:307).
- **Crossings add rows.** resolve-layout.ts:370 forwards `input.course.crossings` to `buildDescriptionSheet`. `mergeDerivedSpecials` (description-rows.ts:144-165) pushes one 13.3/13.4 special per distinct anchor unless a hand-placed row of the same kind already sits at that anchor. Each special becomes a row (description-rows.ts:242-268).
- **The undercount reaches the check.** `list` sets `descriptionRowCount: layout.descriptionRows.length` (courseMap.ts:386) and passes it to `validateCourseMap` (:403). validate.ts:168-191 sizes the block from that count for `description_outside_page`. Two crossing legs with no hand-placed 13.3 make the list's block two cells shorter than the printed one.
- **Variant part also holds structurally.** `list` always uses the root row's `course.courseControls` and `descriptionInstructions`, while a variant page swaps in the child's via `rowForVariant` (sheet-rows.ts:98-115). The `variants` passed at :401 feed only the `control_outside_frame` check, not the row count. I did not verify that the root's controls are specifically the "first alternative".

Mitigations that limit the impact:
- The layout editor validates client-side with the correct count from courseMap.resolved (LayoutMode.tsx:470, fed by courseMap.ts:268), so the issue is flagged there.
- The list validation only drives the overview's issue count and `printStatus` "ready"/"issues" (useCourseMapsOverview.tsx:64-69). I found no print gate on it.
- The failure needs a description block within one or two cell heights of the printable margin plus derived crossing rows (or a longer variant).

The effect is a false "ready" status in the overview in an unusual configuration. There is no data loss and the printed output is not altered by this bug. The duplicated input assembly is a real drift risk.

</details>

### CRS-063 finishReceipt always returns empty classResults and null siac, so those receipt and kiosk sections are dead

- **Area:** Start/result lists and receipts · **Category:** engineering · **Severity:** medium (reviewer said low, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/routers/race.ts:301`
- **Status:** confirmed. Code read only, no reproduction needed. Read packages/api/src/routers/race.ts:150-310 (the whole finishReceipt handler), grepped every producer and consumer of `siac` and `classResults` across packages/, read the call sites (FinishStation.tsx:60-100 and 170-205, KioskPage.tsx:763-803 and 1078-1083), the storage side (cardReadout.ts:408-410, 512-523, 1049-1056, 1193-1195) and the docs that describe these sections.

**What is wrong.** `siac: null` and `classResults: []` are hard-coded. Both receipt builders have a SIAC battery block and a class-results block (escpos.ts:408-445, star-raster.ts:546-577), the kiosk has a class-results panel (KioskPage.tsx:1078), and every call site forwards the fields; escpos.test.ts:153 and :170 test output that production can never produce. Battery data is stored at readout (`voltageMv`, `batteryLow` in storeReadout).

**Scenario.** A SIAC card with a low battery is read out: the receipt has no battery line and the runner is not warned. The class top list never prints.

**Proposed fix.** Either populate both (latest card_readout voltage and battery date; top N of the class from the shared placement helper) or delete the fields, the builder blocks, the kiosk panel and their tests.

**Verifier's note on the fix.** Populate `siac` from the latest stored readout for the runner's card: voltageMv is in millivolts and must become volts, batteryLow maps to batteryOk, batteryDate comes from the readout metadata; only do this for SIAC cards. Populate `classResults` with a bounded top-N query on the same class and OK status with clubName joined; the handler was deliberately optimised to avoid fetching the whole class (comment at race.ts:200-212), so keep it a LIMIT query. Align the offline path, which currently sends clubName "" and ranks by index (FinishStation.tsx:198). Keep KioskPage.tsx:1083's highlight (`r.rank === position.rank`) consistent with tie handling. Fix or keep the escpos tests accordingly; the test file is packages/web/src/lib/__tests__/escpos.test.ts.

<details><summary>Verifier's evidence</summary>

The claim holds for every server-backed path; "dead" is overstated for the class-results print block, which the offline finish-station path does reach.

- Hard-coded return: race.ts:301-309 returns `siac: null as ... | null` and `classResults: [] as Array<...>` unconditionally. The handler never reads voltageMv/batteryLow and only runs two count queries for `position`; no top list is fetched.
- Battery data exists but is unused here: storeReadout persists `voltageMv` and `batteryLow` (cardReadout.ts:512-523); other endpoints expose them (cardReadout.ts:1049-1056, 1193-1195).
- Guarded consumers that can never fire from server data: escpos.ts:408 (`if (data.siac)`) and :425; star-raster.ts:546 and :561; KioskPage.tsx:1078, whose only source is `trpc.race.finishReceipt.useQuery` at :763.
- Call sites forwarding the dead values: FinishStation.tsx:90-91, CompetitionShell.tsx:307-308, RunnerManagement.tsx:84-85.
- Docs promise both: docs/ops/receipt-printer-setup.md:295-296 shows "SIAC 8007045 / Battery: 2.98V 2024-02-12 OK" and a class top list on the sample receipt; docs/system/registration-and-readout.md:659 lists "Class results table" on the kiosk readout screen. These are not map/course chapters, so no "Pending" section excuses them.

Corrections to the claim:
- Class results are not fully dead. The offline finish-station path builds `classResults` from localResult (FinishStation.tsx:198-203, fed by lib/offline/local-readout.ts:116 and :262), so the escpos/star-raster class-results blocks are reachable when offline.
- The SIAC block is dead everywhere: no call site ever sets a non-null `siac`.
- The test file is packages/web/src/lib/__tests__/escpos.test.ts (not receipt-printer/__tests__); the SIAC test is at :153.

Severity: medium, not high. This is a missing feature with dead code and a doc mismatch. Times, status and position are correct, and battery voltage is still visible to the organiser on the Cards page (CardsPage.tsx). The practical cost is that the runner gets no low-battery line on the receipt and the kiosk and online receipts lack the top list.

</details>

### CRS-064 Results and start list group classes in data order, not class sort order, and merge classes by name

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** medium (reviewer said low, verifier corrected) · **Size:** S
- **Location:** `packages/web/src/pages/ResultsPage.tsx:63`; also packages/web/src/pages/StartListPage.tsx:72
- **Status:** confirmed. Code read plus a standalone node reproduction of the pure logic (server sort and placing from lists.ts, client sort and grouping from ResultsPage.tsx).

Code read:
- /home/user/oxygen/packages/api/src/routers/lists.ts:93-98 — `resultList` calls `runner.findMany` with no `orderBy` and selects only `name, seq, courseId` from the class (no `sortIndex`).
- lists.ts:~178-184 — the result is sorted globally: OK runners first, then by running time; non-OK runners keep DB order.
- lists.ts:~187-197 — places are computed per `classId`.
- /home/user/oxygen/packages/web/src/pages/ResultsPage.tsx:61 — default sort is `place asc` via `useSort`.
- /home/user/oxygen/packages/web/src/hooks/useSort.ts:110-115 — a stable `[...items].sort`, so ties on place keep the server's global running-time order.
- ResultsPage.tsx:63-69 — grouping into a `Map` keyed by `entry.className`, rendered in insertion order at line ~100 with `key={className}`.
- /home/user/oxygen/packages/web/src/pages/StartListPage.tsx:72-81 — the same Map-by-`className` grouping; default sort is `startNo`, server order is `startTime, startNo` (lists.ts:39).
- /home/user/oxygen/packages/api/prisma/schema.prisma, model Class — has `sortIndex` and `@@unique([eventId, seq])` but no unique constraint on name. `classRouter.ts:110` orders by `sortIndex` elsewhere, so the intended order exists and is simply not used here.
- Neither page has any print-specific code path that reorders classes.

**What is wrong.** Classes are grouped by `className` in the order entries first appear in the sorted array. `resultList` sorts OK runners globally by running time, so class order follows whichever class has the fastest runner and changes during the event; two classes with the same name are merged into one table with two sets of placings. StartListPage.tsx:72-81 has the same grouping.

**Scenario.** A browser print of the results page during the prize ceremony lists classes in a different order than the programme, and the order differs between two printouts taken ten minutes apart.

**Proposed fix.** Group by `classId` and order the groups by the class `sortIndex` (available from `competition.dashboard` already fetched on the page, or return it from the endpoint).

**Verifier's note on the fix.** - `ResultEntry` and `StartListEntry` do not carry `sortIndex`, and `ResultEntry` grouping has no usable class key on the client; the API (lists.ts) must expose class `sortIndex` (and `classId`) or return entries pre-ordered by class.
- Group by class id (seq), not by name, and order groups by `sortIndex` then name. Column sorting must only reorder rows within a class.
- The React `key={className}` must change to the class id as well.
- Runners with no class (`className ""`, `classId 0`) need a defined position.
- StartListPage's flat view should stay unaffected.
- Other consumers of `resultList` (FinishStation, CardReadout, RunnerInlineDetail, useEventQueue, DeviceManager) may rely on the current global order; check them before changing the server-side sort.

<details><summary>Verifier's evidence</summary>

Reproduction output (node script copying the server sort/placing and client sort/grouping):

1. Three classes, H10 with no finisher yet: `['H21:1', 'D21:1', 'H10:0']`.
2. Same data after one H10 runner finishes in a short time: `['H10:1,0', 'H21:1', 'D21:1']`. The class order changed because of a single new finisher.
3. Two distinct classes (different `classId`) both named "Open": `['Open:1,1,2']`. They merge into one table with two first places.

Results page: with the default place sort, all place-1 entries come first and tie in the server's global running-time order. Class order is therefore the order of the winners' times (shortest winning time first), followed by classes with no classified runner in unspecified DB order. `Class.sortIndex` is never consulted. The order changes whenever a class gets its first finisher or its winning time changes relative to another class.

One correction to the claim's wording: the order follows each class's winning time, not "whichever class has the fastest runner" in a looser sense. That is the same mechanism, and it does change during the event.

Start list: class order is the order of the lowest `startNo` per class (or of whichever column the user sorts by), not `sortIndex`. It is stable over time, unlike the results page, but still not the class sort order. The same-name merge applies there too.

Limits on impact: placings and times inside each class are correct. The same-name merge needs two classes with identical names in one event, which is unusual. I did not check whether class creation or import paths reject duplicate names at the application level; the schema does not.

</details>

### CRS-065 Any successful write clears a pending conflict notice, discarding the user's Keep mine / Keep theirs choice

- **Area:** Web course editor: pages · **Category:** functional · **Severity:** medium (reviewer said low, verifier corrected) · **Size:** S
- **Location:** `packages/web/src/pages/editor/EditorPage.tsx:341`
- **Status:** confirmed. Code read only (no reproduction; node_modules absent and the logic is React state). Read /home/user/oxygen/packages/web/src/pages/editor/EditorPage.tsx:336-363 (`run`), :380-396 (outbox notice effect), :740-760 (`createSite`), :800-819 (`handleMoveEnd`), :2190-2204 (undo/redo), :2827-2861 (notice buttons), and docs/course-editor.md:298-315 (§3 conflict table).

**What is wrong.** `run` calls `setNotice(null)` after every successful op. A direct (non-queued) `moved` notice, or a structure refresh notice naming the differing items, disappears as soon as any other write succeeds: the next gesture, an undo, or the nested `run` of `upsertConfig` in `createSite` (line 752).

**Scenario.** A drags control 40; B had moved it, so the notice "Moved by Anna at 12:41 … Keep mine / Keep theirs" appears. Before answering, A ticks *hide number* on another control. That write succeeds, the notice vanishes, A's position for 40 is dropped (their position stays) and the save indicator returns to Saved.

**Proposed fix.** Clear a notice only when the successful op concerns the same row (pass the row to `run`), or keep `moved` notices until answered, as the queued-entry path already does (lines 382-396).

**Verifier's note on the fix.** The fix cannot simply delete `setNotice(null)` from `run`. Keep mine on a direct notice depends on it to dismiss the notice after its re-send succeeds (:2845), and a new successful move of the same control should also settle it (the spec says so for queued moves, docs/course-editor.md:1807). Clear only when the successful op is the notice's own resolution or a move of the same `controlId`, or clear explicitly in the Keep mine handler. The e2e tests in e2e/course-editor-status.spec.ts (:76, :108) expect the notice to be gone after a later successful write, so check them against the new rule. The refresh notice has the same problem when the nested `run` calls in `createSite` (:752, :758) succeed after an earlier failure.

<details><summary>Verifier's evidence</summary>

The claim holds for direct (non-queued) notices.

- `run` clears the notice unconditionally on any successful op: EditorPage.tsx:340-341 `const out = await op(); setNotice(null);`. There is no check of notice kind, control id, or whether the op relates to the notice.
- A direct `moved` notice keeps the user's position only in React state: :347 `setNotice({ kind: "moved", controlId, mine, theirs })`. The server refused that write, and no undo entry is recorded because `handleMoveEnd` returns when `run` yields undefined (:817). Clearing the notice therefore drops `mine` with no way to recover it.
- Nothing blocks other gestures while the notice is up. It is a small non-modal box (:2828), and about 30 call sites go through `run`, including undo/redo (:2197, :2204) and the nested `upsertConfig` in `createSite` (:752).
- Only queued notices survive: the effect at :387-390 re-raises a notice from an outbox entry still in `conflict`. A direct notice has no `queueSeq` and no backing entry, so it stays gone.
- The save indicator does return to Saved: :2509 gives `conflict` only while `notice` is set.
- The spec (docs/course-editor.md:304, 307) says the moved notice offers Keep mine / Keep theirs and the structure notice names the differing items. It does not say an unrelated write settles it, and no "Pending" section covers this.

Two limits on the claim:
- The specific "hide number" path was not traced, but every editor write goes through `run`, so any successful write triggers it.
- "Discarding the choice" amounts to an implicit Keep theirs. The server state stays consistent (their position); what is lost is one unsaved drag on the user's side, plus the informational refresh notice.

Severity: medium, not higher. It needs a concurrent edit of the same control and the user acting elsewhere before answering. Nothing stored is corrupted, and the control is redrawn at their position after the invalidate.

</details>

### CRS-066 control.list reads every course_controls row of the whole database

- **Area:** Course data and course/control API · **Category:** performance · **Severity:** low (reviewer said medium, verifier corrected) · **Size:** S
- **Location:** `packages/api/src/routers/control.ts:591`
- **Status:** confirmed. Code read only (no reproduction; node_modules absent and no database allowed). Read packages/api/src/routers/control.ts:575-650, packages/api/src/trpc.ts:147-164 and 312, packages/api/prisma/schema.prisma:548-566 (CourseControl) and the Course model (eventId, parentCourseId, removed), packages/api/src/routers/course.ts:1235-1252 and 1918-1936, packages/api/src/course-variants.ts:261, and the web callers of control.list.

**What is wrong.** `ctx.db.courseControl.findMany({ select: { controlId, courseId } })` has no where clause, so each control.list call loads the course_controls of all events on the instance into Node and builds a map of them. No data leaks (rows are joined by the event's own control ids) but the cost grows with the number of events, and removed courses and variant children are counted into runnerCount.

**Scenario.** A club instance with 150 past events (about 40 courses x 20 controls each, plus variants) returns ~120,000 rows on every control.list; the Controls page and the course editor refetch it after each edit and on the watermark poll, so a setter dragging controls triggers repeated 100k-row scans and allocations on the laptop serving the event.

**Proposed fix.** Add `where: { course: { eventId, removed: false } }` (or `controlId: { in: controls.map(c => c.id) }`). Size S. While there, count runners with the same rule as control.detail (runner.courseId first, class course otherwise).

**Verifier's note on the fix.** CourseControl has no eventId; scope with `where: { course: { eventId } }` (or `controlId: { in: controls.map(c => c.id) }`, which uses the existing @@index([controlId])). If the removed-course count is to be fixed too, add `course: { removed: false }` — that changes runnerCount for classes still pointing at a removed course, so treat it as a behaviour change with its own test. Variant children need no filter for runnerCount, since classes reference the root.

<details><summary>Verifier's evidence</summary>

The unscoped read is real. control.ts:591-593 is `ctx.db.courseControl.findMany({ select: { controlId: true, courseId: true } })` with no where clause, while every neighbouring query in the same handler is scoped by eventId (control 578, controlUnit 582, class 601, runner 617). Nothing scopes it elsewhere: trpc.ts:156 sets ctx.db to the singleton `prisma()` client (comment at 163: "the singleton Prisma client"), with no per-event extension, and course_controls is one table in the shared `oxygen` schema holding all events (Course carries eventId). CourseControl has no eventId column, so the fix needs a relation filter; lease.test.ts:881 already uses `where: { course: { eventId } }`. No data leak: the result is only looked up by the event's own control ids (control.ts:628).

Call frequency is as claimed for the editor: EditorPage.tsx:323-325 invalidates control.list after every write; ControlsPage.tsx invalidates it after each mutation (98, 105, 293, 310, 662, 668); CoursesPage.tsx:402 too. useStationSync.ts:64 keeps it at staleTime 60s on station pages. I did not verify the "watermark poll" refetch path.

The runnerCount sub-claim is only partly right:
- Variant children: not shown. Runners are summed through class.courseId (control.ts:600-610), and classes sit on the root course (course-variants.ts:261), not on children, so child rows add map entries but no runners.
- Removed courses: plausible. course.delete (course.ts:1235-1250) sets removed: true without clearing class.courseId or deleting course_controls, so a class still pointing at a removed course keeps contributing its runners. The import replaceAll path does clear class.courseId (course.ts:1932-1935).

Severity: the claimed scenario (150 events, ~120,000 rows) is hypothetical. Each row is two UUIDs; a sequential scan plus Prisma deserialisation of that size is on the order of a few hundred milliseconds and tens of MB transient, per call. That is a latency cost that grows with instance history, not a failure or wrong result. A typical instance with a handful of events sees a few thousand rows. I rate it low, not higher.

</details>

### CRS-067 Description-block header text is never fitted: long event names and class lists overflow the 8-cell block

- **Area:** Course map printing and PDF · **Category:** functional · **Severity:** low (reviewer said medium, verifier corrected) · **Size:** M
- **Location:** `packages/shared/src/print/description.ts:172`
- **Status:** confirmed. Code read only. /home/user/oxygen/packages/shared/src/print/description.ts:172-179 (the `text` helper) and :203-218 (header/title calls); /home/user/oxygen/packages/shared/src/render/text.ts:33-35, 150 (em size = fontSizeUm; wrapping only when the object carries a box); /home/user/oxygen/packages/shared/src/course-maps/description-rows.ts:225-226 and resolve-layout.ts:351-352 (unbounded inputs); both callers (course/page-layer.ts:102, print/description-sheet.ts:171) add no clip; docs/course-print.md §6.2 and its "Pending in this chapter" (line 1964 on). Widths computed by hand from Arial/Liberation Sans Bold advance widths; not rendered, since node_modules is absent.

**What is wrong.** `descriptionBlock` draws `h.eventName`, `h.classNames` (every class of the course joined with ', '), `h.courseName`, and the title at a fixed size (0.40-0.48 x cell) centred on a point, through a text symbol without any width limit or shrink. The block is 8 x cell wide (48 mm at 6 mm; 40 mm on 5 mm setter sheets), which holds roughly 34 bold characters at 6 mm.

**Scenario.** A course shared by eight classes ('H21, D21, H20, D20, H18, D18, H35, D35', 38 characters) or an event named 'Stockholm City Cup 2026 - deltävling 3': the header line runs out of both sides of the white block, over the map detail next to it on maps.pdf and into the neighbouring block on descriptions.pdf (5 mm gap). Course name in its 3-cell field overflows from about 12 characters ('Öppen motion 5').

**Proposed fix.** In the `text()` helper take a `maxWidthMm` (W minus padding for full-width rows, 3 x cell / 2 x cell for the course/length/climb fields), measure the string with the bundled face metrics (the composer already has `fonts`; pass a measure callback into `descriptionBlock`) and scale the font size down to fit, with a floor after which the text is ellipsised. Add a unit test in description.test.ts and a golden for a long class list.

**Verifier's note on the fix.** - The fix belongs in the `text()` helper (description.ts:172-179): give it a max width per call (W, or 3 / 3 / 2 cells for the third header row, minus padding) and shrink or ellipsise.
- Measuring needs font metrics, which `descriptionBlock` does not currently receive; only `symbolise` gets `fonts`. Either pass metrics in, or add a fit-width option to the text symbol/object in the shared shaper.
- The symbol cache key is `text/${sizeUm}/${bold}`, so a shrunk size creates extra symbols. That is fine, but the tests in print/__tests__/description.test.ts that count symbols may need updating.
- §6.2 of docs/course-print.md states the fixed sizes as normative ("formula for formula"). Per CLAUDE.md the spec must be updated first and the user asked, because the spec is silent on long text.
- Severity is low to medium: the output is cosmetic (text over a rule or the block edge, never wrong data) and occurs only with unusually long names or many classes per course. The claim's own two headline examples fit.

<details><summary>Verifier's evidence</summary>

The mechanism is real, but the claim's two headline examples do not actually overflow.

**Mechanism (proved from code)**
- `text()` in description.ts:172-179 emits a point-anchored object (`makePath([X(cx), Y(baseline)])`) with a centre-aligned text symbol at fixed size `cell * sizeFactor`. It has no box, no width limit and no shrink.
- text.ts:150 wraps only when a box is present (`box ? wrapParagraph(...) : [p]`), so header text is one unbounded line.
- Header calls: event name at 0.42 (line 206), class list at 0.40 (line 208), course name at 0.40 centred in a 3-cell field (line 212), title at 0.48 (line 217).
- `classNames` is every class of the course joined with ', ' (description-rows.ts:226, fed from resolve-layout.ts:352); the event name is `event.name` unbounded.
- Neither caller clips to the block. The description-sheet grid places blocks side by side with only `gapMm` between them.
- The spec (course-print.md §6.2) describes the fixed sizes "formula for formula" from the legacy SVG block. It says nothing about long text, and nothing in "Pending in this chapter" covers it, so it is not a documented not-implemented item.

**Capacity (independent of cell size, since font and block both scale with the cell)**
- Block width is 8 cells: 19.05 em for the event name, 20 em for the class list, 16.7 em for the title.
- The course-name field is 3 cells: 7.5 em.

**The claim's examples, measured with Liberation Sans Bold advances**
- 'H21, D21, H20, D20, H18, D18, H35, D35' is about 18.6 em. It fits within 20 em (about 44.6 of 48 mm at 6 mm cells).
- 'Stockholm City Cup 2026 - deltävling 3' is about 18.4 em. It fits within 19.05 em, barely.
- 'Öppen motion 5' is about 7.6 em against 7.5 em. It touches or just crosses the column rule, by about 0.25 mm.

**Where it does overflow**
- Nine or more three-character classes on one course.
- A few long class names, e.g. 'Öppen motion 5, Öppen motion 7, Inskolning' at about 22 em.
- Event names over roughly 37-40 characters.
- Course names over roughly 12-13 characters in the 3-cell field.

The claim's "roughly 34 bold characters" capacity is slightly pessimistic; about 36-40 mixed characters fit.

</details>

### CRS-068 copies=runners counts withdrawn runners and ignores vacancies and unassigned variants, unlike the description sheets

- **Area:** Course map printing and PDF · **Category:** functional · **Severity:** low (reviewer said medium, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/course-maps/routes.ts:207`; also packages/api/src/course-maps/descriptions-pdf.ts:143-149 (the other rule)
- **Status:** confirmed. Code read only, no reproduction (no node_modules, and the logic is a DB query). Read packages/api/src/course-maps/routes.ts:205-219 (selectPrintPages sizing), packages/api/src/course-maps/descriptions-pdf.ts:136-149 (selectDescriptionBlocks), packages/shared/src/types.ts:60-62 (WITHDRAWN_STATUSES), docs/course-print.md:425-434 and 691-692, docs/course-layout.md:668 and 917-920, packages/web/src/lib/editor/export-menu.ts:75-82.

**What is wrong.** `selectPrintPages` sizes hand-out stacks from `runner.groupBy` with only `removed: false`. descriptions.pdf (`selectDescriptionBlocks`) counts runners not in WITHDRAWN_STATUSES plus the class's `vacantCount`. So the two exports for the same class disagree. Also, on a root with variants a runner whose `course_id` is still NULL matches no variant page (`g.courseId ?? classCourse` is the root, never a child) and is silently left out as long as any other page has copies.

**Scenario.** Class D21: 30 entered, 2 withdrawn (DNS reported), 5 vacant places sold on the day. Description sheets: 33 copies. `maps.pdf?classes=…&copies=runners`: 30 maps, two of them for withdrawn runners; the five vacancy runners have no map unless someone remembers `spare=`. On a forked class where 3 late entries have no variant yet, three maps are missing with no message.

**Proposed fix.** Use the same counting rule in both places: filter the groupBy with `status: { notIn: WITHDRAWN_STATUSES.map(valueToRunnerStatus) }`, add `class.vacantCount` to plain-course/class pages (for variant pages decide and document: e.g. spread or add to a 400/notice), and when a selected root has runners with NULL `course_id`, fail with a 400 naming the count ('3 runners in H21 have no variant assigned') or report it as a warning header. Update docs/course-print.md §4.6 and variant-pages.test.ts.

**Verifier's note on the fix.** Any change of the count rule deviates from docs/course-print.md §4.6 (lines 425-434), so it needs a user decision, a spec edit and a decision-log row first.

- **Cancelled runners:** excluding `WITHDRAWN_STATUSES` must also be applied to `course.variantList.runnerCount` and the export-menu label and disabled state, which are documented as the same count. variant-pages.test.ts and print-job.test.ts assert the current page counts.
- **Vacancies:** they cannot be attributed to a variant on a forked class, so they only make sense for plain course or class pages, or stay with `spare=`.
- **Unassigned runners on a root:** the least invasive fix is a warning or an unassigned count, not guessing a variant.

<details><summary>Verifier's evidence</summary>

The three code facts hold, but the behaviour is what the spec says and the scenario is overstated.

**What the code does**
- routes.ts:207 sizes stacks with `db.runner.groupBy({ by: ["courseId","classId"], where: { eventId, removed: false } })`. There is no status filter and `vacantCount` is not read.
- routes.ts:211-214: `runnersOf` matches `(g.courseId ?? classCourse.get(g.classId)) === courseId`. On a root with variants the pages carry `runnerCourseId: kid.id` (routes.ts:199), so a runner with `course_id` NULL resolves to the root id and matches no page.
- routes.ts:216 only throws when the total is 0, so those runners are dropped without a message whenever any other page has copies.
- descriptions-pdf.ts:143 filters `status notIn WITHDRAWN_STATUSES`, and line 149 adds `c.vacantCount`. The two exports do use different counting rules.

**Why it is not a spec violation**
- docs/course-print.md:425-434 specifies exactly this for maps: "a variant page per non-removed runner with runner.course_id = the child (the count course.variantList.runnerCount shows) ... plus spare".
- docs/course-print.md:691-692 specifies runners + vacancies for description sheets. The divergence is a documented design choice per export.
- It is not listed under a Pending section. docs/course-layout.md:917-920 only lists the named per-runner map and a spare count in the menus.

**Where the scenario is overstated**
- `WITHDRAWN_STATUSES` is only `RunnerStatus.Cancel` (types.ts:60-62). DNS runners are counted by both exports, so "2 withdrawn (DNS reported)" is wrong; only cancelled entries get a surplus map.
- `vacantCount` is a count of reserved places, not runners. The specified mechanism for extra maps is `spare=`, which applies per page.
- The only UI entry using `copies=runners` is "One map per runner" on a root (export-menu.ts:75-82). Its label shows the assigned-runner count and it is disabled at 0, so the unassigned omission is visible as a lower number, though not flagged explicitly. `classes=…&copies=runners` is reachable only by hand-written URL.

**Net effect**
- A few surplus maps for cancelled entries.
- No vacancy maps without `spare=`.
- Runners on a forked course with no variant yet get no map and no warning. No single variant page could be chosen for them anyway.

</details>

### CRS-069 resultList recomputes every runner's punch match on every request and the page refetches it after each readout

- **Area:** Start/result lists and receipts · **Category:** performance · **Severity:** low (reviewer said medium, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/routers/lists.ts:141 (the FinishStation invalidate is at packages/web/src/pages/FinishStation.tsx:122, not :120)`; also packages/api/src/routers/lists.ts:44 (startList groups the whole punch table per request)
- **Status:** confirmed. Code read only, no reproduction run (node_modules absent; cost was not measured). Read packages/api/src/routers/lists.ts:77-200, packages/api/src/routers/course.ts:331-367, packages/web/src/pages/ResultsPage.tsx:33 and :161, packages/web/src/context/DeviceManager.tsx:503-517, packages/web/src/pages/FinishStation.tsx:122, packages/web/src/main.tsx:19-27, and grepped packages/web/src for refetchInterval / WebSocket / EventSource / useSubscription to see whether other clients are pushed a refetch.

**What is wrong.** Each call loads every runner and every card's `punchesRaw`, resolves expected positions one course at a time (`await` in a loop, lines 141-146, one query with a control join per course), then parses and matches punches for every runner (149-168) only to get `runningTimeAdjustment`, which is non-zero only on courses with a no-timing position. ResultsPage.tsx:33 always requests the whole event (no classId) and renders every row with a ClubLogo, and `lists.resultList` is invalidated after every readout and finish (DeviceManager.tsx:516, FinishStation.tsx:120).

**Scenario.** 2,000 runners on 40 courses, readouts every few seconds, three laptops with the Results page open: each readout triggers three full recomputations (40 sequential queries plus 2,000 parse-and-match passes) and three full-table re-renders, on the same laptop that serves the readout.

**Proposed fix.** Resolve all courses in one `courseControl.findMany({ where: { courseId: { in } } })`; skip matching for courses with no `noTimingLeg` position (adjustment is 0 by definition); only fetch cards for runners on the remaining courses. Optionally persist the adjustment on the runner at applyResult time. On the page, render classes lazily or collapse them.

**Verifier's note on the fix.** A fix should stay cheap and not change results:
- Replace the per-course loop with one `courseControl.findMany({ where: { courseId: { in: [...] } } })` grouped in memory.
- Skip card loading and matching for courses whose expected positions have no `noTimingLeg`. Keep the BadNoTiming propagation from course.ts:362, which sets `noTimingLeg` on the following position.
- Free-order courses must still pass `orderMode` to the matcher.

Do not design around cross-client invalidation fan-out; it does not exist. Other Results pages are in fact stale until focus or remount, which is a separate freshness question.

<details><summary>Verifier's evidence</summary>

The server-side facts hold, but the claimed scenario is overstated.

What holds:
- lists.ts:93-98 loads every runner of the event (or one class) and lists.ts:108-117 loads `punchesRaw` for every card, on every call. There is no caching.
- lists.ts:141-146 awaits `resolveCourseExpectedPositions` once per course in a loop; each is a `courseControl.findMany` with `include: { control: true }` (course.ts:335-339).
- lists.ts:149-168 runs `parsePunches` and `matchPunchesToCourse` for every runner with a card, keeping only `runningTimeAdjustment`. docs/course-controls-and-matching.md:283 states this is non-zero only for NoTiming/BadNoTiming positions; there is no short-circuit for courses without one.
- ResultsPage.tsx:33 calls `trpc.lists.resultList.useQuery()` with no classId and renders a ClubLogo per row (:161), with no virtualisation.
- `utils.lists.resultList.invalidate()` is called at DeviceManager.tsx:516 and FinishStation.tsx:122 (the claim says :120).
- startList (lists.ts:44-47) does a `punch.groupBy` on cardNo over the whole event per request.
- Nothing in docs/map-*.md or docs/course-*.md lists this as pending.

What does not hold:
- `invalidate()` is a React Query call local to the browser that performed the readout. ResultsPage has no `refetchInterval`, and there is no WebSocket, SSE or subscription pushing invalidations to other clients. Three other laptops showing Results do not refetch on someone else's readout; they refetch only on mount, on window focus after the 5 s staleTime (main.tsx:22), or on their own mutations.
- So a readout triggers at most one recomputation, and only if the reading browser itself has the Results page mounted (an inactive query is only marked stale). "Three full recomputations and three full re-renders per readout" is wrong.
- The per-request work is bounded: about 43 + N_courses indexed queries and an in-memory match of roughly 2,000 short punch lists. My estimate is on the order of 100 ms at the claimed scale, not a failure.

The real defect is avoidable per-request work that grows with event size: a sequential N+1 over courses and matching for courses that have no no-timing position. No wrong results and no failure in normal use.

</details>

### CRS-070 Climbs cleared by a landing automatic route stay empty until the whole event refresh has finished

- **Area:** Elevation, climb, leg routes, route finder (PR #254) · **Category:** functional · **Severity:** low (reviewer said medium, verifier corrected) · **Size:** S
- **Location:** `packages/api/src/leg-routes-auto.ts:214`
- **Status:** confirmed. Code read only (no reproduction: node_modules is absent and the search was not timed). Read packages/api/src/leg-routes-auto.ts:167-231 (refreshAutoRoutes), packages/api/src/course-geometry.ts:321-327 (clearComputedClimbs), packages/api/src/course-climb.ts:100-147 (computeMissingClimbs / refreshComputedClimbs), packages/api/src/leg-routes-auto-worker.ts:17-25, packages/shared/src/route/leg.ts:79-135 (window and cell count), packages/api/src/trpc.ts:181-182 (enqueue), and docs/course-elevation.md §7.5 plus "Pending in this chapter" (lines ~750-795, 1296-1306).

**What is wrong.** Each chunk's transactions clear the computed climb (climb_m = 0, source NULL) of the courses on a changed pair, but refreshComputedClimbs runs only once, in the `finally` after the last chunk. Chunks are 20 pairs each, searched sequentially with two full-grid Dijkstra passes per searched pair and up to 5 minutes per chunk. For a sprint or a large import that is minutes during which the affected courses have no stored climb. Readers (description sheet, course-map header, IOF/Purple Pen export, Eventor push, checkout snapshot) read climb_m as stored. The spec's Pending only names a restart between clear and compute, not this normal-operation window.

**Scenario.** Import courses on a sprint map (a few hundred pairs, almost every straight leg touches a building or fence). For several minutes after the import returns, courses whose first chunk landed show and print no climb. A PDF or IOF export, an Eventor start-list push or an event checkout made in that window carries no climb for them. After a checkout the venue copy stays empty until someone opens the course in the editor there.

**Proposed fix.** Recompute per chunk: collect the course ids cleared in the chunk and call refreshComputedClimbs(db, eventId, ids) right after the chunk's writes (keep the finally as a safety net). Better, compute the new climb inside the same per-pair transaction so the stored value goes old to new without an empty state. Test: a two-chunk refresh with an injected search asserts that chunk 1's courses have a climb before chunk 2 resolves.

**Verifier's note on the fix.** Compute per chunk instead of once at the end: collect the course ids cleared in the chunk and call refreshComputedClimbs(db, eventId, ids) after that chunk's writes. Keep the finally as a safety net for an early exit. computeMissingClimbs only touches courses with an open climb (climb_m = 0 and source not computed) and takes one row lock per course, so a per-chunk call is safe. A course whose pairs span several chunks will be cleared and recomputed more than once, with a course.upserted journal entry each time; passing only the cleared ids keeps that bounded. Alternatively, update the spec text or add this window to Pending if the behaviour is accepted.

<details><summary>Verifier's evidence</summary>

The mechanism is as claimed.

- leg-routes-auto.ts:181-224 loops over chunks of AUTO_ROUTE_CHUNK = 20 (line 31). Each pair is written in its own transaction, and line 214 calls clearComputedClimbs(tx, eventId, p.courses) when a chosen automatic row's vertices changed.
- clearComputedClimbs (course-geometry.ts:321-327) sets climbM = 0 and climbSource = null and commits with that pair's transaction. Its markClimbPending is dropped here because the refresh runs outside a request scope.
- The only recompute is leg-routes-auto.ts:225-227: `finally { if (cleared) await refreshComputedClimbs(db, eventId); }`, after the last chunk. Nothing computes between chunks.
- So a course cleared in chunk 1 has no stored climb until chunks 2..N have been searched and written. With 20 or fewer stale pairs the window is only that chunk's own writes (milliseconds). It only matters for refreshes of more than 20 stale pairs: an import, an out-of-bounds object applying to all courses (it changes every pair's basis), or an AUTO_ROUTE_VERSION bump.

It is not covered by the spec's Pending. That section names only "a refresh cut off by a restart between its clear and its compute". The spec body states the behaviour as implemented ("the climbs are computed again when the refresh ends"), but the same section and the file header promise "until it lands the climb is read as before" and "Between an edit and the route's landing the climb is read along what is stored", which the multi-chunk window contradicts.

What limits the impact:
- No wrong value is ever stored, only an absence, and it self-heals at the end of the refresh, including when the refresh ends in an error (the finally).
- Any edit of the course, or opening it in the editor (course.refreshClimbs, EditorPage.tsx:1977-1996), recomputes it earlier.
- A new row without vertices clears nothing, so only pairs whose straight line is blocked trigger a clear.
- "Minutes" is an upper bound, not the typical case. Sprint legs are short, so the window is small (pad = max(10 mm, half the leg), 0.25 mm cells, leg.ts:79-93), around tens of thousands of cells per pair. A few hundred sprint pairs is more likely tens of seconds, though this was not measured. The 5-minute figure is a per-chunk timeout, not an expected duration. Multi-minute windows need many long blocked legs (forest maps near the 1.2 million cell cap, "a long leg is a few seconds").

The harm needs an export, print, Eventor push or checkout to fall inside that window right after a bulk change. The climb is then missing, not wrong.

</details>

### CRS-071 One failing pair blocks its whole chunk of 20 on every refresh; failures are only a console.warn

- **Area:** Elevation, climb, leg routes, route finder (PR #254) · **Category:** stability · **Severity:** low (reviewer said medium, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/leg-routes-auto.ts:185-193 (the per-chunk catch); packages/api/src/leg-routes-auto-worker.ts:20 is the secondary site`; also packages/api/src/leg-routes-auto.ts:186-193
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent). Read /home/user/oxygen/packages/api/src/leg-routes-auto-worker.ts:17-33, /home/user/oxygen/packages/api/src/leg-routes-auto.ts:99-128, 131-151, 168-231, 239-256, /home/user/oxygen/packages/shared/src/route/leg.ts:76-141, /home/user/oxygen/docs/course-elevation.md §7.5 (lines ~757-774) and its "Pending in this chapter" section, and the test at /home/user/oxygen/packages/api/src/__tests__/integration/leg-routes-auto.test.ts:220-245. Grepped packages/shared/src/route/*.ts (non-test) for `throw`: no hits.

**What is wrong.** searchAutoRoutes maps all jobs of a chunk in one try: an exception in one job (or one job that pushes the worker past the 5 minute timeout in leg-routes-auto.ts:33) rejects the whole chunk, and refreshAutoRoutes (line 190-193) skips all 20 pairs. The stale list is rebuilt in the same deterministic order on the next refresh, so the same 20 pairs are grouped again and fail again on every later edit, each time costing the full search or timeout. Nothing is recorded per pair and the only signal is one console.warn per refresh with the first error.

**Scenario.** One leg of an event hits a pathological geometry (a search that throws, or a 1.2M-cell window that takes too long with 19 other searches before it). Its 19 chunk-mates never get an automatic route, so their climbs stay read along straight lines through lakes and fences. Every course edit starts the chunk again, burning up to 5 minutes of a core on the event laptop. Nobody is told.

**Proposed fix.** In the worker catch per job and return a per-job result ({ ok, points } | { error }); in refreshAutoRoutes write the successful pairs and leave only the failed one. On a chunk timeout or crash retry its pairs singly once. For a pair that failed, store its basis with a failure marker (or keep an in-memory failed-basis set) so it is not retried until its basis changes, and log the pair's control ids with the error.

**Verifier's note on the fix.** The spec sentence in docs/course-elevation.md §7.5 ("a worker that fails or runs past five minutes leaves its pairs for the next refresh") and the test at leg-routes-auto.test.ts:220 describe the current chunk-level behaviour. Any fix (per-job try/catch in the worker returning a per-job error, or retrying a failed chunk split or one pair at a time) must update that spec section first and keep the test's "left for the next refresh" expectation coherent. A per-job catch does not help the timeout path: that needs a per-job time budget or a retry with smaller chunks. A pair that fails deterministically would still be re-searched on every refresh unless its failure is recorded against its basis, and a new column would need a migration. Keep the `routes[i]` index alignment with the chunk (auto.ts:194-196), where null already means "no way".

<details><summary>Verifier's evidence</summary>

The mechanism is real, but no trigger was found and the claimed cost is overstated.

**What holds**
- `searchAutoRoutes` (worker.ts:20) runs all jobs in one `data.jobs.map`; the only try/catch is around the whole call (worker.ts:28-32), so one throwing job posts a single `error` for the batch.
- `refreshAutoRoutes` (auto.ts:185-193) catches per chunk and `continue`s, so none of that chunk's pairs get a row or an `autoBasis`.
- The stale list is `found.pairs.filter(...)` (auto.ts:173). `pairsOf` builds it deterministically: courses ordered by id, Map insertion order (auto.ts:102-126). After the other chunks are written, the stale list is exactly the failed chunk (or the same slice boundaries), so the same pairs are grouped again on the next refresh. There is no bisection, no per-pair retry and no per-pair failure record.
- The only signal is `console.warn` at auto.ts:250, carrying the first failure only (`failure ??= err`).
- The timeout is one timer for the whole worker (auto.ts:143), not per job.

**What weakens it**
- Chunk-level failure is the specified and tested behaviour. `docs/course-elevation.md` §7.5 says: "a worker that fails or runs past five minutes leaves its pairs for the next refresh and the others go on." The test at leg-routes-auto.test.ts:220 covers it. Only the permanent poison-pair consequence is unaddressed; it is not in the Pending list.
- No concrete trigger exists in the code. There is no `throw` anywhere in `packages/shared/src/route/*.ts`. Each search window is capped at `ROUTE_MAX_CELLS = 1_200_000` by coarsening the cells (leg.ts:80, 94), and the comment at auto.ts:33 puts a long leg at a few seconds, so 20 searches sit far below the 5 minute limit. A straight legal line returns without any search (leg.ts:137).
- "Burning up to 5 minutes on every edit" applies only to the timeout path. A throwing job fails as soon as it is reached. The search runs in a worker thread, so the API event loop is not blocked either way.
- The impact is a fallback, not corruption: the 19 chunk-mates keep the climb read along the drawn line, which is the behaviour before this feature. Other chunks are still written and their climbs recomputed (auto.ts:225-228).
- A refresh is triggered only by climb-marking edits, `courseObject.*` writes and `course.refreshClimbs` (trpc.ts:181-182, course.ts:1231), one per event at a time.

**Severity**
Low: this is a robustness gap (no per-pair isolation, weak observability) whose trigger is hypothetical, i.e. it needs a future bug in the search or malformed geometry. If such a trigger were shown, it would be medium.

</details>

### CRS-072 Any map correction makes every pair of the event stale: the whole event is re-searched on the next edit or editor opening

- **Area:** Elevation, climb, leg routes, route finder (PR #254) · **Category:** performance · **Severity:** low (reviewer said medium, verifier corrected) · **Size:** M
- **Location:** `packages/api/src/leg-routes-auto.ts:72 (patchVersion fed in at :104 and :125; stale filter at :173)`; also packages/api/src/leg-routes-auto-worker.ts:18-19
- **Status:** confirmed. Code read only, no reproduction (node_modules absent, and the mechanism is plain from the source). Read /home/user/oxygen/packages/api/src/leg-routes-auto.ts (whole file), /home/user/oxygen/packages/api/src/leg-routes-auto-worker.ts, /home/user/oxygen/packages/api/src/map-store/patches.ts:75-79 and 216-222, the callers at /home/user/oxygen/packages/api/src/trpc.ts:181-182 and /home/user/oxygen/packages/api/src/routers/course.ts:1228-1233, the editor trigger at /home/user/oxygen/packages/web/src/pages/editor/EditorPage.tsx:1989-1996, and /home/user/oxygen/docs/course-elevation.md §7.5 (lines 764-790) and its Pending section (1298-1306). The per-search cost was not measured.

**What is wrong.** autoRouteBasis digests the event's whole map-patch version. One patched object anywhere on the map changes the basis of every pair, and the next course edit, courseObject write or opening of course mode (EditorPage calls course.refreshClimbs once per opening) re-searches all pairs. Each chunk structured-clones the full document bytes into a new worker and decodes, patches, flattens and classifies the entire document again (leg-routes-auto.ts:186-189, worker line 18-19). The refreshes of several events also run in parallel without a cap (stated in Pending), which multiplies this.

**Scenario.** On event morning a fence is added as a map correction. The next person who opens the course editor triggers a refresh of every pair of the event: one worker thread at 100% for many minutes on the arena laptop, with the map document cloned and re-decoded once per 20 pairs, although only legs whose window contains the fence can change.

**Proposed fix.** Make the basis local: hash only what can affect the pair, e.g. the patch entries (and out-of-bounds objects) whose bounding box intersects legWindow({from,to,via}).bounds, instead of the patch version. Reuse one worker for the whole refresh (send the document once, post chunks as messages) so the document is decoded once. Size M; the basis change needs an AUTO_ROUTE_VERSION bump and a test that a far-away patch leaves a pair's basis unchanged.

**Verifier's note on the fix.** The basis is normative in docs/course-elevation.md §7.5, so any narrowing is a spec change: per CLAUDE.md, ask the user, update the spec first and add a decision-log row.

A narrower basis (for example a digest of the patch ops whose bounding boxes intersect the leg's window, `legWindow` in packages/shared/src/route/leg.ts) must still change when:
- a correction is removed or hidden;
- the patch is enabled or disabled;
- symbol definitions change in a way that alters classification.

Reusing one worker, or one decoded feature set, across the chunks of a refresh would remove the repeated clone and decode on its own, without touching the basis.

<details><summary>Verifier's evidence</summary>

The mechanism is real, but it is the specified design and the claimed impact is overstated.

**What the code does**
- leg-routes-auto.ts:70-75: `autoRouteBasis` digests `input.patchVersion` together with the document hash, scale, end points, via and obstacles. Nothing in it is specific to the leg's window.
- leg-routes-auto.ts:104 and 125: `patchVersion` is the single event-wide version from `eventPatchOnPin`, and it goes into every pair's basis.
- patches.ts:216-222: any content change to the patch writes a fresh `nextPatchVersion()`, so one corrected object changes every pair's basis.
- leg-routes-auto.ts:173: every pair whose stored basis differs is stale, so all pairs are searched again.
- leg-routes-auto.ts:182-189: each chunk of 20 pairs starts a new Worker with `doc.bytes` and the patch as `workerData` (structured clone).
- leg-routes-auto-worker.ts:18-19: each worker decodes, patches and classifies the whole document again.
- Triggers: trpc.ts:181-182 (course geometry edits and `courseObject.*` writes), course.ts:1231 (`refreshClimbs`), EditorPage.tsx:1991-1996 (once per opening of course mode, only with `canEdit`).

**Why it is not refuted**
- No guard narrows the stale set to legs whose window contains the changed object.
- The Pending section (course-elevation.md:1298-1306) lists the missing cross-event cap and that a correction alone does not trigger a refresh. It does not list this over-invalidation.

**What limits the impact**
- The spec states this basis outright (course-elevation.md:764-768: "the map patch's version" is part of the basis; "decoded, patched and classified once per worker"). It is a coarse but deliberate invalidation key, not a slip.
- The work runs in a worker thread off the event loop, one chunk at a time, one refresh per event (the `running` map, leg-routes-auto.ts:236-256). Requests are not blocked.
- Each search is bounded: the leg window is capped at `ROUTE_MAX_CELLS = 1_200_000` (packages/shared/src/route/leg.ts:80-94), and the code comment at leg-routes-auto.ts:32 says a long leg takes a few seconds.
- Results stay correct: a pair searched again to the same vertices clears no climbs (leg-routes-auto.ts:211-215).
- "Many minutes at 100%" is one core, and only for an event with a great many distinct pairs. The "refreshes of several events in parallel" multiplier is a separate item already in Pending.

**Severity**
Low: wasted background CPU on one core after a map correction. No wrong results, no blocked request, no data at risk.

</details>

### CRS-073 Courses page: delete, bulk update and most inline edits fail without any message

- **Area:** Web course editor: pages · **Category:** engineering · **Severity:** low (reviewer said medium, verifier corrected) · **Size:** S
- **Location:** `packages/web/src/pages/CoursesPage.tsx:744`; also packages/web/src/pages/CoursesPage.tsx:240-245, 286-293
- **Status:** confirmed. Code read only (no reproduction; node_modules absent). Read /home/user/oxygen/packages/web/src/pages/CoursesPage.tsx:240-256, 286-293, 700-710, 735-750, 780-815, 825-850, 900-916; grepped the file for every onError / .error use; read /home/user/oxygen/packages/web/src/main.tsx:19-27 and 44-67 for a global error handler; read /home/user/oxygen/packages/api/src/routers/course.ts:756-830, 1146-1180, 1235-1252 and the Course model in /home/user/oxygen/packages/api/prisma/schema.prisma for the failure modes the server can actually return.

**What is wrong.** `CourseInlineDetail.updateMutation.onError` only handles version conflicts. Any other failure of a name, length, climb, maps or order-mode edit (network error, duplicate name, COURSE_IS_VARIANT, leased event) is ignored and the field snaps back to the stored value, because the edit state is cleared on blur. `deleteMutation` (240) and `bulkUpdateMutation` (286) have no `onError`; a failed bulk update leaves the selection and value in place with no hint.

**Scenario.** Before the start the organiser raises *Number of maps* for 12 selected courses on a weak connection. The request fails; the bar still shows the selection and the table the old numbers, with no error. Or a course is renamed to an existing name: the input reverts and the user does not know why.

**Proposed fix.** Show `err.message` for every non-conflict error (reuse `saveError`). Add `onError` to delete and bulk update with a visible message near the table or bulk bar.

**Verifier's note on the fix.** Show `err.message` for non-conflict errors in `updateMutation.onError` (744), but avoid double-reporting with the per-call handler for controls (810), which already sets `controlsError`. Add `onError` to `deleteMutation` and `bulkUpdateMutation`, keeping the selection and value on failure. Do not write a test around a duplicate-name rejection on update: the server accepts duplicates; use a blank name (zod min(1)) or a lease/permission refusal instead. Consider keeping the typed value on failure rather than clearing edit state on blur.

<details><summary>Verifier's evidence</summary>

The core claim holds: failures of these mutations are not reported.

- CoursesPage.tsx:240-245 `deleteMutation` and 286-293 `bulkUpdateMutation` have only `onSuccess`. The file has exactly three `onError` (744, 810, 1085), and neither `deleteMutation.error` nor `bulkUpdateMutation.error` is rendered anywhere. The Apply button (704-707) only reflects `isPending`.
- CoursesPage.tsx:744-750: `updateMutation.onError` acts only when `versionConflictOfError(err)` is true. `handleSave` (783-786) passes no per-call handler. Only the controls field has one (803-813, sets `controlsError`).
- Blur handlers clear edit state unconditionally (844 `setEditName(null)`, 912 `setEditMaps(null)`, likewise 866 and 890), so the input reverts to `d.name` / `d.numberOfMaps` on failure.
- No global net: main.tsx:19-27 creates `QueryClient` with query defaults only, no `MutationCache`/`QueryCache` `onError`, and the tRPC links (44-67) have no error/toast link.

Real triggers: network/5xx failure, lease or capability refusal from `coursesEditRaceProcedure` (trpc.ts:316), NOT_FOUND when the course was removed elsewhere (course.ts:240-252), and zod rejection (clearing the name: `name: z.string().min(1)` at course.ts:760 makes a blanked name snap back silently).

Two of the claim's examples are wrong:
- "Renamed to an existing name" does not fail. `course.update` writes `data.name = input.name` (course.ts:805) with no duplicate check, and the Course model has no unique on name (only `@@unique([eventId, seq])` and `@@unique([parentCourseId, variantKey])`). The CONFLICT "already exists" at course.ts:690 is in create only.
- COURSE_IS_VARIANT is unreachable from the inline detail: variants render `readOnly`, inputs are `disabled={readOnly}` and `handleSave` returns early (784).

Severity is low rather than high or medium: nothing is lost or corrupted, and the UI keeps showing the true stored state (old numbers, selection still in place, field reverted). The defect is missing feedback on a failure that originates elsewhere. With the browser fully offline, React Query's default networkMode pauses the mutation rather than failing it, so the "weak connection" case is narrower than stated.

</details>

### CRS-074 The editor's `editor` prop is rebuilt on every render, so MapPanel's memo never holds

- **Area:** Web course editor: pages · **Category:** performance · **Severity:** low (reviewer said medium, verifier corrected) · **Size:** M
- **Location:** `packages/web/src/pages/editor/EditorPage.tsx:1784`; also packages/web/src/hooks/useCoursePresence.ts:27; packages/web/src/pages/editor/EditorPage.tsx:1784-1787, 2138-2180
- **Status:** confirmed. Code read only (no reproduction; node_modules absent and the claim is about render cost, which cannot be measured here). Read packages/web/src/pages/editor/EditorPage.tsx:1345-1357, 1636-1787, 2137-2180, 2523, 2941, 3006-3021; packages/web/src/pages/editor/tools/bindings.ts:172-178, 263-303; packages/web/src/hooks/useCoursePresence.ts; packages/web/src/components/MapPanel.tsx:109-113, 445-456, 708, 763; packages/web/src/components/MapViewer.tsx:563, 796, 1126-1130, 3233-3235.

**What is wrong.** `toolBinding` is an IIFE evaluated on each render (1636-1759; `selectBinding` rebuilds all outlines and maps `objectsInView`). `withCorridorGuides` and the spread at 1784-1787 create a new `shownBinding` each time, and `shownBinding` is a dependency of the `editor` memo (2138-2180). MapPanel's contract (components/MapPanel.tsx:109-113) is "Memoize the object (and stabilize its callbacks) — MapPanel is memoized with shallow equality". The page re-renders at least every 5 s (`useCoursePresence` sets a new `others` array on each heartbeat), on every hover point with an armed tool or snapping (`setHover`), on every GPS fix in Field mode and on each outbox change. Each re-render pushes a new `editor`/`tool` object through MapPanel into MapViewer.

**Scenario.** Editing a 60-control course on a large club map with a filter region: moving the pointer with `K` armed re-renders the 3,000-line page and the whole viewer subtree per pointer move. An idle editor re-renders the viewer every 5 s for presence. On a tablet or old arena laptop this shows as pointer lag while placing.

**Proposed fix.** Wrap the binding per tool kind in `useMemo` with its real inputs (the callbacks are already mostly `useCallback`; move the inline `onObject*` handlers into `useCallback`s reading refs), and memoize `shownBinding`. In `useCoursePresence` keep the previous array when the answer is unchanged. Measure with the React profiler before and after.

**Verifier's note on the fix.** Memoizing `toolBinding`/`shownBinding` alone will not make MapPanel's memo hold: `toolbar` (EditorPage.tsx:2523) and `mapOverlay` (2941) are also fresh JSX on every render. With an armed tool the binding must still change per hover point, because its `shapes` carry the ghost. A real fix would memoize the select binding on its true inputs, keep the presence array's identity when its content is unchanged, and/or move hover-driven shapes out of the `editor` object. Measure before investing; MapViewer already keys its expensive effects on stable derived values.

<details><summary>Verifier's evidence</summary>

The mechanism is real, but the claimed impact is unproven and the codebase already treats the identity churn as a known condition.

What holds:
- `toolBinding` is an un-memoized IIFE (EditorPage.tsx:1636-1759). In the default `select` tool it always returns a fresh object from `selectBinding` (bindings.ts:263-303), with `objectsInView.map(...)` and a dozen inline closures rebuilt per render.
- `shownBinding` (1784-1787) is a fresh spread plus a new `onHover` closure whenever `corridorBinding` is non-null, which is every render in Course mode with the select tool.
- `shownBinding` is in the `editor` useMemo dependency list (2180), so that memo is invalidated on every render and `editor` is a new object each time.
- `useCoursePresence` calls `setOthers(res.others)` on every 5 s beat with a new array and no equality check (useCoursePresence.ts:27), so an idle editor does re-render every 5 s.
- MapPanel is `memo(MapPanelImpl)` (MapPanel.tsx:763) and its contract at 109-113 asks for a memoized `editor`.

What weakens the claim:
- The `editor` prop is not the only reason the memo fails. `toolbar` (EditorPage.tsx:2523) and `overlay` (2941) are plain un-memoized JSX passed to MapPanel at 3012-3013, so MapPanel would re-render on every page render even with a stable `editor`. Stabilising `editor` alone would not restore the memo.
- The churn is known and designed around. MapPanel.tsx:452-455 says "that object is rebuilt on every editor render (a hover with an armed tool, a selection)" and keys its effect on `hasEditor`. MapViewer.tsx:1126 says "the editor object itself changes with every tool hover" and derives stable primitives for the layer request. MapViewer holds the tool in a ref (796) for its handlers.
- MapViewer is a plain function component (563), not memoized, so the visible cost is a React reconcile of the viewer subtree, not a map-layer refetch or re-request.
- With an armed tool, the per-hover re-render is functionally required: the binding's `shapes` (ghost, polygon rubber band) depend on `hover` and are drawn by MapViewer at 3233-3235. `onHover` also dedupes identical snapped points (1350-1356).
- The 5 s presence re-render is one reconcile per 5 s, which is negligible.
- "Pointer lag on a tablet or old laptop" is asserted without measurement, and I found nothing in the code that proves it.

So this is a real violation of a documented memo contract and avoidable per-render work, but not a demonstrated user-visible failure. I rate it low, not the medium-or-higher the scenario implies.

</details>

### CRS-075 A class can be assigned to a materialised variant child

- **Area:** Course data and course/control API · **Category:** functional · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/routers/classRouter.ts:28 (callers at 198, 320, 372); picker at packages/web/src/components/CourseMultiSelectDropdown.tsx:23`
- **Status:** confirmed. Code read only (no reproduction; node_modules absent). Read packages/api/src/routers/classRouter.ts:28-41, 197-224, 317-343, 369-393; packages/api/src/course-variants.ts (syncVariants, syncPoolsOfRoot, syncClassPool, liveChildren, assertNotVariant); packages/api/src/variants.ts:219-249; packages/api/src/routers/course.ts:520-548 and 1235-1251; packages/web/src/components/CourseMultiSelectDropdown.tsx:23-61; docs/course-layer.md §12.4, line 2270 and Pending lines 2508-2511.

**What is wrong.** courseSeqToId accepts any live course, including a variant (parentCourseId set). docs/course-layer.md §12 treats classes as pointing at the root ('classes point at the root; a child's classes is []'), pools are maintained only for classes whose course_id is a root (syncPoolsOfRoot), and print reads 'a class prints its root'. A class set to a child gets no pool, its runners' variants are cleared, and when the root's keys later change the child is soft-deleted without touching the class.

**Scenario.** class.update { id: 5, courseId: <seq of 'Lång AB'> } (the id is in course.list). Later the setter removes alternative B: 'Lång AB' is soft-deleted, class 5 keeps course_id pointing at the removed child and is not in any pool, so its runners are evaluated against a course that no longer exists in any list.

**Proposed fix.** In courseSeqToId (class create/update/bulkUpdate) and course.importCourses' class mapping, refuse a course with parentCourseId != null (PRECONDITION_FAILED COURSE_IS_VARIANT), or resolve it to its root. One test.

**Verifier's note on the fix.** A server-side refusal (assertNotVariant in courseSeqToId) must be matched by filtering variants out of CourseMultiSelectDropdown, or the picker will offer rows that error. course.importCourses' class mapping (course.ts ~2331) assigns class courses by its own path and needs the same rule. Existing classes already on a child need a decision (migrate to root or leave). Whether to forbid it at all is a spec question: CLAUDE.md requires asking the user and recording the answer in docs/course-layer.md §12 first, since the spec currently only describes, not mandates, 'classes point at the root'. Severity would rise to medium if a reader (results/readout/print) is shown to mishandle a class whose course is removed; that was not traced.

<details><summary>Verifier's evidence</summary>

The missing guard is real. courseSeqToId (classRouter.ts:28-41) filters only { eventId, seq, removed: false }; there is no parentCourseId check, and assertNotVariant is not called on class.create (198), class.update (320) or class.bulkUpdate (372). It is reachable from the normal UI, not just the raw API: CourseMultiSelectDropdown.tsx:23-61 lists every course.list row unfiltered, and course.list returns variants (course.ts:546 sets parentCourseId/variantKey on them), so 'Lång AB' sits beside 'Lång' in the class picker.

Mechanics as claimed: syncClassPool -> liveChildren(child) returns [] so the class gets no pool; reconcileClassVariants (variants.ts:229-235) clears runners sitting on a variant. When the key later disappears, syncVariants soft-deletes the child (course-variants.ts:166-170); syncPoolsOfRoot only looks at classes with courseId = rootId and at pool rows, so class.course_id is left pointing at the removed child.

What weakens the claim's impact:
1. A child is a complete ordinary linear course (own course_controls, legs, length), so a class on it behaves as a plain non-forked class. No pool and cleared per-runner variants are the coherent outcome for that; runners fall back to the class course.
2. The dangling pointer is not specific to variants. course.delete (course.ts:1235-1251) soft-deletes a plain course without touching classes that use it either; only importCourses replaceAll nulls class.courseId (course.ts:1932-1934). A class on a removed course is an existing tolerated state; the removed row and its course_controls remain, so evaluation still has a control sequence. The difference here is that it happens silently as a side effect of editing the root's structure.
3. docs/course-layer.md Pending (2508-2511) already says 'a variant is still an ordinary course in every other course list', i.e. the picker exposure is acknowledged. It does not say class assignment to a variant is refused or unimplemented, so I did not treat it as refuting; but the spec invariant at 2183/2270 ('classes point at the root') is only a description, not an enforced rule.

Not verified: the claim's print statement ('a class prints its root') and what result/readout code does with a class whose course is removed; I did not trace those readers.

</details>

### CRS-076 Queries that ignore removed rows or fall back to the whole event

- **Area:** Course data and course/control API · **Category:** functional · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/routers/course.ts:1451`; also packages/api/src/routers/course.ts:1159, :1451; packages/api/src/routers/classRouter.ts:364
- **Status:** confirmed. Code read only (no reproduction; node_modules absent). Read packages/api/src/routers/course.ts:1146-1222 (bulkUpdate), :1235-1252 (delete), :1434-1554 (controlCompletionStatus); packages/api/src/routers/classRouter.ts:347-396; packages/api/prisma/schema.prisma Course model (@@unique([eventId, seq])); consumers packages/web/src/pages/CompetitionDashboard.tsx:9-22, :90-102, :158 and packages/web/src/components/MapPanel.tsx:247-250, :331-337. Searched docs/map-*.md and docs/course-*.md: none lists this as Pending.

**What is wrong.** controlCompletionStatus: an unknown courseId (findFirst without removed filter returns null) falls back to the all-courses branch instead of returning [], and the all-courses branch (`{ course: { eventId } }`, line 1451) includes removed courses and variant children, so totals/passed counts include controls of deleted courses. course.bulkUpdate (line 1159) and class.bulkUpdate (classRouter.ts:364) select rows by seq without `removed: false`, so they rewrite and re-journal soft-deleted rows.

**Scenario.** The dashboard progress bar (no courseId) shows controls that exist only on a deleted course, with total 0 or stale counts; a kiosk asking for a course seq that was just deleted gets the entire event's completion data instead of an empty list.

**Proposed fix.** Return [] when input.courseId is given and not found; add `removed: false` to the course filters at 1440/1451 and to both bulkUpdate row selections.

**Verifier's note on the fix.** Add `removed: false` to the `courseFilter` lookup and return `[]` when `input.courseId` is given but no course is found; add `removed: false` to the all-courses `course` filter but keep live variant children (runners point at variant ids). Adding `removed: false` to both `bulkUpdate` selections changes the returned `count` for stale ids. Separately worth checking, not part of this claim: with a course given, a root with variants is matched by `courseId: courseFilter.id` only, while its runners carry variant ids.

<details><summary>Verifier's evidence</summary>

The code facts hold, but the claimed scenario is partly wrong and the visible effect is small.

**What is true**
- course.ts:1438-1443: `courseFilter` is looked up with `{ eventId, seq }` and no `removed: false`. When it is null (seq that does not exist in the event), line 1450-1452 falls to `{ course: { eventId } }`, so the caller gets the whole event's rows instead of `[]`.
- course.ts:1451: the all-courses branch has no `removed: false` on the course. `course.delete` (1241-1244) only sets `removed: true` and keeps the `courseControl` rows, so bindings of deleted courses are read.
- course.ts:1159 and classRouter.ts:364: both `bulkUpdate`s select by `seq: { in: ids }` without `removed: false`, then `updateMany` and emit an upsert for each row. The single-row `update`/`delete` paths use `getCourseBySeq`/`getClassBySeq`, which do filter (`course.ts:244`, `classRouter.ts:20`), so this is an inconsistency.

**What is overstated or wrong**
- "A kiosk asking for a course seq that was just deleted gets the entire event" is false. Deletion is soft and `(eventId, seq)` is unique, so the unfiltered `findFirst` still finds the deleted course and returns that course's data. The whole-event fallback only happens for a seq that never existed in the event; the web clients take the seq from the class/course lists (CompetitionDashboard.tsx:90-102), so that needs a hand-made or cross-event request.
- A control that exists only on a deleted course gets `total: 0` unless a runner or non-removed class still points at that course (1524-1528). The dashboard sums totals (CompetitionDashboard.tsx:20-22) and MapPanel ignores rows with `total` 0 (MapPanel.tsx:334-335), so a `total: 0` row changes nothing on screen. The count only shifts when a class or runner still references the deleted course, since `delete` does not clear `class.courseId`.
- "Includes variant children" is not a defect for live variants: runners carry the variant's id in `runner.courseId` (classRouter.ts:427-439), so their bindings must be included. Only removed variants are stray, with the same `total: 0` outcome.
- The bulk updates only reach removed rows if the client sends a removed seq (stale list or a race with a delete). The rows stay `removed: true`; the harm is a needless write and journal entry.

No data loss, no wrong results, nothing in the punch/result path. The realistic effect is a slightly off progress percentage on the dashboard when a class still points at a deleted course.

</details>

### CRS-077 course.create linkClassId changes a class under courses.edit and skips the pool/journal path of class.update

- **Area:** Course data and course/control API · **Category:** security · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/routers/course.ts:647-663 (create linkClassId); packages/api/src/routers/course.ts:2313-2334 and 1932-1935 (importCourses classMapping / replaceAll)`; also packages/api/src/routers/course.ts:2331-2350 (classMapping)
- **Status:** confirmed. Code read only, no reproduction (no node_modules, and the point is a capability gate, not pure logic). Read packages/api/src/routers/course.ts:595-670 (create), 1817 and 1922-1935 and 2313-2334 and 2364-2365 (importCourses), packages/api/src/routers/classRouter.ts:290-345 (class.update), packages/api/src/trpc.ts:310-317, packages/shared/src/permissions.ts:36-42, docs/system/authentication.md:149-167, docs/course-import-class-fallback.md, and the web callers CoursesPage.tsx:1102 and EditorPage.tsx:2451.

**What is wrong.** Class writes are manageRaceProcedure (event.manage) in classRouter, but course.create { linkClassId } updates class.course_id with only courses.edit. It also bypasses syncClassPool/emitRunnerVariants that every other class-course change runs (harmless today because a new course has no variants, but it is a second, divergent write path), and importCourses' classMapping does the same for arbitrary classes.

**Scenario.** A user whose role grants courses.edit but not event.manage (a course setter) assigns a course to a class that has none via course.create, or re-maps every class through importCourses classMapping, although class.update would answer FORBIDDEN.

**Proposed fix.** Require event.manage in ctx.capabilities when linkClassId / classMapping is present (capabilitiesForContext is already resolved by the middleware), or document that courses.edit includes class-course assignment in docs/system/authentication.md; route the write through a shared helper that also calls syncClassPool.

**Verifier's note on the fix.** Do not simply gate linkClassId/classMapping behind event.manage: the course import dialog and both course-create UIs (CoursesPage.tsx:1102, EditorPage.tsx:2451) send them for course setters, and integration tests (course.test.ts:100-122, course-import-class-fallback.test.ts) cover the behaviour. This is a product decision to ask the user about: either document that courses.edit may set class.course_id (authentication.md), or drop the field silently / reject for callers without event.manage and adapt the web callers. Separately, course.create could call syncClassPool + emitRunnerVariants after the class update for parity with class.update; importCourses already does the pool sync.

<details><summary>Verifier's evidence</summary>

The capability asymmetry is real, but two parts of the claim are wrong and the severity is low.

What holds:
- course.create is coursesEditRaceProcedure (course.ts:595) and with linkClassId writes class.courseId (course.ts:647-663).
- importCourses is coursesEditRaceProcedure (course.ts:1817) and its classMapping writes class.courseId for any class seq of the event (course.ts:2313-2334). With replaceAll it also nulls courseId on every class (course.ts:1932-1935).
- class.update is manageRaceProcedure, i.e. event.manage (classRouter.ts:290, trpc.ts:311).
- The seeded courseSetter group has courses.edit without event.manage (permissions.ts:39), so the claimed scenario is reachable: class.update answers FORBIDDEN, the two course procedures succeed.

What does not hold:
- course.create does not skip the journal: it calls emitClassUpserted in the same transaction (course.ts:663). It skips only syncClassPool/emitRunnerVariants, and it refuses a class that already has a course (course.ts:653-658), so with a brand-new course there is no pool to sync.
- importCourses classMapping does not "do the same": it calls syncClassPool per class (course.ts:2331) and merges the result into variantSyncs (course.ts:2364-2365).

Why this is low, not a security breach:
- The write is limited to class.course_id within the caller's own event; no other class field is reachable.
- Mapping courses to classes is the documented course-setter workflow: docs/course-import-class-fallback.md describes the import dialog's class dropdown as the course setter's tool, and both web callers pass linkClassId automatically via matchCourselessClass.
- docs/system/authentication.md does not reserve class-to-course assignment for event.manage.
- It is still a real inconsistency: the same field has two gates, and a second write path omits the pool sync.

Not listed under any "Pending" section that I found.

</details>

### CRS-078 Dead query in class.list

- **Area:** Course data and course/control API · **Category:** performance · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/routers/classRouter.ts:122-135 (dead groupBy); 113-120 (runner count in JS)`
- **Status:** confirmed. Code read only, no reproduction run. Read /home/user/oxygen/packages/api/src/routers/classRouter.ts:103-166 and grepped every class.list caller in packages/web/src for polling options (refetchInterval, staleTime).

**What is wrong.** class.list runs courseControl.groupBy over all class courses, builds controlCountMap and then discards it (`void controlCountMap`). It also loads one row per runner of the event to count per class instead of a groupBy. class.list is kiosk-readable and polled.

**Scenario.** A 2,000-runner event: every class.list call transfers 2,000 runner rows and runs an unused aggregate; the kiosk and dashboard poll it.

**Proposed fix.** Delete the groupBy/controlCountMap block; replace the runner findMany with runner.groupBy({ by: ['classId'], _count }) using the same where.

**Verifier's note on the fix.** Delete lines 122-135 outright. If the runner count is moved to runner.groupBy({ by: ['classId'], _count }), keep the same where clause (eventId, removed: false, status notIn withdrawnEnums) and keep skipping null classId. The integration tests cancellation-handling.test.ts:90 and class.test.ts:148-170 pin the runnerCount semantics.

<details><summary>Verifier's evidence</summary>

The dead query is real. classRouter.ts:125-131 runs courseControl.groupBy over the class course ids, 132-134 builds controlCountMap, and 135 is `void controlCountMap;`. The result mapping at 137-159 never reads it, and ClassSummary output carries no controlCount field. That is one wasted DB round-trip per call.

The runner count is also done in JS: 113-116 is runner.findMany with select { classId } over all non-removed, non-withdrawn runners of the event, counted in a Map at 117-120. A groupBy on classId would do the same. Rows stay server-side (one uuid column each), so "transfers 2,000 rows" means DB to API, not to the client.

The "polled" part of the claim is not supported. No class.list caller sets refetchInterval:
- packages/web/src/components/MapPanel.tsx:217 (the kiosk path) uses staleTime: Infinity, so it fetches once per mount.
- ClassesPage.tsx:57, CoursesPage.tsx:1067, EditorPage.tsx:187 and DescriptionSheetsDialog.tsx:31 use the default staleTime of 5000 from main.tsx:22 and refetch on mount or after mutation invalidation.
- print/offline-prepare.ts:81 is a one-shot query.
- hooks/useDefaultMapCourseNames.ts:13 explicitly avoids a separate class.list query on the dashboard.

The procedure is kiosk-readable (kioskOrViewProcedure, line 103), but the real cost is one unused aggregate plus a narrow 2,000-row select on occasional calls. Correctness is unaffected.

</details>

### CRS-079 IOF export writes MapPositionTopLeft with the smallest y while controls use y-up paper mm

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** functional · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/iof-course-export.ts:180-189`
- **Status:** confirmed. Code read only (no reproduction run). /home/user/oxygen/packages/api/src/iof-course-export.ts:112-121 and 171-190; /home/user/oxygen/packages/api/src/iof-course-parser.ts:205-229; /home/user/oxygen/docs/course-layer.md:172 and /home/user/oxygen/docs/course-maps.md:32; /home/user/oxygen/docs/system/iof-coursedata-export.md:39; /home/user/oxygen/packages/api/src/__tests__/iof-course-export.test.ts:154. External consumer behaviour (Condes/OCAD/Purple Pen) was not tested.

**What is wrong.** Control MapPosition values are Oxygen's paper mm with y growing upward, but the Map corners are written as TopLeft = (minX, minY) and BottomRight = (maxX, maxY), which is the bottom-left and top-right of the same extent. The document is internally inconsistent about the y direction (the IOF schema describes y as units below the origin). Oxygen's own importer ignores the corners, so the round-trip test cannot see it.

**Scenario.** A consumer that places the course by the Map corners (image-based maps in Condes/OCAD import) mirrors or shifts the course vertically.

**Proposed fix.** Write TopLeft y = max(ys) and BottomRight y = min(ys) for the y-up convention used for the controls, state the convention in docs/system/iof-coursedata-export.md, and check one export in Condes/OCAD.

**Verifier's note on the fix.** Swap only the y values: TopLeft = (min x, max y), BottomRight = (max x, min y). Keep the control `MapPosition` values unchanged, because the lossless round-trip through the importer depends on them. Do not flip to y-down without checking what Condes/OCAD/Purple Pen actually expect. Add a test asserting TopLeft.y >= BottomRight.y, and update docs/system/iof-coursedata-export.md:39.

<details><summary>Verifier's evidence</summary>

The factual core holds; the claimed impact is unproven.

- Control positions are written raw as y-up paper mm: iof-course-export.ts:117-121 writes `@_y: round(c.yMm, 2)`. The y-up frame of `controls.xpos/ypos` is stated in docs/course-layer.md:172 ("Paper mm at the base map's scale, y-up") and docs/course-maps.md:32.
- The corners are mislabelled for that frame: iof-course-export.ts:180-189 writes `MapPositionTopLeft = (min x, min y)` and `MapPositionBottomRight = (max x, max y)`. In a y-up frame those are the bottom-left and top-right of the control extent. A y-up document should have TopLeft.y greater than BottomRight.y.
- Nothing in the repo catches it: the parser reads only `Control/MapPosition` (iof-course-parser.ts:219-227) and never reads the Map corners (grep for `MapPositionTopLeft` finds only the writer, one doc line and one test). The only test assertion is that the element is absent for an empty event (iof-course-export.test.ts:154).
- It is not listed as pending: docs/system/iof-coursedata-export.md:39 documents the corners as "bounding box of the exported controls", and the code comment at lines 171-173 says they stand in for image corners because no image is shipped. No guard, flip or Pending entry covers the orientation.

Severity is low, not the "mirrors or shifts the course" the claim implies as a likely outcome. No consumer was shown to place courses by these corners. The corners are an admitted placeholder (control bounding box, not a map image extent), so a consumer that did trust them as image corners would misplace the course whichever way y ran. The control coordinates themselves are correct and consistent with Oxygen's importer. This is a labelling inconsistency in a placeholder element with a speculative interoperability effect.

</details>

### CRS-080 No size limit on import payloads; parsing is synchronous and done twice

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** performance · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/routers/course.ts:1709 and :1820 (schemas); packages/api/src/ocd-course-parser.ts:115 and :322-323 (unchecked reads)`; also packages/api/src/ocd-course-parser.ts:115; packages/api/src/ocd-course-parser.ts:322
- **Status:** confirmed. Code read of packages/api/src/routers/course.ts:222-236, 1706-1717, 1820-1888; packages/api/src/ocd-course-parser.ts:75, 107-116, 142-150, 282-287, 311-323; packages/api/src/index.ts:46; packages/web/src/components/CourseImportDialog.tsx:88,108. Plus a standalone node run (no repo code) for the RangeError text and for base64/JSON timing at the body limit.

**What is wrong.** xmlContent and ocdBase64 are z.string() with no max; the only bound is Fastify's 50 MB bodyLimit. Parsing is synchronous on the API's single event loop, the OCD buffer is decoded twice in importCourses (parseCourseFile and the ocad2geojson CRS fallback), and the client sends the whole file once for preview and again for import. The OCD parser also reads at unchecked offsets (readUInt32LE(blockOff) near the end of the buffer, readInt32LE(pos + 60) after only checking pos + 56), which surfaces as a raw RangeError message.

**Scenario.** A 40 MB .ocd (a full map with courses) is imported while readout is running: the API process is blocked for the duration of two base64 decodes and parses, delaying card readouts; a truncated file returns 'The value of "offset" is out of range'.

**Proposed fix.** Add .max() to both inputs (for example 20 MB of base64 / 10 MB XML) with a clear message, bounds-check the OCD reads and throw a readable 'not a valid OCAD file' error, and decode the buffer once.

**Verifier's note on the fix.** - Bounds: line 313 should require `pos + 64 <= length` before the point reads at 322-323 (both reads are unchecked, not only `pos + 60`), and line 115 should require `blockOff + 4 <= buf.length`.
- Alternatively, wrap `parseCourseFile` so a RangeError becomes a BAD_REQUEST with a readable "file is truncated or not a valid OCD" message.
- Any `z.string().max()` must be expressed in base64 characters and stay under the 50 MB body limit. Do not pick a cap that rejects legitimate full-map .ocd bundles; that limit is a product decision.
- The second decode happens only in the no-base-map branch. If removing it, reuse the Buffer from `parseCourseFile` rather than restructuring the CRS fallback.

<details><summary>Verifier's evidence</summary>

The facts are real, but the claimed scenario is overstated.

**Confirmed from the code**
- `xmlContent` and `ocdBase64` are `z.string().optional()` with no max in both `previewImport` (course.ts:1709-1710) and `importCourses` (course.ts:1820-1821). The only bound is Fastify `bodyLimit: 50 * 1024 * 1024` (index.ts:46).
- `parseCourseFile` (course.ts:226-227) runs `Buffer.from(base64)` and `parseOCDCourseData` synchronously inside the mutation.
- The client sends the whole file twice: once for preview (CourseImportDialog.tsx:88) and again for import (CourseImportDialog.tsx:108).
- Unchecked reads exist:
  - ocd-course-parser.ts:113-115: the loop guard is `blockOff < buf.length`, then `buf.readUInt32LE(blockOff)`. This throws when `blockOff` is within the last 3 bytes.
  - ocd-course-parser.ts:313 checks only `pos + 56 <= length`, then lines 322-323 read `readInt32LE(pos + 56)` and `readInt32LE(pos + 60)`. These need `pos + 60` and `pos + 64`, so both reads are unchecked, not just the second.
- Nothing catches the error around `parseCourseFile` in either procedure, so the raw message reaches the client as a tRPC internal error. The node run gave: `RangeError The value of "offset" is out of range. It must be >= 0 and <= 98. Received 100`.

**Overstated or wrong in the claim**
- **The 40 MB scenario cannot happen.** 40 MB of binary is about 53.3 MB of base64, which exceeds the 50 MB body limit and is rejected with a 413. The largest .ocd that gets through is about 37 MB.
- **The second decode is conditional.** The `ocad2geojson` `readOcad` fallback (course.ts:1873-1883) runs only when `loadEventCrs` returns null, meaning the event has no base map yet. With a map present, the buffer is decoded once per request.
- **The measured blocking at the limit is small.** For a 37 MB payload, the base64 decode took 33 ms and `JSON.parse` of the roughly 49 MB body took 57 ms. The custom parser only walks the object index and the 7xxxxx course symbols, which is linear. That is on the order of 100-200 ms of event-loop stall, not a meaningful delay to card readouts. Only the conditional `readOcad` full-file parse could be heavier; I did not measure it because `node_modules` is absent.
- **The RangeError needs a narrow truncation.** The file must be cut within 3 bytes of an index block offset, or within 8 bytes after a course object's 56-byte header. Other truncations are skipped by the existing guards. The result is an ugly error message on an already-invalid file, with no data written, since the parse precedes any DB write.
- **The endpoints are not open.** Both sit behind `coursesEditProcedure` / `coursesEditRaceProcedure`, so this is not an unauthenticated DoS.

Not listed under any "Pending" section as far as the claim's scope goes; I did not search docs/map-*.md or docs/course-*.md exhaustively for an upload-size note.

</details>

### CRS-081 Dead and loose code in the OCD course parser

- **Area:** Course import/export (IOF XML, OCAD, Purple Pen) · **Category:** engineering · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/ocd-course-parser.ts:254 (heuristic), :276 (dead legOverrides push), packages/api/src/test-full-parser.ts:1`; also packages/api/src/test-full-parser.ts:1
- **Status:** confirmed. Code read of /home/user/oxygen/packages/api/src/ocd-course-parser.ts (lines 203-278, 286, 542-770), /home/user/oxygen/packages/api/src/test-full-parser.ts, /home/user/oxygen/packages/api/tsconfig.json, /home/user/oxygen/packages/api/package.json and the Dockerfile; repo-wide grep for legOverrides and test-full-parser. Also ran a standalone node script (copy of the string-index walk plus the course heuristic) against /home/user/oxygen/e2e/test.ocd to see which record types the heuristic matches in the fixture.

**What is wrong.** parseRecord takes four any-typed collections and decides 'course' by a heuristic (any record of any string type with a head, an 's…' part and an 'f…' part) instead of the record type, while classes do check strType === 3. legOverrides are collected and returned but never read. packages/api/src/test-full-parser.ts is a leftover debug script in src that reads e2e/test.ocd and console.logs.

**Scenario.** A non-course string parameter that happens to carry s and f fields would be imported as a course named after its first field; the unused code and the debug script are compiled and shipped with the API.

**Proposed fix.** Require strType === 2 for course records, type the collections, delete legOverrides/LegOverride and test-full-parser.ts.

**Verifier's note on the fix.** If the course branch is gated on strType === 2, keep the `strType === undefined` fallback semantics in mind (parseRecord's strType is optional, though the only caller always passes it). The class branch only accepts strType 3, while the e2e/test.ocd fixture carries type 9 records and no type 3, so check what those are before tightening further. Removing legOverrides also lets the LegOverride interface (line 39) go. Deleting test-full-parser.ts needs no other change; nothing imports it.

<details><summary>Verifier's evidence</summary>

All three factual parts hold; the harmful scenario is theoretical only.

1. Loose typing and heuristic: ocd-course-parser.ts:246 is `function parseRecord(txt: string, courses: Map<string, any>, classes: any[], legOverrides: any[], doglegMarkers: any[], strType?: number)`. The course branch at lines 251-254 fires on `head.length > 0 && !head.startsWith("<") && hasS && hasF` with no strType check, while the class branch at line 265 does check `strType === 3`. parseTextRecords calls parseRecord for every string-index entry of every type (line 238), so a record of any type with a non-empty head, an `s…` field and an `f…` field becomes `courses.set(head, …)` (line 264). Such a course is emitted even when no control resolves (lines 752-758 push unconditionally).

2. legOverrides is dead: it is declared (206, 215), pushed (276) and returned (243), but the only reads of textRecs are `.mapScale` (542), `.courses` (567, 594, 647), `.doglegMarkers` (644) and `.classes` (731, 764). Repo-wide grep finds no other reference.

3. Debug script: packages/api/src/test-full-parser.ts is 15 lines that read 'e2e/test.ocd' and console.log control lookups. Nothing imports it. tsconfig has `include: ["src"]` and excludes only `src/**/__tests__`, build is `tsc`, and the Dockerfile copies packages/api/ into the runtime image, so it is compiled to dist/test-full-parser.js and shipped. It is never executed (CMD is node packages/api/dist/index.js).

Against the claimed scenario: on e2e/test.ocd (OCAD 2018; string types present: 2 x5, 9 x5, 1039 x1) the heuristic matched only the five type-2 course records, so there is no misimport in the fixture. A bogus course needs a non-course record that carries both an s and an f field with a head not starting with '<' (conceivably an older-format type-1 control record with a size and a column-F symbol); I found no file or test demonstrating this, so it is unproven in practice.

</details>

### CRS-082 PdfWriter.imageFor hashes and byte-compares every image on every page

- **Area:** Course map printing and PDF · **Category:** performance · **Severity:** low · **Size:** S
- **Location:** `packages/shared/src/print/writer.ts:206`
- **Status:** confirmed. Code read: /home/user/oxygen/packages/shared/src/print/writer.ts:206-220 (imageFor), /home/user/oxygen/packages/shared/src/print/compose.ts:114-122 (writePage calls wp.image once per distinct graphic per page), /home/user/oxygen/packages/shared/src/print/course-pages.ts:157-200 (same g.data instance set per sheet; copies go through copyPage), /home/user/oxygen/packages/api/src/course-maps/graphics.ts:15 (stored cap 8 MiB), /home/user/oxygen/packages/api/src/course-maps/print-worker-host.ts:24 (10 min timeout). Plus a standalone node benchmark of the exact hash loop and the `every` compare on same-instance buffers.

**What is wrong.** Each `wp.image(png)` call runs an FNV loop over all bytes and then `bucket.find(... b.bytes.every((v, i) => v === png[i]))`, a callback per byte, although renderCoursePages passes the same Uint8Array instance for a graphic on every page. Stored graphics may be up to 8 MiB.

**Scenario.** A template with four logos of 2-8 MB printed for 200 pages: 800 calls x (hash + per-byte callback compare) adds tens of seconds of pure CPU to a job that already runs close to the 10-minute timeout, on the server and in the browser worker.

**Proposed fix.** Add `private readonly imagesByRef = new WeakMap<Uint8Array, entry>()` checked first (identity hit -> no hashing); keep the hash path for distinct instances and replace `every` with a plain indexed loop.

**Verifier's note on the fix.** Add an identity fast path (for example a WeakMap<Uint8Array, image> or a `b.bytes === png` check before hashing) and keep the content-equality dedup for different instances with equal bytes, which 05 §5.10 requires (one XObject per document for equal bytes). If the byte compare stays, use an indexed loop rather than `every` with a callback. The page must still get `setXObject` on every call.

<details><summary>Verifier's evidence</summary>

The mechanism is real. imageFor has no identity shortcut: every call runs the FNV loop over all bytes, then `bucket.find(b => b.bytes.length === png.length && b.bytes.every((v, i) => v === png[i]))`. renderCoursePages puts the same `g.data` Uint8Array into `images` for every sheet (course-pages.ts:170), and writePage calls `wp.image(png)` once per distinct graphicId per page (compose.ts:121), so each PNG graphic is fully hashed and compared again on every composed sheet.

Measured on this machine (node, same-instance buffer): 2 MiB = 2.4 ms hash + 14.9 ms compare; 8 MiB = 10.1 ms hash + 63.2 ms compare, about 73 ms per call. The claimed scenario (4 graphics x 200 pages = 800 calls) therefore costs about 14 s at 2 MiB each and about 59 s at the 8 MiB cap, so "tens of seconds" holds only at the upper end.

What limits the impact:
- It needs 200 distinct sheets. Hand-out stacks (`copies > 1`) go through copyPage (course-pages.ts:200) and never call imageFor again.
- Stored graphics are capped at 4096 px on the longer side and 8 MiB; ordinary logos are tens to hundreds of kB, where the cost is under 1 ms per call and negligible.
- The cost is linear, at most about 10% of the 10-minute worker budget in the worst case. That the job "already runs close to the timeout" is asserted, not shown.
- Output is correct; no data or result is affected.

SVG graphics take the same path with pngCache instances, at smaller sizes.

</details>

### CRS-083 maps.pdf and print-job answer every failure as 400 with the raw internal message

- **Area:** Course map printing and PDF · **Category:** engineering · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/course-maps/routes.ts:464-469 and 491-496`; also packages/api/src/course-maps/routes.ts:491-496
- **Status:** confirmed. Code read only; no reproduction was needed because the behaviour is a plain catch-all. Read packages/api/src/course-maps/routes.ts:424-497, packages/api/src/course-maps/descriptions-pdf.ts:269-273, packages/api/src/course-maps/print-worker-host.ts:75,107,116, packages/web/src/print/client.ts:272-280, docs/course-print.md §8.1 (lines 838-842), §8.2 (925-930), §8.5 (1034-1041), §8.6 (1400-1404), and the integration test at packages/api/src/__tests__/integration/course-maps.test.ts:633-643.

**What is wrong.** The catch-all maps selection errors, CourseStackError, a missing blob, Prisma/DB errors, worker crashes ('print worker exited with code 1') and timeouts all to `400 { error: error.message }`. Clients cannot tell a bad request from a server fault (the device client treats a non-2xx print-job as the final user error with no retry), monitoring sees no 5xx, and internal messages are shown to users. descriptions-pdf.ts already separates typed request errors (400) from the rest (500).

**Scenario.** The database connection drops for a second during `buildPrintJob`: the user sees a 400 with a Prisma message and the browser does not fall back or retry; ops dashboards show no server error.

**Proposed fix.** Introduce a `PrintRequestError` thrown by selectPrintPages/findMapRows/findClassRows/parse helpers and getBaseMapInfo's 'No base map uploaded', keep CourseStackError as 400, and answer everything else 500 with a generic message (log the cause). Keep the 400 texts word for word (print-job.test.ts asserts them).

**Verifier's note on the fix.** The 400-for-any-composer-error rule is normative in docs/course-print.md (§8.1 line 842, §8.2 line 929, line 1095, §8.5 table) and pinned by course-maps.test.ts:633-643. Under the project rules, changing it needs the user's decision, a spec edit first and a decision-log row.

A fix should:
- Introduce typed request errors for selection, caps, no pin and `CourseStackError` (these stay 400 with their messages, which print-job must keep word for word the same as maps.pdf).
- Answer 500 with a generic message for everything else: Prisma errors, a dead worker, the timeout.
- Update the integration test at course-maps.test.ts:633-643.
- Keep the same convention on the `print.png` and thumbnail routes (routes.ts:559, 610), which copy it.

The client needs no change, since it treats 4xx and 5xx alike.

<details><summary>Verifier's evidence</summary>

The mechanics are as claimed, but the behaviour is specified and tested, and the main claimed consequence does not follow from the status code.

**What is true**
- routes.ts:432-469 (maps.pdf) and 483-496 (print-job) wrap everything in one try/catch that answers `reply.code(400).send({ error: error.message })`. That covers `db.event.findUnique`, `buildPrintJob` (Prisma), `CourseStackError`, 'print worker exited with code N' (print-worker-host.ts:75) and 'print exceeded N ms' (print-worker-host.ts:107).
- descriptions-pdf.ts:269-273 does separate typed request errors (400) from the rest (500 with a generic message), so the two routes are inconsistent.
- A transient Prisma error would therefore reach the user as a 400 carrying the Prisma message.

**What weakens the claim**
- This is the documented convention, not an oversight. docs/course-print.md §8.1 line 842 says 'any other composer error | 400 with its message'; §8.2 line 929 says a worker error is 'a 400, §8.1'; line 1095 says a worker that dies or the 10 min timeout is '400 { error } with the message (maps.pdf's convention, §8.1)'. The test 'any composer error is a 400; there is no other path to fall back to' (course-maps.test.ts:633-643) pins it.
- The spec only covers composer and worker errors. DB errors falling into the same 400 are an unspecified side effect of the catch-all.
- The 'no retry / no fallback' consequence is wrong. client.ts:280 throws on any `!res.ok`, and §8.6 line 1404 says 'a 4xx / 5xx stays the export's error'. A 500 would be handled identically by the device client.
- Server faults are not invisible. Both handlers call `req.log.error(error)` (routes.ts:465, 492). Only status-code-based 5xx dashboards miss them.
- Both routes require `courses.view` (routes.ts:429, 480), so internal messages reach authenticated organisers only, and no secrets are involved.

**Net**
A real but small engineering inconsistency: wrong status class for server faults, raw messages to organisers, and a mismatch with descriptions-pdf.ts. It causes no wrong output, no data loss and no change in client behaviour, so severity is low, not higher.

</details>

### CRS-084 Registration receipt reprint prints a negative rental fee when the runner carries the 'use event default' card-fee sentinel

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** low · **Size:** S
- **Location:** `packages/web/src/pages/RunnerManagement.tsx:116`
- **Status:** confirmed. Code read only, no reproduction run. Traced runner.list -> RunnerManagement reprint -> receipt builders, then searched every writer of Runner.cardFeeCents to see how a negative value can exist.

**What is wrong.** `runner.list` returns the raw `cardFeeCents` (runner.ts:407), which can be negative as a sentinel meaning 'rental at the event's fee' (resolved only in runner.ts:245-251 and eventor.ts:1764). The reprint passes any non-zero value as `payment.cardFee`, and the builder computes `entryFee = amount - cardFee` (escpos.ts:561).

**Scenario.** A runner with card fee -1 and 150 paid: the reprinted receipt shows 'Entry fee 151,00 kr' and 'Rental card -1,00 kr'.

**Proposed fix.** Return the resolved card fee from `runner.list` as the detail endpoint does (or resolve it in the page from `event.cardFee`), and only pass `cardFee` when it is greater than 0.

**Verifier's note on the fix.** Guarding only `> 0` at RunnerManagement.tsx:116 would drop the rental line for sentinel runners. Better to resolve the sentinel against the event fee, either in runner.list or client-side via competition.getCardFee, mirroring runner.ts:245-251. If the event fee is 0 the resolved value is still negative, so the reprint must also omit the line when the result is <= 0. Clamping in both builders (escpos.ts:561-564 and :591, star-raster.ts:690-693 and :713) would cover any other caller.

<details><summary>Verifier's evidence</summary>

The defect is real for any runner whose stored card fee is negative, but only two paths can store one.

The display path, as claimed:
- packages/api/src/routers/runner.ts:407 returns the raw value (`cardFee: r.cardFeeCents`). The sentinel is resolved only in runner.getById (runner.ts:243-251) and the Eventor export (routers/eventor.ts:1763-1768).
- packages/web/src/pages/RunnerManagement.tsx:116 passes any non-zero value through: `cardFee: (runner.cardFee ?? 0) !== 0 ? runner.cardFee : undefined`. The button at :368 hands it the list row.
- packages/web/src/lib/receipt-printer/escpos.ts:561-564 computes `entryFeeAmount = amount - (cardFee ?? 0)` and prints the rental line whenever `cardFee` is truthy. `formatAmountSEK` (escpos.ts:303) is `${amount},00 kr` with no clamp.
- With amount 150 and cardFee -1 this prints 'Entry fee 151,00 kr' and 'Rental card -1,00 kr'. That is in kvitto mode (orgNumber set).
- In non-kvitto mode (escpos.ts:587-593) only the '-1,00 kr' rental line is wrong.
- star-raster.ts:690-693 and :713-714 have the same logic.
- The total (escpos.ts:580) uses `payment.amount` and stays correct.

Sibling UI code already treats negative as 'rental, fee unknown': RunnerInlineDetail.tsx:262 shows the amount only when `r.cardFee > 0`. The reprint lacks that guard.

How a negative value gets stored:
- No in-app UI writes one. RegistrationDialog.tsx:631 sends `rentalFee > 0 ? rentalFee : 0`, and the event fee is validated `min(0)` (routers/event.ts:970).
- packages/api/scripts/migrate-mysql-to-pg.ts:687 copies the MeOS `CardFee` verbatim (`Number(r.CardFee) || 0`), so a MeOS-migrated event can carry the sentinel.
- runner.create and runner.update accept any integer (`z.number().int()`, runner.ts:189 and :211), so a direct API call can store one.

There is no DB constraint on the column (schema.prisma:836), and nothing about this appears under a 'Pending' section.

Severity is low to medium; I chose low. It needs migrated or API-written data plus a manual reprint, the result is two wrong lines on a printed receipt, the total is right, and no stored data changes. The wrong lines are on a customer-facing receipt, which is the argument for medium.

</details>

### CRS-085 Star raster receipt is silently cut at 4096 dots, and the logo height is unbounded

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** low · **Size:** S
- **Location:** `packages/web/src/lib/receipt-printer/star-raster.ts:379 (cap), packages/web/src/lib/receipt-printer/raster.ts:34 (unbounded logo height)`; also packages/web/src/lib/receipt-printer/raster.ts:34
- **Status:** confirmed. Code read only (no reproduction run; canvas not available without node_modules). Read /home/user/oxygen/packages/web/src/lib/receipt-printer/star-raster.ts:44-48, 222-227, 245-271, 309-328, 378-409, 467-612; /home/user/oxygen/packages/web/src/lib/receipt-printer/raster.ts:31-36; the four fetchLogoRaster callers (FinishStation.tsx:95, CompetitionShell.tsx:283, RunnerManagement.tsx:87/100, RegistrationDialog.tsx:666, all with width 250); packages/api/src/index.ts:135-158 (logo endpoint serves the stored PNG as is); packages/web/src/lib/offline/local-readout.ts:116 (class results capped at 5). Then summed the layout heights by hand for the claimed scenario.

**What is wrong.** `build()` clamps to `MAX_HEIGHT_DOTS` with no warning, and drawing beyond the canvas is dropped. `fetchLogoRaster` (raster.ts:34-36) scales any logo to the requested width whatever its aspect ratio, so a portrait logo consumes a large share of the height (and of the paper on ESC/POS). Long lines are also clipped at the right edge on Star, where ESC/POS would wrap.

**Scenario.** Portrait club logo 200x800 px scaled to 250x1000 dots, a 60-control score course and a QR code: the Star receipt ends mid-splits with no finish row, position or footer.

**Proposed fix.** Cap the logo height (e.g. 200 dots, scaling by the tighter constraint) in `fetchLogoRaster`; size the canvas from a first measuring pass or grow it when `y` nears the limit; log a warning when truncating.

**Verifier's note on the fix.** The stated example (250x1000 logo, 60 controls, QR) fits in about 3,300 dots, so a regression test must use a taller logo or more controls to exercise the cap. A fix should bound logo height in fetchLogoRaster (scale = min(maxW/w, maxH/h)), which also fixes the ESC/POS paper waste, and either size the Star canvas from measured content or grow it, rather than only adding a warning. Truncation loses the footer and QR first, so do not assume splits are the part at risk. Right-edge clipping affects only the unwrapped runner name/class line and similar free-text lines beyond about 53 characters.

<details><summary>Verifier's evidence</summary>

The mechanism is real, but the claimed scenario does not trigger it.

**What the code does**
- star-raster.ts:222 allocates a fixed 576 x 4096 canvas, and line 379 is `const usedHeight = Math.min(this.y, MAX_HEIGHT_DOTS);`. There is no warning, error or log when `this.y` exceeds 4096; canvas draws past the bottom are dropped.
- raster.ts:34-36 computes `scale = maxWidthDots / img.naturalWidth` and `heightDots = Math.round(img.naturalHeight * scale)` with no height cap. The comment says "at most maxWidthDots", but upscaling is allowed and aspect ratio is not bounded.
- The logo endpoint (api/src/index.ts:135-158) returns the Eventor PNG unmodified, so nothing upstream bounds the aspect ratio.
- `line()` and `leftRight()` (star-raster.ts:254-273) call `fillText` with no wrapping, so an over-wide line is clipped at 576 dots. Only the competition name and custom message go through `wordWrap`; the runner line `  ${name}  ${className}` (line 496) is unbounded. At 18px monospace (about 10.8 dots per character) roughly 53 characters fit, so only very long name plus class strings clip.

**Why the claimed scenario is wrong**
Heights for a 250 x 1000 logo, 60 controls, QR code:
- Leading feed, logo, feed: 24 + 1000 + 24 = 1048
- Header (name 44-88, date 32, separator 12): about 90-130
- Runner block and status block with separators: about 120
- Splits: header 24 + 60 x 24 + finish row 24 + separator 12 = 1500
- Position and 5 class results with separator: about 156
- QR (label 24 + 4 + about 185 + 24): about 240
- Footer: 120

Total is about 3,300 dots, under 4096, so the receipt prints in full. It does not end mid-splits.

**What it actually takes to truncate**
- With a 1:4 portrait logo: roughly 90 or more controls.
- With 60 controls: a logo taller than about 1,800 dots at 250 wide, i.e. aspect ratio beyond about 1:7.
- With no logo: about 140 controls.

When it does overflow, the content lost first is the tail (timestamp, footer, QR), not the splits. The logo height being unbounded also wastes paper on ESC/POS (escpos.ts:320, 495), which is the more likely practical effect of a portrait logo.

Not listed under any "Pending" section of docs/map-*.md or docs/course-*.md (receipts are outside those specs).

</details>

### CRS-086 Finish receipt mixes hard-coded English with translated labels

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** low · **Size:** S
- **Location:** `packages/web/src/lib/receipt-printer/escpos.ts:347-352`; also packages/web/src/lib/receipt-printer/star-raster.ts:503
- **Status:** confirmed. Code read only (no reproduction run). Read packages/web/src/lib/receipt-printer/escpos.ts:310-355, star-raster.ts:499-510, types.ts:39-49, packages/shared/src/types.ts:138-160, packages/web/src/context/PrinterContext.tsx:84-99 and 178-188, and packages/web/src/i18n/locales/sv/receipt.json. Looked for any guard or override that would translate the status line before printing; found none.

**What is wrong.** The status line uses `runnerStatusLabel` (English only, shared/types.ts:138), the literal 'Time:' and 'min/km', while the surrounding labels come from the `receipt` i18n namespace via `FinishReceiptLabels`. Same in star-raster.ts:503-508.

**Scenario.** With the UI in Swedish, a mispunched runner's receipt reads 'Start: ... Mal: ...' followed by 'Missing Punch  Time: -'.

**Proposed fix.** Add `time`, `pacePerKm` and a status-label map to `FinishReceiptLabels`, fill them in `useReceiptLabels` (PrinterContext.tsx:89), and use them in both builders.

**Verifier's note on the fix.** - Add optional fields to `FinishReceiptLabels` for the time label, the pace unit and the status label (or a status-to-string map), with English defaults in BOTH `DEFAULT_FINISH_LABELS` tables (escpos.ts:20 and star-raster.ts:55).
- Fill them in PrinterContext.tsx `useReceiptLabels`. The hook currently loads only the `receipt` namespace, so status labels need the `status` namespace as well, or new keys in `receipt`. The existing unused `receipt.runningTime` key can serve as the time label.
- The ESC/POS line is 38 characters wide. Longer Swedish status text plus the pace suffix may overflow or wrap, so check the line length.
- Check that the ESC/POS text encoding handles å/ä/ö in the status line (other translated labels such as "Mål" already go through the same path).
- Existing tests may assert the English `Time:` string; keep the defaults unchanged so they still pass.

<details><summary>Verifier's evidence</summary>

The claim holds as stated.

- escpos.ts:345 prints the Start/Finish line from the translated labels (`L.start`, `L.finish`).
- escpos.ts:347-352 then builds the status line as `runnerStatusLabel(status)` + the literal `Time:` + the literal `min/km`. star-raster.ts:503-508 is identical.
- `runnerStatusLabel` (shared/src/types.ts:138 onward) returns fixed English strings: "Missing Punch", "Did Not Finish", "Disqualified" and so on.
- `FinishReceiptLabels` (types.ts:39-49) has no field for status, time or pace unit, so the caller cannot translate them. PrinterContext.tsx:89-99 passes only start, finish, splitHeader, fin, battery, position, competitionInfo, tagline and missing.
- The only production call path is PrinterContext.tsx:184-188, which merges those labels and calls the builders directly; nothing rewrites the status line afterwards.
- sv/receipt.json already has an unused `"runningTime": "Löptid"` key, and a `status` i18n namespace exists (locales/sv/status.json), so the translations are available but not wired in.

With the UI in Swedish, a mispunched runner's receipt therefore reads `Start: ...   Mål: ...` followed by `Missing Punch  Time: ...`, while the split header and the missing-control marker are in Swedish.

One detail of the claimed scenario I did not verify: whether the time prints as `-` for a mispunch depends on `formatRunningTime`, which I did not read. It does not affect the defect.

Severity: this is cosmetic. Times, status and splits are all correct, and the English terms are understandable to the runner. Nothing fails. I rate it low.

</details>

### CRS-087 Free-order receipts pair leg lengths with punch order, giving wrong pace per split

- **Area:** Start/result lists and receipts · **Category:** functional · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/routers/race.ts:180-198`
- **Status:** confirmed. Code read only (no reproduction run; node_modules absent and the logic is short enough to prove by reading). Followed race.ts finishReceipt -> performReadout (routers/cardReadout.ts:313 `legs: parseLegsString(course.legs)`, `controls: matches`) -> packages/shared/src/readout.ts matchPunchesToCourse/matchFreeOrder -> receipt printers (packages/web/src/lib/receipt-printer/escpos.ts:376-390, star-raster.ts:517-528). Then checked whether a free_order course can have a non-empty `legs` string at all (course-geometry.ts:293-305, routers/course.ts:2164-2170, 2219/2239, 1206-1212).

**What is wrong.** `legLength: legs[idx]` and `controlIndex: idx` use the array index of `r.controls`. For `free_order` courses `matchFreeOrder` emits matches in punch order (readout.ts:418-455), so the index is not the course position and `legs[idx]` is the length of an unrelated leg. In ordered courses, filtering 'skipped' positions after indexing leaves gaps in the printed numbering.

**Scenario.** Free-order course, runner takes the controls in reverse: each split row prints a min/km pace computed from the planned leg of a different control.

**Proposed fix.** Send `legLength: 0` (pace '-') when `course.orderMode === 'free_order'`, and number rows with a running counter of non-skipped positions (or `m.controlIndex` consistently).

**Verifier's note on the fix.** Using `legs[m.controlIndex]` instead of `legs[idx]` would not make the pace right for free order: the stored leg into position N is the planned leg from position N-1, not the leg the runner actually ran. The receipt should send legLength 0 (no pace) for free_order courses; performReadout's return does not currently expose orderMode in `course`, so it has to be added or looked up. Consider also clearing `legs` when a course becomes free_order (course-geometry.ts:293-305 leaves the old string) and on import of a free-order course (routers/course.ts:2164-2170). The Fin row in both printers reuses the last split's legLength and splitTime (escpos.ts:396-402, star-raster.ts:534-540), which is a separate oddity to keep in mind when touching this. For the ordered case, decide deliberately whether printed numbers should keep course positions (gaps at skipped controls) or be renumbered; `controlIndex` is typed as "0-based sequence number on the course" in receipt-printer/types.ts:22.

<details><summary>Verifier's evidence</summary>

1. race.ts:180-198: `r.controls.forEach((m, idx) => { ... controlIndex: idx, ... legLength: legs[idx] ?? 0 })`. The comment at 164-165 states the assumption "The matcher's `controls` array is already ordered by course position"; the code ignores `m.controlIndex`, which the matcher does set correctly.
2. That assumption is false for free order: packages/shared/src/readout.ts:417-455 (matchFreeOrder) walks punches in card order and pushes ok matches in punch order with `controlIndex: claimedCi`; its doc comment says "Ok matches are emitted in punch (chronological) order". Missing positions are appended afterwards (457-470). So for a reversed run the array index idx is unrelated to the course position, and `legs[idx]` is the stored leg into position idx, not into the control punched.
3. The legs array can be non-empty for a free_order course, so the guard in the printers (`legLength > 0`, escpos.ts:387) does not hide it:
 - course-geometry.ts:293-296: "Free-order courses have no meaningful legs — leave lengthM / legs alone"; `if (orderMode !== "free_order" && mapScale)` only skips rewriting, it does not clear. A course switched from ordered to free order (routers/course.ts:815 and 1182, followed by rebuildCourseLengths at 945 / 1206) keeps the legs string derived while it was ordered.
 - routers/course.ts:2164-2170 builds `legsStr` from the parsed file's per-control legLength for every course and writes it at 2219/2239 together with `orderMode: pc.orderMode`, with no free-order exception (only the geometry features are filtered at 2175).
4. Printers compute pace per row from `split.legLength` and `split.splitTime` (escpos.ts:387-389, star-raster.ts:527-529), so each row shows a min/km figure from a leg that was not the one run.
5. Second half of the claim (ordered courses): race.ts:181 returns for `positionMode === "skipped"` after idx has advanced, and the printers print `controlIndex + 1` (escpos.ts:376), so the printed numbering jumps over skipped positions. True as stated; whether the gap is unwanted is a matter of taste (the number is still the real course position), and legs[idx] stays correctly aligned in the ordered case.
Limits on the claim: no leg length is meaningful for a free-order run at all (the runner did not run a planned leg), so the real fault is that pace is printed for free-order courses whenever a legs string is stored, not only that the pairing is off. Results, status, split and cumulative times are unaffected (they come from the matcher, not from idx). Nothing in docs/course-*.md or docs/map-*.md "Pending" sections lists receipt pace for free order as not implemented.

</details>

### CRS-088 USB mode flash is reported and recorded as done without reading it back

- **Area:** Start/result lists and receipts · **Category:** engineering · **Severity:** low · **Size:** S
- **Location:** `packages/web/src/context/PrinterContext.tsx:254`; also packages/web/src/context/PrinterContext.tsx:246
- **Status:** confirmed. Code read only (no reproduction; needs a physical printer). Read packages/web/src/components/PrinterSettingsDialog.tsx:93-108 and 305-327, packages/web/src/context/PrinterContext.tsx:220-270, packages/web/src/lib/receipt-printer/drivers/webusb.ts:419-449, packages/web/src/i18n/locales/en/devices.json:125-127,143, and docs/ops/printer-mode-management.md:44-56 and 340-368. Grepped all of packages/ for readUsbMode/flashUsbMode callers.

**What is wrong.** `handleFlash` shows success and `flashUsbMode` writes the flash-history record (PrinterContext.tsx:254-261) as soon as the bytes are sent. The driver comments say the firmware can silently ignore the write and provide `readUsbMode()` 'for verifying a flash command landed', but nothing calls it (the context method is unused).

**Scenario.** The write is ignored. The dialog says the mode was changed and to power-cycle; the printer comes back in the old mode, and the history now holds a 'borrowed printer, restore before returning' warning for a change that never happened.

**Proposed fix.** After `driver.flashUsbMode`, call `driver.readUsbMode()` when `supportsRead` and only record and report success if it equals the target; otherwise show `flashFailed`. Remove `readUsbMode` from the context if it stays unused.

**Verifier's note on the fix.** A read-back can only be best-effort. fn=4 reads do not work in Virtual COM mode (docs/ops/printer-mode-management.md:352-363), and the fn=2 exit may soft-reset the printer, so a failed or timed-out read must not be treated as a failed flash. Verify only when `supportsRead` is true and the current mode is Printer Class, and treat only a positive mismatch as failure. A simpler alternative is to reconcile the history record on the next connect by comparing the PID-derived mode with the record's `toMode`. The docs flowchart (Send -> Record) needs updating if the order changes.

<details><summary>Verifier's evidence</summary>

The mechanical facts hold.

- PrinterContext.tsx:254-261: `await driver.flashUsbMode(targetMode)` is followed immediately by `recordFlash({... fromMode: currentMode, toMode: targetMode })`, with no read in between.
- webusb.ts:431-438: `flashUsbMode` is three `sendBytes` calls with sleeps and returns void. It only throws on a USB transfer error, so a write the firmware ignores is indistinguishable from success.
- webusb.ts:423-424 states that plain fn=3 "is silently ignored on at least the 2014 CT-S310II firmware"; webusb.ts:440-449 describes `readUsbMode()` as "useful for verifying a flash command landed correctly before power-cycling".
- The only references to `readUsbMode` are its definition (webusb.ts:446), the context wrapper (PrinterContext.tsx:68, 220-225, 309) and nothing else. PrinterSettingsDialog.tsx:55 does not destructure it. It is dead code.
- PrinterSettingsDialog.tsx:98-100 sets the `flashed` state and refreshes the borrowed record straight after the send. devices.json:143 then shows "This printer was flashed from X to Y ... Restore it to X before returning it."

Three things make the claim overstated.

1. The dialog does not say the mode was changed. devices.json:125-126 reads "Mode change sent" and "Now power-cycle the printer ... It will re-enumerate as a {{mode}} device." The claim's "says the mode was changed" is only half right; the body text does still promise the new mode.
2. Recording straight after the send is the documented design: docs/ops/printer-mode-management.md:50-52 shows Send -> Record -> Notify.
3. Read-back is not generally possible. docs/ops/printer-mode-management.md:352-363 says fn=4 reads work only in Printer Class mode; in Virtual COM mode the IN endpoint streams a status pattern and the response never arrives. webusb.ts:426-427 adds that fn=2 "typically triggers a soft reset". So verification could cover at most the Printer Class -> Virtual COM direction, and might fail even there.

Consequence if the write is ignored: after the power-cycle the printer re-enumerates with the old PID, which the dialog reads from the USB descriptor, so the operator sees the unchanged mode. The stale borrowed-printer warning lives in localStorage and has a dismiss handler (PrinterSettingsDialog.tsx:120-124). No data loss and no effect on results; the write is already wrapped in the fn=1/fn=2 envelope that addresses the known silent-ignore case.

</details>

### CRS-089 The shortest-route search runs the same full-grid Dijkstra twice and never stops at the target

- **Area:** Elevation, climb, leg routes, route finder (PR #254) · **Category:** performance · **Severity:** low · **Size:** S
- **Location:** `packages/shared/src/route/alternatives.ts:179`; also packages/shared/src/route/search.ts:33; packages/shared/src/route/leg.ts:131
- **Status:** confirmed. Code read of /home/user/oxygen/packages/shared/src/route/alternatives.ts:147-189 and 235-268, /home/user/oxygen/packages/shared/src/route/search.ts:33-97, /home/user/oxygen/packages/shared/src/route/leg.ts:77-95 and 124-132, /home/user/oxygen/packages/api/src/leg-routes-auto-worker.ts:17-24, and docs/course-elevation.md §7.5 plus its "Pending in this chapter" section (line 1291 on). Also timed a standalone JS copy of costField (unit factors, a wall with one gap) in node, with and without a stop at the target cell. The repo's test suite was not run (no node_modules).

**What is wrong.** searchStretch always computes `fwd = costField(g, o.model, a)` and then `shortField = costField(g, SHORTEST_COST_MODEL, a)`. The automatic route calls it with model = SHORTEST_COST_MODEL and alternatives 0 (leg.ts shortestLegRoute), so both fields are identical. costField (search.ts:33) also settles every cell of the window (up to 1.2 million) even when only the path to one cell is wanted, and `distinctRoutes` and the `same` check allocate a cols*rows Uint8Array per route.

**Scenario.** Every searched pair of the server's refresh costs two complete Dijkstra passes over the window where a single pass stopped at the target cell would do. On a sprint event with a few hundred searched pairs this at least doubles the minutes of background CPU on the event laptop and lengthens the window in which climbs are empty.

**Proposed fix.** In searchStretch reuse `fwd` when o.model is SHORTEST_COST_MODEL (or o.model.id === 'shortest'). Give costField an optional `target` that returns once the target is popped, and use it for the shortest field and whenever alternatives === 0. Existing route.test.ts determinism tests cover the result.

**Verifier's note on the fix.** - Reuse `fwd` as `shortField` only when `o.model` is `SHORTEST_COST_MODEL` (identity or id check). `findLegRoutes` passes other models and still needs the separate distance-only field.
- An early stop at the target is valid only when `alternatives` is 0. The alternatives branch reads `fwd.cost[i]` for every cell (alternatives.ts:166), so the stop must be an optional `costField` parameter, not the default.
- The stop must come when the target is popped (settled), not when it is first relaxed.
- The found routes must stay identical, so the stored `auto_basis` / `AUTO_ROUTE_VERSION` need no bump.

<details><summary>Verifier's evidence</summary>

The redundancy is real; the claimed impact is overstated.

**What the code does**
- `searchStretch` computes `fwd = costField(g, o.model, a)` at alternatives.ts:148 and, unconditionally, `shortField = costField(g, SHORTEST_COST_MODEL, a)` at alternatives.ts:179.
- `shortestLegRoute` (leg.ts:129) calls `findRoutes` with `model: SHORTEST_COST_MODEL, alternatives: 0`. Both calls therefore have the same grid, model and origin, and `costField` is deterministic, so the two fields are identical.
- The second path equals the first, so the `same` check (alternatives.ts:181-185) always matches at share 1.0 and only sets `shortest = true` on the existing entry. The second pass contributes nothing on this path.
- `costField` has no target parameter: the loop at search.ts:76-95 runs until the heap is empty, settling every reachable cell. With `alternatives: 0` the reverse field and the via-cell scan are skipped (alternatives.ts:157), so nothing on this path needs the full field.
- The `same` check allocates a `cols*rows` Uint8Array per found route (alternatives.ts:182), and `distinctRoutes` one per kept route (alternatives.ts:218).
- The only production caller of `shortestLegRoute` is the auto-route worker (leg-routes-auto-worker.ts:20), one call per searched pair; via legs call `searchStretch` once per stretch (alternatives.ts:260).
- Nothing in "Pending in this chapter" of docs/course-elevation.md covers this, so it is not a documented not-yet-implemented item.

**Why the impact is smaller than claimed**

Timing of the copied Dijkstra:

| Cells | Full pass | Stopped at target |
|---|---|---|
| 51,200 | 15 ms | 11 ms |
| 320,000 | 87 ms | 57 ms |
| 1,201,250 | 259 ms | 140 ms |

- The 1.2 million figure is a cap (`ROUTE_MAX_CELLS`, leg.ts:80), not the typical size. The window is the leg's box padded by max(10 mm, half the leg length) at 0.25 mm cells (leg.ts:86-95), so a 40 mm sprint leg gives roughly 50,000 cells.
- The wasted second pass is therefore about 15 ms for a typical sprint pair and at most about 0.26 s at the cap. For a few hundred pairs that is seconds, about a minute in the worst case, not "minutes doubled".
- Stopping at the target saved only 30-45% of one pass in this geometry, because the window is centred on the leg.
- A legal straight line skips the search entirely (leg.ts:128).
- The work runs in worker threads off the event loop (docs/course-elevation.md §7.5 "What is searched"), so no request is held.
- Climbs are not generally empty during the refresh: the climb is read along the stored route meanwhile (§7.5, "for the seconds the search takes"). Only a chosen row whose vertices changed clears climbs until the refresh ends.

No wrong results follow from this; it is wasted background CPU.

</details>

### CRS-090 course.update changing firstAsStart / lastAsFinish leaves a stale computed climb

- **Area:** Elevation, climb, leg routes, route finder (PR #254) · **Category:** functional · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/routers/course.ts:938`
- **Status:** confirmed. Code read only, no reproduction run (node_modules absent, needs a DB). Read /home/user/oxygen/packages/api/src/routers/course.ts:783-960 (course.update) and 1157-1222 (course.bulkUpdate), /home/user/oxygen/packages/api/src/course-geometry.ts:270-327, /home/user/oxygen/packages/api/src/course-structure.ts:60-69, docs/course-elevation.md:567, and grepped packages/web/src for callers.

**What is wrong.** course.update rewrites the structure when firstAsStart or lastAsFinish changes (rewriteStructureFromColumns), which adds or removes the start/finish leg, but only calls rebuildCourseLengths (and with it clearComputedClimbs) for controlIds, start/finish assignment or orderMode. The PR added the clear for the same change in course.bulkUpdate (line 1202-1205) and the spec §6 "When" lists only bulkUpdate; the single-course procedure accepts the same fields and was missed.

**Scenario.** An API client (or a future UI) calls course.update { id, firstAsStart: true } on a course with a computed climb. The leg from the start triangle to control 1 disappears from the course, but climb_m keeps the value that included it, with source 'computed', until the next geometry edit; that number is printed and exported.

**Proposed fix.** In course.update's transaction, when input.firstAsStart or input.lastAsFinish is defined call `clearComputedClimbs(tx, ctx.event.id, [c.id])` (as bulkUpdate does), add the case to docs/course-elevation.md §6 "When", and extend the integration test 'bulk end moves' with the single-course call.

**Verifier's note on the fix.** Simplest fix is adding input.firstAsStart / input.lastAsFinish to the condition at course.ts:938-942 so rebuildCourseLengths runs (it also refreshes the stale legs string and clears the computed climb). Note that this would also recompute length_m when input.length is undefined, which differs from bulkUpdate (which only clears the climb and never rebuilds legs/length for these flags); decide which behaviour is intended and make both procedures agree. Update docs/course-elevation.md §6 "When" (line 567) to name course.update, and add a test beside course-climb.test.ts:210.

<details><summary>Verifier's evidence</summary>

course.update accepts firstAsStart/lastAsFinish, writes them to the columns (course.ts:817-820) and rewrites the structure for them (course.ts:927-937: the condition includes input.firstAsStart / input.lastAsFinish). The following block that calls rebuildCourseLengths (course.ts:938-949) is conditioned only on controlIds, startFinishChanged (startControlId/finishControlId) and orderMode. clearComputedClimbs is reached only through rebuildCourseLengths (course-geometry.ts:312) and is not called anywhere else in course.update, so a call with only firstAsStart/lastAsFinish leaves climb_m and climb_source='computed' untouched. The only climb handling in update is for input.climb (course.ts:807-810).

The flag does change the course's ends: course-structure.ts:60-69 drops the separate start site when firstAsStart and the finish site when lastAsFinish, so the start-to-first-control or last-control-to-finish leg disappears or appears.

The sibling procedure handles it explicitly: course.ts:1202-1205 "The course's ends moved: a computed climb no longer holds" -> clearComputedClimbs, covered by course-climb.test.ts:210-213 for bulkUpdate only. Spec docs/course-elevation.md:567 lists only course.bulkUpdate for this trigger; it is not under a Pending section. No self-heal: refreshClimbs computes only for courses that have no climb (course.ts:1225-1226 doc), so the stale value persists until a geometry edit or map change.

Limiting factors for severity: no web code sends firstAsStart/lastAsFinish to course.update or bulkUpdate (grep of packages/web/src shows only reads: CoursesPage.tsx:525-541, course-overlay-ids.ts, course-anchors.ts), so this is reachable only by a direct API client today. The effect is a climb figure off by one leg's ascent, not corrupted data. The same call also leaves the derived legs string and length_m stale (rebuildCourseLengths skipped entirely), which predates this PR.

</details>

### CRS-091 computeMissingClimbs reloads every chosen route of the event once per course, inside the awaited mutation

- **Area:** Elevation, climb, leg routes, route finder (PR #254) · **Category:** performance · **Severity:** low · **Size:** S
- **Location:** `packages/api/src/course-climb.ts:120`
- **Status:** confirmed. Code read only (no reproduction run, no timing measured): packages/api/src/course-climb.ts:97-130, leg-routes.ts:14-22, trpc.ts:169-184, course-climb-pending.ts, course-geometry.ts:321-327, leg-routes-auto.ts:202-209, shared/src/course/leg-routes.ts:14-15, prisma/schema.prisma:669-692, and the "Pending in this chapter" section of docs/course-elevation.md (line 1291).

**What is wrong.** Inside the per-course transaction the loop calls `chosenLegRoutes(tx, eventId)`, which reads and zod-parses all chosen leg_routes rows of the event (up to 2000 points each), and `loadCourseSequences` for one course. For an `all` mark (course import, map upload, rotation change) or a control shared by many courses this is N full reads of the table, and the eventProcedure middleware awaits it before the mutation's response is returned (trpc.ts:176).

**Scenario.** Import 40 courses on an event with 600 chosen routes: the import request reads and parses the 600-row route table 40 times after its own work before it answers. Moving a control used by 30 courses does the same on every drag commit.

**Proposed fix.** Read the chosen routes once before the loop (routes are only changed by route writes, which clear and re-mark the affected courses themselves) and pass the map into the loop; keep the per-course row lock. If strict consistency is wanted, re-read only the rows of the course's own pairs with a `where` on the pair ids.

**Verifier's note on the fix.** Hoisting `chosenLegRoutes` out of the loop is the obvious fix, but it lengthens the window in which a concurrent route change can commit between the read and a course's write. `legRoute` mutations clear climbs with `updateMany … climbSource: "computed"` (course-geometry.ts:322-325), which matches and locks no row while the climb is still 0, so the per-course `FOR UPDATE` does not serialise against them. The stale climb would then stay, because the route mutation's own follow-up compute finds the course no longer open. That race already exists with the in-transaction read; a hoisted read widens it from one course's transaction to the whole loop. If hoisting, either re-check the routes (for example by `updatedAt`) or accept and document this. `loadCourseSequences` can stay per course, or be batched with the same caveat.

<details><summary>Verifier's evidence</summary>

The claim is accurate as stated.

- course-climb.ts:108-127 loops over every open course and, inside each per-course `db.$transaction`, calls `loadCourseSequences(tx, eventId, [id])` (line 117) and `chosenLegRoutes(tx, eventId)` (line 120).
- leg-routes.ts:14-22: `chosenLegRoutes` is an event-wide `legRoute.findMany({ where: { eventId, chosen: true } })` with no course or pair filter, and it zod-parses each row's `points` (`legRoutePointsSchema`, max 2000 points, shared/src/course/leg-routes.ts:14-15). Nothing caches or memoises it between iterations.
- trpc.ts:176: `if (result.ok && marks.size > 0) await refreshMarkedClimbs(ctx.db, marks);` runs before `return result`, so the mutation's response waits for the whole loop.
- "all" marks are real: `clearComputedClimbs(…, "all")` at event-map.ts:68 and routers/course.ts:2311 (import) reach `markClimbPending`, and course-climb.ts:135 turns "all" into an unfiltered compute. Control moves mark every affected course through `rebuildCourseLengths` -> `clearComputedClimbs` (course-geometry.ts:312; routers/control.ts:859, 1061, 1158, 1239).
- Hundreds of chosen rows are realistic: the automatic route of a pair is created `chosen` when no other route of the pair is (leg-routes-auto.ts:204-209), so each leg pair run by an ordered course normally has one chosen row.
- Not listed as pending: docs/course-elevation.md "Pending in this chapter" does not mention this.

Limits on the cost, which is why I rate it low:
- Only open courses are iterated (climb 0 and not computed, line 99-100); courses with a typed or imported climb are skipped.
- The function returns before the loop when the event has no climb sampler (lines 105-106), so events without a stored height field pay nothing.
- Each read is one query on `leg_routes`, which has an index leading on `eventId` (schema.prisma:689). The result is N-fold redundant read and parse work, not quadratic growth, and it produces no wrong result.
- Realistic added latency is probably tens of milliseconds to a second or two on the worst mutations (large import, map change); I did not measure it.

</details>

### CRS-092 No unload guard while writes are in flight or queued

- **Area:** Web course editor: pages · **Category:** stability · **Severity:** low · **Size:** S
- **Location:** `packages/web/src/pages/editor/EditorPage.tsx:172 (pendingOps state; line 2509 is only the save-indicator derivation; the guard would be a new effect)`
- **Status:** confirmed. Code read only, no reproduction. Grepped packages/ (ts, tsx, html) for beforeunload|pagehide|onbeforeunload|sendBeacon|keepalive|useBlocker|usePrompt: zero hits. Read packages/web/src/pages/editor/EditorPage.tsx:172, 336-363, 704-721, 1342, 1392, 2509. Grepped docs/course-*.md and docs/map-*.md, including the "Pending in this chapter" section of docs/course-editor.md (line 3371 onward), for unload/close/leave wording.

**What is wrong.** The editor is autosave-only, but there is no `beforeunload` / `pagehide` handling anywhere in packages/web/src. Closing or reloading the tab while `pendingOps > 0`, while placements or instruction edits wait in `placeQueue` / `instructionsQueue`, or while a Layout commit is in flight drops them with no warning. Outbox entries survive but are sent only when the editor is next opened on that device (documented in §9).

**Scenario.** The setter types a finish length, tabs out and immediately closes the laptop lid or tab on a slow link: the `course.update` is cancelled, and on the next visit the description sheet prints the old length.

**Proposed fix.** Register a `beforeunload` handler while `pendingOps > 0` or `outbox.counts.pending > 0` (use the save state already computed at line 2509) so the browser asks before leaving; remove it when saved.

**Verifier's note on the fix.** A `beforeunload` prompt should be registered only while something is unsaved, since a permanent listener disables the back-forward cache. `pendingOps > 0` covers the `run`-wrapped queues, because each queued item enters `run` only when it starts but its predecessor is still counted; I did not check whether Layout commits go through `run`, so they may need their own flag. `beforeunload` is unreliable on mobile and on lid close, so a prompt alone does not cover the claimed lid-close case; `keepalive: true` on the tRPC fetch for small mutations would. In-app route changes away from the editor are a separate path that `beforeunload` does not cover. The behaviour would need a spec line in docs/course-editor.md (§3 or §9) per the project's spec-first rule.

<details><summary>Verifier's evidence</summary>

The absence is real. The only page-lifecycle listeners in packages/web/src are `visibilitychange` in hooks/usePageVisible.ts:4, lib/map-document-cache.ts:403 and pages/editor/useFieldOutbox.ts:131; none of them guards or flushes writes on unload.

In EditorPage.tsx, `pendingOps` (line 172) is incremented and decremented in `run` (337, 360) and is used only for the save indicator (2509), `busy` flags and effect guards. `instructionsQueue` (704, 712) and `placeQueue` (1342, 1392) are in-memory promise chains held in `useRef`; anything chained behind an in-flight write is gone on unload. No fetch uses `keepalive`.

The gap is not documented as known: no Pending entry in docs/course-editor.md or the other course/map specs mentions an unload warning, so the 'refuted because Pending' route does not apply.

The claimed scenario is overstated. A write is dispatched immediately when its queue is empty (`run(redo)` at line 720 runs at once), so a single blur-then-close normally has its request already on the wire, and the server will usually complete it even though the response is discarded. Real loss needs one of: the request not yet flushed on a slow link, or a second or later edit still queued behind an in-flight one. The header shows "saving" during that window (line 2509), so the user has a visible cue. Loss is limited to the last one or few edits; nothing is corrupted, because the writes are sequential and token-checked.

</details>

### CRS-093 A second conflict on the rebased re-send escapes as a raw tRPC error and its token is not seeded

- **Area:** Web course editor: lib/editor · **Category:** engineering · **Severity:** low · **Size:** S
- **Location:** `packages/web/src/lib/editor/write-client.ts:180`; also packages/web/src/lib/editor/__tests__/write-client.test.ts:70
- **Status:** confirmed. Code read only (no reproduction needed; the path is a bare return). /home/user/oxygen/packages/web/src/lib/editor/write-client.ts:165-182 (withToken), /home/user/oxygen/packages/web/src/pages/editor/EditorPage.tsx:336-364 (run) and :205-208 (book re-seeded from refetched lists), /home/user/oxygen/packages/web/src/lib/offline/control-outbox.ts:337-375 (drain outcome mapping) and :267 (retry), /home/user/oxygen/packages/web/src/lib/editor/__tests__/write-client.test.ts:70-79, /home/user/oxygen/docs/course-editor.md:303-305 and :1799-1801.

**What is wrong.** withToken's rebase path is `return send(decision.version)` with no catch. If the row changes again between the conflict and the re-send (two setters nudging, or a check-off landing), the second CONFLICT is not turned into an EditorConflict and versions.seed is not called. EditorPage.run then shows the server's raw message as 'Not saved' instead of the moved/refresh notice, and the outbox marks the entry failed with that message instead of conflict or CHANGED_ELSEWHERE.

**Scenario.** A's field move of 31 conflicts with B's description edit and is rebased; before the re-send lands, B moves 31. The re-send returns CONFLICT; A sees an error string and no Keep mine / Keep theirs, and the queued entry needs a manual Retry.

**Proposed fix.** Wrap the re-send: on a version conflict seed the token and throw EditorConflict from conflictDecision (treating a second `rebase` as refresh). Add a write-client test with two consecutive conflicts.

**Verifier's note on the fix.** Classify the second failure the same way as the first: catch around the re-send, seed the book from versionConflictOfError, and throw an EditorConflict from conflictDecision. If the second decision is again `rebase`, do not loop: the spec says "re-sent once", so either throw a refresh conflict or cap the retries, and record whichever is chosen in docs/course-editor.md §3. Note that a second `rebase` thrown as EditorConflict needs a decision of kind moved or refresh (the class excludes rebase). In the outbox, a `moved` second conflict will then flow into the existing conflict branch, including the samePt "our write already landed" check. Add a test for conflict-then-conflict beside write-client.test.ts:70.

<details><summary>Verifier's evidence</summary>

The mechanism is real. write-client.ts:180 is `return send(decision.version);` inside the catch block, with nothing around it. A rejection of that second send leaves withToken as the raw tRPC error: versionConflictOfError is not applied, versions.seed is not called for the newer token, and no EditorConflict is built.

Downstream effects, as claimed:
- EditorPage.run (EditorPage.tsx:344-357) only shows the moved/refresh notice for `e instanceof EditorConflict`; anything else goes to `setErrorMsg(e.message)`, so the user sees the server's conflict message as the red editor-error text and save state "error", with no Keep mine / Keep theirs.
- control-outbox drain (control-outbox.ts:343-350): the raw error is not an EditorConflict, and isNetworkFailure is false because the tRPC error carries data, so the outcome is `{ failed: e.message }`. The entry becomes status "failed" with the server's message, not "conflict" and not CHANGED_ELSEWHERE.
- The test at write-client.test.ts:70 covers only conflict-then-ok; no test covers a second conflict.

Mitigations that limit the impact:
- Nothing is lost or silently overwritten. The server refuses the write and the user is told it was not saved.
- run's finally block calls invalidate(), and the refetched control.list re-seeds the book (EditorPage.tsx:207), so the missing seed heals on reload and a redo of the edit works.
- A failed outbox entry keeps Retry / Discard; retry re-queues on the book's newest token (control-outbox.ts:267).
- The window is narrow: a second write by another user to the same control must land between the server's CONFLICT answer and the immediate re-send, roughly one round trip. Writes from the same client are serialised per row, so only another client can trigger it.
- The spec says "re-sent once" (course-editor.md:303, 305, 1801) and does not say what a second conflict should produce, so the single re-send matches the spec; the gap is the unclassified error. It is not listed under any Pending section.

Severity: low. It is a rare race whose result is a less helpful message and a manual redo or Retry, with no wrong data.

</details>

## Refuted findings (dropped)

Listed so that nobody raises them again.

- Re-importing Oxygen's own export of a forked event creates duplicate courses beside the live variants (`packages/api/src/routers/course.ts:2146`): The mechanics are as claimed, but the behaviour is specified and its missing half is listed as Pending, so by the stated rule this is refuted.
- The editor's write orchestration has no tests; only pure tool/model modules are covered (`packages/web/src/pages/editor/EditorPage.tsx:336`): The narrow part is true: no unit or component test imports EditorPage.tsx, LayoutMode.tsx or useFieldOutbox.ts; packages/web has vitest only (no jsdom / testing-library / renderHook use), and run (EditorPage.tsx:336), record (:366), applyStructure (:468), deleteControls (:861), runUndo (:2192), LayoutMode save/commit (:209/:241) are closures inside the 3035-line component. pages/editor/__tests__ holds 26 suites plus a fixture, all pure modules.
- Queued moves are keyed by the control's mutable public code, so a renumbering while offline redirects the move (`packages/web/src/lib/offline/control-outbox.ts:108`): The mechanism is real, but it is a documented open limitation, which the task rules class as refuted.

## Not reviewed, or could not be verified

- No test suite, build or E2E run was made. `node_modules` was absent, and no question in this area needed one to settle it. Test-quality findings come from reading the tests.
- The Flaten (Ekudden) club map was not used. Printing findings come from code and fixtures only, not from rendering real event maps.
- PR #254 is still moving. Findings in its files are against `871c74de` and may already be stale on the branch.
- The Eventor upload of course length and climb was not tried against Test-Eventor (open with Marcus).

Each reviewer's own list of what it read only partly or not at all:

### Course data and course/control API

Read in full: routers/course.ts, control.ts, controlSeries.ts, courseObject.ts, classRouter.ts; course-structure.ts, course-variants.ts, variants.ts, course-geometry.ts, course-objects.ts, course-presence.ts, course-checks.ts, course-export.ts, control-id.ts, version-conflict.ts, trpc.ts; shared course/structure.ts, variants.ts, sequence.ts, derive.ts, layer.ts, checks.ts; the Prisma models Control, Course, CourseControl, CourseObject, CoursePresence, Class, ClassCoursePool; docs/course-layer.md §3.5, §6-§7, §8.2, §12 and Pending.
NOT read or only skimmed: packages/shared/src/course/corridor.ts, cuts.ts, bends.ts, arcs.ts, symbols.ts, colour-stack.ts, page-layer.ts, context.ts, types.ts, index.ts and the drawing half of objects.ts (geometry correctness of corridors, cuts, bends and symbol sizes is unverified); all test files under packages/shared/src/course/__tests__ and packages/api/src/__tests__ (only file names and a few greps: test-quality findings in either direction are therefore missing, and 'add a test' statements mean I found no obvious test by grep, not that I proved absence); docs/course-editor.md, docs/course-controls-and-matching.md and docs/architecture.md beyond targeted greps; AGENTS.md beyond a grep.
Not verified because outside scope or not runnable: how peers apply course.upserted / reference.imported (events.push), the seq-allocating DB trigger behind `seq @default(0)`, the web client (whether it always sends baseVersion, filters variants out of the class course picker, or warns before course/control delete), and the print pipeline beyond resolve-layout.ts/sheet-rows.ts lines used to confirm the numbering finding. Nothing was executed (no node_modules); all findings are from reading code. The backup-punch procedures in control.ts (importBackupPunches journals an entry per input row even when createMany skipDuplicates skipped it; pushBackupPunch has no isOriginal guard against a double push) were noticed but not analysed against the punches unique constraints, so they are not listed as findings.

### Course import/export (IOF XML, OCAD, Purple Pen)

Nothing could be executed (no node_modules): all findings are from reading the code. Library behaviour (fast-xml-parser 5.12.1 defaults for parseTagValue, entity handling, XMLBuilder escaping) is from knowledge of the library, not a run; I found no XXE or entity-expansion problem on that basis. The IOF 3.0 XSD and the OCAD file format (course string tokens l/b/p/r/v/q, object-index Status byte) are not in the repo and are from memory; the two OCD findings that depend on them say so and need a real forked file / a file with deleted course objects to confirm. Whether Purple Pen, Condes or OCAD accept the exported files was not verifiable. packages/shared/src/import/**: only xml.ts was read; none of that directory is imported by the course import/export modules (it is the map import pipeline), so the rest was not reviewed. Read in full: the ten scoped API modules, map-coordinate-transfer.ts, the previewImport/importCourses/downloadMap procedures and their helpers in routers/course.ts, the reference.imported applier in routers/events.ts, docs/system/iof-coursedata-export.md, docs/system/ppen-import-export.md, docs/course-import-class-fallback.md. Read only in part: docs/course-controls-and-matching.md (Course length section), docs/course-layer.md (§6.4 import section and Pending), docs/guide course pages (grep), CourseImportDialog.tsx (file handling, defaults, button state), course-structure.ts (persistStructure only). Not read: course-geometry.ts, course-variants.ts, map-projection.ts, event-crs.ts, restGuard.ts, the test files' bodies (only their case titles), slit-angle decoding correctness in the OCD parser (raw values used as angles; covered only by the one fixture), and the XML file encoding path in the browser (FileReader.readAsText assumes UTF-8).

### Course map printing and PDF

Nothing was executed (no node_modules): all findings are from reading; only the SVG validator regexes were replayed in a standalone node script. Not verified at runtime: that browsers execute a <script> inside <metadata> / an expanded internal entity when the graphic URL is opened as a document (standard behaviour, not run here), and resvg's handling of local-file hrefs. Not read: packages/shared/src/course-maps/control-label-placement.ts, overlay-geometry.ts, iof-symbols.ts, iof-symbol-meta.ts; all test files in scope beyond their titles (shared/print/__tests__, web/print/__tests__, API print/graphics tests), so test-quality findings are limited to gaps noted in fixes; the print fixtures (__fixtures__). Docs: docs/course-print.md read in the parts §4.6, §5.2, §6.2-6.4, Pending and grep hits of §8.6; docs/course-layout.md §7-§8 and Pending; docs/course-maps.md and docs/map-rendering.md were not read. Outside scope and only skimmed where printing depends on it: packages/shared/src/course/** (layer, derive, page-layer, objects), render/** (symbolise, image-window), map-store/patches.ts, web callers (download-api, LayoutMode's silent offline run, export-menu's offlineMapQueries, sign-out handling of the `offline-print` cache, how print warnings/storedAt are shown). Not determined: whether firstAsStart/lastAsFinish courses print the first/last control with the right role (print forces role 'control'; the editor's behaviour for this legacy flag was not traced), whether the tRPC client's competition context can differ from the nameId used by prepareOfflinePrint, and real memory/time of a 200-page job in the worker.

### Start/result lists and receipts

Nothing was run: no node_modules, no database, no printer hardware. All findings are from reading code. Hardware-dependent claims (printer stalling on paper-out, default code page of a given printer, CT-S310II memory-switch behaviour) are inferred from the code and the ESC/POS/code-page tables, not observed. Whether the production host sets TZ outside the Dockerfile/compose file was not verified. Read in full: routers/lists.ts, receipt-printer/escpos.ts, star-raster.ts, drivers/webusb.ts, types.ts, raster.ts, index.ts, PrinterContext.tsx, printer-flash-history.ts, StartListPage.tsx, ResultsPage.tsx, race.finishReceipt, performReadout, matchPunchesToCourse, shared/results.ts, and the receipt call sites in FinishStation, CompetitionShell, RunnerManagement, RegistrationDialog (submit path) and KioskPage (print path). Read only in part: PrinterSettingsDialog.tsx (lines 1-330 of 533; the mode, memory-switch and self-test sub-sections below that were not read), escpos-config.ts (builders skimmed, parser not checked byte by byte), local-readout.ts (lines 40-220), EventPage ReceiptSettings (grep only), event.ts receipt config endpoints (grep only). Test files were only listed by title (escpos.test.ts) or grepped; star-raster.test.ts, escpos-config.test.ts and printer-flash-history.test.ts were not read, so no judgement on low-value tests there. No dedicated start/result list PDF or HTML print view was found (a grep for window.print / @media print hit only map-print code), so printed lists are assumed to be browser prints of StartListPage/ResultsPage. Authorisation internals of viewProcedure / resultsViewProcedure / kioskOrRaceOperateProcedure (trpc.ts) were not reviewed beyond confirming the queries filter by ctx.event.id. docs/ops/receipt-printer-setup.md and printer-mode-management.md were not compared with the code.

### Elevation, climb, leg routes, route finder (PR #254)

Read in full: course-climb.ts, course-climb-pending.ts, leg-routes.ts, leg-routes-auto.ts, leg-routes-auto-worker.ts, routers/legRoute.ts, routers/demSettings.ts, cli/calibrate-cost-model.ts, the PR diffs of routers/course.ts, routers/eventor.ts, eventor.ts, backup.ts, referenceJournal.ts, sync/lease.ts, trpc.ts, course-geometry.ts, course-variants.ts, event-map.ts, routers/events.ts, the three migrations and schema.prisma; shared route/{search,grid,leg,cost-model,alternatives}.ts, terrain/profile/*, course/leg-routes.ts; web lib/route/finder.ts + worker entry, lib/editor/{elevation,leg-alternatives,leg-routes,profile-graph}.ts, useCourseElevation.ts, the EditorPage diff; spec §0, §6, §7.1-7.8, §8, Tests, Pending.

NOT read or only skimmed: packages/shared/src/route/calibration/** (fit, attribute, legs, dataset, record, report, validate) and docs/dev/route-calibration.md (offline tool, not reviewed for numerical correctness); packages/api/src/eventor-pace.ts beyond its header (pre-existing, not in the PR diff); web ProfilePanel.tsx, modes/LegSection.tsx, lib/editor/hover-dot.ts, CoursesPage/StatusBar/MapViewer diffs; spec §1-5 and §7.9; all test files (only the test names of leg-routes-auto.test.ts were read, so no findings on test quality); e2e specs.

NOT verified (no node_modules, nothing was run): actual search times and memory per leg (CPU estimates are from reading the code); that the worker entry resolves in the Docker image; Prisma behaviour of an older image importing a snapshot whose course rows carry climb_source / winner_pace_s_per_km; whether the Cloud Run service allocates CPU outside requests (if not, the background refresh would be throttled and hit its 5 minute timeout; the deploy doc does not say); whether Eventor accepts the Course element (stated as untested in Pending). The lease finding rests on reading trpc.ts, cloud-ownership.ts, shipper.ts and applyReferenceUpsert; the venue forwarder itself (venueForwarder.ts) and mapRefresh.ts were only grepped. Height-field orientation and rotation handling (terrainDescriptor, document frame vs course paper mm) were not traced end to end. Cost-class mapping for maps whose symbols are unmatched and use another standard's numbers (e.g. ISOM 2000 source codes) was not checked against the course checks' own reading.

### Web course editor: pages

Read in full: EditorPage.tsx, useFieldOutbox.ts, modes/LayoutMode.tsx, modes/MapMode.tsx, modes/CourseMode.tsx, modes/map/tracks/useMapTracks.ts, ExportMenu.tsx, modes/ClassView.ts, useCourseChecks.ts, layout/SheetActions.tsx, layout/SetterSection.tsx, CourseEditorRoute.tsx, CoursesPage.tsx (logic; JSX markup filtered), plus lib/editor/write-client.ts, lib/version-book.ts, lib/undo-stack.ts, lib/offline/control-outbox.ts and hooks/useCoursePresence.ts for context.

Only skimmed or grepped (not read line by line): tools/bindings.ts (1,424 lines; first ~300 of selectBinding only), layout/bindings.ts, layout/model.ts, layout/KeySections.tsx, layout/LayoutInspector.tsx, layout/LayoutRail.tsx, layout/fields.tsx, modes/ObjectSection.tsx, modes/FieldMode.tsx (first 140 lines), modes/VariationBlock.tsx, StyleFields.tsx, Inspector.tsx, ActionBar.tsx, TopBar.tsx, EditorStatus.tsx, StatusBar.tsx, PresenceChips.tsx, TransformButtons.tsx, ToolRail.tsx, MapInfoDialog.tsx, DescriptionSheetsDialog.tsx, tools/{placement,polygon,gaps,toner-saver,rail,tracks}.ts, modes/map/{model,shape-ops,nodes,symbols,draw,keys,palette,promote,unresolved}.ts, modes/map/{Promote,PromoteDialog,Corrections,ObjectSection,SymbolPicker}.tsx, modes/map/tracks/{useTrackConvert,convert,model,edit,decimate,average,snap-ends,TracksPanel,ConvertPanel}. For these a grep for listeners, timers, workers, object URLs and casts found nothing leaking, but their logic is unreviewed.

ControlsPage.tsx: the page shell, inline detail, create form and the core of programStation and the readout import were read; the auto-poll loops, clock check, results rendering and the rest of ProgrammingPanel/ReadoutPanel (about lines 1270-1520 and 1700-2006) were not.

LegSection.tsx, ProfilePanel.tsx and useCourseElevation.ts were left to the other reviewer.

Docs: docs/course-editor.md §3, §9 "Offline", §11, §12 (canvas) and "Pending" were read; §1-2, §4-8, §10, §13 and docs/guide/course-editor.md, docs/guide/course-maps-print.md were not compared with the code.

Not verified: MapViewer/MapPanel internals (the real cost of the non-memoised `editor` prop is inferred from MapPanel's own contract comment); the server-side outcome of a cross-competition move with a foreign baseVersion (reasoned from conflict.ts and assertCourseVersion, not executed); what a real SI station does with code 0; whether E2E specs cover any of the untested orchestration (e2e/ not inspected). No tests, build or app were run (node_modules absent); the only executed code is the standalone undo-order script in the scratchpad.

### Web course editor: lib/editor

Nothing was run: node_modules is absent, so the two structure-edit bugs were reproduced with a standalone copy of pathOfOrders / slotBefore / moveVisit / insertSite, and the rest is proven from reading.

Read in full: write-client.ts, conflict.ts, field.ts, presence.ts, structure-edit.ts, sequence.ts, clipboard.ts, attach.ts, state.ts, hit.ts, snap.ts, checks.ts, variation-view.ts, status.ts, leg-length.ts, url.ts, export-menu.ts, bends.ts, geometry-edit.ts, geometry-gestures.ts, touch.ts, image-box.ts, mouse-drag.ts, action-bar-place.ts, track-nodes.ts, plus lib/version-book.ts, lib/offline/control-outbox.ts, pages/editor/useFieldOutbox.ts, useCourseChecks.ts and hooks/useCoursePresence.ts.

Not read or only partly read:
- transform-gestures.ts beyond its header, style-fields.ts, symbol-pick.ts, symbol-groups.ts, map-info.ts, setter-maps.ts, template-key.ts, layout-href.ts, instructions.ts beyond its header, and the template/key-course helpers in the second half of layout.ts.
- elevation.ts, leg-alternatives.ts, leg-routes.ts, profile-graph.ts and hover-dot.ts were left to the other reviewer as instructed.
- Tests: only conflict.test.ts, the start of write-client.test.ts and the moveVisit cases of structure-edit.test.ts were read; the other test files were checked by title only, so there is no finding on low-value tests.
- Callers: EditorPage.tsx lines 150-1050 and the undo/placement parts were read; tools/bindings.ts, modes/LayoutMode.tsx, modes/MapMode.tsx, FieldMode.tsx, Inspector and the layout/ and map/ folders were not.
- Docs: course-editor.md §3, §8, §9 "Offline", §12 and Pending were read; the rest of course-editor.md and course-layer.md beyond §7 "Client rules" was not compared line by line.

Not verified:
- Whether the layer's leg indices always map 1:1 onto consecutive positioned rows for loops (insertIndexForLeg assumes it).
- The order render.hitTest returns equally near hits in (hit.ts "topmost wins").
- That /A/course-editor to /B/course-editor can never happen without a remount; if it can, the undo stack and VersionBook would carry over between competitions.
- The server side of control.update (it decides autoDescribe from a row read outside the transaction) was noticed but belongs to another scope.
