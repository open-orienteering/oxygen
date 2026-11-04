# SPORTident Reader BT Protocol

This is Oxygen's working copy of the SPORTident Reader BT Bluetooth Low
Energy protocol, condensed from the vendor's developer documentation
(<https://docs.sportident.com/developers/reader-bt>, read November 2026)
plus the decisions Oxygen takes where the docs are silent. Reader BT is
not a serial device: it speaks its own GATT message protocol, delivers
already-decoded punches, and replaces the serial ACK with a Feedback
message.

First checked against hardware in November 2026 (Reader BT firmware
2.2.0, a SIAC; see [Hardware findings](#hardware-findings)). Where the
vendor docs are ambiguous and hardware has not settled it yet, the
decoder is lenient and the question is listed under
[Open questions to settle on hardware](#open-questions-to-settle-on-hardware).

## Reference artefacts

- Vendor docs: <https://docs.sportident.com/developers/reader-bt>
- Decoder: `packages/web/src/lib/reader-bt/protocol.ts` (pure, no Web Bluetooth)
- Connection: `packages/web/src/lib/reader-bt/connection.ts` (`ReaderBtConnection`, Web Bluetooth)
- Tests: `packages/web/src/lib/__tests__/reader-bt-protocol.test.ts`,
  `reader-bt-mapping.test.ts`, `reader-bt-connection.test.ts` (scripted fake
  device); byte builders in `__tests__/fixtures/reader-bt.ts`
- E2E: `e2e/reader-bt.spec.ts` against the fake `navigator.bluetooth` in
  `e2e/helpers/mock-webbluetooth.ts`

## Discovery and connection

| Item | Value |
| --- | --- |
| Advertised name | `Reader BT <serial>` |
| Scan filter | primary service `bd510001-…` (optionally name prefix `Reader BT`) |
| Advertising window | 20 s after inserting the Service/OFF card, or any SI card while in readout mode and disconnected; never by itself after a disconnect or link loss (hardware finding) |
| Pairing | none; **do not** pair in OS Bluetooth settings (causes connection problems) |
| MTU | up to 517; larger messages are segmented |
| Idle | a new backup session is started after 10 h of inactivity (the docs describe no disconnect) |
| GATT handles | may change between firmware versions; discover by UUID on every connection, never cache |

All client → reader writes are **Write With Response**. Subscribe with
notifications (CCCD `0x0001`); indications are not supported and lose
segmented messages.

## Services and characteristics

Reader BT UUIDs are `bd51xxxx-6aec-4628-a146-f3e95bc49e62` (`RBT_UUID`).

| Service | Characteristic | UUID | Properties | Used for |
| --- | --- | --- | --- | --- |
| Settings (primary, advertised) | — | `bd510001` | | |
| | Read settings | `bd510002` | Notify, Write | ReadDeviceInfo, ReadAllSettings, ReadAutosend |
| | Write settings | `bd510003` | Write (with/without response) | WriteAllSettings, SetAutosend, SetToSleepMode |
| Card readout | — | `bd510011` | | |
| | Card state | `bd510012` | Notify | CardStateChange |
| | Card data | `bd510013` | Notify, Write | readout requests/responses, Feedback |
| Sessions | — | `bd510031` | | |
| | Sessions | `bd510032` | Notify, Write | session table, session data |
| Battery (SIG) | — | `0x180f` | | |
| | Battery Level | `0x2a19` | Read, Notify | uint8 percent (estimate, counted from firmware 2.0.0) |

Only the Settings service is advertised. Web Bluetooth must list the
others in `optionalServices` to reach them.

## Framing

All multi-byte integers are little-endian. No CRC.

| Offset | Size | Type | Name |
| --- | --- | --- | --- |
| 0 | 2 | uint16 | `message_id` |
| 2 | 2 | uint16 | `payload_length` |
| 4 | N | bytes | payload |

`encodeMessage(id, payload)` / `decodeMessage(bytes)`; `splitMessages`
walks a buffer of back-to-back messages (session data) and refuses
trailing bytes.

## Segmentation

A message that does not fit the negotiated ATT MTU arrives as a series of
wrapper messages with id `0xA101`. The wrapper payload starts with a flag:

| Flag | Packet | Layout after the 4-byte wrapper header |
| --- | --- | --- |
| `0x01` | First | `u8 flag, u32 total_message_length, segment` |
| `0x00` | Continuation | `u8 flag, segment` |
| `0x02` | Last | `u8 flag, segment` |

The reassembled bytes are a normal message with its own header. The
vendor example — an 11-byte `0x1102` with zero punches split into three
10-byte notifications — is a unit test:

```
A1 01 06 00 | 01 0B 00 00 00 | 02             First, total 11
A1 01 06 00 | 00 | 11 07 00 01 02             Continuation
A1 01 06 00 | 02 | 03 04 00 00 00             Last
→ 02 11 07 00 01 02 03 04 00 00 00            0x1102, card 0x04030201
```

`SegmentReassembler.push(notification)` (one per notifying characteristic)
returns the message when complete, `null` while waiting, and passes
non-wrapper notifications straight through. On a new First it discards
any partial message. It resets and throws `RbtProtocolError` when the
buffer overflows `total_message_length`, when Last leaves it short, on a
Continuation/Last without a First, or on an unknown flag.

Note the example's wrapper starts with the bytes `A1 01`, which is
`0x01A1` read little-endian, not `0xA101` (which would be `01 A1`).
**Hardware sends `01 A1`, i.e. `0xA101`**: the example is wrong, the text
is right. The decoder still accepts both ids (`isSegmentId`); no other
message uses either.

## Message catalogue

Payload offsets below are from the start of the payload (after the header).

| Name | Id | Characteristic | Direction |
| --- | --- | --- | --- |
| SetToSleepMode | `0x0101` | Write settings | write |
| ReadAllSettings | `0x010C` | Read settings | write empty → notify |
| WriteAllSettings | `0x010D` | Write settings | write |
| ReadDeviceInfo | `0x010E` | Read settings | write empty → notify |
| SetAutosend | `0x010F` | Write settings | write, no response |
| ReadAutosend | `0x0110` | Read settings | write empty → notify |
| CardStateChange | `0x1101` | Card state | notify |
| CardDataReadout minimal / complete | `0x1102` / `0x1103` | Card data | write empty → notify (segmented) |
| Feedback | `0x1110` | Card data | write |
| ReadAvailableSessions request / response | `0x3101` / `0x3103` | Sessions | write → notify |
| ReadSessionData request / response | `0x3102` / `0x3104` | Sessions | write → notify (segmented) |
| Segment wrapper | `0xA101` | any notifying characteristic | notify |

### CardStateChange `0x1101` — `decodeCardStateChange`

| Offset | Size | Type | Name | Notes |
| --- | --- | --- | --- | --- |
| 0 | 4 | uint32 | `card_number` | |
| 4 | 1 | uint8 | `state` | 0 = out, 1 = in |
| 5 | 2 | uint16 | `code_number` | reader's code number |

Not sent while AUTOSEND is on.

### Card readout `0x1102` / `0x1103` — `decodeCardData`

| Offset | Size | Type | Name | Notes |
| --- | --- | --- | --- | --- |
| 0 | 4 | uint32 | `card_number` | |
| 4 | 1 | uint8 | `card_family` | 1 SI9, 2 SI8, 4 pCard, 15 SIAC |
| 5 | 2 | uint16 | `punch_count` | |
| 7 | 8 × n | struct | punches | see below |
| … | 13 | struct | SIAC production data | `0x1103` only, family 15 **and** 8 000 000 ≤ card < 9 000 000 |
| … | rest | bytes | owner data | `0x1103` only, if bytes remain: `u8 charset` then NUL-terminated, NUL-padded string |

Punch record (8 bytes):

| Offset | Size | Type | Name | Notes |
| --- | --- | --- | --- | --- |
| 0 | 1 | uint8 | `control_info` | SIAC only, else 0. Bit 5: punching mode (else timing mode). Bits 6–7: radio mode 0 no / 1 last / 2 all / 3 all new |
| 1 | 1 | uint8 | `punch_type` | 0 undefined, 1 clear, 2 check, 3 start, 4 start reserve, 5 finish, 6 finish reserve, 7 control |
| 2 | 2 | uint16 | `control_code` | |
| 4 | 4 | uint32 | `time_in_ms` | ms since Sunday 00:00:00 (e.g. 183 845 000 = Tuesday 03:04:05.000) |

SIAC production data (13 bytes):

| Offset | Size | Type | Name | Decoded as |
| --- | --- | --- | --- | --- |
| 0 | 1 | uint8 | `hw_version_raw` | `"⌊raw/10⌋.raw%10"` |
| 1 | 1 | uint8 | `sw_version_raw` | same |
| 2 | 2 | uint16 | `signal_count` | feedback cycle counter |
| 4 | 2 | uint16 | `clear_count` | |
| 6 | 2 | uint16 | `battery_mv` | millivolts |
| 8 | 3 | uint8 ×3 | battery year (since 2000), month, day | `YYYY-MM-DD`, null if out of range |
| 11 | 2 | uint8 ×2 | production year (since 2000), month | `YYYY-MM` (no day) |

Owner data: charset `1` = ISO-8859-1 per the docs, `17` = GB2312. **On
hardware, charset 1 carries the card's own CP850 bytes** ("ä" arrives as
`0x84`, a C1 control code in Latin-1), so Oxygen decodes charset 1 with
`decodeCp850`, exactly like the USB path's personal-data parser. Fields
are `;`-separated in the same order as the on-card personal data, which
is `PERSONAL_FIELDS` in `si-protocol.ts`: first name, last name, sex
(free text as written to the card, e.g. `male`), date of birth (as
written, e.g. `YYYYMMDD`; stored in `dateOfBirth`), club, email, mobile (`phone`),
city, street, zip (`postcode`), country. SI8/SI9 carry only first and
last name. Block sizes: SI8 104, SI9 24, pCard/SIAC 128 bytes. Empty
fields are dropped; an all-empty block decodes to `null`. A runtime
without a GB2312 `TextDecoder` falls back to Latin-1 rather than failing
the readout.

### Feedback `0x1110` — `encodeFeedback(ok)`

Payload `u8`: 1 = OK (two short beeps/flashes), 2 = error (four). In
readout mode the reader gives **no** feedback of its own, with or
without AUTOSEND: the client must send OK after each successful readout.
In printout and standalone modes the reader beeps by itself. Works
whether or not the card is still in the reader.

### ReadDeviceInfo `0x010E` — `decodeDeviceInfo`

| Offset | Size | Type | Name |
| --- | --- | --- | --- |
| 0 | 4 | uint32 | `serial_number` |
| 4 | 2 | uint16 | `device_type` (`0x00A7` for Reader BT) |
| 6 | 2 | uint8 ×2 | hardware version major, minor |
| 8 | 4 | `{u16 year, u8 month, u8 day}` | production date |
| 12 | 4 | `{u16 year, u8 month, u8 day}` | battery date |
| 16 | rest | ASCII | software version, NUL-terminated/padded. Firmware 2.2.0 sends `sireader@2.2.0+<git sha>.<build timestamp>`; `firmwareVersion()` extracts `2.2.0` for display |

### ReadAllSettings `0x010C` / WriteAllSettings `0x010D` — `decodeAllSettings`

| Offset | Size | Type | Name | Notes |
| --- | --- | --- | --- | --- |
| 0 | 2 | uint16 | `code_number` | |
| 2 | 1 | uint8 | `operating_mode` | `0x05` readout, `0x0B` printout, `0x0C` standalone (`operatingModeLabel`) |
| 3 | 7 | — | reserved | |

On firmware < 2.0.0 offset 2 was a 0/1 `auto_read` flag instead. Write
uses the same layout (read–modify–write the `raw` bytes); switching away
from readout mode while connected drops the connection. Oxygen only
reads settings; it warns when the mode is not readout.

### SetAutosend `0x010F` / ReadAutosend `0x0110`

Payload `u8`: 0 off, 1 on (`encodeSetAutosend`, `decodeAutosend`).
Firmware ≥ 2.0.0. Per connection, not persisted, resets to off on every
connection, effective in readout mode only. When on, inserting a card
sends a complete card-data notification **instead of** CardStateChange.

### Sessions `0x3101`–`0x3104`

The reader's memory is split into sessions: a new one on every
connection (and in standalone mode, after 10 h of inactivity). Circular,
at most 291 sessions. The table is paged, at most 5 entries per page,
page 0 newest; read page 0 first to learn `total_pages`.

- `0x3101` request: `u8 page` (`encodeSessionsListRequest`).
- `0x3103` response (`decodeSessionsList`): `u8 page, u8 total_pages,
  u8 count`, then `count` × 20-byte entries `{u16 session_number,
  u64 start_time, u64 end_time, u16 number_of_readouts}`. Times are Unix
  seconds, or 0 = unknown; when `start_time` is 0, `end_time` is a
  duration. Current readers have no RTC, so both are 0.
- `0x3102` request: `u16 session_number` (`encodeSessionDataRequest`).
- `0x3104` response (`decodeSessionData`, usually segmented):
  `u16 session_number, u16 number_of_readouts, u32 session_data_length`,
  then the readouts as complete embedded `0x1102`/`0x1103` messages with
  their own headers. Each embedded message keeps its `raw` bytes for the
  backup import (`rawBytesHex`). A count that disagrees with the embedded
  messages throws.

## Live readout: pull vs push

**Pull (Oxygen's default).** Works on every firmware and gives the kiosk
its "card inserted, do not remove" moment:

1. Card state notifies `0x1101` with state 1 → Oxygen emits `si:card-detected`.
2. Write an empty `0x1103` to card data.
3. Card data notifies the (segmented) `0x1103` → `decodeCardData` → `toSICardReadout`.
4. Write Feedback OK, then emit `si:card-readout`. A decode error or no
   response within 3 s is retried once (a second `0x1103` request); if
   that fails too, write Feedback error.
5. `0x1101` with state 0 → `si:card-removed`.

**Push.** After `SetAutosend(1)` the reader sends `0x1103` on insert
with no CardStateChange; the client still sends Feedback. Oxygen treats
an unsolicited card-data notification the same way, synthesising the
detected event.

A repeated "in" for the card already being read is ignored. Oxygen never
turns AUTOSEND on; `ReaderBtConnection.setAutosend()` exists for testing
on hardware.

## Connection (`ReaderBtConnection`)

| Step | What Oxygen does |
| --- | --- |
| Picker | `requestDevice({filters: [{services: [settings]}, {namePrefix: "Reader BT"}], optionalServices: [settings, card, sessions, 0x180f]})` |
| Connect | `gatt.connect()`, services and characteristics by UUID, `startNotifications()` on read settings, card state, card data and battery level |
| Identify | ReadDeviceInfo `0x010E` (serial, firmware) and ReadAllSettings `0x010C` (mode) on read settings, each with a 3 s timeout; a failure is logged and the reader still connects. Battery Level is read once and then followed by notification |
| GATT queue | every `startNotifications`/`writeValueWithResponse`/`readValue` runs after the previous one settled; Web Bluetooth rejects overlapping operations |
| Requests | `sendAndWait(char, bytes, responseId)` registers a waiter for the response id before writing; a notification with that id resolves it, otherwise it goes to the card flow |
| Reconnect | after an unexpected `gattserverdisconnected`: status `error`, then until it is back or the user disconnects/forgets it: first a direct `gatt.connect()` capped at 5 s (once more after 1.5 s if setup fails on a link that is being torn down), then `watchAdvertisements()` (connect on `advertisementreceived`) **and** a `gatt.connect()` poll every 2 s (first after 1 s; every 10 s after five minutes), each connect capped at 8 s (the connect only; service discovery is not capped). The wait is unbounded because the reader only wakes on a card, see the hardware findings. `connectWhenAdvertising(windowMs)` takes an optional window; the default is unbounded |
| Remembered | DeviceManager keeps `{id, name, lastSeen}` per reader in `localStorage["oxygen-reader-bt-devices"]` and on load calls `connectWhenAdvertising()` (the same 60 s wait) for each granted device from `getDevices()` in that list |
| Forget | `disconnect()` then `device.forget()` |

A card inserted while the reader is disconnected wakes it, and after
Oxygen reconnects and subscribes the reader reports that card with a
CardStateChange "in" (confirmed on hardware), so the readout goes on
without re-inserting it.

## Mapping to `SICardReadout` — `toSICardReadout`

The result has exactly the shape the USB path produces, so it flows
through `DeviceManager.addRecentCard` unchanged.

| Reader BT | `SICardReadout` |
| --- | --- |
| `time_in_ms` | `⌊(ms mod 86 400 000) / 1000⌋` — integer seconds since midnight; milliseconds are dropped, never rounded |
| `time_in_ms mod 1000` | control punches only: `subSecond = round(ms × 256 / 1000)` (1/256 s, the unit station backups use), omitted when 0; forwarded per punch to `storeReadout`, which keeps it in the raw readout log. Start/finish/check stay whole seconds, like the USB path |
| day index `⌊ms / 86 400 000⌋` (0 = Sun) | `finishDayOfWeek` / `checkDayOfWeek` as 1 = Mon … 7 = Sun (index 0 → 7), the convention `isPunchDataFresh` uses |
| type 1 clear | `clearTime` |
| type 2 check | `checkTime`, `checkDayOfWeek` |
| type 3 start (type 4 only if no 3) | `startTime` |
| type 5 finish (type 6 only if no 5) | `finishTime`, `finishDayOfWeek` |
| types 0 and 7 | `punches[]` in card order; `punchCount = punches.length` |
| `card_family` | `getCardType(cardNumber)` when the number range is known, else 1 → SI9, 2 → SI8, 4 → pCard, 15 → SIAC, else `Unknown`. The number range wins on disagreement, which covers SI10/SI11 (family codes undocumented) |
| `battery_mv` | `batteryVoltage = mv / 1000` (volts, see `docs/bugfix-siac-voltage-units.md`) |
| production block | `metadata`: `hardwareVersion`, `softwareVersion`, `clearCount`, `batteryDate` (`YYYY-MM-DD`), `productionDate` (`YYYY-MM`, the block has no day) |
| owner data | `ownerData` (`SICardOwnerData`), `null` for minimal readouts |

When a punch type occurs more than once, the first occurrence wins.

## Hardware findings

Reader BT serial 1000139, hardware 4.1, firmware
`sireader@2.2.0+71f89ff.20261008113738`, reading SIAC 8007045 on
Linux Chrome (with `chrome://flags/#enable-experimental-web-platform-features`;
without it `navigator.bluetooth` does not exist). Regression frames are in
`__tests__/fixtures/reader-bt-hardware.ts` (owner data replaced).

| Question | Answer |
| --- | --- |
| Segment wrapper id | `0xA101`, bytes `01 A1` on the wire |
| Segmentation | a 329-byte `0x1103` came as two notifications of 244 + 90 payload bytes (MTU ≥ 251) |
| SIAC family code | 15 |
| Sub-second times | yes: SIAC punch times carry milliseconds in exact steps of 1000/256 ms (e.g. finish `.359`, a control `.839`) |
| SIAC production block | battery date `YY MM DD`, production `YY MM` confirmed (2024-02-12 / 2024-02); 2980 mV; clear count 54, signal count 1016 |
| Owner data | charset byte 1 but CP850 bytes; field order as `PERSONAL_FIELDS`; sex written as `male`, date of birth as `YYYYMMDD`, country as `Swedish` |
| ReadAllSettings | payload `05 00 05 00 …` (10 bytes): code 5, mode `0x05` readout |
| CardStateChange code | the station code (5) |
| Start punch | the card reports both type 3 and type 4 (start reserve) with the same time; same for finish 5/6 |
| Weekday in `time_in_ms` | real: the SIAC's last race (Daladubbeln, a Sunday) decoded as day index 0 = Sunday, so `finishDayOfWeek`/`checkDayOfWeek` feed `isPunchDataFresh` correctly |
| Feedback | two beeps after Feedback OK in readout mode, as documented |
| Card that woke the reader | reported with a CardStateChange "in" right after the reconnect; read out without re-inserting |
| Page reload | Chrome releases the old page's subscriptions at once (`Notifying = false` on all four characteristics) and drops the link about 2 s later. A connect in those 2 s gets the dying link and subscribing fails with `NotSupportedError: GATT Error Unknown` |
| Advertising after a disconnect or link loss | none: after the central disconnects, **and after the link is lost out of range** (BlueZ saw no advertisement for 26 s until a card went in), the reader goes to sleep and stays silent until a card (or the Service/OFF card) wakes it. A reload or a drop therefore reconnects on the next card, which is then read out. A firmware that advertised for a minute after a link loss would let Oxygen reconnect without a card; the poll is ready for that |
| `watchAdvertisements()` on Linux Chrome | starts the BlueZ scan (BlueZ reports the woken reader's RSSI) but Chrome never fires `advertisementreceived` to the page. `gatt.connect()` to a silent reader fails at once with `NetworkError: Bluetooth Device is no longer in range.`, so polling it every 2 s is cheap and connects as soon as the reader advertises |
| `getDevices()` on Linux Chrome | works with the experimental-features flag; the remembered reader comes back after a reload without the picker |

## Open questions to settle on hardware

- **Card family codes** for SI8, SI9, SI10, SI11 and ComCard Pro/Up;
  whether SI5/SI6 cards produce any message at all (unsupported per docs).
- **SIAC production block versions**: the SIAC above sent raw bytes 16
  and 43, decoded as `1.6` / `4.3`; compare with the same card read over
  USB before trusting `major*10+minor`.
- **Owner data** on SIAC outside 8 000 000–8 999 999 (no production
  block): confirm the owner block follows the punches directly.
- **Session timestamps**: confirm `start_time`/`end_time` stay 0 and the
  `u64` unit is seconds.
- **Web Bluetooth**: which of `getDevices()` / `watchAdvertisements()`
  work on Linux Chrome and Android without flags, and whether
  `gatt.connect()` to a sleeping reader rejects or hangs.
- **Feedback error**: confirm Feedback error gives four beeps (OK's two
  beeps are confirmed).
- **Firmware < 2.0.0**: what offset 2 of ReadAllSettings returns, and
  whether SetAutosend/ReadAutosend are silently ignored.
