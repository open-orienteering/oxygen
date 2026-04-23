#!/usr/bin/env tsx
/**
 * Generate docs/screenshots/fixtures/showcase.sql from the live local Vinterserien DB.
 *
 * Strictly read-only on the source DB. The output is a portable SQL dump that
 * docs/screenshots/capture.ts can seed into a fresh competition database.
 *
 * Usage:
 *   tsx scripts/anonymize-vinterserien.ts
 *
 * Environment:
 *   SRC_DB         — source database (default: Vinterserien)
 *   SRC_HOST       — MySQL host (default: localhost)
 *   SRC_USER       — MySQL user (default: meos)
 *   SRC_PASSWORD   — MySQL password (default: empty)
 *   MAX_ZOOM       — maximum cached tile zoom to include (default: 13).
 *                    Deeper tiles render on demand from the OCAD blob.
 *
 * Transformations:
 *   - oRunner.Name / Sex / BirthYear / ExtId / CardNo scrubbed or remapped
 *   - oCard.CardNo remapped symmetrically so punches still link
 *   - oxygen_control_punches.card_no remapped with the same function
 *   - oxygen_card_readouts.OwnerData scrubbed (PII JSON blob)
 *   - oClub contact fields (Street, City, EMail, Phone, CareOf, ZIP, etc.) nulled
 *   - oClub filtered to only clubs referenced by runners
 *   - oxygen_map_tiles filtered to z <= MAX_ZOOM
 *   - Raw OCAD blob (oxygen_map_files) and renderer caches dropped
 *   - Session/cache tables (oMonitor, dbRunner, dbClub, oTeam) dropped
 */

import mysql from "mysql2/promise";
import fs from "node:fs";
import path from "node:path";
import {
  MALE_FIRST_NAMES,
  FEMALE_FIRST_NAMES,
  LAST_NAMES,
} from "../packages/api/src/routers/fictional-names.js";

// ─── Config ──────────────────────────────────────────────────

const SRC_DB = process.env.SRC_DB ?? "Vinterserien";
const SRC_HOST = process.env.SRC_HOST ?? "localhost";
const SRC_USER = process.env.SRC_USER ?? "meos";
const SRC_PASSWORD = process.env.SRC_PASSWORD ?? "";
const MAX_ZOOM = parseInt(process.env.MAX_ZOOM ?? "13", 10);
const OUT_PATH = path.resolve("docs/screenshots/fixtures/showcase.sql");
const CARD_REMAP_OFFSET = 9_000_000;

// Tables we copy into the fixture, with the transform mode for each.
type Mode =
  | "keep"
  | "anonymizeRunner"
  | "remapCard"
  | "scrubClub"
  | "filterClubs"
  | "scrubOwnerData"
  | "remapCardPunch"
  | "filterTiles"
  | "scrubEvent";

const TABLES: { name: string; mode: Mode }[] = [
  { name: "oEvent", mode: "scrubEvent" },
  { name: "oCounter", mode: "keep" },
  { name: "oClub", mode: "scrubClub" },
  { name: "oControl", mode: "keep" },
  { name: "oCourse", mode: "keep" },
  { name: "oClass", mode: "keep" },
  { name: "oRunner", mode: "anonymizeRunner" },
  { name: "oCard", mode: "remapCard" },
  { name: "oPunch", mode: "keep" },
  { name: "oImage", mode: "keep" },
  // Oxygen-specific tables
  // oxygen_map_files holds the OCAD blob — required for the MapPanel to
  // compute bounds/scale/northOffset. Committed at ~2 MB; anything less means
  // hacking the frontend just for docs screenshots.
  { name: "oxygen_map_files", mode: "keep" },
  { name: "oxygen_map_tiles", mode: "filterTiles" },
  { name: "oxygen_routes", mode: "keep" },
  { name: "oxygen_control_config", mode: "keep" },
  { name: "oxygen_control_units", mode: "keep" },
  { name: "oxygen_control_punches", mode: "remapCardPunch" },
  { name: "oxygen_competition_config", mode: "keep" },
  { name: "oxygen_course_geometry", mode: "keep" },
  { name: "oxygen_club_logo", mode: "keep" },
  { name: "oxygen_card_readouts", mode: "scrubOwnerData" },
];

// ─── Deterministic PRNG + pseudonym generator ────────────────

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickByHash<T>(arr: T[], seed: number): T {
  const rng = mulberry32(seed);
  return arr[Math.floor(rng() * arr.length)]!;
}

function pseudonym(id: number, sex: string): string {
  const firstPool =
    sex === "F" || sex === "f" ? FEMALE_FIRST_NAMES : MALE_FIRST_NAMES;
  const first = pickByHash(firstPool, id * 2654435761);
  const last = pickByHash(LAST_NAMES, id * 40503 + 17);
  return `${first} ${last}`;
}

function remapCard(n: number | null): number {
  if (!n || n <= 0) return 0;
  return CARD_REMAP_OFFSET + (n % 900_000);
}

// ─── SQL literal escaping ────────────────────────────────────

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (Buffer.isBuffer(v)) {
    if (v.length === 0) return "''";
    return "0x" + v.toString("hex");
  }
  if (v instanceof Date) {
    return `'${v.toISOString().slice(0, 19).replace("T", " ")}'`;
  }
  if (typeof v === "object") {
    return sqlLiteral(JSON.stringify(v));
  }
  const s = String(v);
  // MySQL string escaping per mysql2
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/\0/g, "\\0")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\x1a/g, "\\Z")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
  return `'${escaped}'`;
}

// ─── Main ────────────────────────────────────────────────────

type ColDef = { name: string; type: string };

async function main(): Promise<void> {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });

  const conn = await mysql.createConnection({
    host: SRC_HOST,
    user: SRC_USER,
    password: SRC_PASSWORD,
    database: SRC_DB,
    multipleStatements: false,
    charset: "utf8mb4",
  });

  console.log(`Connected to ${SRC_USER}@${SRC_HOST}/${SRC_DB}`);

  // ─── Discover referenced clubs ─────────────────────────
  const [runnerClubs] = (await conn.query(
    "SELECT DISTINCT Club FROM oRunner WHERE Club > 0",
  )) as unknown as [{ Club: number }[], unknown];
  const referencedClubIds = new Set(runnerClubs.map((r) => r.Club));
  console.log(`Referenced clubs: ${referencedClubIds.size}`);

  // ─── Preload runner genders for card-readout anonymization ─
  const [runners] = (await conn.query(
    "SELECT Id, Name, CardNo, Sex FROM oRunner",
  )) as unknown as [{ Id: number; Name: string; CardNo: number; Sex: string }[], unknown];
  const cardToRunner = new Map<number, { id: number; sex: string }>();
  for (const r of runners) {
    if (r.CardNo) cardToRunner.set(r.CardNo, { id: r.Id, sex: r.Sex });
  }
  console.log(`Runners: ${runners.length}`);

  // ─── Open output file ─────────────────────────────────
  const out = fs.createWriteStream(OUT_PATH, { encoding: "utf8" });
  const write = (s: string): void => {
    out.write(s);
  };

  write(
    "-- Oxygen showcase fixture — Demo Competition (derived from anonymized Vinterserien data)\n",
  );
  write("-- Generated by scripts/anonymize-vinterserien.ts\n");
  write("-- Do not edit by hand; regenerate with `tsx scripts/anonymize-vinterserien.ts`.\n");
  write("--\n");
  write("-- Contains: controls, courses, classes, anonymized runners, clubs (contact scrubbed),\n");
  write("--           cards with remapped CardNo, GPS routes, map tiles (z <= " + MAX_ZOOM + "),\n");
  write("--           and the OCAD source file (needed for bounds/scale metadata).\n");
  write("-- Excluded: renderer caches, session and Eventor-cache tables.\n");
  write("\n");
  write("SET FOREIGN_KEY_CHECKS=0;\n");
  write("SET NAMES utf8mb4;\n\n");

  let totalRowsWritten = 0;
  let totalBytesWritten = 0;

  for (const { name, mode } of TABLES) {
    // Describe columns for literal generation
    const [rows] = (await conn.query(
      `SHOW COLUMNS FROM \`${name}\``,
    )) as unknown as [{ Field: string; Type: string }[], unknown];
    const columns: ColDef[] = rows.map((r) => ({ name: r.Field, type: r.Type }));

    // Get the original CREATE TABLE statement
    const [createRows] = (await conn.query(
      `SHOW CREATE TABLE \`${name}\``,
    )) as unknown as [Record<string, string>[], unknown];
    const createRow = createRows[0]!;
    // Key for SHOW CREATE TABLE is "Create Table"
    const createStmt =
      createRow["Create Table"] ?? createRow["Create View"] ?? "";

    write(`-- ─── ${name} ─────────────────────────────────────\n`);
    write(`DROP TABLE IF EXISTS \`${name}\`;\n`);
    write(createStmt + ";\n\n");

    // Build WHERE/transform per mode
    let query = `SELECT * FROM \`${name}\``;
    if (mode === "filterTiles") {
      query += ` WHERE Z <= ${MAX_ZOOM}`;
    } else if (mode === "scrubClub") {
      // Only dump clubs actually referenced by runners — keeps the file small.
      if (referencedClubIds.size === 0) {
        query += " WHERE 1=0";
      } else {
        const ids = [...referencedClubIds].join(",");
        query += ` WHERE Id IN (${ids})`;
      }
    }

    const [dataRows] = (await conn.query({
      sql: query,
      rowsAsArray: false,
    })) as unknown as [Record<string, unknown>[], unknown];

    let rowsWritten = 0;
    const beforeBytes = totalBytesWritten;

    for (const row of dataRows) {
      const transformed = transform(row, mode, cardToRunner);
      if (transformed === null) continue;

      const values = columns
        .map((c) => sqlLiteral(transformed[c.name]))
        .join(", ");
      const line = `INSERT INTO \`${name}\` (${columns
        .map((c) => `\`${c.name}\``)
        .join(", ")}) VALUES (${values});\n`;
      write(line);
      rowsWritten++;
      totalBytesWritten += Buffer.byteLength(line, "utf8");
    }

    write("\n");
    totalRowsWritten += rowsWritten;
    const afterBytes = totalBytesWritten;
    const mb = (afterBytes - beforeBytes) / 1024 / 1024;
    console.log(
      `  ${name.padEnd(30)} ${rowsWritten
        .toString()
        .padStart(6)} rows  ${mb.toFixed(2)} MB`,
    );
  }

  write("SET FOREIGN_KEY_CHECKS=1;\n");

  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  await conn.end();

  const sizeMb = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(2);
  console.log(
    `\nWrote ${OUT_PATH} — ${totalRowsWritten} rows, ${sizeMb} MB.`,
  );
}

// ─── Per-row transforms ──────────────────────────────────────

function transform(
  row: Record<string, unknown>,
  mode: Mode,
  cardToRunner: Map<number, { id: number; sex: string }>,
): Record<string, unknown> | null {
  if (mode === "keep") return row;

  const r = { ...row };

  switch (mode) {
    case "scrubEvent": {
      // Rename so it's obvious this is a generic demo dump; the NameId is
      // what the backend uses as the competition database name, so it also
      // drives the loader's DROP/CREATE DATABASE target and the
      // MeOSMain.oEvent registration row.
      r["Name"] = "Demo Competition";
      r["NameId"] = "demo_competition";
      return r;
    }
    case "anonymizeRunner": {
      const id = (r["Id"] as number) ?? 0;
      const sex = (r["Sex"] as string) ?? "";
      r["Name"] = pseudonym(id, sex);
      r["CardNo"] = remapCard(r["CardNo"] as number);
      r["ExtId"] = 0;
      if ("ExtId2" in r) r["ExtId2"] = 0;
      const by = (r["BirthYear"] as number) ?? 0;
      if (by > 0) r["BirthYear"] = Math.round(by / 5) * 5;
      // Scrub all free-text / contact / annotation fields (Family is an int in MeOS, leave it)
      for (const f of ["Phone", "Annotation", "TextA", "Nationality", "Country"]) {
        if (f in r) r[f] = "";
      }
      return r;
    }
    case "remapCard": {
      const cn = r["CardNo"] as number;
      r["CardNo"] = remapCard(cn);
      return r;
    }
    case "remapCardPunch": {
      const cn = r["card_no"] as number;
      r["card_no"] = remapCard(cn);
      return r;
    }
    case "scrubClub": {
      // Keep Id / Name / District / ShortName / Type / ExtId / Modified / Counter /
      // Nationality / Country / StartGroup / Invoice*. Null all contact fields.
      for (const f of [
        "CareOf",
        "Street",
        "City",
        "State",
        "ZIP",
        "EMail",
        "Phone",
      ]) {
        if (f in r) r[f] = "";
      }
      return r;
    }
    case "scrubOwnerData": {
      // oxygen_card_readouts.OwnerData is a JSON blob with firstName/lastName/email/phone/DoB.
      const cn = r["CardNo"] as number;
      const runner = cardToRunner.get(cn);
      if (runner) {
        const pseudo = pseudonym(runner.id, runner.sex);
        const [first, ...rest] = pseudo.split(" ");
        r["OwnerData"] = JSON.stringify({
          firstName: first,
          lastName: rest.join(" "),
          sex: runner.sex === "F" ? "female" : "male",
        });
      } else {
        // No matching runner — fall back to a generic placeholder.
        r["OwnerData"] = JSON.stringify({
          firstName: "Okänd",
          lastName: "Deltagare",
        });
      }
      // Also remap the CardNo and any card-level metadata
      r["CardNo"] = remapCard(cn);
      if ("Metadata" in r) r["Metadata"] = null;
      return r;
    }
    case "filterTiles":
    case "filterClubs":
      return r;
  }
}

main().catch((err) => {
  console.error("Anonymization failed:", err);
  process.exit(1);
});
