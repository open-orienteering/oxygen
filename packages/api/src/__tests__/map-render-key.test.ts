import { describe, expect, it } from "vitest";
import { computeRenderKey, hashMapFileData } from "../map-render-key.js";

describe("computeRenderKey", () => {
  const base = {
    fileHash: "abc123",
    rotationCorrection: 0,
    colorProfile: "auto" as const,
    northLinesBelow: true,
  };

  it("is stable for identical inputs", () => {
    expect(computeRenderKey(base)).toBe(computeRenderKey({ ...base }));
  });

  it("changes when the profile changes", () => {
    expect(computeRenderKey(base)).not.toBe(
      computeRenderKey({ ...base, colorProfile: "issprom" }),
    );
  });

  it("changes when northLinesBelow flips", () => {
    expect(computeRenderKey(base)).not.toBe(
      computeRenderKey({ ...base, northLinesBelow: false }),
    );
  });

  it("changes when rotation correction changes", () => {
    expect(computeRenderKey(base)).not.toBe(
      computeRenderKey({ ...base, rotationCorrection: 1.5 }),
    );
  });

  it("normalises override array order", () => {
    const a = computeRenderKey({
      ...base,
      colorOverrides: { above: [3, 1], below: [2] },
    });
    const b = computeRenderKey({
      ...base,
      colorOverrides: { above: [1, 3], below: [2] },
    });
    expect(a).toBe(b);
  });

  it("returns a 32-char hex string", () => {
    expect(computeRenderKey(base)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("hashMapFileData", () => {
  it("hashes bytes deterministically", () => {
    const buf = Buffer.from("hello ocad");
    expect(hashMapFileData(buf)).toBe(hashMapFileData(buf));
    expect(hashMapFileData(buf)).toHaveLength(64);
    expect(hashMapFileData(buf)).not.toBe(hashMapFileData(Buffer.from("other")));
  });
});
