/**
 * The pure part of the patch store (docs/map-patches.md §3): the row →
 * patch projection, the delivery rule (a patch only paired with the pin),
 * the no-change test, the size cap and the ETag.
 */

import { describe, it, expect, vi } from "vitest";
import type { mapDocument } from "@oxygen/shared";
import {
  MAP_PATCH_MAX_BYTES,
  assertPatchSize,
  deliveredPatch,
  eventPrintPatch,
  patchEtag,
  patchOfRow,
  samePatchContent,
} from "../map-store/patches.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const hide = (i: number): mapDocument.PatchOp => ({ op: "hide", sourceIndex: i });

function row(over: Partial<{ documentHash: string; enabled: boolean; ops: unknown; symbols: unknown; version: bigint }> = {}) {
  return { documentHash: HASH_A, enabled: true, ops: {}, symbols: {}, version: 17n, ...over };
}

describe("patchOfRow", () => {
  it("parses a stored row and sorts its record keys", () => {
    const p = patchOfRow(row({ ops: { "hide:9": hide(9), "hide:10": hide(10) } }));
    expect(p).not.toBeNull();
    expect(Object.keys(p!.ops)).toEqual(["hide:10", "hide:9"]);
    expect(p!.documentHash).toBe(HASH_A);
    expect(p!.enabled).toBe(true);
  });

  it("reads an unparseable row as no patch, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(patchOfRow(row({ ops: { "hide:2": hide(3) } }))).toBeNull();
    expect(patchOfRow(row({ ops: [] }))).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("deliveredPatch", () => {
  it("delivers the row keyed to the pin, with its version as a decimal string", () => {
    const d = deliveredPatch(row({ ops: { "hide:1": hide(1) }, version: 2n ** 62n + 5n }), HASH_A);
    expect(d.version).toBe((2n ** 62n + 5n).toString());
    expect(d.patch?.ops).toEqual({ "hide:1": hide(1) });
  });

  it("delivers a disabled patch as it is", () => {
    expect(deliveredPatch(row({ enabled: false }), HASH_A).patch?.enabled).toBe(false);
  });

  it("delivers nothing without a row, without a pin, or for a dormant row", () => {
    const none = { version: "0", patch: null };
    expect(deliveredPatch(null, HASH_A)).toEqual(none);
    expect(deliveredPatch(row(), null)).toEqual(none);
    expect(deliveredPatch(row(), HASH_B)).toEqual(none);
  });
});

describe("eventPrintPatch (G14: the patch print, cuts and checks apply)", () => {
  const db = (r: ReturnType<typeof row> | null) => ({ mapPatch: { findUnique: vi.fn(async () => r) } }) as unknown as Parameters<typeof eventPrintPatch>[0];

  it("is the delivered patch with its version when it changes the document", async () => {
    const p = await eventPrintPatch(db(row({ ops: { "hide:1": hide(1) }, version: 9n })), 1n, HASH_A);
    expect(p?.version).toBe("9");
    expect(p?.patch.ops).toEqual({ "hide:1": hide(1) });
  });

  it("is null when it changes nothing: no pin, no row, dormant, disabled or op-less (map-patches §2.1, §3.3)", async () => {
    const live = row({ ops: { "hide:1": hide(1) } });
    expect(await eventPrintPatch(db(live), 1n, null)).toBeNull();
    expect(await eventPrintPatch(db(null), 1n, HASH_A)).toBeNull();
    expect(await eventPrintPatch(db(live), 1n, HASH_B)).toBeNull();
    expect(await eventPrintPatch(db({ ...live, enabled: false }), 1n, HASH_A)).toBeNull();
    expect(await eventPrintPatch(db(row()), 1n, HASH_A)).toBeNull();
  });
});

describe("samePatchContent", () => {
  it("ignores key order at every depth", () => {
    const a = { documentHash: HASH_A, enabled: true, ops: { "hide:1": hide(1), "hide:2": hide(2) }, symbols: {} };
    const b = { documentHash: HASH_A, enabled: true, ops: { "hide:2": { sourceIndex: 2, op: "hide" as const }, "hide:1": hide(1) }, symbols: {} };
    expect(samePatchContent(a, b)).toBe(true);
    expect(samePatchContent(a, { ...b, ops: { "hide:1": hide(1) } })).toBe(false);
    expect(samePatchContent(a, { ...a, enabled: false })).toBe(false);
  });
});

describe("assertPatchSize", () => {
  it("passes a small patch and refuses one over the cap with PAYLOAD_TOO_LARGE", () => {
    const small = { documentHash: HASH_A, enabled: true, ops: { "hide:1": hide(1) }, symbols: {} };
    expect(() => assertPatchSize(small)).not.toThrow();
    const ops: Record<string, mapDocument.PatchOp> = {};
    const n = Math.ceil(MAP_PATCH_MAX_BYTES / 30) + 10;
    for (let i = 0; i < n; i++) ops[`hide:${i}`] = hide(i);
    expect(() => assertPatchSize({ ...small, ops })).toThrow(expect.objectContaining({ code: "PAYLOAD_TOO_LARGE" }));
  });
});

describe("patchEtag", () => {
  it("quotes the version", () => {
    expect(patchEtag("123")).toBe('"123"');
  });
});
