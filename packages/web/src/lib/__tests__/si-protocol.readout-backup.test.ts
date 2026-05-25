import { describe, it, expect } from "vitest";
import { parseReadoutBackupBuffer, type ReadoutBackupRecord } from "../si-protocol";
import {
  READOUT_BACKUP_FIXTURE,
  READOUT_BACKUP_FIXTURE_BASE_ADDR,
} from "./fixtures/readout-backup-pcap";

/**
 * Drives parseReadoutBackupBuffer against the byte stream extracted from
 * docs/si-protocol/readout-backup/readout-capture.pcapng.
 *
 * Ground truth comes from the parallel readouts.txt rendering by Config+:
 * 7 cards covering SI5, SI8, SIAC layouts at known flash addresses.
 */

function findBySIID(records: ReadoutBackupRecord[], siid: number) {
  return records.find((r) => r.card.cardNumber === siid);
}

describe("parseReadoutBackupBuffer (M_READOUT slot layout)", () => {
  // Pin `now` so SI5 12h-time disambiguation is deterministic in tests.
  // SI5 cards in this fixture (card 5) were read at ~11:29 AM. With `now`
  // set to 09:00, parseSI5CardData picks the AM interpretation.
  const FIXED_NOW = new Date(2026, 4, 24, 9, 0, 0);
  const records = parseReadoutBackupBuffer(
    READOUT_BACKUP_FIXTURE,
    READOUT_BACKUP_FIXTURE_BASE_ADDR,
    FIXED_NOW,
  );

  it("recovers all 7 cards from the captured backup", () => {
    const siids = records.map((r) => r.card.cardNumber).sort((a, b) => a - b);
    expect(siids).toEqual([
      452242,    // card 5 (classic SI5)
      2164102,   // card 1 (SI8, "series 2" layout — 0x100 slot)
      2220164,   // card 7 (SI8, 0x100 slot)
      8007045,   // card 3 (SIAC, owner=Marcus Kempe)
      8060780,   // card 6 (SIAC)
      8408405,   // card 4 (SIAC)
      8506707,   // card 2 (SIAC)
    ]);
  });

  it("identifies slot addresses correctly", () => {
    const byAddr = Object.fromEntries(
      records.map((r) => [r.slotAddress.toString(16), r.card.cardNumber]),
    );
    expect(byAddr).toEqual({
      "100": 2164102,   // SI8: 0x100 slot
      "200": 8506707,   // SIAC: 0x400 slot
      "600": 8007045,   // SIAC: 0x400 slot
      "a00": 8408405,   // SIAC: 0x400 slot
      "e00": 452242,    // SI5: 0x80 slot
      "e80": 8060780,   // SIAC: 0x400 slot
      "1280": 2220164,  // SI8: 0x100 slot
    });
  });

  it("parses card 3 (SIID 8007045, SIAC) — full owner + 18 punches", () => {
    const rec = findBySIID(records, 8007045);
    expect(rec).toBeDefined();
    if (!rec) return;
    const c = rec.card;
    expect(c.cardType).toBe("SIAC");
    expect(c.punchCount).toBe(18);
    expect(c.punches).toHaveLength(18);
    // First punch from readouts.txt: 32 Tu 18:50:02
    expect(c.punches[0].controlCode).toBe(32);
    expect(c.punches[0].time).toBe(18 * 3600 + 50 * 60 + 2);
    // Last punch: 100 Tu 19:16:54
    expect(c.punches[17].controlCode).toBe(100);
    expect(c.punches[17].time).toBe(19 * 3600 + 16 * 60 + 54);
    // Owner — readouts.txt: Marcus / Kempe / Skogsluffarnas OK
    expect(c.ownerData?.firstName).toBe("Marcus");
    expect(c.ownerData?.lastName).toBe("Kempe");
    expect(c.ownerData?.club).toBe("Skogsluffarnas OK");
  });

  it("parses card 5 (SIID 452242, classic SI5) — 10 punches", () => {
    const rec = findBySIID(records, 452242);
    expect(rec).toBeDefined();
    if (!rec) return;
    const c = rec.card;
    expect(c.cardType).toBe("SI5");
    expect(c.punchCount).toBe(10);
    expect(c.punches).toHaveLength(10);
    // Each punch from readouts.txt
    const expected = [
      { code: 87, time: 11 * 3600 + 29 * 60 + 15 },
      { code: 88, time: 11 * 3600 + 29 * 60 + 16 },
      { code: 90, time: 11 * 3600 + 29 * 60 + 17 },
      { code: 80, time: 11 * 3600 + 29 * 60 + 20 },
      { code: 93, time: 11 * 3600 + 29 * 60 + 24 },
      { code: 80, time: 11 * 3600 + 29 * 60 + 28 },
      { code: 70, time: 11 * 3600 + 29 * 60 + 28 },
      { code: 74, time: 11 * 3600 + 29 * 60 + 31 },
      { code: 75, time: 11 * 3600 + 29 * 60 + 31 },
      { code: 77, time: 11 * 3600 + 29 * 60 + 34 },
    ];
    for (let i = 0; i < expected.length; i++) {
      expect(c.punches[i].controlCode).toBe(expected[i].code);
      expect(c.punches[i].time).toBe(expected[i].time);
    }
  });

  it("clears the SI8+ marker so clearTime parses as null (not garbage)", () => {
    // Card 3 has Clear reserve filled, but the backup format overwrites
    // the primary Clear field with the marker. Parser must report null,
    // not a decoded `ea ea` time.
    const rec = findBySIID(records, 8007045);
    expect(rec).toBeDefined();
    if (!rec) return;
    expect(rec.card.clearTime).toBeNull();
  });

  it("captures the 4-byte slot header for forensics", () => {
    const rec = findBySIID(records, 8007045);
    expect(rec).toBeDefined();
    if (!rec) return;
    // Card 3 (slot 0x600) — first 4 bytes from the pcap = 72 95 46 9c
    expect(Array.from(rec.readAtRaw)).toEqual([0x72, 0x95, 0x46, 0x9c]);
  });

  it("preserves raw slot bytes (0x400 for SIAC)", () => {
    const rec = findBySIID(records, 8007045);
    expect(rec).toBeDefined();
    if (!rec) return;
    expect(rec.rawBytes.length).toBe(0x400);
  });

  it("preserves raw slot bytes (0x80 for SI5)", () => {
    const rec = findBySIID(records, 452242);
    expect(rec).toBeDefined();
    if (!rec) return;
    expect(rec.rawBytes.length).toBe(0x80);
  });

  it("parses card 7 (SIID 2220164, SI8) — last slot in flash, 10 punches", () => {
    const rec = findBySIID(records, 2220164);
    expect(rec).toBeDefined();
    if (!rec) return;
    const c = rec.card;
    expect(c.cardType).toBe("SI8");
    expect(c.punchCount).toBe(10);
  });

  it("skips empty-flash regions without throwing", () => {
    // 0xF00..0x12FF in the fixture is all 0xEE.  No slot records there.
    const inEmptyRange = records.filter(
      (r) => r.slotAddress >= 0xf00 && r.slotAddress < 0x1280,
    );
    expect(inEmptyRange).toHaveLength(0);
  });

  it("never throws on malformed input", () => {
    // 1 KB of random-ish bytes — must not throw.
    const garbage = new Uint8Array(1024);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 31 + 7) & 0xff;
    expect(() => parseReadoutBackupBuffer(garbage)).not.toThrow();
  });

  it("returns empty array on all-EE buffer", () => {
    const empty = new Uint8Array(512).fill(0xee);
    expect(parseReadoutBackupBuffer(empty)).toEqual([]);
  });
});
