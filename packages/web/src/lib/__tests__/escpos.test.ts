import { describe, it, expect } from "vitest";
import { buildFinishReceipt } from "../receipt-printer/escpos.js";
import type { FinishReceiptData } from "../receipt-printer/types.js";

const SAMPLE: FinishReceiptData = {
  competitionName: "Test Cup 2026",
  competitionDate: "2026-03-04",
  runner: {
    name: "Anna Svensson",
    clubName: "IFK Göteborg OK",
    className: "H21",
    startNo: 42,
    cardNo: 8007045,
  },
  timing: {
    startTime: 360000, // 10:00:00
    finishTime: 385550, // 10:42:35
    runningTime: 25550, // 42:35
    status: 1, // OK
  },
  splits: [
    { controlIndex: 0, controlCode: 101, splitTime: 3120, cumTime: 3120, status: "ok", punchTime: 363120, legLength: 850 },
    { controlIndex: 1, controlCode: 102, splitTime: 3502, cumTime: 6622, status: "ok", punchTime: 366622, legLength: 1200 },
    { controlIndex: 2, controlCode: 103, splitTime: 9060, cumTime: 15682, status: "ok", punchTime: 375682, legLength: 650 },
  ],
  course: { name: "Lång", length: 8500 },
  position: { rank: 3, total: 12 },
  siac: { voltage: 2.98, batteryDate: "2024-02-12", batteryOk: true },
  classResults: [
    { rank: 1, name: "Kevin Hedström", clubName: "Skogsluffarnas OK", runningTime: 24000 },
    { rank: 2, name: "Anna Ek", clubName: "IFK Göteborg OK", runningTime: 25200 },
    { rank: 3, name: "Anna Svensson", clubName: "IFK Göteborg OK", runningTime: 25550 },
  ],
};

describe("buildFinishReceipt", () => {
  it("returns a Uint8Array", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(50);
  });

  it("starts with ESC @ (printer init)", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40);
  });

  it("ends with GS V partial cut command", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const tail = bytes.slice(-4);
    expect([...tail]).toEqual([0x1d, 0x56, 0x42, 0x0a]);
  });

  it("does not send a code page selection command (PC437 is default after ESC @)", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const arr = [...bytes];
    // ESC t = [0x1b, 0x74] — should NOT appear
    const found = arr.some((b, i) => b === 0x1b && arr[i + 1] === 0x74);
    expect(found).toBe(false);
  });

  it("encodes Swedish characters as PC437/CP850 bytes", () => {
    const data: FinishReceiptData = {
      ...SAMPLE,
      runner: { ...SAMPLE.runner, name: "Åsa Öberg", clubName: "Säffle OK" },
    };
    const bytes = buildFinishReceipt(data);
    const arr = [...bytes];
    // In PC437/CP850: Å=0x8F, Ö=0x99 (NOT Latin-1 0xC5/0xD6)
    expect(arr.includes(0x8f)).toBe(true); // Å
    expect(arr.includes(0x99)).toBe(true); // Ö
  });

  it("encodes lowercase Swedish characters as PC437/CP850 bytes", () => {
    const data: FinishReceiptData = {
      ...SAMPLE,
      runner: { ...SAMPLE.runner, clubName: "IFK Göteborg OK" },
    };
    const bytes = buildFinishReceipt(data);
    const arr = [...bytes];
    // In PC437/CP850: ö=0x94 (NOT Latin-1 0xF6)
    expect(arr.includes(0x94)).toBe(true); // ö
  });

  it("includes competition name in output", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("Test Cup 2026");
  });

  it("includes runner name in output", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("Anna Svensson");
  });

  it("includes position in output", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("3/12");
  });

  it("includes splits column header when splits are provided", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("Nr.");
    expect(text).toContain("Pace");
  });

  it("omits splits section when no splits", () => {
    const data: FinishReceiptData = { ...SAMPLE, splits: [] };
    const bytes = buildFinishReceipt(data);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).not.toContain("Nr.");
  });

  it("marks missing controls with SAKNAS", () => {
    const data: FinishReceiptData = {
      ...SAMPLE,
      splits: [
        { controlIndex: 0, controlCode: 101, splitTime: 3120, cumTime: 3120, status: "ok" },
        { controlIndex: 1, controlCode: 102, splitTime: 0, cumTime: 0, status: "missing" },
      ],
    };
    const bytes = buildFinishReceipt(data);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("MISSING");
  });

  it("handles missing position gracefully", () => {
    const data: FinishReceiptData = { ...SAMPLE, position: null };
    expect(() => buildFinishReceipt(data)).not.toThrow();
    const bytes = buildFinishReceipt(data);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).not.toContain("Position");
  });

  it("includes clock time column when punchTime is provided", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const text = Buffer.from(bytes).toString("latin1");
    // punchTime 363120 ds = 10:05:12 clock
    expect(text).toContain("10:05:12");
  });

  it("includes pace column when legLength is provided", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const text = Buffer.from(bytes).toString("latin1");
    // 850m in 3120ds: pace = 3120 / (850 * 0.6) = 3120/510 = 6.118 min/km = 6:07
    expect(text).toContain("6:07");
  });

  it("includes SIAC battery section when siac data is provided", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("SIAC");
    expect(text).toContain("2.98V");
    expect(text).toContain("2024-02-12");
    expect(text).toContain("OK");
  });

  it("omits SIAC section when siac is null", () => {
    const data: FinishReceiptData = { ...SAMPLE, siac: null };
    const bytes = buildFinishReceipt(data);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).not.toContain("SIAC");
    expect(text).not.toContain("Battery");
  });

  it("includes class results when provided", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("Position");
    expect(text).toContain("Kevin");
  });

  it("omits class results section when empty", () => {
    const data: FinishReceiptData = { ...SAMPLE, classResults: [] };
    const bytes = buildFinishReceipt(data);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).not.toContain("Kevin");
  });

  it("includes attribution footer", () => {
    const bytes = buildFinishReceipt(SAMPLE);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text).toContain("Lightweight orienteering management");
    expect(text).toContain("open-orienteering.org");
  });

  it("replaces non-Latin-1 characters with '?'", () => {
    const data: FinishReceiptData = {
      ...SAMPLE,
      runner: { ...SAMPLE.runner, name: "Test \u4e2d\u6587 Runner" }, // Chinese characters
    };
    const bytes = buildFinishReceipt(data);
    const arr = [...bytes];
    // Chinese chars (> 0xFF) should become 0x3F ('?')
    expect(arr.includes(0x3f)).toBe(true);
  });

  it("includes raster image command when logoRaster is provided", () => {
    const data: FinishReceiptData = {
      ...SAMPLE,
      logoRaster: { widthBytes: 1, heightDots: 1, data: new Uint8Array([0x80]) },
    };
    const arr = [...buildFinishReceipt(data)];
    // GS v 0 preamble: 0x1D 0x76 0x30 0x00
    expect(arr.some((b, i) => b === 0x1D && arr[i + 1] === 0x76 && arr[i + 2] === 0x30)).toBe(true);
  });

  it("includes QR code command when qrUrl is provided", () => {
    const data: FinishReceiptData = { ...SAMPLE, qrUrl: "https://example.com" };
    const arr = [...buildFinishReceipt(data)];
    // GS ( k preamble: 0x1D 0x28 0x6B
    expect(arr.some((b, i) => b === 0x1D && arr[i + 1] === 0x28 && arr[i + 2] === 0x6B)).toBe(true);
  });

  it("omits QR command when qrUrl is null", () => {
    const data: FinishReceiptData = { ...SAMPLE, qrUrl: null };
    const arr = [...buildFinishReceipt(data)];
    // GS ( k should not appear
    expect(arr.some((b, i) => b === 0x1D && arr[i + 1] === 0x28 && arr[i + 2] === 0x6B)).toBe(false);
  });
});
