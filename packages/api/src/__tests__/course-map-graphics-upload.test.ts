/**
 * J2 upload preparation (docs/course-maps.md "Data model"): pixel size,
 * the 4096 px resample, the 3072/2048 fallbacks under the 8 MiB stored cap,
 * and the thumbnail box.
 */
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  GRAPHIC_MAX_PX,
  MAX_GRAPHIC_STORED_BYTES,
  graphicPixelSize,
  prepareGraphicUpload,
  thumbBox,
} from "../course-maps/graphics.js";

async function png(w: number, h: number, opts: { noise?: boolean } = {}): Promise<Buffer> {
  const raw = opts.noise ? randomBytes(w * h * 4) : Buffer.alloc(w * h * 4, 0x80);
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: opts.noise ? 0 : 9 }).toBuffer();
}

describe("graphicPixelSize", () => {
  it("reads a PNG's IHDR", async () => {
    expect(graphicPixelSize(await png(30, 12), "image/png")).toEqual({ widthPx: 30, heightPx: 12 });
  });

  it("scales an SVG viewBox to 4096 px on its longer side (question 14)", () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20"></svg>`);
    expect(graphicPixelSize(svg, "image/svg+xml")).toEqual({ widthPx: 4096, heightPx: 2731 });
    const tall = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="4"></svg>`);
    expect(graphicPixelSize(tall, "image/svg+xml")).toEqual({ widthPx: 1024, heightPx: 4096 });
  });

  it("answers null for unreadable bytes", () => {
    expect(graphicPixelSize(Buffer.from("nope"), "image/png")).toBeNull();
    expect(graphicPixelSize(Buffer.from("<p/>"), "image/svg+xml")).toBeNull();
    expect(graphicPixelSize(Buffer.from("x"), "image/jpeg")).toBeNull();
  });
});

describe("prepareGraphicUpload", () => {
  it("stores a PNG that fits byte for byte", async () => {
    const input = await png(64, 32);
    const out = await prepareGraphicUpload(input);
    expect(out.data.equals(input)).toBe(true);
    expect(out).toMatchObject({ mime: "image/png", widthPx: 64, heightPx: 32 });
  });

  it("resamples a PNG over 4096 px to 4096 on its longer side, alpha kept", async () => {
    const out = await prepareGraphicUpload(await png(5000, 2500));
    expect([out.widthPx, out.heightPx]).toEqual([GRAPHIC_MAX_PX, 2048]);
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height, meta.hasAlpha]).toEqual([4096, 2048, true]);
  });

  it("falls back to 3072 then 2048 px when 4096 is still over 8 MiB (question 12)", async () => {
    // Noise does not compress, so a PNG is ~4 bytes a pixel: 4096 × 600 ≈ 9.4 MiB is over the cap, 3072 × 450 ≈ 5.3 MiB fits.
    const strip = await png(4096, 600, { noise: true });
    expect(strip.byteLength).toBeGreaterThan(MAX_GRAPHIC_STORED_BYTES);
    const out = await prepareGraphicUpload(strip);
    expect(out.data.byteLength).toBeLessThanOrEqual(MAX_GRAPHIC_STORED_BYTES);
    expect(out.widthPx).toBe(3072);
    expect(out.heightPx).toBe(450);
  }, 60_000);

  it("refuses a PNG still over 8 MiB at 2048 px", async () => {
    // 2048 × 1500 noise ≈ 11.7 MiB: under the 16 MiB upload cap, over the stored cap at every side tried.
    await expect(prepareGraphicUpload(await png(2048, 1500, { noise: true }))).rejects.toThrow("2048 px");
  }, 60_000);

  it("refuses a PNG over 64 megapixels before decoding it", async () => {
    const huge = await sharp({ create: { width: 8200, height: 8200, channels: 3, background: "#fff" } }).png().toBuffer();
    await expect(prepareGraphicUpload(huge)).rejects.toThrow("64 megapixels");
  }, 60_000);

  it("refuses an SVG over the 8 MiB stored cap", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${" ".repeat(MAX_GRAPHIC_STORED_BYTES)}</svg>`);
    await expect(prepareGraphicUpload(svg)).rejects.toThrow("SVG graphic is limited");
  });

  it("stores an SVG as uploaded with its viewBox size", async () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`);
    const out = await prepareGraphicUpload(svg);
    expect(out.data).toBe(svg);
    expect(out).toMatchObject({ mime: "image/svg+xml", widthPx: 4096, heightPx: 4096 });
  });
});

describe("thumbBox", () => {
  it("fits inside 256 px, keeps aspect, never enlarges", () => {
    expect(thumbBox(4096, 2048)).toEqual([256, 128]);
    expect(thumbBox(100, 40)).toEqual([100, 40]);
    expect(thumbBox(1, 4096)).toEqual([1, 256]);
  });
});
