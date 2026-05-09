import { describe, it, expect } from "vitest";
import {
  buildReadMemorySwitch,
  parseMemorySwitchResponse,
  buildWriteMemorySwitch,
  buildWriteMemorySwitchBit,
  buildFlashUsbMode,
  parseUsbModeFromSwitch5,
  buildSelfTest,
  buildEnterUserMode,
  buildExitUserMode,
  CITIZEN_USB_MODE_SWITCH,
  CITIZEN_USB_MODE_BIT,
} from "../receipt-printer/escpos-config.js";

const hex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join(" ");

describe("buildReadMemorySwitch", () => {
  it("emits GS ( E pL=2 pH=0 fn=4 a=N", () => {
    expect(hex(buildReadMemorySwitch(5))).toBe("1d 28 45 02 00 04 05");
  });

  it("supports switch numbers 1 through 10", () => {
    for (let n = 1; n <= 10; n++) {
      const bytes = buildReadMemorySwitch(n);
      expect(bytes[6]).toBe(n);
    }
  });

  it("rejects out-of-range switch numbers", () => {
    expect(() => buildReadMemorySwitch(0)).toThrow();
    expect(() => buildReadMemorySwitch(11)).toThrow();
    expect(() => buildReadMemorySwitch(1.5)).toThrow();
  });
});

describe("parseMemorySwitchResponse", () => {
  it("decodes the 11-byte response into an MSB-first bit string", () => {
    // Header 0x37, identifier 0x21, eight bits, terminator 0x00.
    // Bit pattern: bit8..bit1 = 0 0 0 0 0 1 0 0 (matches our slip's SW5 = 00000100)
    const response = new Uint8Array([
      0x37, 0x21,
      0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x30, 0x30,
      0x00,
    ]);
    expect(parseMemorySwitchResponse(response)).toBe("00000100");
  });

  it("throws on too-short responses", () => {
    expect(() => parseMemorySwitchResponse(new Uint8Array([0x37, 0x21]))).toThrow(/too short/);
  });

  it("throws when header is absent", () => {
    const bad = new Uint8Array(11);
    bad[0] = 0xff;
    expect(() => parseMemorySwitchResponse(bad)).toThrow(/no 0x37 0x21 header/);
  });

  it("throws on non-binary bit values", () => {
    const bad = new Uint8Array([
      0x37, 0x21,
      0x30, 0x30, 0x30, 0x30, 0x30, 0x32, 0x30, 0x30,
      0x00,
    ]);
    expect(() => parseMemorySwitchResponse(bad)).toThrow(/bit value/);
  });

  it("throws on bad terminator", () => {
    const bad = new Uint8Array([
      0x37, 0x21,
      0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30, 0x30,
      0x01,
    ]);
    expect(() => parseMemorySwitchResponse(bad)).toThrow(/terminator/);
  });

  it("ignores trailing bytes beyond the documented 11", () => {
    const padded = new Uint8Array([
      0x37, 0x21,
      0x31, 0x30, 0x31, 0x30, 0x31, 0x30, 0x31, 0x30,
      0x00,
      0xaa, 0xbb,
    ]);
    expect(parseMemorySwitchResponse(padded)).toBe("10101010");
  });

  it("tolerates leading garbage by finding the header anywhere in the buffer", () => {
    // E.g. leftover bytes from a previous interrupted read.
    const padded = new Uint8Array([
      0x31, 0x60, 0x99, // junk
      0x37, 0x21,
      0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x30, 0x30,
      0x00,
    ]);
    expect(parseMemorySwitchResponse(padded)).toBe("00000100");
  });

  it("includes a hex dump in error messages for diagnosability", () => {
    const bad = new Uint8Array([0x31, 0x60, 0xff, 0x00, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56, 0x78]);
    expect(() => parseMemorySwitchResponse(bad)).toThrow(/31 60 ff/);
  });
});

describe("buildWriteMemorySwitch", () => {
  it("emits GS ( E pL=10 fn=3 a=N followed by 8 ASCII bit chars", () => {
    const bytes = buildWriteMemorySwitch(5, "22220222");
    expect(hex(bytes)).toBe("1d 28 45 0a 00 03 05 32 32 32 32 30 32 32 32");
  });

  it("preserves bit order MSB-first (bit 8 at index 0, bit 1 at index 7)", () => {
    const bytes = buildWriteMemorySwitch(1, "10101010");
    expect(bytes.slice(7)).toEqual(
      new Uint8Array([0x31, 0x30, 0x31, 0x30, 0x31, 0x30, 0x31, 0x30]),
    );
  });

  it("rejects bit strings of wrong length", () => {
    expect(() => buildWriteMemorySwitch(1, "0000000")).toThrow();
    expect(() => buildWriteMemorySwitch(1, "000000000")).toThrow();
  });

  it("rejects invalid bit characters", () => {
    expect(() => buildWriteMemorySwitch(1, "0000x000")).toThrow();
    expect(() => buildWriteMemorySwitch(1, "        ")).toThrow();
    // '.' is no longer accepted — Citizen/Epson use '2' for "no change".
    expect(() => buildWriteMemorySwitch(1, "....0...")).toThrow();
  });

  it("rejects out-of-range switch numbers", () => {
    expect(() => buildWriteMemorySwitch(0, "22222222")).toThrow();
    expect(() => buildWriteMemorySwitch(11, "22222222")).toThrow();
  });
});

describe("buildWriteMemorySwitchBit", () => {
  it("places the value at MSB-first index (8 - bitNumber), other bits = '2' (no change)", () => {
    // bit 3 → index 5 (= 8 - 3)
    const bytes = buildWriteMemorySwitchBit(5, 3, "0");
    // Bytes 7..14 are the bit chars. Index 7+5 = 12 should be '0' (0x30);
    // others should be '2' (0x32, "no change").
    for (let i = 7; i < 15; i++) {
      const expected = i === 12 ? 0x30 : 0x32;
      expect(bytes[i]).toBe(expected);
    }
  });

  it("works for bit 1 (rightmost / index 7)", () => {
    const bytes = buildWriteMemorySwitchBit(5, 1, "1");
    expect(bytes[14]).toBe(0x31);
    for (let i = 7; i < 14; i++) expect(bytes[i]).toBe(0x32);
  });

  it("works for bit 8 (leftmost / index 0)", () => {
    const bytes = buildWriteMemorySwitchBit(5, 8, "1");
    expect(bytes[7]).toBe(0x31);
    for (let i = 8; i < 15; i++) expect(bytes[i]).toBe(0x32);
  });

  it("rejects out-of-range bit numbers", () => {
    expect(() => buildWriteMemorySwitchBit(5, 0, "0")).toThrow();
    expect(() => buildWriteMemorySwitchBit(5, 9, "0")).toThrow();
    expect(() => buildWriteMemorySwitchBit(5, 1.5, "0")).toThrow();
  });
});

describe("buildFlashUsbMode (CT-S310II MSW5-3)", () => {
  it("targets MSW5-3 with value '0' for virtual-com (matches Citizen utility USB capture)", () => {
    const bytes = buildFlashUsbMode("virtual-com");
    // GS ( E pL pH fn=03 a=05 then bits "22222022" — '2' = "no change"
    expect(hex(bytes)).toBe("1d 28 45 0a 00 03 05 32 32 32 32 32 30 32 32");
  });

  it("targets MSW5-3 with value '1' for printer-class", () => {
    const bytes = buildFlashUsbMode("printer-class");
    expect(hex(bytes)).toBe("1d 28 45 0a 00 03 05 32 32 32 32 32 31 32 32");
  });

  it("uses the documented switch and bit numbers", () => {
    expect(CITIZEN_USB_MODE_SWITCH).toBe(5);
    expect(CITIZEN_USB_MODE_BIT).toBe(3);
  });
});

describe("parseUsbModeFromSwitch5", () => {
  it("returns printer-class when MSW5-3 is ON (matches our slip 00000100)", () => {
    expect(parseUsbModeFromSwitch5("00000100")).toBe("printer-class");
  });

  it("returns virtual-com when MSW5-3 is OFF", () => {
    expect(parseUsbModeFromSwitch5("00000000")).toBe("virtual-com");
  });

  it("ignores other bits in the switch", () => {
    expect(parseUsbModeFromSwitch5("11111011")).toBe("virtual-com");
    expect(parseUsbModeFromSwitch5("11111111")).toBe("printer-class");
  });

  it("throws on wrong-length input", () => {
    expect(() => parseUsbModeFromSwitch5("0000000")).toThrow();
    expect(() => parseUsbModeFromSwitch5("000000000")).toThrow();
  });
});

describe("buildSelfTest", () => {
  it("emits GS ( A 02 00 00 02", () => {
    expect(hex(buildSelfTest())).toBe("1d 28 41 02 00 00 02");
  });
});

describe("buildEnterUserMode", () => {
  it("emits GS ( E pL=3 fn=1 'I' 'N'", () => {
    expect(hex(buildEnterUserMode())).toBe("1d 28 45 03 00 01 49 4e");
  });
});

describe("buildExitUserMode", () => {
  it("emits GS ( E pL=4 fn=2 'O' 'U' 'T'", () => {
    expect(hex(buildExitUserMode())).toBe("1d 28 45 04 00 02 4f 55 54");
  });
});
