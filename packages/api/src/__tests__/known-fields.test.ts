/**
 * `knownFields`: a row from the peer keeps only the columns this schema has
 * (review SYNC-17, version skew between a box and the cloud).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { knownFields, _resetKnownFieldsWarnings } from "../sync/knownFields.js";

afterEach(() => {
  vi.restoreAllMocks();
  _resetKnownFieldsWarnings();
});

describe("knownFields", () => {
  it("drops keys the model does not have and keeps the rest, values untouched", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = { id: "c1", name: "A", futureColumn: 5, anotherNew: { x: 1 } };
    expect(knownFields("course", row)).toEqual({ id: "c1", name: "A" });
  });

  it("handles every model of a snapshot, join tables and the E5 dropped columns included", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(knownFields("courseControl", { id: "x", courseId: "c", nope: 1 })).not.toHaveProperty("nope");
    expect(knownFields("event", { nameId: "e", mapPipeline: "vector", overprintCutsVersion: 3 })).toEqual({ nameId: "e" });
    expect(knownFields("mapFile", { fileName: "a.ocd", fileData: "x", renderKey: "k" })).toEqual({ fileName: "a.ocd" });
    expect(knownFields("course", { name: "A", geometry: {}, geometrySource: "editor" })).toEqual({ name: "A" });
  });

  it("keeps the course climb's source and the winner pace and drops a column this schema does not have (docs/course-elevation.md §6 \"Readers\")", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = { id: "c1", name: "A", climbM: 120, climbSource: "computed", winnerPaceSPerKm: 330, someFutureColumn: 1 };
    expect(knownFields("course", row)).toEqual({ id: "c1", name: "A", climbM: 120, climbSource: "computed", winnerPaceSPerKm: 330 });
  });

  it("warns once per model and name", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    knownFields("runner", { name: "a", brandNew: 1 });
    knownFields("runner", { name: "b", brandNew: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("runner");
    expect(String(warn.mock.calls[0]![0])).toContain("brandNew");
    knownFields("runner", { name: "c", anotherNew: 2 });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("returns the row as is for a model it does not know, and does not mutate its input", () => {
    const row = { a: 1, b: 2 };
    expect(knownFields("noSuchModel", row)).toEqual(row);
    const input = { name: "A", extra: 1 };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    knownFields("course", input);
    expect(input).toEqual({ name: "A", extra: 1 });
  });
});
