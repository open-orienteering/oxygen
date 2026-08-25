#!/usr/bin/env tsx
/**
 * Estimate how fast each entrant of an Oxygen event is, from their results
 * in past Eventor events.
 *
 * The point is the start draw: a slow runner placed at the end of their
 * class keeps the whole finish waiting. Sorting a class by the `ratio`
 * column of this report, slowest first, gives a defensible start order.
 *
 * Strictly read-only. It reads the Oxygen database, GETs result lists from
 * Eventor, and writes nothing back to either.
 *
 * Usage:
 *   pnpm tsx scripts/eventor-pace.ts --event <nameId> --history <ids> [--csv <path>]
 *   pnpm tsx scripts/eventor-pace.ts --discover Ungdomsserien [--from 2026-01-01]
 *   pnpm tsx scripts/eventor-pace.ts --probe <eventId>
 *
 * Modes:
 *   --discover <text>  List Eventor events whose name contains <text>, to
 *                      find the ids of the rounds you want to feed --history.
 *   --probe <eventId>  Fetch one event both ways and report what the XML
 *                      actually contains — dialect, competitors, whether
 *                      person ids and course lengths are present.
 *   (default)          The pace report.
 *
 * Options:
 *   --event <nameId>   Oxygen event whose start list is scored.
 *   --history <ids>    Comma-separated Eventor event ids to learn from.
 *   --csv <path>       Also write the report as CSV.
 *   --from, --to       Date window for --discover (default: past 12 months).
 *   --no-cache         Bypass the on-disk XML cache.
 *
 * Environment:
 *   DATABASE_URL           Oxygen DB (default: local dev database)
 *   EVENTOR_API_KEY        Overrides the key stored in `settings`
 *   EVENTOR_API_BASE_URL   Points the fetches at a stub instead of Eventor
 *   EVENTOR_ENV            `prod` (default) or `test`
 *   PACE_CACHE_DIR         Raw XML cache (default: .eventor-cache)
 */

import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";
import { fetchEventsBroad } from "../packages/api/src/eventor.js";
import {
  aggregateRunner,
  median,
  parseResultList,
  predictSeconds,
  summarizeClasses,
  toRunnerRaces,
  type ClassSummary,
  type RunnerRace,
} from "../packages/api/src/eventor-pace.js";
import type { EventorEnvironment } from "@oxygen/shared";

// ─── Config ──────────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://oxygen:oxygen@localhost:5432/oxygen?schema=oxygen";
const EVENTOR_ENV = (process.env.EVENTOR_ENV ?? "prod") as EventorEnvironment;
const CACHE_DIR = process.env.PACE_CACHE_DIR ?? ".eventor-cache";

const EVENTOR_URLS: Record<EventorEnvironment, string> = {
  prod: "https://eventor.orientering.se/api/",
  test: "https://eventor-sweden-test.orientering.se/api/",
};

/** Mirrors `eventorBaseUrl` in packages/api/src/eventor.ts, which is private. */
function baseUrl(): string {
  const override = process.env.EVENTOR_API_BASE_URL;
  if (!override) return EVENTOR_URLS[EVENTOR_ENV];
  return override.endsWith("/") ? override : `${override}/`;
}

// ─── CLI parsing ─────────────────────────────────────────────

interface Args {
  event?: string;
  history: number[];
  csv?: string;
  discover?: string;
  probe?: number;
  from?: string;
  to?: string;
  cache: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { history: [], cache: true };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--event":
        args.event = value;
        i++;
        break;
      case "--history":
        args.history = (value ?? "")
          .split(",")
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => n > 0);
        i++;
        break;
      case "--csv":
        args.csv = value;
        i++;
        break;
      case "--discover":
        args.discover = value;
        i++;
        break;
      case "--probe":
        args.probe = parseInt(value ?? "", 10);
        i++;
        break;
      case "--from":
        args.from = value;
        i++;
        break;
      case "--to":
        args.to = value;
        i++;
        break;
      case "--no-cache":
        args.cache = false;
        break;
      default:
        if (flag.startsWith("--")) {
          throw new Error(`Unknown flag: ${flag}`);
        }
    }
  }
  return args;
}

// ─── Eventor access ──────────────────────────────────────────

async function resolveApiKey(db: Client): Promise<string> {
  const fromEnv = process.env.EVENTOR_API_KEY;
  if (fromEnv) return fromEnv;

  const settingKey =
    EVENTOR_ENV === "test" ? "eventor_api_key_test" : "eventor_api_key";
  const res = await db.query<{ value: string }>(
    "SELECT value FROM oxygen.settings WHERE key = $1",
    [settingKey],
  );
  const key = res.rows[0]?.value;
  if (!key) {
    throw new Error(
      `No Eventor API key: set EVENTOR_API_KEY or store one under settings.${settingKey}`,
    );
  }
  return key;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET an Eventor endpoint, memoised on disk. Result lists for finished
 * events never change, so a rerun should cost nothing and Eventor should
 * not be asked twice for the same thing.
 */
async function fetchXml(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string,
  useCache: boolean,
): Promise<string> {
  const query = new URLSearchParams(params).toString();
  const cacheFile = path.join(
    CACHE_DIR,
    `${endpoint.replace(/\//g, "_")}__${query.replace(/[^A-Za-z0-9_=&-]/g, "_")}.xml`,
  );

  if (useCache && fs.existsSync(cacheFile)) {
    return fs.readFileSync(cacheFile, "utf-8");
  }

  const url = new URL(endpoint, baseUrl());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString(), { headers: { ApiKey: apiKey } });
  if (!resp.ok) {
    throw new Error(
      `Eventor GET ${endpoint} failed: ${resp.status} ${await resp.text()}`,
    );
  }
  const xml = await resp.text();

  if (useCache) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, xml, "utf-8");
  }
  await sleep(300);
  return xml;
}

/**
 * Prefer the IOF 3.0 rendering: times are plain seconds and it is the only
 * one that can carry a course length. Fall back to the 2.0.3 endpoint when
 * it yields nothing, which is what Oxygen's own importer uses.
 */
async function fetchEventResults(
  eventId: number,
  apiKey: string,
  useCache: boolean,
): Promise<{ xml: string; endpoint: string }> {
  try {
    const xml = await fetchXml(
      "results/event/iofxml",
      { eventId: String(eventId) },
      apiKey,
      useCache,
    );
    if (parseResultList(xml).results.length > 0) {
      return { xml, endpoint: "results/event/iofxml" };
    }
  } catch {
    // Fall through to the older endpoint.
  }
  const xml = await fetchXml(
    "results/event",
    { eventId: String(eventId) },
    apiKey,
    useCache,
  );
  return { xml, endpoint: "results/event" };
}

// ─── Oxygen start list ───────────────────────────────────────

interface Entrant {
  personId: number;
  name: string;
  clubName: string;
  className: string;
  courseLengthM: number;
}

async function loadStartList(db: Client, nameId: string): Promise<Entrant[]> {
  const res = await db.query<{
    eventor_person_id: string | null;
    name: string;
    club_name: string;
    class_name: string | null;
    length_m: number | null;
  }>(
    `SELECT r.eventor_person_id, r.name, r.club_name,
            c.name AS class_name, co.length_m
       FROM oxygen.runners r
       LEFT JOIN oxygen.classes c ON c.id = r.class_id
       LEFT JOIN oxygen.courses co ON co.id = COALESCE(r.course_id, c.course_id)
      WHERE r.event_id = (SELECT id FROM oxygen.events WHERE name_id = $1)
        AND r.removed = false
      ORDER BY c.name, r.name`,
    [nameId],
  );

  if (res.rows.length === 0) {
    throw new Error(`No runners found for event "${nameId}"`);
  }

  return res.rows.map((row) => ({
    personId: row.eventor_person_id ? Number(row.eventor_person_id) : 0,
    name: row.name,
    clubName: row.club_name,
    className: row.class_name ?? "",
    courseLengthM: row.length_m ?? 0,
  }));
}

// ─── Report ──────────────────────────────────────────────────

interface Row extends Entrant {
  races: number;
  dnf: number;
  ratio: number | null;
  paceMinPerKm: number | null;
  predictedSec: number;
  seed: number;
}

/**
 * Higher seed = faster = starts later, matching how `seededDraw` sorts
 * (packages/api/src/draw/algorithms.ts). Runners we know nothing about land
 * on the median so they are neither first nor last out.
 */
function seedFor(ratio: number | null): number {
  if (ratio === null || ratio <= 0) return 1000;
  return Math.round(1000 / ratio);
}

function fmtTime(sec: number): string {
  if (sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s.padEnd(width);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s.padStart(width);
}

async function runReport(db: Client, args: Args, apiKey: string) {
  if (!args.event) throw new Error("--event <nameId> is required");
  if (args.history.length === 0) {
    throw new Error(
      "--history <eventIds> is required; use --discover <text> to find them",
    );
  }

  const entrants = await loadStartList(db, args.event);
  console.log(
    `${entrants.length} runners in ${args.event}; ` +
      `${entrants.filter((e) => e.personId > 0).length} linked to an Eventor person\n`,
  );

  // personId -> every race we found them in
  const racesByPerson = new Map<number, RunnerRace[]>();
  // class name -> summaries from the history, for a target pace
  const summariesByClassName = new Map<string, ClassSummary[]>();

  for (const eventId of args.history) {
    const { xml, endpoint } = await fetchEventResults(
      eventId,
      apiKey,
      args.cache,
    );
    const parsed = parseResultList(xml);
    const summaries = summarizeClasses(parsed.results);
    const races = toRunnerRaces(parsed.results, summaries);

    for (const race of races) {
      if (race.personId <= 0) continue;
      const bucket = racesByPerson.get(race.personId);
      if (bucket) bucket.push(race);
      else racesByPerson.set(race.personId, [race]);
    }
    for (const summary of summaries.values()) {
      const bucket = summariesByClassName.get(summary.className);
      if (bucket) bucket.push(summary);
      else summariesByClassName.set(summary.className, [summary]);
    }

    const withLength = [...summaries.values()].filter(
      (s) => s.courseLengthM > 0,
    ).length;
    console.log(
      `  event ${eventId}: ${parsed.results.length} results, ` +
        `${summaries.size} classes (${withLength} with a course length), ` +
        `via ${endpoint} [${parsed.iofVersion}]`,
    );
  }
  console.log("");

  /** Median pace an average runner of this class held, where we know lengths. */
  function targetPace(className: string): number {
    const paces = (summariesByClassName.get(className) ?? [])
      .filter((s) => s.courseLengthM > 0 && s.medianSec > 0)
      .map((s) => s.medianSec / 60 / (s.courseLengthM / 1000));
    return paces.length > 0 ? median(paces) : 0;
  }

  const rows: Row[] = entrants.map((entrant) => {
    const agg = aggregateRunner(racesByPerson.get(entrant.personId) ?? []);
    const pace = targetPace(entrant.className);
    return {
      ...entrant,
      races: agg.races,
      dnf: agg.dnf,
      ratio: agg.ratio,
      paceMinPerKm: agg.paceMinPerKm,
      predictedSec:
        agg.ratio !== null
          ? predictSeconds(agg.ratio, entrant.courseLengthM, pace)
          : 0,
      seed: seedFor(agg.ratio),
    };
  });

  printReport(rows);
  if (args.csv) writeCsv(rows, args.csv);
}

function printReport(rows: Row[]): void {
  const classes = [...new Set(rows.map((r) => r.className))].sort();

  for (const className of classes) {
    // Slowest first: that is the suggested start order within the class.
    const inClass = rows
      .filter((r) => r.className === className)
      .sort((a, b) => (b.ratio ?? 1) - (a.ratio ?? 1));
    const known = inClass.filter((r) => r.ratio !== null).length;

    console.log(
      `── ${className} — ${inClass.length} runners, ${known} with history ──`,
    );
    console.log(
      `${pad("Name", 26)}${pad("Club", 22)}${padLeft("Races", 6)}` +
        `${padLeft("Ratio", 7)}${padLeft("min/km", 8)}${padLeft("Est", 7)}` +
        `${padLeft("DNF", 5)}${padLeft("Seed", 6)}`,
    );
    for (const r of inClass) {
      console.log(
        pad(r.name, 26) +
          pad(r.clubName, 22) +
          padLeft(r.races > 0 ? String(r.races) : "-", 6) +
          padLeft(r.ratio !== null ? r.ratio.toFixed(2) : "-", 7) +
          padLeft(
            r.paceMinPerKm !== null ? r.paceMinPerKm.toFixed(1) : "-",
            8,
          ) +
          padLeft(fmtTime(r.predictedSec) || "-", 7) +
          padLeft(r.dnf > 0 ? String(r.dnf) : "", 5) +
          padLeft(String(r.seed), 6),
      );
    }
    console.log("");
  }

  const noHistory = rows.filter((r) => r.ratio === null);
  console.log(
    `${rows.length - noHistory.length}/${rows.length} runners scored; ` +
      `${noHistory.length} without usable history (seeded at the class median).`,
  );
}

function writeCsv(rows: Row[], target: string): void {
  const header =
    "class,name,club,races,ratio,min_per_km,predicted_seconds,dnf,seed";
  const lines = rows.map((r) =>
    [
      r.className,
      `"${r.name.replace(/"/g, '""')}"`,
      `"${r.clubName.replace(/"/g, '""')}"`,
      r.races,
      r.ratio !== null ? r.ratio.toFixed(4) : "",
      r.paceMinPerKm !== null ? r.paceMinPerKm.toFixed(2) : "",
      r.predictedSec > 0 ? r.predictedSec : "",
      r.dnf,
      r.seed,
    ].join(","),
  );
  fs.writeFileSync(target, [header, ...lines].join("\n") + "\n", "utf-8");
  console.log(`\nCSV written to ${target}`);
}

// ─── Probe + discover ────────────────────────────────────────

async function runProbe(eventId: number, apiKey: string, useCache: boolean) {
  for (const endpoint of ["results/event/iofxml", "results/event"]) {
    try {
      const xml = await fetchXml(
        endpoint,
        { eventId: String(eventId) },
        apiKey,
        useCache,
      );
      const parsed = parseResultList(xml);
      const summaries = summarizeClasses(parsed.results);
      const withPersonId = parsed.results.filter((r) => r.personId > 0).length;
      const withLength = parsed.results.filter(
        (r) => r.courseLengthM > 0,
      ).length;

      console.log(`\n${endpoint}`);
      console.log(`  bytes:          ${xml.length}`);
      console.log(`  dialect:        ${parsed.iofVersion}`);
      console.log(`  results:        ${parsed.results.length}`);
      console.log(`  with person id: ${withPersonId}`);
      console.log(`  with a length:  ${withLength}`);
      console.log(`  classes:        ${summaries.size}`);
      for (const s of [...summaries.values()].slice(0, 5)) {
        console.log(
          `    ${pad(s.className, 14)} ${padLeft(String(s.finishers), 4)} finishers` +
            `  median ${fmtTime(s.medianSec)}` +
            `  length ${s.courseLengthM || "-"}`,
        );
      }
    } catch (err) {
      console.log(`\n${endpoint}\n  FAILED: ${String(err)}`);
    }
  }
}

async function runDiscover(args: Args, apiKey: string) {
  const to = args.to ?? new Date().toISOString().slice(0, 10);
  const from =
    args.from ??
    new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const events = await fetchEventsBroad(
    apiKey,
    { fromDate: `${from} 00:00:00`, toDate: `${to} 23:59:59` },
    EVENTOR_ENV,
  );
  const needle = (args.discover ?? "").toLowerCase();
  const hits = events
    .filter((e) => e.name.toLowerCase().includes(needle))
    .sort((a, b) => a.date.localeCompare(b.date));

  console.log(
    `${hits.length} of ${events.length} events match "${args.discover}"\n`,
  );
  for (const e of hits) {
    console.log(
      `${padLeft(String(e.eventId), 7)}  ${e.date.slice(0, 10)}  ${pad(e.name, 46)}  ${e.organiserName}`,
    );
  }
  if (hits.length > 0) {
    console.log(`\n--history ${hits.map((e) => e.eventId).join(",")}`);
  }
}

// ─── Entry point ─────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = new Client({ connectionString: DATABASE_URL });
  await db.connect();
  try {
    const apiKey = await resolveApiKey(db);
    if (args.probe) {
      await runProbe(args.probe, apiKey, args.cache);
    } else if (args.discover) {
      await runDiscover(args, apiKey);
    } else {
      await runReport(db, args, apiKey);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
