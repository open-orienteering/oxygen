import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { renderOcadPreview } from "../club-map-preview.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../../../../e2e/test.ocd");

describe("renderOcadPreview", () => {
  it("renders an OCAD file as a bounded PNG", async () => {
    const png = await renderOcadPreview(readFileSync(FIXTURE));

    expect(png).not.toBeNull();
    expect(png!.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const metadata = await sharp(png!).metadata();
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.width).toBeLessThanOrEqual(512);
  });

  it("returns null for data that is not an OCAD file", async () => {
    await expect(renderOcadPreview(Buffer.from("not an OCAD file"))).resolves.toBeNull();
  });
});
