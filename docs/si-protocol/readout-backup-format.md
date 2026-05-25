# SI Readout-Station Backup Memory Format

This is Oxygen's reverse-engineered notes on how SPORTident BSM-family
readout stations (M_READOUT mode, byte `0x05` at SYS_VAL `0x71`) store
card readouts to their internal flash. SPORTident has not published this
layout; what's here was derived from a Config+ pcap capture in May 2026
and validated against the parser fixtures committed alongside this doc.

If you have a station running different firmware, the markers and slot
sizes documented here may not match. Capture a fresh trace before
trusting them — see [Capturing a fresh trace](#capturing-a-fresh-trace).

## Reference artefacts

- `readout-capture.pcapng` — Config+ ↔ station USB-serial traffic, 7 cards
- `readouts.txt` — Config+'s rendering of the same backup, used as ground
  truth for the parser tests

## Protocol layer

The read-back uses the same `GET_BACKUP 0x81` command we already use for
control-mode stations:

| Field | Value |
| --- | --- |
| Command | `0x81` (`CMD.GET_BACKUP`) |
| Page size | `0x80` (128) bytes per request |
| Start address | `0x000100` |
| End address | `info.backupPointer` (from SYS_VAL `0x1C/0x1D/0x21/0x22`) |
| Response framing | `STX 02 | CMD 81 | LEN 85 | [00, station_code, adr2, adr1, adr0] | 128 data bytes | CRC | ETX` |

Config+ does a simple sequential walk from `0x100` to the end pointer;
no per-slot skipping. The 5-byte response header `[00, station_code,
adr2, adr1, adr0]` is the same as the control-mode response. Pages are
concatenated (header bytes stripped) to form a contiguous flash buffer.

Empty flash reads as `ee ee ee ...`.

## Slot layout

Each card readout occupies one slot in the buffer. Slot size is determined
by card type (matches the BLOCKS_TO_READ count for a live readout):

| Card type | Slot size | Notes |
| --- | --- | --- |
| SI5 | `0x80` (128) | One card-image block. No SI8+ marker. |
| SI8 / SI9 | `0x100` (256) | Two blocks. SI8+ marker present. |
| SI10 / SI11 / SIAC | `0x400` (1024) | Eight blocks. SI8+ marker present. |

Slot start addresses observed in the captured backup:

| Card | SIID | Type | Slot start |
| --- | --- | --- | --- |
| 1 | 2164102 | SI8 | 0x100 |
| 2 | 8506707 | SIAC | 0x200 |
| 3 | 8007045 | SIAC | 0x600 |
| 4 | 8408405 | SIAC | 0xA00 |
| 5 | 452242  | SI5 | 0xE00 |
| 6 | 8060780 | SIAC | 0xE80 |
| 7 | 2220164 | SI8 | 0x1280 |

Note that slots are NOT 0x100-aligned in the general case (SI5 slots are
0x80) — they pack tightly back-to-back. The parser walks the buffer in
`0x80`-byte steps.

### SI8+ slot (SI8 / SI9 / SI10 / SI11 / SIAC)

```
offset 0x00..0x03  4 bytes        backup-record header (timestamp / CRC — semantics unknown)
offset 0x04..0x07  4 bytes        marker `ea ea ea ea`  — discriminates from SI5 slots
                                  Important: this marker OVERWRITES the card-image bytes that
                                  would hold the 4-byte `clear` punch record (PTD + CN + TimeH + TimeL).
                                  Parser patches these to 0xEE so clearTime decodes as null.
offset 0x08..        card image  Identical layout to a live card readout from offset 0x08 onwards.
                                  In particular: cardType-discriminator byte at offset 0x18, SIID
                                  at offsets 0x19..0x1B, punch count at 0x16, check/start/finish
                                  at 0x08/0x0C/0x10 (4 bytes each in the standard SI8+ encoding).
```

The card image preserves block-by-block what a live readout would return.
That means `parseSI8CardData` and `parseSI10CardData` work unchanged
against backup-slot bytes (after the bytes 4-7 patch).

### SI5 slot

```
offset 0x00..        card image  Standard SI5 layout, starts directly. No backup-side header,
                                  no `ea ea ea ea` marker. Cardnumber at bytes 4-5 + series at byte 6,
                                  punch count at byte 23, etc. — exactly what parseSI5CardData expects.
```

The leading bytes for SI5 slots in the captured backup were `aa fe fe fe …`
but this is just incidental card data, not a marker we rely on.

### Empty slots

A slot that has never been written reads as 128 bytes of `0xEE`. The
parser uses this as a sentinel to skip ahead 0x80 bytes without trying
to decode.

## Discrimination

The walker steps `0x80` bytes at a time. At each candidate offset:

1. If all 128 bytes are `0xEE` → empty, skip 0x80.
2. If bytes 4-7 are `ea ea ea ea` → SI8+ slot. Peek SIID at bytes 25-27
   to compute card type and slot size, then dispatch to `parseSI8CardData`
   or `parseSI10CardData`. Advance by the slot size.
3. Otherwise → candidate SI5 slot. Run `parseSI5CardData` against the
   128-byte chunk; accept if `cardNumber > 0`. Advance 0x80.
4. Unknown / unparseable → log, advance 0x80. Never throw.

## Things still unknown

- **4-byte slot header semantics.** Cards 2-6 each have a distinct
  4-byte head (`83 98 14 9f`, `72 95 46 9c`, `ac 50 bf 64`, `aa fe fe fe`,
  `ba 52 bf 64`). It might be a read-time stamp, a CRC, or a sequence
  number. Decoding it would let us populate `CardReadoutBackup.originalReadAt`
  instead of falling back to import time.
- **SIAC slots > `0x400`.** A SIAC card supports up to 192 punches; that
  would need more than one slot's worth of punch records. The captured
  data didn't exercise this case. If it shows up, our parser will
  truncate to the first 0x400 bytes — we'd see the punch list cut off in
  the parsed result. Defensive size check would be a nice-to-have.
- **Card 1 (SI8 family) punch list.** In the captured slot the
  punch records didn't appear at the expected `parseSI8CardData` offset
  (block 0 byte 32) — they showed up at block 1 byte 22. The current
  parser may under-report card 1's punches. The other cards in the
  capture are SIAC and round-trip correctly.

## 12-hour AM/PM disambiguation (SI5 only)

SI5 cards store times as seconds-since-midnight or seconds-since-noon
with no AM/PM flag. `parseSI5CardData` resolves the ambiguity against a
wall-clock parameter (`now`). For backup imports done same-day, the
operator's wall clock works. For older imports (across midnight or
re-imports days later), AM punches may render as PM (or vice versa). A
future enhancement would resolve SI5 times against the event's
`zeroTime` instead.

## Capturing a fresh trace

1. Put a few SI cards through a readout station so its flash has known
   contents.
2. Open Wireshark with USBPcap (Windows) / `usbmon` (Linux) and start
   capturing on the USB serial endpoint Config+ uses.
3. Open Config+, connect to the station, hit "Read backup memory".
4. Stop the capture. Also export the Config+ "card readouts" view to
   `.txt` or `.csv` — this is the ground-truth labels for the parser
   tests.
5. Commit both files under `docs/si-protocol/readout-backup/` and update
   the fixture generator at
   `packages/web/src/lib/__tests__/fixtures/readout-backup-pcap.ts`.

## Implementation

| Layer | File |
| --- | --- |
| Slot demuxer + helpers | `packages/web/src/lib/si-protocol.ts` → `parseReadoutBackupBuffer`, `ReadoutBackupRecord`, `isReadoutMode` |
| WebSerial dispatch | `packages/web/src/lib/webserial.ts` → `readBackupMemory` mode-aware return |
| Staging table | `packages/api/prisma/schema.prisma` → `CardReadoutBackup` model |
| Server endpoints | `packages/api/src/routers/cardReadout.ts` → `importReadoutBackups`, `listReadoutBackups`, `pushReadoutBackup` |
| Import UI | `packages/web/src/pages/ControlsPage.tsx` → `ReadoutPanel` (mode-aware branch) |
| Review UI | `packages/web/src/pages/BackupPunchesPage.tsx` → "Card readouts" tab |

Parser tests at `packages/web/src/lib/__tests__/si-protocol.readout-backup.test.ts`
drive the parser against the captured fixture and assert SIID + punch
list + owner data for the 7 captured cards.

Integration tests at
`packages/api/src/__tests__/integration/readout-backup.test.ts` cover
import dedup, push effects, push idempotency, and the no_runner
match-status path.
