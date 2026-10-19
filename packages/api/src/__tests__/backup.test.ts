/**
 * The per-event dump script (docs/backup-restore.md, docs/map-storage.md
 * §7.3): table order, per-table filters, and splitting a dump back into
 * its sections.
 */

import { describe, it, expect } from "vitest";
import { BACKUP_TABLES, buildBackupScript, splitBackupSections } from "../backup.js";

describe("BACKUP_TABLES", () => {
  it("puts the blob tables before map_files (FK order: sources, documents, map_files)", () => {
    const i = (t: string) => BACKUP_TABLES.indexOf(t as (typeof BACKUP_TABLES)[number]);
    expect(i("map_sources")).toBeGreaterThan(-1);
    expect(i("map_sources")).toBeLessThan(i("map_documents"));
    expect(i("map_documents")).toBeLessThan(i("map_files"));
    expect(BACKUP_TABLES[0]).toBe("events");
  });

  it("does not carry previews (a cache) or the global tile cache", () => {
    expect(BACKUP_TABLES).not.toContain("map_previews");
    expect(BACKUP_TABLES).not.toContain("map_tiles");
  });
});

describe("buildBackupScript", () => {
  const script = buildBackupScript(42n);

  it("emits one separator and one \\copy per table, in order", () => {
    const separators = [...script.matchAll(/^\\echo --- (\S+) ---$/gm)].map((m) => m[1]);
    expect(separators).toEqual([...BACKUP_TABLES]);
    expect(script.match(/^\\copy /gm)).toHaveLength(BACKUP_TABLES.length);
  });

  it("filters map_sources to the event's pins and their documents' sources", () => {
    const line = script.split("\n").find((l) => l.includes("FROM oxygen.map_sources"))!;
    expect(line).toContain("f.source_hash FROM oxygen.map_files f WHERE f.event_id = 42");
    expect(line).toContain("d.source_hash FROM oxygen.map_documents d JOIN oxygen.map_files f ON f.document_hash = d.hash WHERE f.event_id = 42");
  });

  it("filters map_documents to the event's document pins", () => {
    const line = script.split("\n").find((l) => l.includes("FROM oxygen.map_documents s"))!;
    expect(line).toContain("f.document_hash FROM oxygen.map_files f WHERE f.event_id = 42");
  });

  it("keeps the event-scoped filters", () => {
    expect(script).toContain("SELECT * FROM oxygen.events WHERE id = 42");
    expect(script).toContain("SELECT * FROM oxygen.map_files WHERE event_id = 42");
    expect(script).toContain("JOIN oxygen.courses c ON c.id = cc.course_id WHERE c.event_id = 42");
  });

  it("rejects a non-integer id", () => {
    expect(() => buildBackupScript(-1n)).toThrow();
  });
});

describe("splitBackupSections", () => {
  it("returns each section's CSV keyed by table, header comment ignored", () => {
    const dump = [
      "-- Oxygen backup",
      "-- Event: x",
      "",
      "--- events ---",
      "id,name_id",
      "7,x",
      "--- map_sources ---",
      "file_hash,kind,bytes",
      'aa,ocad,\\x0102',
      "--- map_documents ---",
      "hash,bytes",
      "",
    ].join("\n");
    const sections = splitBackupSections(dump);
    expect([...sections.keys()]).toEqual(["events", "map_sources", "map_documents"]);
    expect(sections.get("events")).toBe("id,name_id\n7,x\n");
    expect(sections.get("map_sources")).toBe("file_hash,kind,bytes\naa,ocad,\\x0102\n");
    expect(sections.get("map_documents")).toBe("hash,bytes\n");
  });

  it("stops at a failure trailer", () => {
    const sections = splitBackupSections("--- events ---\nid\n1\n\n-- BACKUP FAILED (exit 2): nope\n");
    expect(sections.get("events")).toBe("id\n1\n");
  });
});
