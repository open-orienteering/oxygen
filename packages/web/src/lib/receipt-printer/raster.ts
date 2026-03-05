/**
 * Browser-only helper for converting a logo image to an ESC/POS 1-bit raster.
 *
 * Uses HTMLImageElement + <canvas> to fetch and threshold the image.
 * Returns null on any error (network failure, 404, CORS, no canvas support).
 */

import type { LogoRaster } from "./types.js";

/**
 * Fetch an image from `logoUrl`, scale it to at most `maxWidthDots` dots wide,
 * and convert it to a 1-bit (black/white) raster ready for the ESC/POS GS v 0 command.
 *
 * @param logoUrl     URL of the PNG/JPEG logo (e.g. "/api/club-logo/12345?variant=large")
 * @param maxWidthDots Maximum width in printer dots (default 300 ≈ 37 mm at 203 dpi)
 */
export async function fetchLogoRaster(
  logoUrl: string,
  maxWidthDots = 300,
): Promise<LogoRaster | null> {
  try {
    const img = new Image();
    img.crossOrigin = "anonymous";

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("logo load failed"));
      img.src = logoUrl;
    });

    if (!img.naturalWidth || !img.naturalHeight) return null;

    // Scale to fit within maxWidthDots (upscale allowed — small source images still fill the space)
    const scale = maxWidthDots / img.naturalWidth;
    const widthDots = Math.round(img.naturalWidth * scale);
    const heightDots = Math.round(img.naturalHeight * scale);
    const widthBytes = Math.ceil(widthDots / 8);

    const canvas = document.createElement("canvas");
    canvas.width = widthDots;
    canvas.height = heightDots;

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    // White background so transparent PNGs render correctly
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, widthDots, heightDots);
    ctx.drawImage(img, 0, 0, widthDots, heightDots);

    const pixels = ctx.getImageData(0, 0, widthDots, heightDots).data; // RGBA flat array
    const rasterData = new Uint8Array(widthBytes * heightDots);

    for (let y = 0; y < heightDots; y++) {
      for (let x = 0; x < widthDots; x++) {
        const i = (y * widthDots + x) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
        // Luminance threshold: dark pixels with sufficient opacity → black dot
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        if (a >= 128 && luminance < 128) {
          // MSB-first: bit 7 = leftmost pixel in byte
          rasterData[y * widthBytes + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
        }
      }
    }

    return { widthBytes, heightDots, data: rasterData };
  } catch {
    return null;
  }
}
