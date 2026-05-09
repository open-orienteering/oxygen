import { describe, it, expect, beforeEach } from "vitest";
import {
  printerKey,
  readHistory,
  getRecord,
  recordFlash,
  clearRecord,
  pendingRestores,
  type FlashHistoryStorage,
} from "../printer-flash-history.js";

class MemoryStorage implements FlashHistoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  set(raw: string) {
    this.store.set("oxygen.printer-flash-history.v1", raw);
  }
}

let storage: MemoryStorage;
const NOW = new Date("2026-04-30T12:00:00Z");

beforeEach(() => {
  storage = new MemoryStorage();
});

describe("printerKey", () => {
  it("formats vendorId as 4-digit hex", () => {
    expect(printerKey(0x1d90, "ABC123")).toBe("1d90:ABC123");
  });

  it("uses empty string for null serial", () => {
    expect(printerKey(0x1d90, null)).toBe("1d90:");
  });
});

describe("readHistory", () => {
  it("returns empty object when storage is empty", () => {
    expect(readHistory(storage)).toEqual({});
  });

  it("returns empty object when storage contains garbage", () => {
    storage.set("not json");
    expect(readHistory(storage)).toEqual({});
  });

  it("ignores entries with invalid shape", () => {
    storage.set(
      JSON.stringify({
        "1d90:abc": { vendorId: 0x1d90 }, // incomplete
        "1d90:def": {
          vendorId: 0x1d90,
          serial: "def",
          productName: null,
          originalMode: "printer-class",
          currentMode: "virtual-com",
          flashedAt: "2026-01-01T00:00:00Z",
        },
      }),
    );
    const history = readHistory(storage);
    expect(Object.keys(history)).toEqual(["1d90:def"]);
  });
});

describe("recordFlash", () => {
  it("creates a new record with originalMode = fromMode", () => {
    const record = recordFlash(
      {
        vendorId: 0x1d90,
        serial: "00000000",
        productName: "Thermal Printer",
        fromMode: "printer-class",
        toMode: "virtual-com",
        now: NOW,
      },
      storage,
    );
    expect(record).toEqual({
      vendorId: 0x1d90,
      serial: "00000000",
      productName: "Thermal Printer",
      originalMode: "printer-class",
      currentMode: "virtual-com",
      flashedAt: NOW.toISOString(),
    });
    expect(getRecord(0x1d90, "00000000", storage)).toEqual(record);
  });

  it("preserves originalMode across subsequent flashes", () => {
    recordFlash(
      {
        vendorId: 0x1d90,
        serial: "abc",
        productName: null,
        fromMode: "printer-class",
        toMode: "virtual-com",
        now: NOW,
      },
      storage,
    );
    // A second flash from virtual-com to ... something else (hypothetical)
    // should keep the original printer-class as the restore target. We
    // simulate this by re-flashing to a non-original mode.
    const r2 = recordFlash(
      {
        vendorId: 0x1d90,
        serial: "abc",
        productName: null,
        fromMode: "virtual-com",
        toMode: "virtual-com", // re-flash, same mode
        now: NOW,
      },
      storage,
    );
    expect(r2.originalMode).toBe("printer-class");
  });

  it("removes the record when flashing back to the original mode (round trip)", () => {
    recordFlash(
      {
        vendorId: 0x1d90,
        serial: "abc",
        productName: null,
        fromMode: "printer-class",
        toMode: "virtual-com",
        now: NOW,
      },
      storage,
    );
    expect(getRecord(0x1d90, "abc", storage)).not.toBeNull();

    recordFlash(
      {
        vendorId: 0x1d90,
        serial: "abc",
        productName: null,
        fromMode: "virtual-com",
        toMode: "printer-class",
        now: NOW,
      },
      storage,
    );
    expect(getRecord(0x1d90, "abc", storage)).toBeNull();
  });

  it("treats different printers (different serials) independently", () => {
    recordFlash(
      {
        vendorId: 0x1d90, serial: "aaa", productName: null,
        fromMode: "printer-class", toMode: "virtual-com", now: NOW,
      },
      storage,
    );
    recordFlash(
      {
        vendorId: 0x1d90, serial: "bbb", productName: null,
        fromMode: "printer-class", toMode: "virtual-com", now: NOW,
      },
      storage,
    );
    expect(Object.keys(readHistory(storage))).toEqual(["1d90:aaa", "1d90:bbb"]);
  });
});

describe("clearRecord", () => {
  it("removes a record without affecting others", () => {
    recordFlash(
      { vendorId: 0x1d90, serial: "a", productName: null,
        fromMode: "printer-class", toMode: "virtual-com", now: NOW },
      storage,
    );
    recordFlash(
      { vendorId: 0x1d90, serial: "b", productName: null,
        fromMode: "printer-class", toMode: "virtual-com", now: NOW },
      storage,
    );
    clearRecord(0x1d90, "a", storage);
    expect(getRecord(0x1d90, "a", storage)).toBeNull();
    expect(getRecord(0x1d90, "b", storage)).not.toBeNull();
  });

  it("is a no-op when the record doesn't exist", () => {
    expect(() => clearRecord(0x1d90, "nope", storage)).not.toThrow();
  });
});

describe("pendingRestores", () => {
  it("returns only records where currentMode != originalMode", () => {
    // a: needs restore
    recordFlash(
      { vendorId: 0x1d90, serial: "a", productName: null,
        fromMode: "printer-class", toMode: "virtual-com", now: NOW },
      storage,
    );
    // b: also needs restore
    recordFlash(
      { vendorId: 0x1d90, serial: "b", productName: null,
        fromMode: "virtual-com", toMode: "printer-class", now: NOW },
      storage,
    );
    expect(pendingRestores(storage)).toHaveLength(2);

    // Round-trip a back — it should drop out of the list.
    recordFlash(
      { vendorId: 0x1d90, serial: "a", productName: null,
        fromMode: "virtual-com", toMode: "printer-class", now: NOW },
      storage,
    );
    expect(pendingRestores(storage).map((r) => r.serial)).toEqual(["b"]);
  });
});
