/**
 * Row G19, docs/map-storage.md §7.2 "Following the cloud during a lease":
 * the pure parts of the box's map refresh — what counts as changed, the
 * mirror plan, the `map_files` set comparison, the held-graphic rule and
 * which forwarded writes refresh.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  canonicalJson,
  knownTemplateOf,
  planMirror,
  refreshWrites,
  rowContent,
  sameMapFiles,
  type MapRefreshResult,
} from "../sync/mapRefresh.js";
import { holdsGraphic } from "../sync/snapshotGraphics.js";
import { refreshesMapRows } from "../sync/venueForwarder.js";
import { applyTokens } from "../sync/snapshotMaps.js";

const TOKEN = 2n ** 60n + 7n;
const at = new Date("2026-11-14T10:00:00.123Z");
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)));

const sheet = (over: Record<string, unknown> = {}) => ({
  id: "0190a000-0000-7000-8000-000000000001",
  eventId: 12n,
  seq: 1,
  name: "Blå",
  overrides: { b: 1, a: [1, 2] },
  windowCenter: null,
  version: TOKEN,
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe("canonicalJson", () => {
  it("sorts keys, writes dates and bigints as they cross HTTP", () => {
    expect(canonicalJson({ b: 1, a: { d: at, c: 5n } })).toBe(`{"a":{"c":"5","d":"2026-11-14T10:00:00.123Z"},"b":1}`);
    expect(canonicalJson({ a: undefined, b: null })).toBe(`{"b":null}`);
    expect(canonicalJson([1, "x", true, null])).toBe(`[1,"x",true,null]`);
  });

  it("is equal for a row and its JSON round trip on the compared columns", () => {
    const local = sheet();
    const cloud = json(sheet({ eventId: 99n }));
    const keys = Object.keys(cloud);
    expect(rowContent(local, keys)).toBe(rowContent(cloud, keys));
  });
});

describe("planMirror", () => {
  const exact = (rows: Record<string, unknown>[]) =>
    applyTokens(rows, Object.fromEntries(rows.map((r) => [String(r.id), String(TOKEN)])));

  it("leaves an unchanged row alone, whatever its updated_at and event id", () => {
    const cloud = exact([json(sheet({ eventId: 99n, updatedAt: new Date("2030-01-01T00:00:00Z") }))]);
    expect(planMirror([sheet()], cloud)).toEqual({ deletes: [], creates: [], updates: [] });
  });

  it("updates a row whose content changed under the same token (a reorder moves z without one)", () => {
    const cloud = exact([json(sheet({ overrides: { a: [2, 1], b: 1 } }))]);
    expect(planMirror([sheet()], cloud).updates.map((r) => r.id)).toEqual([sheet().id]);
  });

  it("updates a row whose exact token changed, even when a JSON round trip would round both alike", () => {
    const next = TOKEN + 1n;
    expect(Number(next)).toBe(Number(TOKEN)); // a rounded token cannot tell them apart
    const cloud = applyTokens([json(sheet())], { [sheet().id]: String(next) });
    expect(planMirror([sheet()], cloud).updates).toHaveLength(1);
  });

  it("creates what the box lacks and deletes what the cloud lacks, sorted", () => {
    const b = sheet({ id: "0190a000-0000-7000-8000-00000000000b" });
    const a = sheet({ id: "0190a000-0000-7000-8000-00000000000a" });
    const c = sheet({ id: "0190a000-0000-7000-8000-00000000000c" });
    const plan = planMirror([b, a, sheet()], exact([json(sheet()), json(c)]));
    expect(plan.deletes).toEqual([a.id, b.id]);
    expect(plan.creates.map((r) => r.id)).toEqual([c.id]);
    expect(plan.updates).toEqual([]);
  });

  it("compares only the cloud row's columns (a column an older cloud lacks)", () => {
    const { overrides: _o, ...older } = json(sheet());
    expect(planMirror([sheet()], exact([older])).updates).toEqual([]);
  });
});

describe("sameMapFiles", () => {
  const file = (over: Record<string, unknown> = {}) => ({
    fileName: "a.ocd",
    sourceHash: "s".repeat(64),
    documentHash: "d".repeat(64),
    scale: 10000,
    bounds: { n: 1 },
    uploadedAt: at,
    ...over,
  });

  it("ignores the local id, event id and the venue NULL of the club version", () => {
    const local = [{ id: 7n, eventId: 3n, clubMapVersionId: null, ...file() }];
    expect(sameMapFiles(local, [json({ ...file(), clubMapVersionId: "0190" })])).toBe(true);
  });

  it("is a multiset comparison: order does not matter, a moved pin does", () => {
    const x = file({ fileName: "x.ocd" });
    const y = file({ fileName: "y.ocd" });
    expect(sameMapFiles([x, y], json([y, x]))).toBe(true);
    expect(sameMapFiles([x], json([file({ fileName: "x.ocd", documentHash: "e".repeat(64) })]))).toBe(false);
    expect(sameMapFiles([x, x], json([x, y]))).toBe(false);
    expect(sameMapFiles([x], [])).toBe(false);
    expect(sameMapFiles([], [])).toBe(true);
  });
});

describe("helpers", () => {
  it("knownTemplateOf: a template the export lacks becomes NULL", () => {
    const ids = new Set(["t1"]);
    expect(knownTemplateOf(ids, "t1")).toBe("t1");
    expect(knownTemplateOf(ids, "t2")).toBeNull();
    expect(knownTemplateOf(ids, null)).toBeNull();
  });

  it("refreshWrites counts every written row; 0 for an unchanged cloud", () => {
    const zero = { created: 0, updated: 0, deleted: 0 };
    const none: MapRefreshResult = {
      mapFiles: 0,
      patch: "unchanged",
      graphics: { written: 0, updated: 0, deleted: 0 },
      templates: zero,
      classes: 0,
      sheets: { ...zero, skipped: 3 },
      objects: zero,
      fetchedBytes: 0,
    };
    expect(refreshWrites(none)).toBe(0);
    expect(refreshWrites({ ...none, patch: "deleted", classes: 2, objects: { created: 1, updated: 1, deleted: 1 } })).toBe(6);
  });

  it("holdsGraphic: same bytes and owner; an event graphic only with the local event named", () => {
    const data = Buffer.from("png");
    const sha256 = createHash("sha256").update(data).digest("hex");
    expect(holdsGraphic({ club: true, sha256 }, { eventId: null, data })).toBe(true);
    expect(holdsGraphic({ club: true, sha256 }, { eventId: 5n, data })).toBe(false);
    expect(holdsGraphic({ club: false, sha256 }, { eventId: 5n, data })).toBe(false); // checkout: always fetched
    expect(holdsGraphic({ club: false, sha256 }, { eventId: 5n, data }, 5n)).toBe(true);
    expect(holdsGraphic({ club: false, sha256 }, { eventId: 6n, data }, 5n)).toBe(false);
    expect(holdsGraphic({ club: false, sha256 }, { eventId: null, data }, 5n)).toBe(false);
    expect(holdsGraphic({ club: false, sha256: "0".repeat(64) }, { eventId: 5n, data }, 5n)).toBe(false);
    expect(holdsGraphic({ club: true, sha256 }, null)).toBe(false);
  });

  it("refreshesMapRows: layout and patch writes refresh, others do not", () => {
    for (const p of ["mapPatch.save", "courseMap.update", "mapTemplate.create", "layout.autoSheets", "graphics.upload", "courseObject.reorder"]) {
      expect(refreshesMapRows([p])).toBe(true);
    }
    expect(refreshesMapRows(["club.update", "eventor.sync"])).toBe(false);
    expect(refreshesMapRows(["club.update", "courseMap.update"])).toBe(true);
  });
});
