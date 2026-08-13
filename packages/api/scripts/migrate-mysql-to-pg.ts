#!/usr/bin/env tsx
/**
 * One-shot migration: MeOS-compatible MySQL → Oxygen PostgreSQL 18.
 *
 * Default scope: Vinterserien + Bagissprinten.
 *
 * Usage:
 *   LEGACY_MYSQL_URL=mysql://meos@localhost:3306/MeOSMain \
 *   DATABASE_URL=postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen \
 *     pnpm migrate:mysql-to-pg [--dry-run] [--force] [--nameId X] ...
 *
 * Each per-event migration runs in its own Postgres transaction. The
 * directories + global settings are migrated once at the end.
 *
 * See docs/migrations/2026-drop-meos.md.
 */

import mysql, { type RowDataPacket } from "mysql2/promise";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  valueToRunnerStatus,
  valueToControlStatus,
} from "../src/statusConvert.js";

// ─── CLI args ──────────────────────────────────────────────

interface Args {
  nameIds: string[];
  all: boolean;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(): Args {
  const out: Args = { nameIds: [], all: false, dryRun: false, force: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
    else if (a === "--nameId" || a === "--name") {
      const next = argv[++i];
      if (!next) throw new Error(`${a} requires a value`);
      out.nameIds.push(next);
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      out.nameIds.push(a);
    }
  }
  if (!out.all && out.nameIds.length === 0) {
    // Default scope per the migration plan.
    out.nameIds = ["Vinterserien", "Bagissprinten"];
  }
  return out;
}

// ─── Connection ────────────────────────────────────────────

interface Connections {
  mysqlMain: mysql.Connection;
  legacyMysqlBaseUrl: string;
  pg: PrismaClient;
}

function parseMysqlUrl(url: string): {
  baseUrl: string;
  user?: string;
  host: string;
  port: number;
} {
  const u = new URL(url);
  return {
    baseUrl: url,
    user: u.username ? decodeURIComponent(u.username) : undefined,
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 3306,
  };
}

function buildLegacyDbUrl(baseUrl: string, dbName: string): string {
  return baseUrl.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
}

async function openConnections(): Promise<Connections> {
  const legacyUrl =
    process.env.LEGACY_MYSQL_URL ?? "mysql://meos@localhost:3306/MeOSMain";
  const targetUrl = process.env.DATABASE_URL;
  if (!targetUrl) {
    throw new Error(
      "DATABASE_URL must be set (point at the target PostgreSQL).",
    );
  }
  const mysqlMain = await mysql.createConnection(legacyUrl);
  const pgUrl = process.env.DATABASE_URL;
  if (!pgUrl) throw new Error("DATABASE_URL is not set");
  const pg = new PrismaClient({ adapter: new PrismaPg({ connectionString: pgUrl }) });
  return { mysqlMain, legacyMysqlBaseUrl: legacyUrl, pg };
}

// ─── Helpers ───────────────────────────────────────────────

/** Convert MeOS YYYY-MM-DD string to JS Date (UTC, day-only). */
function parseDate(s: string | Date): Date {
  if (s instanceof Date) return s;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error(`Bad date: ${s}`);
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
}

/** MeOS x*10 → real decimal, NULL when 0. */
function coordX10(v: number | null | undefined): number {
  return (v ?? 0) / 10;
}
function coordE6(v: number | null | undefined): number | null {
  if (!v) return null;
  return v / 1_000_000;
}

/** Normalise BirthYear (MeOS may store YYYYMMDD). */
function normYear(v: number | null | undefined): number {
  if (!v) return 0;
  return v > 9999 ? Math.floor(v / 10000) : v;
}

/**
 * Clamp a value into Postgres INTEGER (signed 32-bit) range. MeOS used
 * `int unsigned` for several counter columns (ReadId, Voltage, …) that
 * can legitimately overflow int32 over a card's lifetime, plus the
 * occasional corrupt legacy row that returns a near-uint32 value where
 * we'd expect a small number.
 *
 * - When `maxPlausible` is passed (e.g. for voltages where >100_000 mV
 *   is clearly garbage), values above the bound are dropped to 0.
 * - Otherwise values above INT32_MAX are clamped to INT32_MAX, which
 *   preserves "very large" semantics for monotonically-growing counters
 *   like ReadId without losing the row.
 */
function clampInt32(v: number | null | undefined, maxPlausible = Infinity): number {
  const MAX = 2_147_483_647;
  const n = Number(v) || 0;
  if (n < 0) return 0;
  if (n > maxPlausible) return 0;
  if (n > MAX) return MAX;
  return n;
}

// ─── Logging ───────────────────────────────────────────────

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function step(name: string, count: number): void {
  log(`    ${name}: ${count}`);
}

// ─── MeOSMain lookup ───────────────────────────────────────

interface LegacyEvent {
  id: number;
  name: string;
  nameId: string;
  date: string | Date;
  removed: number;
}

async function lookupEvent(
  mainConn: mysql.Connection,
  nameId: string,
): Promise<LegacyEvent | null> {
  const [rows] = await mainConn.execute<RowDataPacket[]>(
    "SELECT Id, Name, NameId, Date, Removed FROM oEvent WHERE NameId = ?",
    [nameId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.Id),
    name: String(r.Name),
    nameId: String(r.NameId),
    date: r.Date as string,
    removed: Number(r.Removed),
  };
}

// ─── Per-event migration ───────────────────────────────────

interface MigrationCounts {
  controls: number;
  courses: number;
  courseControls: number;
  classes: number;
  runners: number;
  teams: number;
  cards: number;
  cardReadouts: number;
  punches: number;
  controlUnits: number;
  eventLog: number;
  mapFiles: number;
}

async function migrateEvent(
  conns: Connections,
  legacy: LegacyEvent,
  args: Args,
): Promise<MigrationCounts | "skipped"> {
  log("");
  log(`━━ ${legacy.nameId} (#${legacy.id}) ━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Check whether this event already exists in PG.
  const existing = await conns.pg.event.findUnique({
    where: { nameId: legacy.nameId },
    select: { id: true, nameId: true, removed: true },
  });
  if (existing && !args.force) {
    log(`  ⏭  already in PG (event_id=${existing.id}); use --force to re-import.`);
    return "skipped";
  }
  if (existing && args.force) {
    log(`  ↻  --force: removing existing event_id=${existing.id} + all children`);
    if (!args.dryRun) {
      // CASCADE deletes children.
      await conns.pg.event.delete({ where: { id: existing.id } });
    }
  }

  // Open the per-event source DB.
  const eventDbUrl = buildLegacyDbUrl(conns.legacyMysqlBaseUrl, legacy.nameId);
  const src = await mysql.createConnection({
    uri: eventDbUrl,
    typeCast: (field, next) => {
      // Default cast — keep mysql2 defaults.
      return next();
    },
  });

  try {
    // ── 1. Build the events row from oEvent + oxygen_competition_config ──
    const [eventRows] = await src.execute<RowDataPacket[]>(
      `SELECT Name, Date, ZeroTime, Annotation, Organizer, ExtId,
              CardFee, EntryFee, EliteFee, YouthFee, YouthAge, SeniorAge,
              MaxTime, NumStages
         FROM oEvent
         WHERE Removed = 0
         LIMIT 1`,
    );
    if (eventRows.length === 0) {
      log(`  ⚠  no live oEvent row inside ${legacy.nameId}; using registry data.`);
    }
    const e = eventRows[0] ?? {
      Name: legacy.name,
      Date: legacy.date,
      ZeroTime: 324000,
      Annotation: "",
      Organizer: "",
      ExtId: 0,
      CardFee: 0,
      EntryFee: 0,
      EliteFee: 0,
      YouthFee: 0,
      YouthAge: 0,
      SeniorAge: 0,
      MaxTime: 0,
      NumStages: 1,
    };

    const [cfgRows] = await src.execute<RowDataPacket[]>(
      `SELECT * FROM oxygen_competition_config WHERE id = 1 LIMIT 1`,
    );
    const cfg = cfgRows[0] ?? null;

    // Per-event settings from MeOSMain.oxygen_settings
    const [perEventSettings] = await conns.mysqlMain.execute<RowDataPacket[]>(
      `SELECT SettingKey, SettingValue FROM oxygen_settings WHERE SettingKey LIKE ?`,
      [`%_${legacy.nameId}`],
    );
    const settingsMap = new Map<string, string | null>();
    for (const r of perEventSettings) {
      settingsMap.set(String(r.SettingKey), (r.SettingValue as string | null));
    }
    const eventorEnv =
      (settingsMap.get(`eventor_env_${legacy.nameId}`) as
        | "prod"
        | "test"
        | null) ?? "prod";
    const liveresultsTavidRaw = settingsMap.get(
      `liveresults_tavid_${legacy.nameId}`,
    );
    const liveresultsTavid = liveresultsTavidRaw
      ? parseInt(liveresultsTavidRaw, 10)
      : null;
    const liveresultsConfigRaw = settingsMap.get(
      `liveresults_config_${legacy.nameId}`,
    );
    let liveresultsConfig: unknown = null;
    if (liveresultsConfigRaw) {
      try {
        liveresultsConfig = JSON.parse(liveresultsConfigRaw);
      } catch {
        liveresultsConfig = { raw: liveresultsConfigRaw };
      }
    }

    if (args.dryRun) {
      log(`  [DRY] would create event ${legacy.nameId}`);
    }

    const eventRow = args.dryRun
      ? { id: BigInt(-1), nameId: legacy.nameId }
      : await conns.pg.event.create({
          data: {
            nameId: legacy.nameId,
            name: String(e.Name),
            annotation: String(e.Annotation ?? ""),
            date: parseDate(e.Date as string),
            zeroTime: Number(e.ZeroTime) || 324000,
            kind: "competition",
            eventorEventId: e.ExtId ? BigInt(e.ExtId as number | bigint) : null,
            eventorEnv,
            liveresultsTavid: liveresultsTavid ?? null,
            liveresultsConfig: (liveresultsConfig as never) ?? undefined,
            organizerName: String(e.Organizer ?? ""),
            cardFeeCents: Number(e.CardFee) || 0,
            entryFeeCents: Number(e.EntryFee) || 0,
            eliteFeeCents: Number(e.EliteFee) || 0,
            youthFeeCents: Number(e.YouthFee) || 0,
            youthAge: Number(e.YouthAge) || 0,
            seniorAge: Number(e.SeniorAge) || 0,
            maxTime: Number(e.MaxTime) || 0,
            numStages: Number(e.NumStages) || 1,
            // From oxygen_competition_config
            airPlus: cfg ? Boolean(cfg.air_plus) : false,
            awakeHours: cfg ? Number(cfg.awake_hours) || 6 : 6,
            paymentMethods: cfg ? String(cfg.payment_methods ?? "billed") : "billed",
            swishNumber: cfg ? String(cfg.swish_number ?? "") : "",
            swishPayeeName: cfg ? String(cfg.swish_payee_name ?? "") : "",
            printRegistrationReceipt: cfg
              ? Boolean(cfg.print_registration_receipt)
              : false,
            registrationReceiptMessage: cfg
              ? String(cfg.registration_receipt_message ?? "")
              : "",
            finishReceiptMessage: cfg
              ? String(cfg.finish_receipt_message ?? "")
              : "",
            organizerEventorId: cfg ? Number(cfg.organizer_eventor_id) || 0 : 0,
            orgNumber: cfg ? String(cfg.org_number ?? "") : "",
            vatExempt: cfg ? Boolean(cfg.vat_exempt) : true,
            receiptFriskvardNote: cfg
              ? Boolean(cfg.receipt_friskvard_note)
              : false,
            webUrl: cfg ? String(cfg.web_url ?? "") : "",
            googleSheetsWebhookUrl: cfg
              ? String(cfg.google_sheets_webhook_url ?? "")
              : "",
            liveloxEventId: cfg ? (cfg.livelox_event_id ?? null) : null,
          },
          select: { id: true, nameId: true },
        });

    log(`  ✓ events row id=${eventRow.id}`);
    const eventId = eventRow.id;

    // ── 2. Clubs (build map only — clubs no longer per-event) ──
    const [clubRows] = await src.execute<RowDataPacket[]>(
      `SELECT Id, Name, ExtId FROM oClub WHERE Removed = 0`,
    );
    interface ClubRef {
      name: string;
      eventorClubId: bigint | null;
    }
    const clubMap = new Map<number, ClubRef>();
    for (const r of clubRows) {
      clubMap.set(Number(r.Id), {
        name: String(r.Name),
        eventorClubId: r.ExtId ? BigInt(r.ExtId as number | bigint) : null,
      });
    }
    log(`    clubs (mapped only, no table): ${clubMap.size}`);

    const counts: MigrationCounts = {
      controls: 0,
      courses: 0,
      courseControls: 0,
      classes: 0,
      runners: 0,
      teams: 0,
      cards: 0,
      cardReadouts: 0,
      punches: 0,
      controlUnits: 0,
      eventLog: 0,
      mapFiles: 0,
    };

    if (args.dryRun) {
      // Just count.
      for (const [t, q] of [
        ["oControl", "SELECT COUNT(*) c FROM oControl WHERE Removed = 0"],
        ["oCourse", "SELECT COUNT(*) c FROM oCourse WHERE Removed = 0"],
        ["oClass", "SELECT COUNT(*) c FROM oClass WHERE Removed = 0"],
        ["oRunner", "SELECT COUNT(*) c FROM oRunner WHERE Removed = 0"],
        ["oTeam", "SELECT COUNT(*) c FROM oTeam WHERE Removed = 0"],
        ["oCard", "SELECT COUNT(*) c FROM oCard WHERE Removed = 0"],
        ["oPunch", "SELECT COUNT(*) c FROM oPunch WHERE Removed = 0"],
        ["oxygen_card_readouts", "SELECT COUNT(*) c FROM oxygen_card_readouts"],
        ["oxygen_control_units", "SELECT COUNT(*) c FROM oxygen_control_units"],
        ["oxygen_map_files", "SELECT COUNT(*) c FROM oxygen_map_files"],
      ] as const) {
        try {
          const [rows] = await src.execute<RowDataPacket[]>(q);
          step(`[DRY] ${t}`, Number(rows[0]?.c) || 0);
        } catch {
          step(`[DRY] ${t}`, 0);
        }
      }
      return counts;
    }

    // ── 3. Controls (seq = oControl.Id) ──
    const [controlRows] = await src.execute<RowDataPacket[]>(
      `SELECT Id, Name, Numbers, Status, TimeAdjust, MinTime,
              xpos, ypos, latcrd, longcrd
         FROM oControl WHERE Removed = 0`,
    );
    const controlIdMap = new Map<number, string>(); // legacy Id → PG UUID
    for (const r of controlRows) {
      const row = await conns.pg.control.create({
        data: {
          eventId,
          seq: Number(r.Id),
          name: String(r.Name ?? ""),
          codes: String(r.Numbers ?? ""),
          status: valueToControlStatus(Number(r.Status) || 0),
          timeAdjust: Number(r.TimeAdjust) || 0,
          minTime: Number(r.MinTime) || 0,
          xpos: coordX10(Number(r.xpos)),
          ypos: coordX10(Number(r.ypos)),
          lat: coordE6(Number(r.latcrd)),
          lng: coordE6(Number(r.longcrd)),
        },
        select: { id: true },
      });
      controlIdMap.set(Number(r.Id), row.id);
      counts.controls++;
    }
    step("controls", counts.controls);

    // Bring over per-control config (radio_type / air_plus).
    const [controlCfgRows] = await src.execute<RowDataPacket[]>(
      `SELECT control_id, radio_type, air_plus FROM oxygen_control_config`,
    );
    for (const r of controlCfgRows) {
      const uuid = controlIdMap.get(Number(r.control_id));
      if (!uuid) continue;
      const data: Record<string, unknown> = {};
      if (r.radio_type) data.radioType = String(r.radio_type);
      if (r.air_plus) data.airPlus = String(r.air_plus);
      if (Object.keys(data).length > 0) {
        await conns.pg.control.update({ where: { id: uuid }, data });
      }
    }

    // ── 4. Courses (seq = oCourse.Id) ──
    const [courseRows] = await src.execute<RowDataPacket[]>(
      `SELECT Id, Name, Length, Climb, NumberMaps, StartName, Legs,
              FirstAsStart, LastAsFinish, CControl, Shorten, Controls
         FROM oCourse WHERE Removed = 0`,
    );
    const courseIdMap = new Map<number, string>();
    interface PendingCourseControls {
      courseUuid: string;
      controlSeqs: number[];
    }
    const pendingCC: PendingCourseControls[] = [];
    for (const r of courseRows) {
      const row = await conns.pg.course.create({
        data: {
          eventId,
          seq: Number(r.Id),
          name: String(r.Name ?? ""),
          lengthM: Number(r.Length) || 0,
          climbM: Number(r.Climb) || 0,
          numberOfMaps: Number(r.NumberMaps) || 0,
          startName: String(r.StartName ?? ""),
          legs: String(r.Legs ?? ""),
          firstAsStart: Boolean(r.FirstAsStart),
          lastAsFinish: Boolean(r.LastAsFinish),
          shorten: Number(r.Shorten) || 0,
        },
        select: { id: true },
      });
      courseIdMap.set(Number(r.Id), row.id);
      counts.courses++;
      // Parse Controls string ("123;456;789;") into seq list.
      const seqs = String(r.Controls ?? "")
        .split(";")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0);
      pendingCC.push({ courseUuid: row.id, controlSeqs: seqs });
    }
    step("courses", counts.courses);

    // ── 5. course_controls (resolved from controlIdMap) ──
    for (const pc of pendingCC) {
      const rows: { courseId: string; position: number; controlId: string }[] =
        [];
      let position = 1;
      let warned = false;
      for (const cseq of pc.controlSeqs) {
        const controlUuid = controlIdMap.get(cseq);
        if (!controlUuid) {
          if (!warned) {
            log(
              `    ⚠  course ${pc.courseUuid}: unresolved control seq ${cseq} (skipped)`,
            );
            warned = true;
          }
          continue;
        }
        rows.push({
          courseId: pc.courseUuid,
          position: position++,
          controlId: controlUuid,
        });
      }
      if (rows.length > 0) {
        await conns.pg.courseControl.createMany({
          data: rows,
        });
        counts.courseControls += rows.length;
      }
    }
    step("course_controls", counts.courseControls);

    // ── 6. Classes (seq = oClass.Id) ──
    const [classRows] = await src.execute<RowDataPacket[]>(
      `SELECT Id, Name, LongName, Course, ExtId, LowAge, HighAge, Sex,
              ClassType, ClassFee, ClassFeeRed, HighClassFee, HighClassFeeRed,
              SecondHighClassFee, SecondHighClassFeeRed,
              AllowQuickEntry, Vacant, Reserved, StartName, StartBlock,
              NoTiming, FreeStart, RequestStart, IgnoreStart,
              FirstStart, StartInterval, SortIndex, MaxTime, Status,
              DirectResult, Bib, BibMode, Unordered, NumberMaps, Result,
              LegMethod, TransferFlags
         FROM oClass WHERE Removed = 0`,
    );
    const classIdMap = new Map<number, string>();
    for (const r of classRows) {
      const courseUuid = courseIdMap.get(Number(r.Course)) ?? null;
      const row = await conns.pg.class.create({
        data: {
          eventId,
          seq: Number(r.Id),
          name: String(r.Name ?? ""),
          longName: String(r.LongName ?? ""),
          courseId: courseUuid,
          eventorId: r.ExtId ? BigInt(r.ExtId as number | bigint) : null,
          lowAge: Number(r.LowAge) || 0,
          highAge: Number(r.HighAge) || 0,
          sex: String(r.Sex ?? ""),
          classType: String(r.ClassType ?? ""),
          classFeeCents: Number(r.ClassFee) || 0,
          classFeeRedCents: Number(r.ClassFeeRed) || 0,
          highClassFeeCents: Number(r.HighClassFee) || 0,
          highClassFeeRedCents: Number(r.HighClassFeeRed) || 0,
          secondHighClassFeeCents: Number(r.SecondHighClassFee) || 0,
          secondHighClassFeeRedCents: Number(r.SecondHighClassFeeRed) || 0,
          allowQuickEntry: Boolean(r.AllowQuickEntry),
          vacantCount: Number(r.Vacant) || 0,
          reservedCount: Number(r.Reserved) || 0,
          startName: String(r.StartName ?? ""),
          startBlock: Number(r.StartBlock) || 0,
          noTiming: Boolean(r.NoTiming),
          freeStart: Boolean(r.FreeStart),
          requestStart: Boolean(r.RequestStart),
          ignoreStart: Boolean(r.IgnoreStart),
          firstStart: Number(r.FirstStart) || 0,
          startInterval: Number(r.StartInterval) || 0,
          sortIndex: Number(r.SortIndex) || 0,
          maxTime: Number(r.MaxTime) || 0,
          status: String(r.Status ?? ""),
          directResult: Boolean(r.DirectResult),
          bib: String(r.Bib ?? ""),
          bibMode: String(r.BibMode ?? ""),
          unordered: Boolean(r.Unordered),
          numberMaps: Number(r.NumberMaps) || 0,
          result: String(r.Result ?? ""),
          legMethod: String(r.LegMethod ?? ""),
          transferFlags: Number(r.TransferFlags) || 0,
        },
        select: { id: true },
      });
      classIdMap.set(Number(r.Id), row.id);
      counts.classes++;
    }
    step("classes", counts.classes);

    // ── 7. Cards (seq = oCard.Id) ──
    const [cardRows] = await src.execute<RowDataPacket[]>(
      `SELECT Id, CardNo, ReadId, Voltage, BDate, Punches
         FROM oCard WHERE Removed = 0`,
    );
    const cardIdMap = new Map<number, string>();
    for (const r of cardRows) {
      const row = await conns.pg.card.create({
        data: {
          eventId,
          seq: Number(r.Id),
          cardNo: clampInt32(Number(r.CardNo)),
          readCount: clampInt32(Number(r.ReadId)),
          voltageMv: clampInt32(Number(r.Voltage), 100_000),
          batteryDate: clampInt32(Number(r.BDate)),
          punchesRaw: String(r.Punches ?? ""),
        },
        select: { id: true },
      });
      cardIdMap.set(Number(r.Id), row.id);
      counts.cards++;
    }
    step("cards", counts.cards);

    // ── 8. Runners (seq = oRunner.Id) ──
    const [runnerRows] = await src.execute<RowDataPacket[]>(
      `SELECT Id, Name, CardNo, Club, Class, Course, Card, StartNo,
              StartTime, FinishTime, Status, Bib, BirthYear, Sex,
              Nationality, Country, Phone, EntryDate, EntryTime,
              EntrySource, ExtId, ExtId2,
              Fee, CardFee, Paid, PayMode, Taxable,
              Priority, TimeAdjust, PointAdjust, TransferFlags, Shorten,
              StartGroup, NoRestart, Heat, Reference, Family, \`Rank\`,
              Annotation
         FROM oRunner WHERE Removed = 0`,
    );
    const runnerIdMap = new Map<number, string>();
    let runnerBatch: Parameters<typeof conns.pg.runner.create>[0]["data"][] = [];
    const FLUSH_AT = 500;
    const flushRunners = async () => {
      if (runnerBatch.length === 0) return;
      // createMany doesn't return ids; emulate by chunking inserts so we get
      // the (legacy_id → uuid) map.
      for (const data of runnerBatch) {
        const row = await conns.pg.runner.create({
          data,
          select: { id: true, seq: true },
        });
        runnerIdMap.set(row.seq, row.id);
        counts.runners++;
      }
      runnerBatch = [];
    };
    for (const r of runnerRows) {
      const club = clubMap.get(Number(r.Club));
      const cardUuid =
        Number(r.Card) > 0 ? cardIdMap.get(Number(r.Card)) ?? null : null;
      runnerBatch.push({
        eventId,
        seq: Number(r.Id),
        classId: classIdMap.get(Number(r.Class)) ?? null,
        clubName: club?.name ?? "",
        eventorClubId: club?.eventorClubId ?? null,
        courseId: courseIdMap.get(Number(r.Course)) ?? null,
        cardId: cardUuid,
          name: String(r.Name ?? ""),
          cardNo: clampInt32(Number(r.CardNo)),
          startNo: clampInt32(Number(r.StartNo)),
          startTime: clampInt32(Number(r.StartTime)),
          finishTime: clampInt32(Number(r.FinishTime)),
          status: valueToRunnerStatus(Number(r.Status) || 0),
          bib: String(r.Bib ?? ""),
          birthYear: normYear(Number(r.BirthYear)),
        sex: String(r.Sex ?? ""),
        nationality: String(r.Nationality ?? ""),
        country: String(r.Country ?? ""),
        phone: String(r.Phone ?? ""),
        entryDate: Number(r.EntryDate) || 0,
        entryTime: Number(r.EntryTime) || 0,
        entrySource: Number(r.EntrySource) || 0,
        eventorPersonId: r.ExtId ? BigInt(r.ExtId as number | bigint) : null,
        eventorEntryId: r.ExtId2 ? BigInt(r.ExtId2 as number | bigint) : null,
        feeCents: Number(r.Fee) || 0,
        cardFeeCents: Number(r.CardFee) || 0,
        paidCents: Number(r.Paid) || 0,
        payMode: Number(r.PayMode) || 0,
        taxableCents: Number(r.Taxable) || 0,
        priority: Number(r.Priority) || 0,
        timeAdjust: Number(r.TimeAdjust) || 0,
        pointAdjust: Number(r.PointAdjust) || 0,
        transferFlags: Number(r.TransferFlags) || 0,
        shorten: Boolean(r.Shorten),
        startGroup: Number(r.StartGroup) || 0,
        noRestart: Boolean(r.NoRestart),
        heat: Number(r.Heat) || 0,
        reference: Number(r.Reference) || 0,
        family: Number(r.Family) || 0,
        rank: Number(r["Rank"]) || 0,
        annotation: String(r.Annotation ?? ""),
      });
      if (runnerBatch.length >= FLUSH_AT) await flushRunners();
    }
    await flushRunners();
    step("runners", counts.runners);

    // ── 9. Teams (seq = oTeam.Id) ──
    const [teamRows] = await src.execute<RowDataPacket[]>(
      `SELECT Id, Name, Class, Club, StartNo, StartTime, FinishTime, Status,
              Bib, Runners, ExtId
         FROM oTeam WHERE Removed = 0`,
    );
    for (const r of teamRows) {
      const club = clubMap.get(Number(r.Club));
      // Convert MeOS team "Runners" string ("id1;id2;id3;") to UUID[]
      const memberSeqs = String(r.Runners ?? "")
        .split(";")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0);
      const memberUuids = memberSeqs
        .map((s) => runnerIdMap.get(s))
        .filter((u): u is string => !!u);
      await conns.pg.team.create({
        data: {
          eventId,
          seq: Number(r.Id),
          classId: classIdMap.get(Number(r.Class)) ?? null,
          clubName: club?.name ?? "",
          eventorClubId: club?.eventorClubId ?? null,
          name: String(r.Name ?? ""),
          startNo: Number(r.StartNo) || 0,
          startTime: Number(r.StartTime) || 0,
          finishTime: Number(r.FinishTime) || 0,
          status: valueToRunnerStatus(Number(r.Status) || 0),
          bib: String(r.Bib ?? ""),
          members: memberUuids,
          eventorId: r.ExtId ? BigInt(r.ExtId as number | bigint) : null,
        },
      });
      counts.teams++;
    }
    step("teams", counts.teams);

    // ── 10. Punches (UUID, no seq) ──
    const [punchRows] = await src.execute<RowDataPacket[]>(
      `SELECT CardNo, Type, Time, Origin FROM oPunch WHERE Removed = 0`,
    );
    if (punchRows.length > 0) {
      const punchData = punchRows.map((r) => ({
        eventId,
        cardNo: clampInt32(Number(r.CardNo)),
        controlCode: clampInt32(Number(r.Type)),
        time: clampInt32(Number(r.Time)),
        source: "card",
        isOriginal: Number(r.Origin) > 0,
      }));
      // createMany doesn't enforce per-row trigger semantics — that's fine here.
      const r = await conns.pg.punch.createMany({ data: punchData });
      counts.punches += r.count;
    }

    // ── 11. Backup-memory punches → punches with source='backup_memory' ──
    const [bmPunches] = await src.execute<RowDataPacket[]>(
      `SELECT control_id, card_no, punch_time, punch_datetime,
              sub_second, station_serial
         FROM oxygen_control_punches`,
    );
    if (bmPunches.length > 0) {
      const data = bmPunches.map((r) => ({
        eventId,
        cardNo: clampInt32(Number(r.card_no)),
        controlCode: 0, // unknown — would need a lookup from control_id
        controlId: controlIdMap.get(Number(r.control_id)) ?? null,
        time: clampInt32(Number(r.punch_time)),
        punchedAt: r.punch_datetime as Date | null,
        subSecond: r.sub_second != null ? Number(r.sub_second) : null,
        source: "backup_memory",
        isOriginal: true,
      }));
      const rrr = await conns.pg.punch.createMany({ data });
      counts.punches += rrr.count;
    }
    step("punches", counts.punches);

    // ── 12. card_readouts (UUID, no seq) ──
    const [crRows] = await src.execute<RowDataPacket[]>(
      `SELECT Id, CardNo, CardType, Punches, Voltage, OwnerData, Metadata, ReadAt
         FROM oxygen_card_readouts`,
    );
    if (crRows.length > 0) {
      const data = crRows.map((r) => {
        let owner: unknown = null;
        let meta: unknown = null;
        try {
          if (r.OwnerData) owner = JSON.parse(String(r.OwnerData));
        } catch {
          owner = { raw: String(r.OwnerData) };
        }
        try {
          if (r.Metadata) meta = JSON.parse(String(r.Metadata));
        } catch {
          meta = { raw: String(r.Metadata) };
        }
        return {
          eventId,
          cardNo: clampInt32(Number(r.CardNo)),
          cardType: String(r.CardType ?? ""),
          punches: { raw: String(r.Punches ?? "") } as never, // matcher pending
          voltageMv: clampInt32(Number(r.Voltage), 100_000),
          ownerData: (owner ?? undefined) as never,
          metadata: (meta ?? undefined) as never,
          readAt: r.ReadAt as Date,
        };
      });
      const rrr = await conns.pg.cardReadout.createMany({ data });
      counts.cardReadouts += rrr.count;
    }
    step("card_readouts", counts.cardReadouts);

    // ── 13. control_units ──
    const [unitRows] = await src.execute<RowDataPacket[]>(
      `SELECT station_serial, control_id, last_programmed_code,
              battery_voltage, battery_low, checked_at, memory_cleared_at,
              firmware_version, model_id, model_name, last_seen_at
         FROM oxygen_control_units`,
    );
    for (const r of unitRows) {
      await conns.pg.controlUnit.create({
        data: {
          eventId,
          stationSerial: Number(r.station_serial),
          controlId: controlIdMap.get(Number(r.control_id)) ?? null,
          lastProgrammedCode:
            r.last_programmed_code != null ? Number(r.last_programmed_code) : null,
          batteryVoltageMv:
            r.battery_voltage != null
              ? Math.round(Number(r.battery_voltage) * 1000)
              : null,
          batteryLow: Boolean(r.battery_low),
          checkedAt: r.checked_at as Date | null,
          memoryClearedAt: r.memory_cleared_at as Date | null,
          firmwareVersion: r.firmware_version as string | null,
          modelId: r.model_id != null ? Number(r.model_id) : null,
          modelName: r.model_name as string | null,
          lastSeenAt: r.last_seen_at as Date | null,
        },
      });
      counts.controlUnits++;
    }
    step("control_units", counts.controlUnits);

    // ── 14. map_files ──
    try {
      const [mfRows] = await src.execute<RowDataPacket[]>(
        `SELECT Id, FileName, FileData, UploadedAt FROM oxygen_map_files`,
      );
      for (const r of mfRows) {
        await conns.pg.mapFile.create({
          data: {
            eventId,
            fileName: String(r.FileName ?? ""),
            fileData: r.FileData as Buffer,
            uploadedAt: r.UploadedAt as Date,
          },
        });
        counts.mapFiles++;
      }
    } catch {
      // table may not exist on older events
    }
    step("map_files", counts.mapFiles);

    // ── 15. Fix up event_seqs.next_seq to MAX(seq)+1 per (event, table) ──
    const seqTables = [
      "controls",
      "courses",
      "classes",
      "runners",
      "teams",
      "cards",
      "control_units",
    ];
    for (const t of seqTables) {
      await conns.pg.$executeRawUnsafe(
        `INSERT INTO oxygen.event_seqs (event_id, table_name, next_seq)
         SELECT $1, $2, COALESCE((SELECT MAX(seq) FROM oxygen.${t} WHERE event_id = $1), 0) + 1
         ON CONFLICT (event_id, table_name) DO UPDATE SET next_seq = EXCLUDED.next_seq`,
        eventId,
        t,
      );
    }
    log(`  ✓ event_seqs bumped (next allocation continues past migrated max)`);

    return counts;
  } finally {
    await src.end();
  }
}

// ─── Global migration ──────────────────────────────────────

async function migrateGlobals(conns: Connections, args: Args): Promise<void> {
  log("");
  log("━━ Global directories & settings ━━━━━━━━━━━━━━━━━━━━━━━━━");

  // settings — only truly global keys; per-event ones land in events row.
  const GLOBAL_KEYS = new Set([
    "eventor_api_key",
    "eventor_api_key_test",
    "runnerdb_last_sync",
    "runnerdb_runner_count",
    "runnerdb_club_count",
  ]);
  const [settingRows] = await conns.mysqlMain.execute<RowDataPacket[]>(
    `SELECT SettingKey, SettingValue FROM oxygen_settings`,
  );
  let copiedSettings = 0;
  for (const r of settingRows) {
    const key = String(r.SettingKey);
    if (!GLOBAL_KEYS.has(key)) continue;
    if (args.dryRun) {
      log(`  [DRY] settings: ${key}`);
      continue;
    }
    await conns.pg.setting.upsert({
      where: { key },
      create: { key, value: r.SettingValue as string | null },
      update: { value: r.SettingValue as string | null },
    });
    copiedSettings++;
  }
  log(`    settings: ${copiedSettings}`);

  // runner_directory
  let rdCount = 0;
  try {
    const [rdRows] = await conns.mysqlMain.execute<RowDataPacket[]>(
      `SELECT ExtId, Name, CardNo, ClubId, BirthYear, Sex, Nationality FROM oxygen_runner_db`,
    );
    if (args.dryRun) {
      log(`  [DRY] runner_directory: ${rdRows.length}`);
    } else {
      // Bulk in batches for the 250k-row directory.
      const batchSize = 1000;
      for (let i = 0; i < rdRows.length; i += batchSize) {
        const slice = rdRows.slice(i, i + batchSize).map((r) => ({
          eventorPersonId: BigInt(r.ExtId as number | bigint),
          name: String(r.Name ?? ""),
          cardNo: Number(r.CardNo) || 0,
          eventorClubId: Number(r.ClubId) || 0,
          birthYear: Number(r.BirthYear) || 0,
          sex: String(r.Sex ?? ""),
          nationality: String(r.Nationality ?? ""),
        }));
        const r = await conns.pg.runnerDirectory.createMany({
          data: slice,
          skipDuplicates: true,
        });
        rdCount += r.count;
      }
    }
  } catch (err) {
    log(`    runner_directory: skipped (${(err as Error).message})`);
  }
  log(`    runner_directory: ${rdCount}`);

  // club_directory
  let cdCount = 0;
  try {
    const [cdRows] = await conns.mysqlMain.execute<RowDataPacket[]>(
      `SELECT EventorId, Name, ShortName, CountryCode, SmallLogoPng, LargeLogoPng
         FROM oxygen_club_db`,
    );
    if (args.dryRun) {
      log(`  [DRY] club_directory: ${cdRows.length}`);
    } else {
      const batchSize = 200;
      for (let i = 0; i < cdRows.length; i += batchSize) {
        const slice = cdRows.slice(i, i + batchSize).map((r) => ({
          eventorId: BigInt(r.EventorId as number | bigint),
          name: String(r.Name ?? ""),
          shortName: String(r.ShortName ?? ""),
          countryCode: String(r.CountryCode ?? ""),
          smallLogoPng: r.SmallLogoPng as Buffer | null,
          largeLogoPng: r.LargeLogoPng as Buffer | null,
        }));
        const r = await conns.pg.clubDirectory.createMany({
          data: slice,
          skipDuplicates: true,
        });
        cdCount += r.count;
      }
    }
  } catch (err) {
    log(`    club_directory: skipped (${(err as Error).message})`);
  }
  log(`    club_directory: ${cdCount}`);

  // eventor_event_meta + entry_history
  let metaCount = 0;
  let histCount = 0;
  try {
    const [metaRows] = await conns.mysqlMain.execute<RowDataPacket[]>(
      `SELECT EventorEventId, Name, StartDate, ClassificationId, Organiser, EntryCount, FetchedAt
         FROM oxygen_eventor_event_meta`,
    );
    if (!args.dryRun) {
      for (const r of metaRows) {
        await conns.pg.eventorEventMeta.upsert({
          where: { eventorEventId: Number(r.EventorEventId) },
          create: {
            eventorEventId: Number(r.EventorEventId),
            name: String(r.Name ?? ""),
            startDate: parseDate(r.StartDate as string),
            classificationId: Number(r.ClassificationId) || 0,
            organiser: String(r.Organiser ?? ""),
            entryCount: Number(r.EntryCount) || 0,
            fetchedAt: r.FetchedAt as Date,
          },
          update: {},
        });
        metaCount++;
      }
    } else metaCount = metaRows.length;

    const [histRows] = await conns.mysqlMain.execute<RowDataPacket[]>(
      `SELECT EventorEventId, RowSeq, EntryClassId, EntryAt
         FROM oxygen_eventor_entry_history`,
    );
    if (!args.dryRun) {
      const r = await conns.pg.eventorEntryHistory.createMany({
        data: histRows.map((r) => ({
          eventorEventId: Number(r.EventorEventId),
          rowSeq: Number(r.RowSeq),
          entryClassId: Number(r.EntryClassId) || 0,
          entryAt: r.EntryAt as Date,
        })),
        skipDuplicates: true,
      });
      histCount = r.count;
    } else histCount = histRows.length;
  } catch (err) {
    log(`    eventor_*: skipped (${(err as Error).message})`);
  }
  log(`    eventor_event_meta: ${metaCount}`);
  log(`    eventor_entry_history: ${histCount}`);
}

// ─── Verification ──────────────────────────────────────────

async function verifyEvent(conns: Connections, legacy: LegacyEvent): Promise<void> {
  const eventDbUrl = buildLegacyDbUrl(conns.legacyMysqlBaseUrl, legacy.nameId);
  const src = await mysql.createConnection({ uri: eventDbUrl });
  try {
    const pgEvent = await conns.pg.event.findUnique({
      where: { nameId: legacy.nameId },
      select: { id: true },
    });
    if (!pgEvent) {
      log(`  ⚠  no PG event found for ${legacy.nameId}`);
      return;
    }
    const checks: Array<{
      name: string;
      mysql: string;
      pg: () => Promise<number>;
    }> = [
      {
        name: "controls",
        mysql: "SELECT COUNT(*) c FROM oControl WHERE Removed = 0",
        pg: () =>
          conns.pg.control.count({
            where: { eventId: pgEvent.id, removed: false },
          }),
      },
      {
        name: "courses",
        mysql: "SELECT COUNT(*) c FROM oCourse WHERE Removed = 0",
        pg: () =>
          conns.pg.course.count({
            where: { eventId: pgEvent.id, removed: false },
          }),
      },
      {
        name: "classes",
        mysql: "SELECT COUNT(*) c FROM oClass WHERE Removed = 0",
        pg: () =>
          conns.pg.class.count({
            where: { eventId: pgEvent.id, removed: false },
          }),
      },
      {
        name: "runners",
        mysql: "SELECT COUNT(*) c FROM oRunner WHERE Removed = 0",
        pg: () =>
          conns.pg.runner.count({
            where: { eventId: pgEvent.id, removed: false },
          }),
      },
      {
        name: "teams",
        mysql: "SELECT COUNT(*) c FROM oTeam WHERE Removed = 0",
        pg: () =>
          conns.pg.team.count({
            where: { eventId: pgEvent.id, removed: false },
          }),
      },
      {
        name: "cards",
        mysql: "SELECT COUNT(*) c FROM oCard WHERE Removed = 0",
        pg: () =>
          conns.pg.card.count({
            where: { eventId: pgEvent.id, removed: false },
          }),
      },
      {
        name: "control_units",
        mysql: "SELECT COUNT(*) c FROM oxygen_control_units",
        pg: () => conns.pg.controlUnit.count({ where: { eventId: pgEvent.id } }),
      },
    ];

    log("");
    log(`━━ Verify ${legacy.nameId} ━━━━━━━━━━━━━━━━━━━━━━━━━`);
    let ok = true;
    for (const c of checks) {
      const [rows] = await src.execute<RowDataPacket[]>(c.mysql);
      const expected = Number(rows[0]?.c) || 0;
      const actual = await c.pg();
      const mark = expected === actual ? "✓" : "✗";
      if (expected !== actual) ok = false;
      log(`    ${mark} ${c.name}: mysql=${expected} pg=${actual}`);
    }
    log(`  ${ok ? "✓ all counts match" : "✗ MISMATCH"}`);
  } finally {
    await src.end();
  }
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  log("Oxygen migration: MySQL → PostgreSQL");
  log(`  flags: nameIds=[${args.nameIds.join(",") || "(all)"}] all=${args.all} dry=${args.dryRun} force=${args.force}`);

  const conns = await openConnections();
  try {
    // Resolve target events.
    let toMigrate: LegacyEvent[] = [];
    if (args.all) {
      const [rows] = await conns.mysqlMain.execute<RowDataPacket[]>(
        `SELECT Id, Name, NameId, Date, Removed FROM oEvent WHERE Removed = 0`,
      );
      toMigrate = rows.map((r) => ({
        id: Number(r.Id),
        name: String(r.Name),
        nameId: String(r.NameId),
        date: r.Date as string,
        removed: Number(r.Removed),
      }));
    } else {
      for (const nameId of args.nameIds) {
        const ev = await lookupEvent(conns.mysqlMain, nameId);
        if (!ev) {
          throw new Error(
            `MeOSMain.oEvent has no row for NameId='${nameId}'. ` +
              `Available events: ${(
                await conns.mysqlMain.execute<RowDataPacket[]>(
                  `SELECT NameId FROM oEvent WHERE Removed = 0 ORDER BY Date DESC LIMIT 20`,
                )
              )[0]
                .map((r) => r.NameId)
                .join(", ")}`,
          );
        }
        toMigrate.push(ev);
      }
    }

    log("");
    log(`Migrating ${toMigrate.length} event(s):`);
    for (const ev of toMigrate) {
      log(`  - ${ev.nameId} (#${ev.id}) — ${ev.name} on ${ev.date}`);
    }

    const results: Array<{ ev: LegacyEvent; counts: MigrationCounts | "skipped" }> = [];
    for (const ev of toMigrate) {
      try {
        const counts = await migrateEvent(conns, ev, args);
        results.push({ ev, counts });
      } catch (err) {
        log(`  ✗ ${ev.nameId}: ${(err as Error).message}`);
        throw err;
      }
    }

    await migrateGlobals(conns, args);

    if (!args.dryRun) {
      for (const { ev, counts } of results) {
        if (counts !== "skipped") await verifyEvent(conns, ev);
      }
    }

    log("");
    log("✓ Migration complete.");
  } finally {
    await conns.mysqlMain.end();
    await conns.pg.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
