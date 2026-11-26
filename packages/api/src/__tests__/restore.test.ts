/**
 * The per-event restore's pure parts (packages/api/src/restore.ts,
 * docs/ops/backup-restore.md "Restoring an event"): vetting a dump, the
 * generated psql scripts and the phase plan. The round trip against a
 * database is integration/backup-restore-roundtrip.test.ts.
 */

import { describe, it, expect } from "vitest";
import { BACKUP_COMPLETE_MARKER } from "../backup.js";
import { buildCoreRestoreScript, buildMapExtrasScript, checkDump, csvHeader, planRestore, type CheckedDump } from "../restore.js";

const dumpOf = (sections: Record<string, string>, tail = BACKUP_COMPLETE_MARKER) =>
  ["-- Oxygen backup", "", ...Object.entries(sections).flatMap(([t, csv]) => [`--- ${t} ---`, csv]), tail, ""].join("\n");

const BASIC = {
  events: "id,name_id,name\n42,vinter,Vinter",
  controls: "id,event_id,seq\n0190a0a0-0000-7000-8000-000000000001,42,1",
  runners: "id,event_id,card_id\n",
  card_readouts: "id,event_id\n",
  cards: "id,event_id,readout_id\n",
  journal: "id,event_id,ingest_seq\n",
  event_seqs: "event_id,table_name,next_seq\n42,controls,2",
};

function checked(sections: Record<string, string>): CheckedDump {
  const c = checkDump(dumpOf(sections));
  if (!c.ok) throw new Error(c.error);
  return c.dump;
}

describe("checkDump", () => {
  it("accepts a complete dump and orders its tables by foreign key, not by file order", () => {
    const c = checkDump(dumpOf(BASIC));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.dump.warnings).toEqual([]);
    expect(c.dump.tables).toEqual(["events", "controls", "card_readouts", "cards", "runners", "journal", "event_seqs"]);
  });

  it("refuses a dump with a failure trailer", () => {
    const c = checkDump(dumpOf(BASIC, "-- BACKUP FAILED (exit 3): boom"));
    expect(c).toMatchObject({ ok: false });
    if (!c.ok) expect(c.error).toContain("BACKUP FAILED");
  });

  it("refuses a current-format dump that was cut short", () => {
    const c = checkDump(dumpOf(BASIC, ""));
    expect(c).toMatchObject({ ok: false });
    if (!c.ok) expect(c.error).toContain("cut short");
  });

  it("loads an older dump (no marker, no journal) with warnings, skipping unknown sections", () => {
    const old = { events: BASIC.events, runners: BASIC.runners, event_log: "id,event_id\n", rendered_maps: "id\n" };
    const c = checkDump(dumpOf(old, ""));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.dump.tables).toEqual(["events", "runners"]);
    expect(c.dump.warnings.join("\n")).toContain("older release");
    expect(c.dump.warnings.join("\n")).toContain("section event_log is not restored");
    expect(c.dump.warnings.join("\n")).toContain("section rendered_maps is not restored");
  });

  it("refuses a file that is not an event dump", () => {
    expect(checkDump("hello\n")).toMatchObject({ ok: false });
  });

  it("refuses a column name that is not a plain identifier", () => {
    const c = checkDump(dumpOf({ ...BASIC, controls: 'id,"x""); DROP TABLE y; --"\n' }));
    expect(c).toMatchObject({ ok: false });
  });
});

describe("csvHeader", () => {
  it("reads the header row, unquoting quoted names", () => {
    expect(csvHeader('id,"event_id",name\n1,2,3\n')).toEqual(["id", "event_id", "name"]);
    expect(csvHeader("")).toBeNull();
  });
});

describe("buildCoreRestoreScript", () => {
  const dump = checked(BASIC);

  it("stops at the first error, in one transaction, and reports the new event id", () => {
    const s = buildCoreRestoreScript(dump, { replace: false });
    expect(s.startsWith("\\set ON_ERROR_STOP on\nBEGIN;\n")).toBe(true);
    expect(s).toContain("COMMIT;\n\\echo restored-event-id :new_event_id");
  });

  it("loads each section by its header into a text temp table", () => {
    const s = buildCoreRestoreScript(dump, { replace: false });
    expect(s).toContain('CREATE TEMP TABLE restore_cards ("id" text, "event_id" text, "readout_id" text) ON COMMIT DROP;');
    expect(s).toContain("\\copy restore_cards FROM 'cards.csv' WITH (FORMAT csv, HEADER true)");
  });

  it("inserts in foreign-key order and leaves the script-loaded sections out", () => {
    const s = buildCoreRestoreScript(dump, { replace: false });
    const at = (t: string) => s.indexOf(`oxygen_restore_section('${t}'`);
    expect(at("events")).toBeGreaterThan(-1);
    expect(at("card_readouts")).toBeLessThan(at("cards"));
    expect(at("cards")).toBeLessThan(at("runners"));
    expect(at("event_seqs")).toBe(-1);
  });

  it("refuses an existing event unless replace, which deletes it first", () => {
    expect(buildCoreRestoreScript(dump, { replace: false })).toContain("already exists in this database: pass --replace");
    const r = buildCoreRestoreScript(dump, { replace: true });
    expect(r).toContain("DELETE FROM oxygen.events e USING restore_events s WHERE e.name_id = s.name_id;");
    expect(r).not.toContain("already exists");
  });
});

describe("planRestore", () => {
  it("runs the core, then the map scripts, the extras, the tracks and the counters", () => {
    const dump = checked({
      ...BASIC,
      map_sources: "file_hash\n",
      map_documents: "hash\n",
      club_symbol_decisions: "fingerprint\n",
      map_files: "id,event_id,source_hash\n",
      map_patches: "id,event_id\n",
      map_gps_tracks: "id,event_id\n",
    });
    const { steps, notes } = planRestore(dump);
    expect(steps.map((s) => (s.kind === "script" ? s.file : s.kind))).toEqual([
      "core",
      "restore-map-blobs.sql",
      "map-extras",
      "restore-map-gps-tracks.sql",
      "restore-event-seqs.sql",
    ]);
    expect(notes).toEqual([]);
    expect(buildMapExtrasScript(dump)).toContain("oxygen_restore_section('map_patches'");
  });

  it("restores a pre-v0.6.1 map file through the legacy script and says to re-match", () => {
    const dump = checked({ events: BASIC.events, map_files: "id,event_id,file_data\n" });
    const { steps, notes } = planRestore(dump);
    expect(steps.map((s) => (s.kind === "script" ? s.file : s.kind))).toEqual(["core", "restore-legacy-map-files.sql"]);
    expect(notes[0]).toContain("map:rematch");
    expect(buildMapExtrasScript(dump)).toBeNull();
  });
});
