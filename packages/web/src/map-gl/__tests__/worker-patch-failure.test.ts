/**
 * A patch request that throws after the overlay is computed (docs/map-rendering.md §5.2 "Reply"):
 * the worker is left as the engine still has it, so the next change is diffed against the last
 * reply and an atlas grown by the failed request goes with the next one.
 */

import { describe, it, expect, vi } from "vitest";
import { mapDocument } from "@oxygen/shared";
import { createMapGlWorker, type LoadedReply, type PatchedReply, type WorkerReply } from "../worker";
import { CELL_UM, cell, discSym, documentBytes, moveLine1, patchOf } from "./patch-fixture";

const fail = vi.hoisted(() => ({ on: false }));
vi.mock("../buckets", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../buckets")>();
  return {
    ...mod,
    prepareBucketPartFrom: (...args: Parameters<typeof mod.prepareBucketPartFrom>) => {
      if (fail.on) throw new Error("prepare failed");
      return mod.prepareBucketPartFrom(...args);
    },
  };
});

describe("a patch request that throws while preparing", () => {
  it("leaves the overlay, the bytes and the atlas as last sent", () => {
    const sent: WorkerReply[] = [];
    const w = createMapGlWorker((msg) => sent.push(msg), (fn) => fn(), 0);
    w.handle({ type: "load", source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } }, fonts: [], cellUm: CELL_UM });
    const loaded = sent[0] as LoadedReply;
    let g = 0;
    const ask = (p: mapDocument.MapPatch | null) => {
      w.handle({ type: "patch", generation: ++g, patch: p, detail: [0, 1, 3] });
      return sent[sent.length - 1];
    };
    expect((ask(patchOf([moveLine1(7)])) as PatchedReply).touched).toEqual([cell(0)]);

    // Resymbol the boulder to a new glyph (the atlas grows) and fail while preparing.
    const big = { "K:1": mapDocument.patchSymbolSchema.parse(discSym("K:1", 1500)) };
    const resymbol = patchOf([moveLine1(7), { op: "resymbol", sourceIndex: 4, symbol: { patch: "K:1" } }], big);
    fail.on = true;
    expect(ask(resymbol)).toMatchObject({ type: "error", patch: 2 });
    fail.on = false;

    // The same content as the last reply touches nothing; the atlas the failed request grew goes
    // with this reply (the main thread has not seen the new mesh).
    const same = ask(patchOf([moveLine1(7)])) as PatchedReply;
    expect(same.touched).toEqual([]);
    expect(same.atlas?.meshes.length).toBe(loaded.atlas.meshes.length + 1);
    const retried = ask(resymbol) as PatchedReply;
    expect(retried.touched).toEqual([cell(3)]);
    expect(retried.atlas).toBeUndefined();
    expect(retried.bytes.base).toBe(loaded.summary.bytes.base);
  });
});
