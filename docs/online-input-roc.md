# Online Input — ROC (Radio Online Control)

Oxygen polls a remote ROC-compatible service on a fixed interval and inserts
each new punch into the event's `punches` table. This drives liveresults
splits, the runner punch list, and any other view that consumes
`punches`. Card readout still owns final grading — radio punches are
informational; they do not flip a runner's `status` or `finish_time`.

The wire protocol matches `Type::ROC` in MeOS's
[`code/onlineinput.cpp`](https://github.com/melinsoftware/meos/blob/main/code/onlineinput.cpp);
the same ROC accounts that worked with MeOS keep working against Oxygen.

## What it talks to

By default Oxygen polls [roc.olresultat.se](https://roc.olresultat.se) at:

```
GET http://roc.olresultat.se/getpunches.asp
   ?unitId={accountOrMac}
   &lastId={N}
   &date=YYYY-MM-DD
   &time=HH:MM:SS
```

Response is plain text, semicolon-separated, one row per punch:

```
1;31;1234567;2026-05-05 09:42:13
2;100;7654321;2026-05-05 09:43:00
```

`punchId;controlCode;cardNo;timestamp`. ROC honours `lastId` and only returns
rows newer than the watermark.

The endpoint URL is configurable, so the ROC protocol-compatible endpoint at
[OResults](https://docs.oresults.eu/integrations/roc/)
(`https://api.oresults.eu/roc`) also works. Any future ROC-compatible
service does too.

No authentication is needed for ROC — the URL plus `unitId` is the entire
credential.

## Setup

1. Create or locate your ROC account ID (or device MAC address) at
   [roc.olresultat.se](https://roc.olresultat.se). The account ID covers
   every radio you have linked under it; the MAC scopes the poll to one
   physical device.
2. Open the **Event** tab in Oxygen and find the **Online Input (ROC)**
   panel.
3. Paste the unit/account ID and click **Save**.
4. (Optional) Add control mappings if a specific raw control code should
   act as Start, Finish or Check rather than as a regular split. See
   below.
5. Toggle the panel **on**. The first poll runs immediately so you'll see
   any backlog appear right away. Subsequent polls run on the configured
   interval (default 10s).

## Control mapping

Some installations want a particular raw control code (e.g. 100) to land
in `punches.type` as a special punch — this matches the same feature in
MeOS's "Kontrollmappning" dialog.

The mapping is per-event, stored as a single JSON row in
`oxygen.oxygen_settings`:

```
online_input_mapping_<nameId> = {"100": 1, "200": 2}
```

Values mirror the MeOS `oPunch::SpecialPunch` enum:

| Value | Meaning      |
|-------|--------------|
| 1     | `PunchStart` |
| 2     | `PunchFinish`|
| 3     | `PunchCheck` |

Codes that aren't in the mapping land in `punches.type` with their raw
value, which is what you want for spectator radios that just shadow a
regular control.

## Origin attribution

Each row in `punches` carries an `origin` column identifying where the
punch came from (card readout, ROC, SICenter, backup-memory push, manual
edit, …). ROC-imported punches use `Origin::ROC`. The result engine and
liveresults exporter consume `origin` to deduplicate when a card readout
later supplies the same `(card, code, time)` triple.

> **Historical note:** an earlier MeOS-compatible build stored a numeric
> checksum in `oPunch.Origin` (`meosOrigin.ts`) so a MeOS client opening
> the same database would treat the punch as "original". That column and
> the checksum logic disappeared with the May 2026 PostgreSQL migration —
> see [`migrations/2026-drop-meos.md`](migrations/2026-drop-meos.md).

## What lives where

```
packages/api/src/
├── online-input/
│   ├── protocol.ts                     # Protocol seam (extend → SICenter)
│   ├── roc.ts                          # ROC implementation
│   ├── mapping.ts                      # Control-mapping helpers
│   └── puller.ts                       # PullerManager + reconcile
└── routers/onlineInput.ts              # tRPC router
```

`oxygen.oxygen_settings` rows used:

| Key                                    | Value                                                  |
|----------------------------------------|--------------------------------------------------------|
| `online_input_config_<nameId>`         | JSON `{enabled, protocol, endpointUrl, unitId, intervalSeconds}` |
| `online_input_last_id_<nameId>`        | Highest `punchId` already imported                     |
| `online_input_mapping_<nameId>`        | JSON `{"<rawCode>": 1|2|3, ...}`                       |

Boot reconciliation (`reconcileEnabledPullers` in
[`puller.ts`](../packages/api/src/online-input/puller.ts)) re-arms every
enabled puller on API restart and skips orphaned settings whose `nameId`
is no longer present in `oxygen.events`.

## Forward-compat: SICenter

SportIdent Center
(`https://center-origin.sportident.com/api/rest/v1/punches`) is the next
protocol we plan to add. It shares 90% of this design — the same
`PullerManager`, `punches` insert path, control mapping, boot reconciler,
EventPage panel and tRPC router are reused unchanged. Differences live
inside the protocol implementation:

| Aspect              | ROC                                                   | SICenter                                                                    |
|---------------------|-------------------------------------------------------|-----------------------------------------------------------------------------|
| Scheme              | HTTP                                                  | HTTPS                                                                       |
| Query               | `?unitId&lastId&date=YYYY-MM-DD&time=HH:MM:SS`        | `?eventId&afterId&after=epochMs` *or* `?modem=<csv>&afterId&after=epochMs`  |
| Time anchor         | `HH:MM:SS` slice from each row                        | Milliseconds since Unix epoch; subtract zero-time epoch ms                  |
| Response separator  | Semicolon, no header                                  | Comma, with a header row                                                    |
| Special punches     | Mapped manually via control-mapping table             | Sent in a `type` column (`Start`/`Finish`/`Check`/`Clear`) by the server    |
| Auth                | None                                                  | `Authorization: Bearer <apiKey>`                                            |
| Multi-device        | Single `unitId` (account scopes the poll)             | Multiple modems comma-separated in one call                                 |

When SICenter lands, the `online_input_config_<nameId>` JSON gains a
`protocol: "sicenter"` field plus an encrypted `apiKey` (mirroring the
existing pattern in
[`packages/api/src/eventorKeyStore.ts`](../packages/api/src/eventorKeyStore.ts)),
and the `Protocol` registry adds a `sicenter.ts` entry. The
`online_input_last_id_<nameId>` and `online_input_mapping_<nameId>` rows
carry over as-is.
