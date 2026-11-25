# SI card protocol: what package 6 left out

Items found while fixing [SI-04, SI-05, SI-06, SI-09, SI-13, SI-18 and SI-24](si-card-protocol.md) that were left for later, with the reason.

- **Midnight unwrap (decision D2).** The card order is kept (SI-09), but times are never unwrapped across midnight. The plan is to unwrap card times to within +-12 h of the start end to end (about 18 `finish - start` sites in 13 files), together with SI-33 and SI-34. Until then a run that crosses midnight is as wrong as before in running time.
- **tCard decoder (D4).** Series 6 fails safe (`card-read-failed`, reason `parse`). It needs a capture of a real tCard (it uses a different record size) before it can be decoded. A tCard in a readout-station backup is logged and skipped by `parseReadoutBackupBuffer`, and the Controls panel is not told: **"Clear after read" can clear a station holding a slot the parser could not decode.** Return the number of skipped slots from the backup read and refuse to clear when it is above zero.
- **Owner data of SI8/SI9/pCard.** The SI8 text in the capture (`2220164;SPORTident Swede;` at byte 32) is not parsed.
- **SI-25, SI-28 and the rest of SI-48; SI-43.** Not touched.
- **`getCardType` ranges and PTD bit 7.** The 9M and 14M-16M mapping and fCard (series 14) are as before. MeOS reads the control code's high bit from PTD bit 6 only; Oxygen uses bits 6-7. No card in the capture exercises either.
- **0xFF extended branch of `extractFrame`.** The extended frame form is only resynchronised on a bad CRC; its length handling is otherwise as before.
- **SI-31 leftovers.** `buildSetTime`, `encodeStationCode`/`decodeStationCode`, `parseTimeDrift`, `parseBackupPage` table tests and `addRecentCard` have no unit tests. The new fake serial port (`webserial.test.ts`) makes them cheap to add.
- **E2E for SI-06.** The mock reader has no backup memory, so the incomplete-backup message and the no-clear rule are covered by unit tests of the walk only.
- **Bluetooth retries and timeouts.** Reader BT retries a read once and then gives up (it now reports `si:card-read-failed`); an unsolicited card message that cannot be decoded reports no failure (the card number is unknown).
- **SI9 and pCard offsets** (56 and 176) come from MeOS, not from a capture. Check them with a real card before relying on them.
- **SI5 in the serial reader** expects the 130-byte `0xB1` frame (station code + 128 bytes, no block number) the protocol describes; no live SI5 read is in the capture.
