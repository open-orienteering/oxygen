/**
 * The per-event dump against the migrated schema, and a whole-event round
 * trip through `runRestore` (docs/ops/backup-restore.md, DB-13, DB-14,
 * BLD-01):
 *
 *  - every event-scoped table is dumped or listed in BACKUP_EXCLUDED, and
 *    BACKUP_TABLES is in foreign-key order by the real constraints;
 *  - an event with readouts, cards, runners, punches, units, a course
 *    variant, a class with a sheet template, course maps, a readout
 *    backup, the journal, a graphic and event permissions dumps (every
 *    section with a header row, the completion marker last), is lost, and
 *    restores with every row back under a new event id;
 *  - the map (its pin, patch, colour settings and GPS track) comes back
 *    through the map phases;
 *  - a second restore is refused, `replace` restores it again in place;
 *  - a permission of a user the target no longer has is skipped;
 *  - a dump that cannot reach the database answers 502, not a file.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyEventMap } from "../../event-map.js";
import Fastify, { type FastifyInstance } from "fastify";
import { createTestEvent, disconnect, type TestEventContext } from "../helpers/test-db.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { BACKUP_COMPLETE_MARKER, BACKUP_EXCLUDED, BACKUP_TABLES, registerBackupRoute, splitBackupSections, type PgDumpProcess } from "../../backup.js";
import { RestoreError, runRestore } from "../../restore.js";
import { prisma } from "../../db.js";

const suffix = randomBytes(4).toString("hex");
const FIXTURE = resolve(__dirname, "../../../../../e2e/test.ocd");
let documentHash: string;
let src: TestEventContext;
let server: FastifyInstance;
let dump: string;
let before: Snapshot;
let restoredId: bigint | null = null;
let keptUserId: string;
let groupId: string;

type Snapshot = Record<string, unknown[]>;

/** Columns the restore renumbers from the target's sequences (restore.ts FRESH_COLUMNS, graphics). */
const RENUMBERED: Record<string, string[]> = { graphics: ["id"], tracks: ["id"], routes: ["id"], journal: ["ingest_seq"], map_files: ["id"] };

/** `graphicId` in layout JSON, replaced by the graphic's name, so a renumbered graphic compares equal. */
function byGraphicName(v: unknown, names: Map<string, string>): unknown {
  if (Array.isArray(v)) return v.map((x) => byGraphicName(x, names));
  if (v && typeof v === "object") {
    const o = { ...(v as Record<string, unknown>) };
    if ("graphicId" in o) o.graphicId = `graphic:${names.get(String(o.graphicId)) ?? `missing ${String(o.graphicId)}`}`;
    return o;
  }
  return v;
}

/** The event's rows per table, as JSON without `event_id`, in a stable order. */
async function snapshot(eventId: bigint): Promise<Snapshot> {
  const db = prisma();
  const out: Snapshot = {};
  const scoped = BACKUP_TABLES.filter((t) => !["events", "course_controls", "class_course_pools", "map_sources", "map_documents", "map_document_colour_settings", "club_symbol_decisions"].includes(t));
  const graphicNames = new Map(
    (await db.$queryRawUnsafe<{ id: string; name: string }[]>(`SELECT id::text AS id, name FROM oxygen.graphics WHERE event_id = $1`, eventId)).map((g) => [g.id, g.name]),
  );
  for (const t of scoped) {
    const key = t === "event_seqs" ? "table_name" : t === "graphics" ? "name" : t === "tracks" ? "device_id" : "id";
    const rows = await db.$queryRawUnsafe<{ j: Record<string, unknown> }[]>(
      `SELECT to_jsonb(t) - 'event_id' AS j FROM oxygen.${t} t WHERE event_id = $1 ORDER BY to_jsonb(t) ->> '${key}'`,
      eventId,
    );
    out[t] = rows.map(({ j }) => {
      const row: Record<string, unknown> = { ...j };
      for (const c of RENUMBERED[t] ?? []) delete row[c];
      if (t === "map_templates" || t === "course_maps") row.objects = byGraphicName(row.objects, graphicNames);
      if (t === "course_objects") row.props = byGraphicName(row.props, graphicNames);
      return row;
    });
  }
  out.map_document_colour_settings = (await db.$queryRawUnsafe<{ j: unknown }[]>(
    `SELECT to_jsonb(s) AS j FROM oxygen.map_document_colour_settings s WHERE s.document_hash IN (SELECT document_hash FROM oxygen.map_files WHERE event_id = $1) ORDER BY colour_key`, eventId,
  )).map((r) => r.j);
  out.course_controls = (await db.$queryRawUnsafe<{ j: unknown }[]>(
    `SELECT to_jsonb(cc) AS j FROM oxygen.course_controls cc JOIN oxygen.courses c ON c.id = cc.course_id WHERE c.event_id = $1 ORDER BY cc.course_id, cc.position`, eventId,
  )).map((r) => r.j);
  out.class_course_pools = (await db.$queryRawUnsafe<{ j: unknown }[]>(
    `SELECT to_jsonb(p) AS j FROM oxygen.class_course_pools p JOIN oxygen.classes c ON c.id = p.class_id WHERE c.event_id = $1 ORDER BY p.class_id, p.course_id`, eventId,
  )).map((r) => r.j);
  out.events = (await db.$queryRawUnsafe<{ j: unknown }[]>(
    `SELECT to_jsonb(e) - 'id' - 'created_at' - 'updated_at' AS j FROM oxygen.events e WHERE id = $1`, eventId,
  )).map((r) => r.j);
  return out;
}

async function one<T = { id: string }>(sql: string, ...params: unknown[]): Promise<T> {
  const rows = await prisma().$queryRawUnsafe<T[]>(sql, ...params);
  return rows[0];
}

beforeAll(async () => {
  src = await createTestEvent("restore_rt");
  const e = src.eventId;
  const db = src.db;
  keptUserId = (await db.user.create({ data: { email: `kept@restore-${suffix}.example`, displayName: "Kept", active: true } })).id;
  const goneUser = await db.user.create({ data: { email: `gone@restore-${suffix}.example`, displayName: "Gone", active: true } });
  groupId = (await one(`INSERT INTO oxygen.permission_groups (name, capabilities) VALUES ($1, '[]'::jsonb) RETURNING id`, `rt-${suffix}`)).id;

  const control = await one(`INSERT INTO oxygen.controls (event_id, name, codes) VALUES ($1, '31', '31') RETURNING id`, e);
  const finish = await one(`INSERT INTO oxygen.controls (event_id) VALUES ($1) RETURNING id`, e);
  const course = await one(`INSERT INTO oxygen.courses (event_id, name, finish_control_id) VALUES ($1, 'A', $2::uuid) RETURNING id`, e, finish.id);
  const variant = await one(`INSERT INTO oxygen.courses (event_id, name, parent_course_id, variant_key) VALUES ($1, 'A1', $2::uuid, 'AB') RETURNING id`, e, course.id);
  await one(`INSERT INTO oxygen.course_controls (course_id, position, control_id) VALUES ($1::uuid, 0, $2::uuid) RETURNING course_id AS id`, course.id, control.id);
  const logo = await one(`INSERT INTO oxygen.graphics (event_id, name, mime, data, size_bytes) VALUES ($1, 'logo', 'image/png', '\\x89504e47'::bytea, 4) RETURNING id::text AS id`, e);
  const drawn = JSON.stringify([{ kind: "image", graphicId: Number(logo.id), x: 1 }, { kind: "text", text: "graphicId" }]);
  const template = await one(`INSERT INTO oxygen.map_templates (event_id, name, print_scale, objects) VALUES ($1, 'A4', 10000, $2::jsonb) RETURNING id`, e, drawn);
  await one(`INSERT INTO oxygen.course_objects (event_id, kind, geometry, scope, props) VALUES ($1, 'image', '[]'::jsonb, '{"all":true}'::jsonb, $2::jsonb) RETURNING id`, e, JSON.stringify({ graphicId: Number(logo.id) }));
  const klass = await one(`INSERT INTO oxygen.classes (event_id, name, course_id, sheet_template_id) VALUES ($1, 'H21', $2::uuid, $3::uuid) RETURNING id`, e, course.id, template.id);
  await one(`INSERT INTO oxygen.class_course_pools (class_id, course_id) VALUES ($1::uuid, $2::uuid) RETURNING class_id AS id`, klass.id, variant.id);
  await one(`INSERT INTO oxygen.course_maps (event_id, name, course_id, template_id, class_id, objects) VALUES ($1, 'A map', $2::uuid, $3::uuid, $4::uuid, $5::jsonb) RETURNING id`, e, course.id, template.id, klass.id, drawn);
  const readout = await one(`INSERT INTO oxygen.card_readouts (event_id, card_no, punches) VALUES ($1, 500123, '[{"code":31,"time":3600}]'::jsonb) RETURNING id`, e);
  const card = await one(`INSERT INTO oxygen.cards (event_id, card_no, readout_id) VALUES ($1, 500123, $2::uuid) RETURNING id`, e, readout.id);
  const runner = await one(`INSERT INTO oxygen.runners (event_id, name, club_name, card_id, class_id, course_id) VALUES ($1, 'Anna "A" Berg, jr', $5, $2::uuid, $3::uuid, $4::uuid) RETURNING id`, e, card.id, klass.id, course.id, "OK Linné\n--- runners ---");
  await one(`INSERT INTO oxygen.teams (event_id, name, class_id) VALUES ($1, 'Lag 1', $2::uuid) RETURNING id`, e, klass.id);
  const unit = await one(`INSERT INTO oxygen.control_units (event_id, station_serial, control_id) VALUES ($1, 77001, $2::uuid) RETURNING id`, e, control.id);
  await one(`INSERT INTO oxygen.punches (event_id, card_no, control_code, time, unit_id, control_id) VALUES ($1, 500123, 31, 3600, $2::uuid, $3::uuid) RETURNING id`, e, unit.id, control.id);
  await one(`INSERT INTO oxygen.card_readout_backups (event_id, slot_address, card_no, punches, punches_hash, raw_bytes) VALUES ($1, 8, 500123, '[]'::jsonb, 'h1', '\\x0102ff'::bytea) RETURNING id`, e);
  await one(`INSERT INTO oxygen.journal (event_id, type, station_id, client_timestamp, payload, hlc, schema_version) VALUES ($1, 'runner.update', 'st-1', now(), '{"note":"a, \\"b\\""}'::jsonb, 1, 1) RETURNING id`, e);
  await one(`INSERT INTO oxygen.tracks (event_id, device_id, start_time_ms, geometry) VALUES ($1, 'dev', 1, '{}'::jsonb) RETURNING id::text AS id`, e);
  await one(`INSERT INTO oxygen.routes (event_id, waypoints, runner_id, class_id) VALUES ($1, '[]'::jsonb, $2::uuid, $3::uuid) RETURNING id::text AS id`, e, runner.id, klass.id);
  await one(`INSERT INTO oxygen.event_permissions (event_id, user_id, group_id, granted_by) VALUES ($1, $2::uuid, $3::uuid, $4::uuid) RETURNING id`, e, keptUserId, groupId, goneUser.id);
  await one(`INSERT INTO oxygen.event_permissions (event_id, user_id, group_id) VALUES ($1, $2::uuid, $3::uuid) RETURNING id`, e, goneUser.id, groupId);

  // The map: a pin, a dormant patch, colour settings and a GPS track.
  const fixture = Buffer.concat([readFileSync(FIXTURE), Buffer.from(`restore-rt-${suffix}`)]);
  const applied = await applyEventMap(db, e, "rt.ocd", fixture, { uploadedBy: keptUserId });
  documentHash = applied.documentHash!;
  const sourceHash = (await db.mapFile.findFirstOrThrow({ where: { eventId: e } })).sourceHash!;
  await one(`INSERT INTO oxygen.map_patches (event_id, document_hash, enabled, ops) VALUES ($1, $2, false, '{}'::jsonb) RETURNING id`, e, documentHash);
  await one(`INSERT INTO oxygen.map_colour_settings (event_id, source_hash, colour_order, deviations, updated_by) VALUES ($1, $2, 'source', '{"k":1}'::jsonb, $3::uuid) RETURNING id`, e, sourceHash, goneUser.id);
  await one(`INSERT INTO oxygen.map_document_colour_settings (document_hash, colour_key, colour) VALUES ($1, $2, '{"c":0}'::jsonb) RETURNING colour_key AS id`, documentHash, `rt-${suffix}`);
  await db.mapGpsTrack.create({ data: { eventId: e, name: "t", sourceName: "t.gpx", points: { lat: [1, 2], lng: [3, 4], time: null, ele: null }, pointCount: 2, trimStart: 0, trimEnd: 2, createdBy: keptUserId } });

  server = Fastify({ logger: false });
  registerBackupRoute(server);
  await server.ready();
  const res = await server.inject({ method: "GET", url: `/api/backup/event?name=${src.nameId}` });
  expect(res.statusCode).toBe(200);
  dump = res.body;
  before = await snapshot(e);

  // The database loses the event, and one of the users.
  await db.event.delete({ where: { id: e } });
  await db.user.delete({ where: { id: goneUser.id } });
}, 60_000);

afterAll(async () => {
  await server?.close();
  const db = prisma();
  await db.event.deleteMany({ where: { nameId: src.nameId } });
  await db.$executeRawUnsafe(`DELETE FROM oxygen.permission_groups WHERE id = $1::uuid`, groupId);
  if (documentHash) {
    await db.$executeRawUnsafe(`DELETE FROM oxygen.map_document_colour_settings WHERE colour_key = $1`, `rt-${suffix}`);
  }
  await db.user.deleteMany({ where: { email: { endsWith: `@restore-${suffix}.example` } } });
  await disconnect();
}, 30_000);

describe("the dump against the schema", () => {
  it("dumps or excludes every event-scoped table", async () => {
    const rows = await prisma().$queryRawUnsafe<{ t: string }[]>(
      `SELECT DISTINCT table_name AS t FROM information_schema.columns WHERE table_schema = 'oxygen' AND column_name = 'event_id' ORDER BY 1`,
    );
    const missing = rows.map((r) => r.t).filter((t) => !(BACKUP_TABLES as readonly string[]).includes(t) && !(t in BACKUP_EXCLUDED));
    expect(missing).toEqual([]);
    for (const t of [...BACKUP_TABLES, ...Object.keys(BACKUP_EXCLUDED)]) {
      const [{ n }] = await prisma().$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'oxygen' AND table_name = $1`, t,
      );
      expect(n, `oxygen.${t} exists`).toBe(1);
    }
  });

  it("lists every table after each dumped table it references (restore order)", async () => {
    const fks = await prisma().$queryRawUnsafe<{ child: string; parent: string }[]>(
      `SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
        WHERE k.contype = 'f' AND k.connamespace = 'oxygen'::regnamespace`,
    );
    const order = BACKUP_TABLES as readonly string[];
    const wrong = fks
      .filter((f) => f.child !== f.parent && order.includes(f.child) && order.includes(f.parent))
      .filter((f) => order.indexOf(f.parent) > order.indexOf(f.child))
      .map((f) => `${f.child} -> ${f.parent}`);
    expect(wrong).toEqual([]);
  });

  it("has every section with a header row, the journal, and the completion marker last", () => {
    expect(dump).not.toContain("-- BACKUP FAILED");
    expect(dump.trimEnd().endsWith(BACKUP_COMPLETE_MARKER)).toBe(true);
    const sections = splitBackupSections(dump);
    expect([...sections.keys()]).toEqual([...BACKUP_TABLES]);
    for (const [t, csv] of sections) expect(csv.split("\n")[0], t).not.toBe("");
    expect(sections.get("journal")!.trim().split("\n")).toHaveLength(2);
  });
});

describe("runRestore", () => {
  it("restores every row of the lost event under a new id", async () => {
    const result = runRestore(dump);
    restoredId = result.eventId;
    expect(restoredId).not.toBe(src.eventId);
    const after = await snapshot(restoredId);
    // The permission of the user this database no longer has is skipped;
    // the other's granted_by (the same lost user) is cleared.
    const perms = before.event_permissions as { user_id: string; granted_by: string | null }[];
    expect(after.event_permissions).toEqual(perms.filter((p) => p.user_id === keptUserId).map((p) => ({ ...p, granted_by: null })));
    // The colour settings' updated_by (the lost user) is cleared too.
    expect(after.map_colour_settings).toEqual((before.map_colour_settings as object[]).map((r) => ({ ...r, updated_by: null })));
    const { event_permissions: _a, map_colour_settings: _c, ...restAfter } = after;
    const { event_permissions: _b, map_colour_settings: _d, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
    for (const t of ["runners", "cards", "card_readouts", "punches", "control_units", "map_templates", "classes", "course_maps", "course_objects", "journal", "graphics", "tracks", "routes", "card_readout_backups", "map_files", "map_patches", "map_gps_tracks", "map_colour_settings", "map_document_colour_settings", "event_seqs"]) {
      expect(after[t].length, t).toBeGreaterThan(0);
    }
  });

  it("renumbers the graphics, and the layout JSON draws the new ids", async () => {
    const [g] = await prisma().$queryRawUnsafe<{ id: string }[]>(`SELECT id::text AS id FROM oxygen.graphics WHERE event_id = $1`, restoredId);
    const [t] = await prisma().$queryRawUnsafe<{ objects: { graphicId?: number }[] }[]>(`SELECT objects FROM oxygen.map_templates WHERE event_id = $1`, restoredId);
    const [o] = await prisma().$queryRawUnsafe<{ props: { graphicId?: number } }[]>(`SELECT props FROM oxygen.course_objects WHERE event_id = $1 AND kind = 'image'`, restoredId);
    expect(t.objects[0].graphicId).toBe(Number(g.id));
    expect(o.props.graphicId).toBe(Number(g.id));
    // The dumped id is not reused: another database may hold it.
    const dumped = splitBackupSections(dump).get("graphics")!.split("\n")[1].split(",")[0];
    expect(g.id).not.toBe(dumped);
  });

  it("refuses to restore over the event a second time", () => {
    expect(() => runRestore(dump)).toThrow(RestoreError);
    expect(() => runRestore(dump)).toThrow(/already exists in this database: pass --replace/);
  });

  it("restores it again in place with replace", async () => {
    const again = runRestore(dump, { replace: true });
    expect(again.eventId).not.toBe(restoredId);
    const [{ n }] = await prisma().$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM oxygen.events WHERE name_id = $1`, src.nameId);
    expect(n).toBe(1);
    const after = await snapshot(again.eventId);
    expect(after.runners).toEqual(before.runners);
    expect(after.punches).toEqual(before.punches);
    restoredId = again.eventId;
  });

  it("refuses a cut-short dump and leaves nothing behind", async () => {
    // Cut in the race data, before the journal section (M1).
    const cut = dump.slice(0, dump.indexOf("--- punches ---"));
    expect(() => runRestore(cut, { replace: true })).toThrow(/cut short/);
    const [{ n }] = await prisma().$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM oxygen.events WHERE name_id = $1`, src.nameId);
    expect(n).toBe(1);
  });
});

describe("the backup route", () => {
  it("aborts the HTTP transfer when psql fails mid-dump (DB-13)", async () => {
    const live = await createTestEvent("restore_abort");
    const http = Fastify({ logger: false });
    registerBackupRoute(http, {
      spawnDump: () => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = Object.assign(new EventEmitter(), { kill: () => true });
        const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
          setTimeout(() => {
            stdout.write("--- events ---\nid\n1\n");
            setTimeout(() => {
              stdout.end();
              resolve({ code: 3, stderr: "ERROR:  boom" });
            }, 50);
          }, 10);
        });
        return { child, stdout, stderr, exited } as unknown as PgDumpProcess;
      },
    });
    try {
      const address = await http.listen({ port: 0, host: "127.0.0.1" });
      const res = await fetch(`${address}/api/backup/event?name=${live.nameId}`);
      expect(res.status).toBe(200);
      await expect(res.text()).rejects.toThrow();
    } finally {
      await http.close();
      await live.cleanup();
    }
  });

  it("answers 502 and no attachment when psql cannot reach the database (BLD-01)", async () => {
    const saved = process.env.DATABASE_URL!;
    // The event must exist for the route to start a dump.
    const live = await createTestEvent("restore_502");
    try {
      process.env.DATABASE_URL = "postgresql://oxygen:oxygen@127.0.0.1:1/oxygen?schema=oxygen";
      const res = await server.inject({ method: "GET", url: `/api/backup/event?name=${live.nameId}` });
      expect(res.statusCode).toBe(502);
      expect(res.headers["content-disposition"]).toBeUndefined();
      expect(res.json().error).toContain("Backup failed");
    } finally {
      process.env.DATABASE_URL = saved;
      await live.cleanup();
    }
  });
});
