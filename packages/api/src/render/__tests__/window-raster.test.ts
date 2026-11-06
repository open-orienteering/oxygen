/**
 * The prepared print document (docs/course-print.md §8.2): the objects
 * near a window of the e2e fixture. The window raster's tests went with
 * it in E4a.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { importOcadToDocument } from "../../import/ocad.js";
import { objectsNear, prepareDocument } from "../window-raster.js";

const fixture = readFileSync(fileURLToPath(new URL("../../../../../e2e/test.ocd", import.meta.url)));

let prepared: Awaited<ReturnType<typeof prepareDocument>>;

beforeAll(async () => {
  const imported = await importOcadToDocument(fixture, "test.ocd");
  prepared = await prepareDocument("unit", () => imported.bytes);
});

describe("objectsNear", () => {
  it("selects by extent plus margin", () => {
    const all = prepared.input.objects;
    const far = objectsNear(all, { minX: 500, minY: 500, width: 10, height: 10 }, 20);
    expect(far).toHaveLength(0);
    const centre = objectsNear(all, { minX: -1, minY: -1, width: 2, height: 2 }, 0);
    expect(centre.length).toBeGreaterThan(0);
    expect(centre.length).toBeLessThan(all.length);
  });
});
