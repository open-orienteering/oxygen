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

  const t = (h: number, m: number, sec: number) => h * 3600 + m * 60 + sec;

  it("parses card 7 (SIID 2220164, SI8): owner text is not read as punches", () => {
    // The capture holds "2220164;SPORTident Swede;" at image byte 32, where the
    // old parser started reading punch records. The first real punch is at 136.
    const c = findBySIID(records, 2220164)!.card;
    expect(c.cardType).toBe("SI8");
    expect(c.punchCount).toBe(10);
    expect(c.punches).toEqual([
      { controlCode: 48, time: t(10, 27, 46) },
      { controlCode: 56, time: t(10, 32, 35) },
      { controlCode: 53, time: t(10, 41, 21) },
      { controlCode: 41, time: t(10, 43, 56) },
      { controlCode: 57, time: t(10, 50, 50) },
      { controlCode: 44, time: t(10, 54, 48) },
      { controlCode: 45, time: t(10, 57, 26) },
      { controlCode: 31, time: t(10, 59, 33) },
      { controlCode: 32, time: t(11, 2, 50) },
      { controlCode: 100, time: t(11, 4, 42) },
    ]);
    expect(c.finishTime).toBe(t(11, 5, 20));
  });

  it("parses card 1 (SIID 2164102, SI8): counter 27 with 5 blank records -> 22 punches", () => {
    const c = findBySIID(records, 2164102)!.card;
    expect(c.punchCount).toBe(27);
    expect(c.finishTime).toBe(t(11, 37, 35));
    const expected = [
      [72, t(11, 27, 37)], [62, t(11, 27, 6)], [81, t(11, 29, 39)],
      [83, t(11, 29, 7)], [88, t(11, 29, 20)], [71, t(11, 32, 47)],
      [70, t(11, 33, 3)], [90, t(11, 33, 56)], [91, t(11, 34, 25)],
      [80, t(11, 34, 46)], [64, t(11, 34, 54)], [63, t(11, 37, 7)],
      [85, t(11, 37, 29)], [84, t(11, 37, 39)],
      // Fr 05:43..08:27, written by an older event; the times are still raw
      // seconds-of-day, no day-of-week handling here.
      [42, t(5, 43, 11)], [42, t(5, 45, 22)], [42, t(5, 57, 47)],
      [42, t(6, 49, 3)], [42, t(7, 3, 15)], [42, t(8, 9, 4)],
      [42, t(8, 18, 52)], [42, t(8, 27, 15)],
    ].map(([controlCode, time]) => ({ controlCode, time }));
    expect(c.punches).toEqual(expected);
    expect(c.punches).toHaveLength(22);
  });

  it("parses SIAC 8506707: exactly 12 punches, the stale record 13 is not read", () => {
    const c = findBySIID(records, 8506707)!.card;
    expect(c.punchCount).toBe(12);
    expect(c.punches).toEqual([
      [45, t(18, 35, 59)], [72, t(18, 37, 39)], [73, t(18, 39, 10)],
      [50, t(18, 40, 9)], [37, t(18, 40, 47)], [41, t(18, 42, 2)],
      [33, t(18, 42, 50)], [42, t(18, 44, 14)], [60, t(18, 45, 39)],
      [78, t(18, 46, 43)], [62, t(18, 47, 22)], [100, t(18, 47, 31)],
    ].map(([controlCode, time]) => ({ controlCode, time })));
  });

  it("parses SIAC 8408405 and 8060780: 8 punches each", () => {
    expect(findBySIID(records, 8408405)!.card.punches).toEqual([
      [33, t(18, 4, 53)], [34, t(18, 6, 11)], [35, t(18, 7, 51)],
      [40, t(18, 12, 46)], [44, t(18, 15, 54)], [48, t(18, 22, 31)],
      [53, t(18, 25, 9)], [100, t(18, 26, 20)],
    ].map(([controlCode, time]) => ({ controlCode, time })));
    expect(findBySIID(records, 8060780)!.card.punches).toEqual([
      [34, t(18, 22, 36)], [44, t(18, 29, 43)], [40, t(18, 31, 30)],
      [56, t(18, 34, 52)], [62, t(18, 36, 55)], [48, t(18, 40, 12)],
      [50, t(18, 42, 53)], [100, t(18, 44, 22)],
    ].map(([controlCode, time]) => ({ controlCode, time })));
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

  it("owner text in an unclaimed chunk is not emitted as an SI5 card", () => {
    // 0x80 bytes of personal data, no SI8+ marker: the SI5 branch must reject it.
    const text = "Marcus;Kempe;male;19790314;Skogsluffarnas OK;marcus@example.org;0046708956221;Lagmansplan 3;12838;Skarpnack;SWE;";
    const chunk = new Uint8Array(0x80).fill(0xee);
    for (let i = 0; i < text.length && i < 0x80; i++) chunk[i] = text.charCodeAt(i);
    expect(parseReadoutBackupBuffer(chunk, 0x100)).toEqual([]);
  });

  it("an SI5 chunk with an implausible punch pointer is skipped", () => {
    const sl = READOUT_BACKUP_FIXTURE.slice(0xd00, 0xd80); // card 452242
    expect(parseReadoutBackupBuffer(sl, 0xe00)).toHaveLength(1);
    const damaged = Uint8Array.from(sl);
    damaged[23] = 0x80;
    expect(parseReadoutBackupBuffer(damaged, 0xe00)).toEqual([]);
  });

  it("returns empty array on all-EE buffer", () => {
    const empty = new Uint8Array(512).fill(0xee);
    expect(parseReadoutBackupBuffer(empty)).toEqual([]);
  });
});
