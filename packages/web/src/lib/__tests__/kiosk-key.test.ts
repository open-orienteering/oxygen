import { describe, it, expect } from "vitest";
import { kioskKeyFromUrl } from "../kiosk-key";

describe("kioskKeyFromUrl", () => {
  it("reads ?k= from a search string", () => {
    expect(kioskKeyFromUrl("?k=abc123")).toBe("abc123");
    expect(kioskKeyFromUrl("?class=5&k=abc%2B1")).toBe("abc+1");
  });

  it("returns null when absent or blank", () => {
    expect(kioskKeyFromUrl("")).toBeNull();
    expect(kioskKeyFromUrl("?class=5")).toBeNull();
    expect(kioskKeyFromUrl("?k=")).toBeNull();
    expect(kioskKeyFromUrl("?k=%20")).toBeNull();
  });
});
