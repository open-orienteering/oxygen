# Online Input — ROC (Radio Online Control)

Oxygen polls a remote ROC-compatible service on a fixed interval and inserts
each new punch into the competition's `oPunch` table. This drives liveresults
splits, the runner punch list, and any other view that already consumes
`oPunch`. Card readout still owns final grading — radio punches are
informational; they do not flip a runner's `Status` or `FinishTime`.

The wire protocol matches `Type::ROC` in MeOS's
[`code/onlineinput.cpp`](https://github.com/melinsoftware/meos/blob/main/code/onlineinput.cpp)
so the same ROC accounts work between the two tools.

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
in `oPunch.Type` as a special punch — this matches the same feature in
MeOS's "Kontrollmappning" dialog.

The mapping is per-competition, stored as a single JSON row in
`oxygen_settings`:

```
online_input_mapping_<nameId> = {"100": 1, "200": 2}
```

Values are the MeOS `oPunch::SpecialPunch` enum:

| Value | Meaning      |
|-------|--------------|
| 1     | `PunchStart` |
| 2     | `PunchFinish`|
| 3     | `PunchCheck` |

Codes that aren't in the mapping land in `oPunch.Type` with their raw
value, which is what you want for spectator radios that just shadow a
regular control.

## MeOS bidirectional compatibility

The `oPunch.Origin` column in MeOS is **not** an enum — it's a checksum
that lets MeOS detect whether a punch has been edited since import. The
algorithm lives in
[`code/oPunch.cpp:321-330`](https://github.com/melinsoftware/meos/blob/main/code/oPunch.cpp#L321):

```cpp
int oPunch::computeOrigin(int time, int code) {
  if (time <= 0 || code <= 0) return false;
  time = time % (36000 * 24 * 7);
  code = code % 29;
  uint64_t xcode = (uint64_t)(time * 29 + code) * 7;
  return (xcode * 53458ul) % 1300602071;
}
```

Oxygen ports this verbatim in
[`packages/api/src/meosOrigin.ts`](../packages/api/src/meosOrigin.ts) and
calls it on every ROC-imported punch. A MeOS install opening the same
database sees these punches as `isOriginal()`, indistinguishable from
what its own `OnlineInput` machine would have written.

Per AGENTS.md §7, every insert also calls `incrementCounter("oPunch", id, dbName)`
so MeOS's per-record change detection stays consistent.

> **Adjacent cleanup, not in this PR.** The existing `Origin: 5` value
> used for backup-pushed punches in
> [`packages/api/src/routers/control.ts`](../packages/api/src/routers/control.ts)
> is technically wrong (it should also use `computeOrigin(...)`). It's
> harmless — MeOS just sees them as "edited" rather than "original" — but
> a follow-up PR should align it.

## What lives where

```
packages/api/src/
├── meosOrigin.ts                       # MeOS Origin checksum
├── online-input/
│   ├── protocol.ts                     # Protocol seam (extend → SICenter)
│   ├── roc.ts                          # ROC implementation
│   ├── mapping.ts                      # Control-mapping helpers
│   └── puller.ts                       # PullerManager + reconcile
└── routers/onlineInput.ts              # tRPC router
```

`oxygen_settings` rows used:

| Key                                    | Value                                                  |
|----------------------------------------|--------------------------------------------------------|
| `online_input_config_<nameId>`         | JSON `{enabled, protocol, endpointUrl, unitId, intervalSeconds}` |
| `online_input_last_id_<nameId>`        | Highest `punchId` already imported                     |
| `online_input_mapping_<nameId>`        | JSON `{"<rawCode>": 1|2|3, ...}`                       |

Boot reconciliation (`reconcileEnabledPullers` in
[`puller.ts`](../packages/api/src/online-input/puller.ts)) re-arms every
enabled puller on API restart and skips orphaned settings whose `nameId`
is no longer present in `oEvent`.

## Forward-compat: SICenter

SportIdent Center
(`https://center-origin.sportident.com/api/rest/v1/punches`) is the next
protocol we plan to add. It shares 90% of this design — the same
`PullerManager`, `oPunch` insert path, control mapping, boot reconciler,
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
