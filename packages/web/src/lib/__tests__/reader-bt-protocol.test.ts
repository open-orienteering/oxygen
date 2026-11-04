import { describe, it, expect } from "vitest";
import {
  RBT_MSG,
  RBT_UUID,
  RbtProtocolError,
  SegmentReassembler,
  decodeAllSettings,
  decodeAutosend,
  decodeCardData,
  decodeCardStateChange,
  decodeDeviceInfo,
  decodeMessage,
  decodeSessionData,
  decodeSessionsList,
  encodeCardDataRequest,
  encodeFeedback,
  encodeMessage,
  encodeSessionDataRequest,
  encodeSessionsListRequest,
  encodeSetAutosend,
  firmwareVersion,
  operatingModeLabel,
  splitMessages,
  toSICardReadout,
} from "../reader-bt";
import { HW_CARD_IN, HW_DEVICE_INFO, HW_SETTINGS, HW_SIAC_MESSAGE, hwSegments } from "./fixtures/reader-bt-hardware";
import {
  SIAC_CARD,
  SIAC_OWNER,
  SI8_CARD,
  cardPayload,
  latin1,
  message,
  u16,
  u32,
  u64,
  weekMs,
} from "./fixtures/reader-bt";

const hex = (s: string) => new Uint8Array(s.trim().split(/\s+/).map((b) => parseInt(b, 16)));

describe("RBT_UUID", () => {
  it("uses the bd51xxxx base for Reader BT services and the SIG battery service", () => {
    expect(RBT_UUID.settingsService).toBe("bd510001-6aec-4628-a146-f3e95bc49e62");
    expect(RBT_UUID.readSettings).toBe("bd510002-6aec-4628-a146-f3e95bc49e62");
    expect(RBT_UUID.writeSettings).toBe("bd510003-6aec-4628-a146-f3e95bc49e62");
    expect(RBT_UUID.cardService).toBe("bd510011-6aec-4628-a146-f3e95bc49e62");
    expect(RBT_UUID.cardState).toBe("bd510012-6aec-4628-a146-f3e95bc49e62");
    expect(RBT_UUID.cardData).toBe("bd510013-6aec-4628-a146-f3e95bc49e62");
    expect(RBT_UUID.sessionsService).toBe("bd510031-6aec-4628-a146-f3e95bc49e62");
    expect(RBT_UUID.sessions).toBe("bd510032-6aec-4628-a146-f3e95bc49e62");
    expect(RBT_UUID.batteryService).toBe("0000180f-0000-1000-8000-00805f9b34fb");
    expect(RBT_UUID.batteryLevel).toBe("00002a19-0000-1000-8000-00805f9b34fb");
  });
});

describe("message header", () => {
  it("round-trips id and payload", () => {
    const bytes = encodeMessage(0x1110, new Uint8Array([1]));
    expect(Array.from(bytes)).toEqual([0x10, 0x11, 0x01, 0x00, 0x01]);
    const msg = decodeMessage(bytes);
    expect(msg.id).toBe(0x1110);
    expect(Array.from(msg.payload)).toEqual([1]);
  });

  it("encodes an empty request as a bare 4-byte header", () => {
    expect(Array.from(encodeMessage(RBT_MSG.READ_DEVICE_INFO))).toEqual([0x0e, 0x01, 0, 0]);
  });

  it("accepts a DataView (as Web Bluetooth delivers it)", () => {
    const bytes = encodeMessage(0x010c, new Uint8Array([7, 8]));
    const msg = decodeMessage(new DataView(bytes.buffer));
    expect(msg.id).toBe(0x010c);
    expect(Array.from(msg.payload)).toEqual([7, 8]);
  });

  it("rejects a header shorter than 4 bytes or a truncated payload", () => {
    expect(() => decodeMessage(new Uint8Array([0x01, 0x11, 0x07]))).toThrow(RbtProtocolError);
    expect(() => decodeMessage(new Uint8Array([0x01, 0x11, 0x07, 0x00, 1, 2]))).toThrow(
      RbtProtocolError,
    );
  });

  it("splits concatenated messages", () => {
    const a = message(0x1102, [1, 2, 3]);
    const b = message(0x1103, []);
    const msgs = splitMessages(new Uint8Array([...a, ...b]));
    expect(msgs.map((m) => m.id)).toEqual([0x1102, 0x1103]);
    expect(Array.from(msgs[0].payload)).toEqual([1, 2, 3]);
    expect(msgs[1].payload.length).toBe(0);
  });

  it("refuses trailing garbage when splitting", () => {
    expect(() => splitMessages(new Uint8Array([...message(0x1102, []), 0x01]))).toThrow(
      RbtProtocolError,
    );
  });
});

describe("request encoders", () => {
  it("encodes feedback OK / error", () => {
    expect(Array.from(encodeFeedback(true))).toEqual([0x10, 0x11, 1, 0, 1]);
    expect(Array.from(encodeFeedback(false))).toEqual([0x10, 0x11, 1, 0, 2]);
  });

  it("encodes set autosend", () => {
    expect(Array.from(encodeSetAutosend(true))).toEqual([0x0f, 0x01, 1, 0, 1]);
    expect(Array.from(encodeSetAutosend(false))).toEqual([0x0f, 0x01, 1, 0, 0]);
  });

  it("encodes card data requests as empty messages", () => {
    expect(Array.from(encodeCardDataRequest())).toEqual([0x03, 0x11, 0, 0]);
    expect(Array.from(encodeCardDataRequest(false))).toEqual([0x02, 0x11, 0, 0]);
  });

  it("encodes session requests", () => {
    expect(Array.from(encodeSessionsListRequest(3))).toEqual([0x01, 0x31, 1, 0, 3]);
    expect(Array.from(encodeSessionDataRequest(0x0123))).toEqual([0x02, 0x31, 2, 0, 0x23, 0x01]);
  });
});

describe("SegmentReassembler", () => {
  // Example from the Reader BT developer documentation: an 11-byte 0x1102
  // message split into three 10-byte wrapper notifications.
  const seg1 = hex("A1 01 06 00 01 0B 00 00 00 02");
  const seg2 = hex("A1 01 06 00 00 11 07 00 01 02");
  const seg3 = hex("A1 01 06 00 02 03 04 00 00 00");

  it("reassembles the documented three-segment example", () => {
    const r = new SegmentReassembler();
    expect(r.push(seg1)).toBeNull();
    expect(r.push(seg2)).toBeNull();
    const msg = r.push(seg3);
    expect(msg).not.toBeNull();
    expect(msg!.id).toBe(RBT_MSG.CARD_DATA_MINIMAL);
    expect(Array.from(msg!.payload)).toEqual([1, 2, 3, 4, 0, 0, 0]);

    const card = decodeCardData(msg!);
    expect(card.cardNumber).toBe(0x04030201);
    expect(card.cardFamily).toBe(0);
    expect(card.punches).toEqual([]);
    expect(card.complete).toBe(false);
  });

  it("also accepts the 0xA101 id encoded little-endian (01 A1)", () => {
    const le = (b: Uint8Array) => new Uint8Array([0x01, 0xa1, ...b.subarray(2)]);
    const r = new SegmentReassembler();
    r.push(le(seg1));
    r.push(le(seg2));
    expect(r.push(le(seg3))!.id).toBe(RBT_MSG.CARD_DATA_MINIMAL);
  });

  it("passes unsegmented messages straight through", () => {
    const r = new SegmentReassembler();
    const msg = r.push(message(RBT_MSG.CARD_STATE_CHANGE, [...u32(1), 1, ...u16(31)]));
    expect(msg!.id).toBe(RBT_MSG.CARD_STATE_CHANGE);
  });

  it("starts over when a new first segment arrives mid-message", () => {
    const r = new SegmentReassembler();
    r.push(seg1);
    r.push(seg2);
    // Lost the last segment; a fresh message begins.
    expect(r.push(seg1)).toBeNull();
    expect(r.push(seg2)).toBeNull();
    expect(r.push(seg3)!.id).toBe(RBT_MSG.CARD_DATA_MINIMAL);
  });

  it("throws and resets when segments overflow the announced length", () => {
    const r = new SegmentReassembler();
    r.push(seg1);
    r.push(seg2);
    r.push(seg2); // 11 bytes buffered, matching the total but not flagged last
    expect(() => r.push(seg2)).toThrow(RbtProtocolError);
    // Buffer is cleared: the next complete sequence decodes normally.
    r.push(seg1);
    r.push(seg2);
    expect(r.push(seg3)).not.toBeNull();
  });

  it("throws when the last segment leaves the message short", () => {
    const r = new SegmentReassembler();
    r.push(seg1);
    expect(() => r.push(seg3)).toThrow(/length/i);
  });

  it("throws on a continuation without a first segment", () => {
    const r = new SegmentReassembler();
    expect(() => r.push(seg2)).toThrow(RbtProtocolError);
  });
});

describe("decodeCardStateChange", () => {
  it("decodes insert and remove", () => {
    expect(decodeCardStateChange(new Uint8Array([...u32(8007045), 1, ...u16(31)]))).toEqual({
      cardNumber: 8007045,
      inserted: true,
      codeNumber: 31,
    });
    expect(decodeCardStateChange(new Uint8Array([...u32(2220164), 0, ...u16(1)])).inserted).toBe(
      false,
    );
  });
});

describe("decodeCardData", () => {
  it("decodes an SI8 complete readout with first/last name", () => {
    const d = decodeCardData(message(RBT_MSG.CARD_DATA_COMPLETE, cardPayload(SI8_CARD)));
    expect(d.cardNumber).toBe(2220164);
    expect(d.cardFamily).toBe(2);
    expect(d.complete).toBe(true);
    expect(d.punches).toHaveLength(6);
    expect(d.punches[3]).toEqual({
      controlInfo: 0,
      type: 7,
      code: 31,
      timeMs: weekMs(1, 10, 5, 10),
      punchingMode: false,
      radioMode: 0,
    });
    expect(d.siac).toBeUndefined();
    expect(d.owner).toEqual({ firstName: "Anna", lastName: "Svensson" });
  });

  it("decodes a SIAC complete readout with production block and å/ä/ö owner data", () => {
    const d = decodeCardData(message(RBT_MSG.CARD_DATA_COMPLETE, cardPayload(SIAC_CARD)));
    expect(d.cardFamily).toBe(15);
    expect(d.punches[1].punchingMode).toBe(true);
    expect(d.punches[1].radioMode).toBe(1);
    expect(d.punches[2].punchingMode).toBe(false);
    expect(d.punches[2].radioMode).toBe(2);
    expect(d.siac).toEqual({
      hardwareVersion: "3.1",
      softwareVersion: "6.4",
      signalCount: 120,
      clearCount: 45,
      batteryMv: 3050,
      batteryDate: "2024-03-15",
      productionDate: "2023-11",
    });
    expect(d.ownerCharset).toBe(1);
    expect(d.owner).toEqual({
      firstName: "Åsa",
      lastName: "Öberg",
      sex: "F",
      dateOfBirth: "1985",
      club: "OK Ärla",
      email: "asa@example.se",
      phone: "+46701234567",
      city: "Västerås",
      street: "Storgatan 1",
      postcode: "72211",
      country: "SWE",
    });
    expect(SIAC_OWNER.split(";")).toHaveLength(11);
  });

  it("has no production block for SIAC outside 8000000..8999999", () => {
    const spec = { ...SIAC_CARD, cardNumber: 9100200, siacProduction: undefined };
    const d = decodeCardData(message(RBT_MSG.CARD_DATA_COMPLETE, cardPayload(spec)));
    expect(d.siac).toBeUndefined();
    expect(d.owner?.firstName).toBe("Åsa");
  });

  it("decodes GB2312 owner data (charset 17)", () => {
    const spec = {
      ...SI8_CARD,
      owner: { charset: 17, bytes: [0xd5, 0xc5, 0x3b, 0xc8, 0xfd], size: 104 }, // 张;三
    };
    const d = decodeCardData(message(RBT_MSG.CARD_DATA_COMPLETE, cardPayload(spec)));
    expect(d.owner).toEqual({ firstName: "张", lastName: "三" });
  });

  it("ignores owner data in a minimal readout and tolerates an empty owner block", () => {
    const minimal = decodeCardData(
      message(RBT_MSG.CARD_DATA_MINIMAL, cardPayload({ ...SI8_CARD, owner: undefined })),
    );
    expect(minimal.complete).toBe(false);
    expect(minimal.owner).toBeUndefined();

    const empty = decodeCardData(
      message(
        RBT_MSG.CARD_DATA_COMPLETE,
        cardPayload({ ...SI8_CARD, owner: { charset: 1, bytes: latin1(";"), size: 24 } }),
      ),
    );
    expect(empty.owner).toBeNull();
  });

  it("decodes an unknown family code without failing", () => {
    const d = decodeCardData(
      message(
        RBT_MSG.CARD_DATA_COMPLETE,
        cardPayload({ cardNumber: 7123456, family: 9, punches: [] }),
      ),
    );
    expect(d.cardFamily).toBe(9);
    expect(d.cardNumber).toBe(7123456);
  });

  it("throws on a truncated punch list and on a non-card message", () => {
    const bytes = cardPayload(SI8_CARD).slice(0, 7 + 8 * 2 + 3);
    expect(() => decodeCardData(message(RBT_MSG.CARD_DATA_COMPLETE, bytes))).toThrow(
      RbtProtocolError,
    );
    expect(() => decodeCardData(message(RBT_MSG.FEEDBACK, [1]))).toThrow(RbtProtocolError);
  });
});

describe("decodeDeviceInfo", () => {
  it("decodes serial, type, versions and dates", () => {
    const payload = [
      ...u32(500123),
      ...u16(0x00a7),
      2,
      1,
      ...u16(2025),
      9,
      30,
      ...u16(2025),
      10,
      2,
      ...latin1("2.0.3"),
      0,
      0,
      0,
    ];
    expect(decodeDeviceInfo(new Uint8Array(payload))).toEqual({
      serialNumber: 500123,
      deviceType: 0xa7,
      hardwareVersion: "2.1",
      productionDate: "2025-09-30",
      batteryDate: "2025-10-02",
      softwareVersion: "2.0.3",
    });
  });

  it("returns null dates for zeroed fields", () => {
    const payload = [...u32(1), ...u16(0xa7), 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const info = decodeDeviceInfo(new Uint8Array(payload));
    expect(info.productionDate).toBeNull();
    expect(info.batteryDate).toBeNull();
    expect(info.softwareVersion).toBe("");
  });
});

describe("settings", () => {
  it("decodes code number and operating mode", () => {
    const s = decodeAllSettings(new Uint8Array([...u16(31), 0x05, 0, 0, 0, 0, 0, 0, 0]));
    expect(s.codeNumber).toBe(31);
    expect(s.operatingMode).toBe(0x05);
    expect(s.raw.length).toBe(10);
  });

  it("labels operating modes", () => {
    expect(operatingModeLabel(0x05)).toBe("readout");
    expect(operatingModeLabel(0x0b)).toBe("printout");
    expect(operatingModeLabel(0x0c)).toBe("standalone");
    expect(operatingModeLabel(0x01)).toBe("other");
  });

  it("decodes the autosend flag", () => {
    expect(decodeAutosend(new Uint8Array([1]))).toBe(true);
    expect(decodeAutosend(new Uint8Array([0]))).toBe(false);
  });
});

describe("sessions", () => {
  const entry = (n: number, readouts: number, start = 0, end = 0) => [
    ...u16(n),
    ...u64(start),
    ...u64(end),
    ...u16(readouts),
  ];

  it("decodes a page of the session lookup table", () => {
    const page0 = decodeSessionsList(
      new Uint8Array([0, 3, 5, ...[10, 9, 8, 7, 6].flatMap((n) => entry(n, n * 2))]),
    );
    expect(page0.page).toBe(0);
    expect(page0.totalPages).toBe(3);
    expect(page0.entries.map((e) => e.sessionNumber)).toEqual([10, 9, 8, 7, 6]);
    expect(page0.entries[0].readoutCount).toBe(20);

    const last = decodeSessionsList(
      new Uint8Array([2, 3, 1, ...entry(1, 4, 1_760_000_000, 1_760_003_600)]),
    );
    expect(last.page).toBe(2);
    expect(last.entries).toEqual([
      { sessionNumber: 1, startTime: 1_760_000_000, endTime: 1_760_003_600, readoutCount: 4 },
    ]);
  });

  it("throws when the entry count does not fit the payload", () => {
    expect(() => decodeSessionsList(new Uint8Array([0, 1, 2, ...entry(1, 1)]))).toThrow(
      RbtProtocolError,
    );
  });

  it("decodes session data with embedded readout messages", () => {
    const a = message(RBT_MSG.CARD_DATA_MINIMAL, cardPayload({ ...SI8_CARD, owner: undefined }));
    const b = message(RBT_MSG.CARD_DATA_COMPLETE, cardPayload(SIAC_CARD));
    const data = [...a, ...b];
    const s = decodeSessionData(new Uint8Array([...u16(7), ...u16(2), ...u32(data.length), ...data]));
    expect(s.sessionNumber).toBe(7);
    expect(s.readouts).toHaveLength(2);
    expect(s.readouts.map((m) => m.id)).toEqual([0x1102, 0x1103]);
    expect(decodeCardData(s.readouts[0]).cardNumber).toBe(2220164);
    expect(decodeCardData(s.readouts[1]).owner?.city).toBe("Västerås");
    expect(Array.from(s.readouts[1].raw)).toEqual(Array.from(b));
  });

  it("decodes an empty session", () => {
    const s = decodeSessionData(new Uint8Array([...u16(3), ...u16(0), ...u32(0)]));
    expect(s.readouts).toEqual([]);
  });

  it("throws when the readout count disagrees with the embedded messages", () => {
    const a = message(RBT_MSG.CARD_DATA_MINIMAL, cardPayload({ ...SI8_CARD, owner: undefined }));
    expect(() =>
      decodeSessionData(new Uint8Array([...u16(7), ...u16(2), ...u32(a.length), ...a])),
    ).toThrow(RbtProtocolError);
  });
});

describe("frames captured from a real Reader BT", () => {
  it("segment wrappers start with the bytes 01 a1 (0xA101 little-endian)", () => {
    const segs = hwSegments(HW_SIAC_MESSAGE);
    expect(Array.from(segs[0].subarray(0, 5))).toEqual([0x01, 0xa1, 0xf4, 0x00, 0x01]);
    const r = new SegmentReassembler();
    expect(r.push(segs[0])).toBeNull();
    expect(r.push(segs[1])?.raw).toEqual(HW_SIAC_MESSAGE);
  });

  it("device info: serial, hardware, dates and the long software string", () => {
    const d = decodeDeviceInfo(decodeMessage(HW_DEVICE_INFO).payload);
    expect(d.serialNumber).toBe(1000139);
    expect(d.deviceType).toBe(0x00a7);
    expect(d.hardwareVersion).toBe("4.1");
    expect(d.productionDate).toBe("2026-10-02");
    expect(d.softwareVersion).toBe("sireader@2.2.0+71f89ff.20261008113738");
    expect(firmwareVersion(d.softwareVersion)).toBe("2.2.0");
    expect(firmwareVersion("2.0.3")).toBe("2.0.3");
    expect(firmwareVersion("beta")).toBe("beta");
  });

  it("settings and card state", () => {
    const s = decodeAllSettings(decodeMessage(HW_SETTINGS).payload);
    expect(s.codeNumber).toBe(5);
    expect(operatingModeLabel(s.operatingMode)).toBe("readout");
    expect(decodeCardStateChange(decodeMessage(HW_CARD_IN).payload)).toEqual({
      cardNumber: 8007045,
      inserted: true,
      codeNumber: 5,
    });
  });

  it("SIAC readout: punches, sub-seconds, production block and CP850 owner data", () => {
    const d = decodeCardData(HW_SIAC_MESSAGE);
    expect(d.cardFamily).toBe(15);
    expect(d.punches).toHaveLength(22);
    expect(d.siac).toMatchObject({
      signalCount: 1016,
      clearCount: 54,
      batteryMv: 2980,
      batteryDate: "2024-02-12",
      productionDate: "2024-02",
    });

    const r = toSICardReadout(d);
    expect(r.cardType).toBe("SIAC");
    expect(r.clearTime).toBe(36881); // 10:14:41
    expect(r.checkTime).toBe(37081); // 10:18:01
    expect(r.startTime).toBe(37749); // 10:29:09
    expect(r.finishTime).toBe(42138); // 11:42:18.359
    expect(r.finishDayOfWeek).toBe(7); // day index 0 → Sunday
    expect(r.punches).toHaveLength(16);
    expect(r.punches[0]).toEqual({ controlCode: 144, time: 38031, subSecond: 215 }); // .839 s
    expect(r.batteryVoltage).toBeCloseTo(2.98);
    expect(r.ownerData).toMatchObject({
      firstName: "Åsa",
      lastName: "Öberg",
      club: "OK Ärla",
      city: "Västerås",
      country: "Swedish",
    });
  });
});
