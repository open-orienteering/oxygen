# Bugfix: proxy-mode authorisation gaps and stored XSS through SVG graphics

Review package 20 (findings API-16, API-17, MAP-4, API-25, API-29, MC-24,
SYNC-23, CRS-003, API-31, API-36), 2026-11-27. Fixed in `trpc.ts`,
`routers/eventor.ts`, `routers/clubRouter.ts`, `routers/registrationTrends.ts`,
`map-store/source-possession.ts`, `course-maps/graphics.ts`,
`course-maps/routes.ts`, `sync/venueForwarder.ts`.

The deployed shape this is about: `AUTH_MODE=proxy` with
`AUTH_AUTO_PROVISION=member` (the Cloud Run deploy), where "signed in" means
"anyone the proxy admits".

## What happened

1. **Personal data behind "any signed-in user" or nothing at all (API-16).**
   `eventor.runnerDbDump`, `searchRunnerDb`, `lookupByCardNo` and
   `clubMembers` (names, birth years, card numbers of every Swedish
   orienteer in the cached directory) were `publicProcedure`: no sign-in.
   So were `club.searchDirectory`, the Eventor browse calls, the
   registration-trends lookups, `event.dbStatus` and, worst, `syncRunnerDb`,
   a ~9 MB download plus bulk upsert that anyone could start any number of
   times.
2. **A map file obtainable by quoting its hash (API-17, MAP-4).**
   `clubMap.addFromSource` and `course.applyUploadedMap` accepted any
   `fileHash` that existed in `map_sources`, then made the version's
   uploader the caller. The club-map download rule (uploader or admin) was
   one call away from being bypassed: add the hash to your own series and
   download it.
3. **Stored XSS through an SVG graphic (CRS-003, API-31).** The validator
   tested a copy with comments, `<metadata>` and the DOCTYPE stripped, but
   the stored bytes are the upload as is, and the raw route served them as
   `image/svg+xml` with no protective header. `<metadata><script>`, a script
   behind a character reference (`&#60;script`) or an entity, or
   `java&#115;cript:` all passed, then ran on the application's origin when
   the URL was opened.
4. **Forwarded edits as an anonymous or borrowed identity (API-29, MC-24,
   SYNC-23).** The venue forwarder sent the caller's identity header (a value
   the cloud's proxy had not set), no node secret and no IAP token, followed
   redirects and had no timeout. Against a cloud in proxy mode that is either
   `UNAUTHORIZED` or, worse, a forged identity.
5. **No test that the surface stays closed (API-36).** Nothing failed when a
   procedure was added as `publicProcedure`.

API-25 (who may check an event out) was already enforced on `main`; only its
tests and its documentation were missing.

## The fix

- **Gates.** The four directory lookups are `raceOperateProcedure` (Race crew
  registers runners; **a kiosk key does not carry it**: the kiosk looks cards
  up through `race.lookupByCard`, and `useStationSync(…, { runnerDb: false })`
  no longer prefetches the dump there). `syncRunnerDb` and `runnerDbStatus`
  are `manageProcedure`, and `syncRunnerDb` runs one at a time (a second call
  is `CONFLICT`). The rest of the list is `authedProcedure`. Table in
  [authentication.md](../system/authentication.md#runner-directory-and-eventor-browse).
  `lease.checkout` became an `authedProcedure` too, so it refuses an
  anonymous caller before its input is parsed.
- **Possession.** `assertMayConsumeSource` ([map-storage.md §5.1](../map-storage.md)):
  an admin, or a caller with their own finalised `map_uploads` row for the
  hash (24 h). The version's uploader is the import job's `started_by`
  (`ImportJobRow.startedBy`), and the after-the-fact overwrite in
  `createClubMap` is gone.
- **SVG.** The validator checks the text as uploaded and with character
  references and the five predefined entities expanded, strips nothing, and
  refuses: a script, `foreignObject`, iframe, object, embed, audio, video,
  link, meta or base element (with or without a namespace prefix),
  `javascript:`, event-handler attributes, `@import`, any `href` / `xlink:href`
  / `src` that is not `#fragment` or a `data:image/(png|jpeg|gif|webp);base64`
  raster, any `url(...)` that is not `url(#…)`, and DOCTYPE entities that are
  parameter entities, `SYSTEM` / `PUBLIC`, or whose value contains `<` or `&`
  (a plain URL value, as Illustrator writes, passes). Accepted false
  positive: forbidden text in a comment or `<metadata>` is refused. The three
  graphic routes send `Content-Security-Policy: default-src 'none';
  style-src 'unsafe-inline'; sandbox` and `X-Content-Type-Options: nosniff`;
  the raw route sends an SVG as an attachment; every API response carries
  `nosniff`. Stored bytes stay as uploaded; the web client never renders a
  graphic as SVG (it uses `thumb.png` and `print.png`).
- **Forwarding.** The forwarder sends the box's own credentials (node secret,
  node id, `x-oxygen-forwarded`, IAP token), no identity header, no redirect
  following, a 30 s timeout. The cloud reads a marked call with a valid secret
  as `ctx.nodeForward`: authed-level, all capabilities on events whose lease
  the node holds, none elsewhere, never admin
  ([authentication.md](../system/authentication.md#venue-nodes)). A redirect or
  HTML answer is the typed `CLOUD_AUTH` refusal.
- **Sweeps.** `router-auth-sweep.test.ts` (anonymous, unit) and its
  integration twin (member with no grant) list every procedure reachable
  without a capability; anything new has to be written into the list with its
  reason.

## Tests

`router-auth-sweep.test.ts` (unit, + integration), `node-forward-context.test.ts`,
`venueForwarder.test.ts` (on the wire), `course-map-graphics.test.ts`,
`integration/graphics.test.ts`, `integration/club-maps.test.ts`,
`integration/permissions.test.ts`, `integration/runner-db-sync-single-flight.test.ts`,
`integration/node-forward-authority.test.ts`, `integration/lease.test.ts`
(API-25), `integration/rest-access-negatives.test.ts`,
`web/src/hooks/__tests__/useStationSync.test.tsx`, and E2E
`permissions.spec.ts` (a kiosk makes no `runnerDbDump` request).

Left out on purpose: [proxy-auth-followups.md](proxy-auth-followups.md).

## Review round (same day)

Two reviews of the first fix found the following, now fixed:

- The forwarder lent the box's authority to any local caller; a box with
  login on now checks its caller (round 2 replaced the `event.manage`
  requirement with the caller's capability set, see below).
- A node could create, import and delete events and list every event; it now
  cannot create, import or delete, sees only events it holds, and a node id
  that is empty or the cloud's own is anonymous.
- The SVG validator read `<!ENTITY` only inside a well-formed `[...]>` subset
  (a `]>` decoy skipped it), did not expand declared entities before its
  checks, and missed XSLT, `ATTLIST`, CSS escapes and `image-set(`; it also
  refused `href= "#a"`, `url(&quot;#c&quot;)` and embedded fonts. See
  [course-maps.md](../course-maps.md).
- A JSON 401 from the cloud on a forward is `CLOUD_AUTH`.

## Review round 2 (same day)

A re-review showed the regex SVG validator was still bypassable (a comment or
CDATA quote that desynchronised the attribute scan hid `<image href="/abs/path.png">`
from the checks, so resvg read a local file; duplicate entity declarations;
non-ASCII entity names; `</style >`; a prefixed `<s:style>`; CSS escapes in
presentation attributes; `<set attributeName="href">` and `<animate
attributeName="xlink:href">`; non-UTF-8 encodings). The approach was replaced,
not patched:

- **Parser-based validation and a sanitised render input.** Pre-checks (UTF-8,
  no control characters, no processing instructions, a DOCTYPE of plain
  entities only, custom entity references only inside `xmlns` values), then
  `fast-xml-parser` validate + parse, a walk of the tree (elements, attributes,
  animations, CSS decoded in one pass), and a re-serialisation that is the only
  thing resvg, the window wrapper and the trim step read. A stored graphic that
  no longer validates renders as nothing, with a warning. Details in
  [course-maps.md](../course-maps.md) "SVG validation".
- **The forwarder's local gate no longer needs `event.manage`** (it blocked
  course setters with only `courses.edit`). The box sends the caller's
  capabilities in `x-oxygen-forwarded-caps`; the cloud intersects them with the
  lease rule. Anonymous is 401, an empty set on an event-scoped forward is 403.
- **A box whose `NODE_ID` is unset or `cloud`** answers 412 `CLOUD_AUTH` with
  the instruction to set it, without calling the cloud.
- **`RunnerDbPanel`** runs `runnerDbStatus` (now `event.manage`) only for a user
  who has it.
- A node with the secret but no lease passes authed-level procedures; noted in
  [authentication.md](../system/authentication.md) and the follow-ups.
