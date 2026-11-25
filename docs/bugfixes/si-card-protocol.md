# Bugfix: SI8 punches read from the owner area, half-read cards filed, clock-skewed punches lost

Full review work package 6, "SI card protocol" (SI-04 with SI-24, SI-05, SI-06, SI-13, SI-18, SI-09). The layouts and the capture the fixes are checked against are in [si-protocol/card-layouts.md](../si-protocol/card-layouts.md) and [si-protocol/readout-backup-format.md](../si-protocol/readout-backup-format.md).

## Symptom

- An SI8 card (2xxxxxx) showed too few punches, wrong ones, or none: the punch list started inside the owner text.
- A card pulled out too early, or one whose transfer was damaged, was filed as a result with missing punches (and the reader beeped as if all was well).
- A readout-station backup with a page that did not answer was imported with a hole in it and then cleared.
- A readout of a run in which one control's clock was wrong (an hour behind) reported that control as missing.
- After the USB reader was unplugged, the reader stayed in error and a replug did nothing until the page was reloaded; the kiosk gave no hint.

## Root cause

| Finding | What was wrong | Capture evidence |
| --- | --- | --- |
| SI-04 | `parseSI8CardData` read punches from block 0 byte 32 for every series. That is the owner area; an SI8 stores its punches from image byte 136 (SI9 56, pCard 176). It also read blocks by "counter > 24" instead of always the two blocks the layout needs. | SI8 2220164 holds the text `2220164;SPORTident Swede;` at byte 32 and its first punch (48 @ 10:27:46) at 136. |
| SI-24 | Both parsers skipped a blank slot without counting it and looped on `punches.length < counter`, so stale records beyond the counter were read; a code with no time was dropped. | SIAC 8506707: counter 12, stale record 13 behind it. SI8 2164102: counter 27, records 1-5 blank, 22 punches. |
| SI-05 | A block timeout finalized the card with what had arrived and sent the ACK; no completeness check; a removed card did not end the read; a frame of any length of 128 bytes or more counted as a block. | n/a |
| SI-13 | `crcValid` was computed and never looked at; the extended-frame branch (no ETX) swallowed `len` bytes after a bad CRC. | The CRC of the real odd-length frames (131 and 133 data bytes) in the capture is valid, so enforcing it is safe (`station-frames-pcap.ts`). |
| SI-06 | The backup walk skipped a page that failed four times, matched replies by command byte only (a late answer to page N could be taken for page N+1), and concatenated pages without their addresses. A personal-data chunk could be filed as an SI5 card. | n/a |
| SI-18 | A stream error left the status `error` for good; a fatal one nulled the port without closing it; `connect()` stranded an open port; a replug was never noticed. | n/a |
| SI-09 | The readout merged card and free punches and sorted them by time, so one punch with a mis-set clock moved out of order and the sequential matcher called it missing. | n/a |

## Fix

- `SI_CARD_LAYOUT` (series nibble to first punch, record size, max) in `si-protocol.ts`; `parseSI8CardData` needs both blocks, reads `min(counter, max)` slots at their offset and consumes blanks by position (`parsePunchSlot`); `parseSI10CardData` reads slot k from block `4 + k/32` and returns null when a needed block is missing. A code with no time is kept at time 0, code 0 is dropped, tCard (series 6) fails safe. `punchCount` stays the raw counter. The mock reader in `e2e/helpers/mock-webserial.ts` builds the same layout.
- `webserial.ts`: `failReadout(reason)` and `si:card-read-failed`, one re-request per block (timeout, bad CRC, wrong length or block number), completeness and parse check in `finalizeReadout`, a removed card fails the open read, un-awaited readout promises are caught. The ACK is sent only after a complete, parsed read. The Reader BT dispatches the same event. Kiosk message `card-read-failed`, kiosk screen and operator banner (en/sv).
- `handleFrame` drops a frame with a bad CRC (a pending block is asked for again as its one retry); `extractFrame` resyncs one byte on a bad extended-frame CRC; a short SYS_VAL reply throws.
- Backup walk: `sendAndWait(..., accept)` discards replies for another address or length, pages are placed by address in a buffer pre-filled with `0xEE`, a missing page throws `BackupReadIncompleteError` and nothing is cleared (explicit message in the Controls panel); auto-clear only follows a complete read and a successful import; SI5 plausibility check on unclaimed chunks.
- Read loop: a recoverable stream error returns to `reading`; a fatal one fails the open read and command, closes and releases the port; `connect()`/`attach()` release a held port first and a cancelled picker leaves a connected reader alone; DeviceManager attaches a granted port again on the `navigator.serial` `connect` event; the standalone kiosk shows "Reader disconnected".
- `mergePunchesInCardOrder` (shared): card punches keep the card's order, free punches are slotted in by time before the first card control punch with a strictly later time (start and finish are not insert positions: a stored card lists them first); used by `performReadout` and the Eventor result export.

## Found on the way

- The kiosk's standalone "reading" screen did not show again when the same card number was inserted twice in a row (the dedupe ref was never reset); it is reset now, which the "insert again" flow needs.
- `punches_raw` lists start and finish before the controls; the first draft of the merge treated them as insert positions and put a radio punch in front of control 31.

## Left out

See [si-card-protocol-followups.md](si-card-protocol-followups.md).

## Tests

- `si-protocol.readout-backup.test.ts`: full punch lists of the captured SI8 (2220164, 2164102) and SIAC cards.
- `si-protocol.test.ts`: `SI_CARD_LAYOUT`, SI9/SI8/pCard images built per the layout (SI9 and pCard are labelled "built per MeOS layout, not captured"), boundaries, blank and stale slots, code without time, tCard, real station frames with valid CRC.
- `webserial.test.ts` (new, fake serial port driven by the capture): live reads of SI8, SIAC and SI5 with exactly one ACK, split frames, bad CRC, wrong block, timeout and retry, removal, the backup walk with page placement, late and short replies, stream errors, fatal error and re-attach, picker cancel.
- `reader-hub.test.ts`, `reader-bt-connection.test.ts`: the new event.
- `readout.test.ts` (shared) and `kiosk-finish.test.ts` (integration): merge order, clock an hour behind, radio punch.
- E2E: `webserial.spec.ts` and `kiosk-readout.spec.ts` (card that cannot be read completely).
