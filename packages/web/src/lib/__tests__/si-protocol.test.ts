import { describe, it, expect } from "vitest";
import {
  calculateCRC,
  buildCommand,
  buildReadCommand,
  extractFrame,
  parseCardDetection,
  parsePunchRecord,
  parsePunchTime,
  parseDayOfWeek,
  parseSI8CardData,
  parseSI10CardData,
  parseSI10PersonalData,
  decodeCp850,
  parseTransmitRecord,
  getCardType,
  isDetectionCommand,
  isReadoutResponse,
  isLargeCardType,
  supportsFullReadout,
  CMD,
  STX,
  ETX,
  WAKEUP,
} from "../si-protocol";

// ─── Card Type Detection ───────────────────────────────────

describe("getCardType", () => {
  it("returns Unknown for invalid card numbers", () => {
    expect(getCardType(0)).toBe("Unknown");
    expect(getCardType(-1)).toBe("Unknown");
  });

  it("detects SI5 cards (1–499999)", () => {
    expect(getCardType(1)).toBe("SI5");
    expect(getCardType(250000)).toBe("SI5");
    expect(getCardType(499999)).toBe("SI5");
  });

  it("detects SI6 cards (500000–999999)", () => {
    expect(getCardType(500000)).toBe("SI6");
    expect(getCardType(750000)).toBe("SI6");
    expect(getCardType(999999)).toBe("SI6");
  });

  it("detects SI6 special range (2003001–2003400)", () => {
    expect(getCardType(2003001)).toBe("SI6");
    expect(getCardType(2003200)).toBe("SI6");
    expect(getCardType(2003400)).toBe("SI6");
  });

  it("detects SI9 cards (1000000–1999999)", () => {
    expect(getCardType(1000000)).toBe("SI9");
    expect(getCardType(1500000)).toBe("SI9");
    expect(getCardType(1999999)).toBe("SI9");
  });

  it("detects SI8 cards (2000001–2999999)", () => {
    expect(getCardType(2000001)).toBe("SI8");
    expect(getCardType(2220164)).toBe("SI8");
    expect(getCardType(2999999)).toBe("SI8");
  });

  it("detects pCard (4000000–4999999)", () => {
    expect(getCardType(4000000)).toBe("pCard");
    expect(getCardType(4500000)).toBe("pCard");
  });

  it("detects tCard (6000001–6999999)", () => {
    expect(getCardType(6000001)).toBe("tCard");
    expect(getCardType(6500000)).toBe("tCard");
  });

  it("detects SI10 cards (7000001–7999999)", () => {
    expect(getCardType(7000001)).toBe("SI10");
    expect(getCardType(7500000)).toBe("SI10");
  });

  it("detects SIAC cards (8M, 9M, 14M-16M ranges)", () => {
    expect(getCardType(8000001)).toBe("SIAC");
    expect(getCardType(8506707)).toBe("SIAC");
    expect(getCardType(9000001)).toBe("SIAC");
    expect(getCardType(14000001)).toBe("SIAC");
    expect(getCardType(16000000)).toBe("SIAC");
  });
});

describe("supportsFullReadout", () => {
  it("returns true for SI8+", () => {
    expect(supportsFullReadout("SI8")).toBe(true);
    expect(supportsFullReadout("SI9")).toBe(true);
    expect(supportsFullReadout("SI10")).toBe(true);
    expect(supportsFullReadout("SIAC")).toBe(true);
    expect(supportsFullReadout("pCard")).toBe(true);
  });

  it("returns false for SI5/SI6/Unknown", () => {
    expect(supportsFullReadout("SI5")).toBe(false);
    expect(supportsFullReadout("SI6")).toBe(false);
    expect(supportsFullReadout("Unknown")).toBe(false);
  });
});

// ─── CRC Calculation ───────────────────────────────────────

describe("calculateCRC", () => {
  it("returns 0 for empty/short data", () => {
    expect(calculateCRC(new Uint8Array([]))).toBe(0);
    expect(calculateCRC(new Uint8Array([0x42]))).toBe(0);
  });

  it("returns the two-byte value for 2-byte input", () => {
    const data = new Uint8Array([0xEF, 0x01]);
    expect(calculateCRC(data)).toBe(0xef01);
  });

  it("calculates CRC for a known command (0xEF read block 0)", () => {
    // CMD=0xEF, LEN=0x01, DATA=0x00
    const data = new Uint8Array([0xef, 0x01, 0x00]);
    const crc = calculateCRC(data);
    // This CRC must be consistent (deterministic)
    expect(crc).toBeGreaterThan(0);
    expect(crc).toBeLessThanOrEqual(0xffff);

    // Verify the frame we build has the same CRC
    const frame = buildCommand(CMD.SI8_READ, [0]);
    const crcHigh = frame[frame.length - 3];
    const crcLow = frame[frame.length - 2];
    expect((crcHigh << 8) | crcLow).toBe(crc);
  });

  it("calculates different CRC for different data", () => {
    const crc1 = calculateCRC(new Uint8Array([0xef, 0x01, 0x00]));
    const crc2 = calculateCRC(new Uint8Array([0xef, 0x01, 0x01]));
    expect(crc1).not.toBe(crc2);
  });
});

// ─── Frame Building ────────────────────────────────────────

describe("buildCommand", () => {
  it("builds a frame with WAKEUP + STX + CMD + LEN + CRC + ETX", () => {
    const frame = buildCommand(CMD.SI8_READ, [0]);
    // WAKEUP(1) + STX(1) + CMD(1) + LEN(1) + DATA(1) + CRC(2) + ETX(1) = 8
    expect(frame.length).toBe(8);
    expect(frame[0]).toBe(WAKEUP);
    expect(frame[1]).toBe(STX);
    expect(frame[2]).toBe(CMD.SI8_READ);
    expect(frame[3]).toBe(1); // length
    expect(frame[4]).toBe(0); // block 0
    expect(frame[frame.length - 1]).toBe(ETX);
  });

  it("builds a frame with no params", () => {
    const frame = buildCommand(0x83, []);
    expect(frame.length).toBe(7);
    expect(frame[3]).toBe(0); // length = 0
    expect(frame[frame.length - 1]).toBe(ETX);
  });

  it("builds frames that pass CRC validation", () => {
    const frame = buildCommand(CMD.SI8_READ, [0]);
    // Extract and verify CRC
    const crcData = frame.slice(2, 2 + 2 + 0); // CMD + LEN (no additional data beyond what we already verified)
    // The full CRC data is CMD + LEN + PARAMS
    const fullCrcData = frame.slice(2, 5); // 0xEF, 0x01, 0x00
    const calcCrc = calculateCRC(fullCrcData);
    const frameCrc = (frame[5] << 8) | frame[6];
    expect(calcCrc).toBe(frameCrc);
  });
});

describe("buildReadCommand", () => {
  it("uses 0xEF for SI8 cards", () => {
    const frame = buildReadCommand("SI8", 0);
    expect(frame[2]).toBe(CMD.SI8_READ);
  });

  it("uses 0xB1 for SI5 cards", () => {
    const frame = buildReadCommand("SI5", 0);
    expect(frame[2]).toBe(CMD.SI5_READ);
  });

  it("uses 0xE1 for SI6 cards", () => {
    const frame = buildReadCommand("SI6", 0);
    expect(frame[2]).toBe(CMD.SI6_READ);
  });

  it("uses 0xEF for SIAC cards", () => {
    const frame = buildReadCommand("SIAC", 0);
    expect(frame[2]).toBe(CMD.SI8_READ);
  });
});

// ─── Frame Parsing ─────────────────────────────────────────

describe("extractFrame", () => {
  it("returns null for empty buffer", () => {
    expect(extractFrame(new Uint8Array([]))).toBeNull();
  });

  it("returns null for buffer without STX", () => {
    expect(extractFrame(new Uint8Array([0x00, 0x01, 0x02]))).toBeNull();
    // Actually 0x02 IS STX, but not enough data after it
  });

  it("returns null for incomplete frame", () => {
    // STX + CMD + LEN but not enough data
    expect(extractFrame(new Uint8Array([STX, 0xe8, 0x06]))).toBeNull();
  });

  it("parses a valid BSF8 frame", () => {
    // Build a known frame and parse it
    const cmd = buildCommand(CMD.SI8_READ, [0]);
    // Strip the WAKEUP prefix (extractFrame looks for STX)
    const frameBytes = cmd.slice(1); // Remove WAKEUP
    const result = extractFrame(frameBytes);
    expect(result).not.toBeNull();
    expect(result!.frame.cmd).toBe(CMD.SI8_READ);
    expect(result!.frame.data.length).toBe(1);
    expect(result!.frame.data[0]).toBe(0);
    expect(result!.frame.crcValid).toBe(true);
  });

  it("skips garbage bytes before STX", () => {
    const cmd = buildCommand(CMD.SI8_READ, [0]);
    const withGarbage = new Uint8Array([0xff, 0x00, 0x42, ...cmd.slice(1)]);
    const result = extractFrame(withGarbage);
    expect(result).not.toBeNull();
    expect(result!.frame.cmd).toBe(CMD.SI8_READ);
  });

  it("returns remaining bytes after the frame", () => {
    const cmd = buildCommand(CMD.SI8_READ, [0]);
    const trailing = new Uint8Array([0xAA, 0xBB]);
    const combined = new Uint8Array([...cmd.slice(1), ...trailing]);
    const result = extractFrame(combined);
    expect(result).not.toBeNull();
    expect(result!.remaining.length).toBe(2);
    expect(result!.remaining[0]).toBe(0xaa);
  });

  it("extracts multiple frames sequentially", () => {
    const cmd1 = buildCommand(CMD.SI8_READ, [0]);
    const cmd2 = buildCommand(CMD.SI8_READ, [1]);
    const combined = new Uint8Array([...cmd1.slice(1), ...cmd2.slice(1)]);

    const r1 = extractFrame(combined);
    expect(r1).not.toBeNull();
    expect(r1!.frame.data[0]).toBe(0);

    const r2 = extractFrame(r1!.remaining);
    expect(r2).not.toBeNull();
    expect(r2!.frame.data[0]).toBe(1);
  });

  it("handles extended protocol frames (with FF marker)", () => {
    // STX + FF + CMD + LEN + DATA + CRC(2)
    const cmd = 0xe8;
    const data = new Uint8Array([0x00, 0x7d, 0x02, 0x21, 0xe0, 0x84]);
    const crcInput = new Uint8Array([cmd, data.length, ...data]);
    const crc = calculateCRC(crcInput);

    const frame = new Uint8Array([
      STX, 0xff, cmd, data.length, ...data,
      (crc >> 8) & 0xff, crc & 0xff, ETX,
    ]);

    const result = extractFrame(frame);
    expect(result).not.toBeNull();
    expect(result!.frame.cmd).toBe(cmd);
    expect(result!.frame.isExtended).toBe(true);
    expect(result!.frame.crcValid).toBe(true);
    expect(result!.frame.data.length).toBe(6);
  });
});

// ─── Card Detection Parsing ────────────────────────────────

describe("parseCardDetection", () => {
  it("parses SI8 detection (0xE8) with 6-byte data", () => {
    // Station 125, SI8 card 2,220,164
    // 0x21E084 = 2,220,164
    const data = new Uint8Array([0x00, 0x7d, 0x02, 0x21, 0xe0, 0x84]);
    const result = parseCardDetection(CMD.SI8_DETECTED, data);
    expect(result).not.toBeNull();
    expect(result!.cardNumber).toBe(2220164);
    expect(result!.cardType).toBe("SI8");
  });

  it("parses SIAC detection via SI8 command", () => {
    // Station 125, SIAC card 8,506,707
    // 0x81CD53 = 8,506,707
    const data = new Uint8Array([0x00, 0x7d, 0x0f, 0x81, 0xcd, 0x53]);
    const result = parseCardDetection(CMD.SI8_DETECTED, data);
    expect(result).not.toBeNull();
    expect(result!.cardNumber).toBe(8506707);
    expect(result!.cardType).toBe("SIAC");
  });

  it("parses SI5 detection with series byte", () => {
    // Card number 12345 with series 2 → 212345
    const data = new Uint8Array([0x30, 0x39, 0x02]); // 12345 = 0x3039
    const result = parseCardDetection(CMD.SI5_DETECTED, data);
    expect(result).not.toBeNull();
    expect(result!.cardNumber).toBe(212345);
    expect(result!.cardType).toBe("SI5");
  });

  it("returns null for unknown command", () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x00]);
    expect(parseCardDetection(0x99, data)).toBeNull();
  });

  it("returns null for too-short data", () => {
    expect(parseCardDetection(CMD.SI8_DETECTED, new Uint8Array([0x00]))).toBeNull();
  });
});

// ─── Punch Time Parsing ────────────────────────────────────

describe("parsePunchTime", () => {
  it("parses AM time (no PM flag)", () => {
    // 60 seconds = 0x003C, PTD byte has bit 0 = 0 (AM)
    // Format: PTD(1) + CN(1) + PTH(1) + PTL(1), parsePunchTime reads at offset 2
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x3c]);
    expect(parsePunchTime(data, 2)).toBe(60);
  });

  it("parses large AM time (10:00:00 = 36000 seconds)", () => {
    // 36000 = 0x8CA0, PTD byte has bit 0 = 0 (AM)
    const data = new Uint8Array([0x00, 0x00, 0x8c, 0xa0]);
    expect(parsePunchTime(data, 2)).toBe(36000);
  });

  it("parses PM time (adds 12 hours)", () => {
    // PM flag is bit 0 of the PTD byte (2 positions before time bytes)
    // PTD = 0x01 (PM), CN = 0x00, Time = 3600 (1:00:00 PM → 46800 seconds)
    const data = new Uint8Array([0x01, 0x00, 0x0e, 0x10]);
    expect(parsePunchTime(data, 2)).toBe(3600 + 43200);
  });

  it("returns null for NO_TIME (0xEEEE)", () => {
    const data = new Uint8Array([0xee, 0xee]);
    expect(parsePunchTime(data, 0)).toBeNull();
  });

  it("returns null when offset is out of bounds", () => {
    const data = new Uint8Array([0x00]);
    expect(parsePunchTime(data, 0)).toBeNull();
  });
});

// ─── Punch Record Parsing ──────────────────────────────────

describe("parsePunchRecord", () => {
  it("parses a 4-byte punch record", () => {
    // PTD=0x00, CN=0x1F (control 31), time 0x00 0x3C = 60 sec
    const data = new Uint8Array([0x00, 0x1f, 0x00, 0x3c]);
    const result = parsePunchRecord(data, 0);
    expect(result).not.toBeNull();
    expect(result!.controlCode).toBe(31);
    expect(result!.time).toBe(60);
  });

  it("handles PTD high bits for station codes > 255", () => {
    // PTD=0x40 (bit 6 set), CN=0x1F → station = (0x40 & 0xC0) << 2 | 0x1F = 0x100 | 0x1F = 287
    const data = new Uint8Array([0x40, 0x1f, 0x00, 0x3c]);
    const result = parsePunchRecord(data, 0);
    expect(result).not.toBeNull();
    expect(result!.controlCode).toBe(287);
  });

  it("returns null for zero control code", () => {
    const data = new Uint8Array([0x00, 0x00, 0x00, 0x3c]);
    expect(parsePunchRecord(data, 0)).toBeNull();
  });

  it("returns null for too-short data", () => {
    expect(parsePunchRecord(new Uint8Array([0x00, 0x1f]), 0)).toBeNull();
  });
});

// ─── SI8 Card Data Parsing ─────────────────────────────────

describe("parseSI8CardData", () => {
  function makeBlock0(options: {
    cardNumber?: number;
    punchCount?: number;
    checkTime?: [number, number]; // [high, low] bytes
    startTime?: [number, number];
    finishTime?: [number, number];
    punches?: Array<{ ptd: number; cn: number; timeH: number; timeL: number }>;
  }): Uint8Array {
    const block = new Uint8Array(128);
    const cn = options.cardNumber ?? 2220164;

    // Series byte at offset 24
    if (cn >= 8000001) block[24] = 0x0f; // SIAC
    else if (cn >= 7000001) block[24] = 0x0f; // SI10/11
    else if (cn >= 2000001) block[24] = 0x02; // SI8
    else if (cn >= 1000000) block[24] = 0x01; // SI9

    // Card number at offset 25-27 (3 bytes, big-endian)
    block[25] = (cn >> 16) & 0xff;
    block[26] = (cn >> 8) & 0xff;
    block[27] = cn & 0xff;

    // Punch count at offset 22
    block[22] = options.punchCount ?? options.punches?.length ?? 0;

    // Check time at offset 10-11
    if (options.checkTime) {
      block[10] = options.checkTime[0];
      block[11] = options.checkTime[1];
    }

    // Start time at offset 14-15
    if (options.startTime) {
      block[14] = options.startTime[0];
      block[15] = options.startTime[1];
    }

    // Finish time at offset 18-19
    if (options.finishTime) {
      block[18] = options.finishTime[0];
      block[19] = options.finishTime[1];
    }

    // Punches start at offset 32
    if (options.punches) {
      for (let i = 0; i < options.punches.length; i++) {
        const p = options.punches[i];
        const off = 32 + i * 4;
        block[off] = p.ptd;
        block[off + 1] = p.cn;
        block[off + 2] = p.timeH;
        block[off + 3] = p.timeL;
      }
    }

    return block;
  }

  it("returns null for empty blocks", () => {
    expect(parseSI8CardData([])).toBeNull();
  });

  it("returns null for too-short block", () => {
    expect(parseSI8CardData([new Uint8Array(64)])).toBeNull();
  });

  it("parses card number from block 0", () => {
    const block = makeBlock0({ cardNumber: 2220164 });
    const result = parseSI8CardData([block]);
    expect(result).not.toBeNull();
    expect(result!.cardNumber).toBe(2220164);
    expect(result!.cardType).toBe("SI8");
  });

  it("parses check/start/finish times", () => {
    const block = makeBlock0({
      // Check at 10:00:00 = 36000 sec = 0x8CA0
      checkTime: [0x8c, 0xa0],
      // Start at 10:30:00 = 37800 sec = 0x93A8
      startTime: [0x93, 0xa8],
      // Finish at 11:15:00 = 40500 sec = 0x9E34
      finishTime: [0x9e, 0x34],
    });
    const result = parseSI8CardData([block]);
    expect(result).not.toBeNull();
    // Just verify they're parsed as non-null numbers
    expect(result!.checkTime).toBeTypeOf("number");
    expect(result!.startTime).toBeTypeOf("number");
    expect(result!.finishTime).toBeTypeOf("number");
  });

  it("parses punch records from block 0", () => {
    const block = makeBlock0({
      punchCount: 3,
      punches: [
        { ptd: 0x00, cn: 31, timeH: 0x00, timeL: 0x3c }, // control 31, 60s
        { ptd: 0x00, cn: 32, timeH: 0x00, timeL: 0x78 }, // control 32, 120s
        { ptd: 0x00, cn: 33, timeH: 0x00, timeL: 0xb4 }, // control 33, 180s
      ],
    });
    const result = parseSI8CardData([block]);
    expect(result).not.toBeNull();
    expect(result!.punches).toHaveLength(3);
    expect(result!.punches[0].controlCode).toBe(31);
    expect(result!.punches[0].time).toBe(60);
    expect(result!.punches[1].controlCode).toBe(32);
    expect(result!.punches[1].time).toBe(120);
    expect(result!.punches[2].controlCode).toBe(33);
    expect(result!.punches[2].time).toBe(180);
  });

  it("parses punches across two blocks", () => {
    // 30 punches fills block 0 (24 punch slots) and overflows to block 1
    const punches = Array.from({ length: 30 }, (_, i) => ({
      ptd: 0x00,
      cn: 31 + i,
      timeH: 0x00,
      timeL: 60 + i,
    }));

    const block0 = makeBlock0({ punchCount: 30, punches: punches.slice(0, 24) });
    const block1 = new Uint8Array(128);
    // Block 1 punches start at offset 0
    for (let i = 0; i < 6; i++) {
      const p = punches[24 + i];
      block1[i * 4] = p.ptd;
      block1[i * 4 + 1] = p.cn;
      block1[i * 4 + 2] = p.timeH;
      block1[i * 4 + 3] = p.timeL;
    }

    const result = parseSI8CardData([block0, block1]);
    expect(result).not.toBeNull();
    expect(result!.punches).toHaveLength(30);
    expect(result!.punches[0].controlCode).toBe(31);
    expect(result!.punches[29].controlCode).toBe(60);
  });

  it("handles NO_TIME (0xEEEE) for missing finish", () => {
    const block = makeBlock0({
      finishTime: [0xee, 0xee],
    });
    const result = parseSI8CardData([block]);
    expect(result).not.toBeNull();
    expect(result!.finishTime).toBeNull();
  });
});

// ─── Transmit Record Parsing ───────────────────────────────

describe("parseTransmitRecord", () => {
  it("parses a transmit record", () => {
    // Station 42 (0x002A), card 2220164 (0x21E084), time bytes
    const data = new Uint8Array([
      0x00, 0x2a, // station/control
      0x21, 0xe0, 0x84, // card number
      0x00, // TD byte
      0x00, 0x3c, // time = 60s
    ]);
    const result = parseTransmitRecord(data);
    expect(result).not.toBeNull();
    expect(result!.cardNumber).toBe(2220164);
    expect(result!.controlCode).toBe(42);
    expect(result!.time).toBe(60);
  });

  it("returns null for too-short data", () => {
    expect(parseTransmitRecord(new Uint8Array([0x00, 0x2a]))).toBeNull();
  });
});

// ─── Helper function tests ─────────────────────────────────

describe("isDetectionCommand", () => {
  it("returns true for detection commands", () => {
    expect(isDetectionCommand(CMD.SI5_DETECTED)).toBe(true);
    expect(isDetectionCommand(CMD.SI6_DETECTED)).toBe(true);
    expect(isDetectionCommand(CMD.SI8_DETECTED)).toBe(true);
  });

  it("returns false for non-detection commands", () => {
    expect(isDetectionCommand(CMD.CARD_REMOVED)).toBe(false);
    expect(isDetectionCommand(CMD.SI8_READ)).toBe(false);
    expect(isDetectionCommand(CMD.TRANSMIT_RECORD)).toBe(false);
  });
});

describe("isReadoutResponse", () => {
  it("returns true for readout commands", () => {
    expect(isReadoutResponse(CMD.SI5_READ)).toBe(true);
    expect(isReadoutResponse(CMD.SI6_READ)).toBe(true);
    expect(isReadoutResponse(CMD.SI8_READ)).toBe(true);
  });

  it("returns false for non-readout commands", () => {
    expect(isReadoutResponse(CMD.SI8_DETECTED)).toBe(false);
    expect(isReadoutResponse(CMD.CARD_REMOVED)).toBe(false);
  });
});

describe("isLargeCardType", () => {
  it("returns true for SI10/SI11/SIAC", () => {
    expect(isLargeCardType("SI10")).toBe(true);
    expect(isLargeCardType("SI11")).toBe(true);
    expect(isLargeCardType("SIAC")).toBe(true);
  });

  it("returns false for SI8/SI9/pCard/tCard", () => {
    expect(isLargeCardType("SI8")).toBe(false);
    expect(isLargeCardType("SI9")).toBe(false);
    expect(isLargeCardType("pCard")).toBe(false);
    expect(isLargeCardType("tCard")).toBe(false);
  });
});

// ─── CP850 decoding ─────────────────────────────────────────

describe("decodeCp850", () => {
  it("decodes pure ASCII text", () => {
    const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"
    expect(decodeCp850(data)).toBe("Hello");
  });

  it("decodes Swedish characters (å ä ö)", () => {
    // CP850: å=0x86, ä=0x84, ö=0x94
    const data = new Uint8Array([0x86, 0x84, 0x94]);
    expect(decodeCp850(data)).toBe("åäö");
  });

  it("decodes uppercase Swedish (Å Ä Ö)", () => {
    // CP850: Å=0x8F, Ä=0x8E, Ö=0x99
    const data = new Uint8Array([0x8f, 0x8e, 0x99]);
    expect(decodeCp850(data)).toBe("ÅÄÖ");
  });

  it("decodes Norwegian/Danish (æ ø Æ Ø)", () => {
    // CP850: æ=0x91, ø=0x9B, Æ=0x92, Ø=0x9D
    const data = new Uint8Array([0x91, 0x9b, 0x92, 0x9d]);
    expect(decodeCp850(data)).toBe("æøÆØ");
  });

  it("stops at 0xEE sentinel", () => {
    const data = new Uint8Array([0x48, 0x69, 0xee, 0x41, 0x42]);
    expect(decodeCp850(data)).toBe("Hi");
  });

  it("stops at null byte", () => {
    const data = new Uint8Array([0x48, 0x69, 0x00, 0x41, 0x42]);
    expect(decodeCp850(data)).toBe("Hi");
  });

  it("supports start offset", () => {
    const data = new Uint8Array([0x00, 0x00, 0x48, 0x69]);
    expect(decodeCp850(data, 2)).toBe("Hi");
  });

  it("returns empty string for empty data", () => {
    expect(decodeCp850(new Uint8Array(0))).toBe("");
  });
});

// ─── SI10/SIAC personal data parsing ────────────────────────

describe("parseSI10PersonalData", () => {
  /** Build blocks with personal data starting at block0[32] */
  function makePersonalBlocks(text: string): Uint8Array[] {
    const block0 = new Uint8Array(128);
    block0.fill(0xee);

    // Encode text as ASCII (good enough for test data)
    const bytes = Array.from(text).map((c) => c.charCodeAt(0));

    // Write to block0 starting at offset 32
    const block0Limit = Math.min(bytes.length, 96); // 128 - 32
    for (let i = 0; i < block0Limit; i++) {
      block0[32 + i] = bytes[i];
    }

    // Overflow into blocks 1-3
    const blocks = [block0];
    let remaining = bytes.slice(96);
    for (let b = 1; b <= 3 && remaining.length > 0; b++) {
      const block = new Uint8Array(128);
      block.fill(0xee);
      const limit = Math.min(remaining.length, 128);
      for (let i = 0; i < limit; i++) {
        block[i] = remaining[i];
      }
      blocks.push(block);
      remaining = remaining.slice(128);
    }

    return blocks;
  }

  it("returns null for empty blocks", () => {
    expect(parseSI10PersonalData([])).toBeNull();
  });

  it("returns null when no personal data (all 0xEE)", () => {
    const block = new Uint8Array(128);
    block.fill(0xee);
    expect(parseSI10PersonalData([block])).toBeNull();
  });

  it("parses all fields from semicolon-separated data", () => {
    const text = "Marcus;Andersson;M;19850315;Skogsluffarna;marcus@test.se;+46701234567;Stockholm;Storgatan 1;11122;SWE";
    const blocks = makePersonalBlocks(text);
    const result = parseSI10PersonalData(blocks);

    expect(result).not.toBeNull();
    expect(result!.firstName).toBe("Marcus");
    expect(result!.lastName).toBe("Andersson");
    expect(result!.sex).toBe("M");
    expect(result!.dateOfBirth).toBe("19850315");
    expect(result!.club).toBe("Skogsluffarna");
    expect(result!.email).toBe("marcus@test.se");
    expect(result!.phone).toBe("+46701234567");
    expect(result!.city).toBe("Stockholm");
    expect(result!.street).toBe("Storgatan 1");
    expect(result!.postcode).toBe("11122");
    expect(result!.country).toBe("SWE");
  });

  it("handles partial fields (only name and club)", () => {
    const text = "Anna;Svensson;;; IF Skansen";
    const blocks = makePersonalBlocks(text);
    const result = parseSI10PersonalData(blocks);

    expect(result).not.toBeNull();
    expect(result!.firstName).toBe("Anna");
    expect(result!.lastName).toBe("Svensson");
    expect(result!.sex).toBeUndefined();
    expect(result!.dateOfBirth).toBeUndefined();
    expect(result!.club).toBe("IF Skansen");
  });

  it("handles just first name", () => {
    const blocks = makePersonalBlocks("Per");
    const result = parseSI10PersonalData(blocks);
    expect(result).not.toBeNull();
    expect(result!.firstName).toBe("Per");
    expect(result!.lastName).toBeUndefined();
  });
});

// ─── SI10/SIAC card data parsing ────────────────────────────

describe("parseSI10CardData", () => {
  /** Build SI10 blocks: block0=header+personal, blocks1-3=personal, blocks4+=punches */
  function makeSI10Blocks(options: {
    cardNumber?: number;
    punchCount?: number;
    checkTime?: [number, number];
    startTime?: [number, number];
    finishTime?: [number, number];
    personalText?: string;
    punches?: Array<{ ptd: number; cn: number; timeH: number; timeL: number }>;
  }): Uint8Array[] {
    const cn = options.cardNumber ?? 8007045;
    const punches = options.punches ?? [];
    const personalText = options.personalText ?? "";

    // Block 0: header + personal data start
    const block0 = new Uint8Array(128);
    block0.fill(0xee);

    // Header area (clear 0-31)
    for (let i = 0; i < 32; i++) block0[i] = 0;

    if (cn >= 8000001) block0[24] = 0x0f;
    else if (cn >= 7000001) block0[24] = 0x0f;
    block0[25] = (cn >> 16) & 0xff;
    block0[26] = (cn >> 8) & 0xff;
    block0[27] = cn & 0xff;
    block0[22] = options.punchCount ?? punches.length;

    if (options.checkTime) {
      block0[10] = options.checkTime[0];
      block0[11] = options.checkTime[1];
    }
    if (options.startTime) {
      block0[14] = options.startTime[0];
      block0[15] = options.startTime[1];
    }
    if (options.finishTime) {
      block0[18] = options.finishTime[0];
      block0[19] = options.finishTime[1];
    }

    // Personal data at offset 32
    const personalBytes = Array.from(personalText).map((c) => c.charCodeAt(0));
    for (let i = 0; i < Math.min(personalBytes.length, 96); i++) {
      block0[32 + i] = personalBytes[i];
    }

    // Blocks 1-3: personal data overflow + metadata
    const blocks: Uint8Array[] = [block0];
    const personalOverflow = personalBytes.slice(96);
    for (let b = 1; b <= 3; b++) {
      const block = new Uint8Array(128);
      block.fill(0xee);
      const start = (b - 1) * 128;
      for (let i = 0; i < 128 && start + i < personalOverflow.length; i++) {
        block[i] = personalOverflow[start + i];
      }
      blocks.push(block);
    }

    // Blocks 4-7: punches (32 per block)
    for (let pb = 0; pb < 4; pb++) {
      const block = new Uint8Array(128);
      block.fill(0xee);
      const punchStart = pb * 32;
      for (let i = 0; i < 32 && punchStart + i < punches.length; i++) {
        const p = punches[punchStart + i];
        const off = i * 4;
        block[off] = p.ptd;
        block[off + 1] = p.cn;
        block[off + 2] = p.timeH;
        block[off + 3] = p.timeL;
      }
      blocks.push(block);
    }

    return blocks;
  }

  it("returns null for empty blocks", () => {
    expect(parseSI10CardData([])).toBeNull();
  });

  it("parses SIAC card number", () => {
    const blocks = makeSI10Blocks({ cardNumber: 8007045 });
    const result = parseSI10CardData(blocks);
    expect(result).not.toBeNull();
    expect(result!.cardNumber).toBe(8007045);
    expect(result!.cardType).toBe("SIAC");
  });

  it("parses SI10 card number", () => {
    const blocks = makeSI10Blocks({ cardNumber: 7123456 });
    const result = parseSI10CardData(blocks);
    expect(result).not.toBeNull();
    expect(result!.cardNumber).toBe(7123456);
    expect(result!.cardType).toBe("SI10");
  });

  it("parses times from header", () => {
    const blocks = makeSI10Blocks({
      checkTime: [0x8c, 0xa0],   // 36000s = 10:00:00
      startTime: [0x93, 0xa8],   // 37800s = 10:30:00
      finishTime: [0xa8, 0xc0],  // 43200s = 12:00:00
    });
    const result = parseSI10CardData(blocks)!;
    expect(result.checkTime).toBe(36000);
    expect(result.startTime).toBe(37800);
    expect(result.finishTime).toBe(43200);
  });

  it("parses personal data from blocks 0-3", () => {
    const blocks = makeSI10Blocks({
      personalText: "Anna;Johansson;F;19900101;Skogsluffarna",
    });
    const result = parseSI10CardData(blocks)!;
    expect(result.ownerData).not.toBeNull();
    expect(result.ownerData!.firstName).toBe("Anna");
    expect(result.ownerData!.lastName).toBe("Johansson");
    expect(result.ownerData!.sex).toBe("F");
    expect(result.ownerData!.club).toBe("Skogsluffarna");
  });

  it("parses punches from blocks 4+ (not block 0)", () => {
    const blocks = makeSI10Blocks({
      punches: [
        { ptd: 0, cn: 31, timeH: 0x8e, timeL: 0x28 }, // 36392s
        { ptd: 0, cn: 32, timeH: 0x8e, timeL: 0x64 }, // 36452s
        { ptd: 0, cn: 33, timeH: 0x8e, timeL: 0xa0 }, // 36512s
      ],
    });
    const result = parseSI10CardData(blocks)!;
    expect(result.punchCount).toBe(3);
    expect(result.punches).toHaveLength(3);
    expect(result.punches[0].controlCode).toBe(31);
    expect(result.punches[1].controlCode).toBe(32);
    expect(result.punches[2].controlCode).toBe(33);
  });

  it("does not parse personal data area as punches", () => {
    // The personal data "Marcus;Andersson" would be misread as punches
    // if using SI8 parser. Verify SI10 parser correctly ignores block 0[32+]
    const blocks = makeSI10Blocks({
      personalText: "Marcus;Andersson;M;19850315;Skogsluffarna",
      punches: [
        { ptd: 0, cn: 31, timeH: 0x8e, timeL: 0x28 },
      ],
    });
    const result = parseSI10CardData(blocks)!;
    expect(result.punches).toHaveLength(1);
    expect(result.punches[0].controlCode).toBe(31);
    expect(result.ownerData!.firstName).toBe("Marcus");
  });

  it("returns null ownerData when no personal data stored", () => {
    const blocks = makeSI10Blocks({
      punches: [{ ptd: 0, cn: 31, timeH: 0x8e, timeL: 0x28 }],
    });
    const result = parseSI10CardData(blocks)!;
    expect(result.ownerData).toBeNull();
  });
});

// ─── parseDayOfWeek ─────────────────────────────────────────

describe("parseDayOfWeek", () => {
  it("extracts day-of-week from PTD byte bits 1-3", () => {
    // DOW 1 (Mon) = 0b0000_0010 (bit 1 set)
    expect(parseDayOfWeek(0x02)).toBe(1);
    // DOW 5 (Fri) = 0b0000_1010
    expect(parseDayOfWeek(0x0a)).toBe(5);
    // DOW 7 (Sun) = 0b0000_1110
    expect(parseDayOfWeek(0x0e)).toBe(7);
  });

  it("handles PM flag (bit 0) without affecting DOW", () => {
    // DOW 3 (Wed) + PM = 0b0000_0111
    expect(parseDayOfWeek(0x07)).toBe(3);
    // DOW 6 (Sat) + PM = 0b0000_1101
    expect(parseDayOfWeek(0x0d)).toBe(6);
  });

  it("ignores high bits (used for station code in punch records)", () => {
    // DOW 2 (Tue) = 0b0000_0100, with high bits set: 0b1100_0100
    expect(parseDayOfWeek(0xc4)).toBe(2);
  });

  it("returns null for zero DOW", () => {
    expect(parseDayOfWeek(0x00)).toBeNull();
    expect(parseDayOfWeek(0x01)).toBeNull(); // only PM set, DOW=0
  });
});

// ─── SI8 Day-of-Week extraction ─────────────────────────────

describe("parseSI8CardData DOW extraction", () => {
  // Reuse makeBlock0 from the parseSI8CardData describe block above
  function makeDowBlock(options: {
    finishDow?: number; // 1-7
    finishPm?: boolean;
    checkDow?: number;
    checkPm?: boolean;
  }): Uint8Array {
    const block = new Uint8Array(128);
    // Card number 2220164 (SI8)
    block[24] = 0x02;
    block[25] = (2220164 >> 16) & 0xff;
    block[26] = (2220164 >> 8) & 0xff;
    block[27] = 2220164 & 0xff;
    block[22] = 0; // no punches

    if (options.checkDow != null) {
      // Check PTD at offset 8: DOW in bits 1-3, PM in bit 0
      block[8] = ((options.checkDow & 0x07) << 1) | (options.checkPm ? 1 : 0);
      // Check time at offset 10-11: 10:00:00 = 36000s = 0x8CA0
      block[10] = 0x8c;
      block[11] = 0xa0;
    }

    if (options.finishDow != null) {
      // Finish PTD at offset 16: DOW in bits 1-3, PM in bit 0
      block[16] = ((options.finishDow & 0x07) << 1) | (options.finishPm ? 1 : 0);
      // Finish time at offset 18-19: 10:30:00 = 37800s = 0x93A8
      block[18] = 0x93;
      block[19] = 0xa8;
    }

    return block;
  }

  it("extracts finishDayOfWeek from PTD byte", () => {
    const block = makeDowBlock({ finishDow: 5 }); // Friday
    const result = parseSI8CardData([block])!;
    expect(result.finishDayOfWeek).toBe(5);
  });

  it("extracts checkDayOfWeek from PTD byte", () => {
    const block = makeDowBlock({ checkDow: 3 }); // Wednesday
    const result = parseSI8CardData([block])!;
    expect(result.checkDayOfWeek).toBe(3);
  });

  it("returns null DOW when no finish time", () => {
    const block = makeDowBlock({}); // no finish, no check
    const result = parseSI8CardData([block])!;
    expect(result.finishDayOfWeek).toBeNull();
    expect(result.checkDayOfWeek).toBeNull();
  });

  it("handles PM flag alongside DOW", () => {
    const block = makeDowBlock({ finishDow: 6, finishPm: true }); // Saturday PM
    const result = parseSI8CardData([block])!;
    expect(result.finishDayOfWeek).toBe(6);
    // Finish time should be PM-adjusted (37800 + 43200 = 81000)
    expect(result.finishTime).toBe(81000);
  });
});
