#!/usr/bin/env node
/**
 * Native-module smoke test for the production image (CI job "Docker image
 * smoke", docs/deps-2026-11.md). The API loads sharp and @resvg/resvg-js by
 * dynamic import only when a course graphic or print is rendered, so a broken
 * native binary would not stop the server from starting. This script loads
 * both, renders one SVG to PNG with resvg and resamples it with sharp.
 *
 *   docker run --rm -w /app/packages/api <image> node scripts/image-smoke.mjs
 */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b) => Buffer.from(b).subarray(0, 8).equals(PNG);

const { Resvg } = await import("@resvg/resvg-js");
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
  '<circle cx="32" cy="32" r="24" fill="none" stroke="#a626ff" stroke-width="4"/></svg>';
const rendered = new Resvg(svg).render().asPng();
if (!isPng(rendered)) throw new Error("resvg did not return a PNG");

const sharp = (await import("sharp")).default;
const resized = await sharp(rendered).resize(16, 16).png().toBuffer();
const meta = await sharp(resized).metadata();
if (!isPng(resized) || meta.width !== 16 || meta.height !== 16) {
  throw new Error(`sharp resample failed: ${JSON.stringify(meta)}`);
}

console.log(
  `image-smoke OK: node ${process.version}, sharp ${sharp.versions.sharp}, ` +
    `libvips ${sharp.versions.vips}, resvg PNG ${rendered.length} B`,
);
