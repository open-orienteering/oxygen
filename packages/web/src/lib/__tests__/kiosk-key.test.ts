import { describe, it, expect } from "vitest";
import { kioskKeyFromUrl, tileQueryString } from "../kiosk-key";

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

describe("tileQueryString", () => {
  // `<img>` tile requests cannot send the x-kiosk-key header, so the key
  // must ride in the query string for key-only kiosk devices.
  it("combines version and kiosk key", () => {
    expect(tileQueryString(undefined, null)).toBe("");
    expect(tileQueryString(42, null)).toBe("?v=42");
    expect(tileQueryString(undefined, "secret")).toBe("?k=secret");
    expect(tileQueryString(42, "s+cret")).toBe("?v=42&k=s%2Bcret");
  });
});
