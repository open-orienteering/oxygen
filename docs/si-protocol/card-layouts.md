# SI card memory layouts

How Oxygen decodes the memory image of an SI card (`parseSI8CardData`, `parseSI10CardData` in `packages/web/src/lib/si-protocol.ts`; table in `SI_CARD_LAYOUT`). There is no vendor specification in the repository: every row says where its offset comes from. The punch area, not the header, is what differs between series.

## Header (block 0, all cards from SI8 up)

| Bytes | Field | Evidence |
| --- | --- | --- |
| 4-7 | clear station + time (the backup overwrites it with `ea ea ea ea`) | capture (see [readout-backup-format.md](readout-backup-format.md)); unverifiable on a live read |
| 8-11 | check: PTD, code, time (2) | capture: SI8 2220164 check `2 Sa 10:20:12` |
| 12-15 | start | capture |
| 16-19 | finish | capture: 2164102 finish `11 Sa 11:37:35` |
| 22 | punch counter (**can include blank slots**) | capture: 2164102 counter 27, records 1-5 blank |
| 24 | series, low nibble (`& 0x0f`) | capture: SI8 `02`, SIAC `0f`; MeOS `getCard9Data` |
| 25-27 | card number, big-endian | capture |

PTD byte: bit 0 = PM (+12 h), bits 1-3 day of week, bits 6-7 high bits of the control code (`code = ((PTD & 0xC0) << 2) | CN`). MeOS takes only bit 6 for the code; Oxygen uses bits 6-7 (unverified difference, no card in the capture has either bit).

## Punch area per series

Offsets are into the concatenated image (block 0 at 0, block 1 at 128, ...).

| Series | Card | First punch | Record | Max | Blocks read | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | SI9 | 56 | 4 B | 50 | 0-1 | MeOS `getCard9Data` only, not captured |
| 2 | SI8 | 136 | 4 B | 30 | 0-1 | capture, two cards: 2220164 first punch (48 @ 10:27:46) at image byte 136, owner text `2220164;SPORTident Swede;` at 32; 2164102 first slot at 136, record 6 (72 @ 11:27:37) at 156. MeOS agrees |
| 4 | pCard | 176 | 4 B | 20 | 0-1 | MeOS only, not captured |
| 6 | tCard | not decoded | | | | no layout known: the read fails with `card-read-failed` (reason `parse`) instead of guessing |
| 15 | SI10 / SI11 / SIAC | 512 (block 4, byte 0) | 4 B | 128 | 0-3 personal data + 4..7 punches | capture (three SIACs) and MeOS |

Each small layout ends inside the 256-byte image (`56 + 50*4 = 256`, `136 + 30*4 = 256`, `176 + 20*4 = 256`). For a large card slot k is at block `4 + floor(k/32)`, byte `(k % 32) * 4`.

The series byte decides the layout; an unknown series falls back to the card-number range (`getCardType`). Series 14 (fCard) and the `getCardType` ranges for 9M and 14M-16M are untouched.

## Reading the slots

- A card has `min(counter, max)` slots to look at. Nothing after slot `n - 1` is read: SIAC 8506707 has counter 12 and a stale record 13 (`124 We 18:22:12`) that must not become a punch.
- Slots are consumed by position. A blank slot (`ee ee ee ee` or `00 00 00 00`) emits nothing but still counts toward the counter: SI8 2164102 has counter 27 with five blank slots, so 22 punches. Do not reject a card because `punches.length < counter`.
- A slot with a control code and no time (`ee ee` time) is kept as `{ controlCode, time: 0 }`; code 0 is dropped. `punchCount` stays the raw counter (display only).
- Times are seconds since midnight (+43200 with the PM bit); no day or midnight handling here.

## Not verified

- Clear time on a live read (bytes 4-7); the capture is a backup.
- SI9 and pCard offsets and capacities (MeOS only), tCard format, owner data of SI8/SI9/pCard (the SI8 text in the capture sits in 32..135).
- PTD bit 7 for control codes above 511.
- Midnight: a card that crosses midnight lists its punches in card order with times that wrap. Matching keeps the card order (SI-09); unwrapping times to the event day is a follow-up.
