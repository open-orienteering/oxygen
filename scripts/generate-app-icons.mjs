/**
 * Renders the PNG app icons in `packages/web/public/` from `favicon.svg`.
 *
 *   pwa-192.png            192×192  manifest icon (Android / desktop install)
 *   pwa-512.png            512×512  manifest icon + splash source
 *   apple-touch-icon.png   180×180  iOS home screen
 *
 * The favicon carries a squircle clip so it looks like an app icon in a
 * browser tab. The PNGs are rendered *full-bleed* (clip removed): iOS and
 * Android apply their own masks to home-screen icons, and transparent
 * corners would show through as black on iOS.
 *
 * Uses the Playwright Chromium that is already a dev dependency — ImageMagick's
 * built-in SVG renderer mangles clip paths and gradients.
 *
 * Usage: node scripts/generate-app-icons.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "../packages/web/public");
const svg = readFileSync(resolve(publicDir, "favicon.svg"), "utf8");

// Full-bleed variant: drop the squircle clip so the flag fills the square.
const fullBleed = svg.replace(/\s*clip-path="url\(#squircle\)"/, "");

const targets = [
  { file: "pwa-192.png", size: 192 },
  { file: "pwa-512.png", size: 512 },
  { file: "apple-touch-icon.png", size: 180 },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size } of targets) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><body style="margin:0;background:#F8FAFC">` +
        fullBleed.replace("<svg ", `<svg width="${size}" height="${size}" style="display:block" `) +
        `</body>`,
    );
    const png = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: size, height: size } });
    writeFileSync(resolve(publicDir, file), png);
    console.log(`wrote ${file} (${size}×${size}, ${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
