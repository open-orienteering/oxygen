import { describe, expect, it } from "vitest";
import { heightNormals } from "@oxygen/shared/src/terrain/field/read.js";
import { createMapGlWorker, type TerrainReply, type WorkerReply } from "../worker";
import { buildTerrainMesh } from "../terrain/mesh";
import { coneField, noiseField } from "../terrain/synthetic";

function harness() {
  const sent: { msg: WorkerReply; transfer: ArrayBuffer[] }[] = [];
  const w = createMapGlWorker((msg, transfer) => sent.push({ msg, transfer }), () => {}, 0);
  return { w, sent };
}

describe("worker terrain request (map-rendering.md §5.6 \"Worker\")", () => {
  it("prepares the mesh and the normals as the main thread would, without a document loaded", () => {
    for (const field of [coneField(), noiseField(200, 130)]) {
      const { w, sent } = harness();
      w.handle({ type: "terrain", generation: 7, header: field.header, z: field.z.slice() });
      expect(sent).toHaveLength(1);
      const r = sent[0].msg as TerrainReply;
      expect(r.type).toBe("terrain");
      expect(r.generation).toBe(7);
      const mesh = buildTerrainMesh(field);
      expect(r.terrain.heights).toEqual(mesh.heights);
      expect([r.terrain.zMin, r.terrain.zMax, r.terrain.chunksX, r.terrain.chunksY]).toEqual([mesh.zMin, mesh.zMax, mesh.chunksX, mesh.chunksY]);
      expect(r.terrain.chunks).toEqual(mesh.chunks);
      expect(r.normals).toEqual(heightNormals(field, 1));
      expect(r.ms.fill).toBeGreaterThanOrEqual(0);
      // the two large arrays go back as transferables
      expect(sent[0].transfer).toEqual([r.terrain.heights.buffer, r.normals.buffer]);
    }
  });

  it("answers an error naming its generation for a malformed field", () => {
    const { w, sent } = harness();
    const field = coneField();
    w.handle({ type: "terrain", generation: 3, header: field.header, z: new Int16Array(10) });
    expect(sent[0].msg).toMatchObject({ type: "error", terrain: 3 });
  });
});
