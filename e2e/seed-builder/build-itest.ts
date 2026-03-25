/**
 * Seed builder for the `itest` E2E test database ("My example tävling").
 *
 * This script recreates the database programmatically using Prisma, then
 * exports it as `e2e/seed.sql` via mysqldump so it can be checked in and
 * loaded quickly during test runs.
 *
 * Usage:
 *   cd packages/api
 *   DATABASE_URL="mysql://meos@localhost:3306/itest" \
 *   MEOS_MAIN_DB_URL="mysql://meos@localhost:3306/MeOSMain" \
 *   pnpm tsx ../../e2e/seed-builder/build-itest.ts
 *
 * After running, commit the updated e2e/seed.sql.
 */
import { execSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";
import { PrismaClient } from "@prisma/client";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED_SQL = resolve(__dirname, "../seed.sql");

const DB_NAME = "itest";
const DB_URL = process.env.DATABASE_URL ?? `mysql://meos@localhost:3306/${DB_NAME}`;
const MAIN_DB_URL = process.env.MEOS_MAIN_DB_URL ?? "mysql://meos@localhost:3306/MeOSMain";

// ZeroTime-relative conversion: MeOS stores all times relative to ZeroTime.
// createCompetitionDatabase sets ZeroTime=324000 (09:00:00).
const ZERO_TIME_DS = 324000;
const ZERO_TIME_SECS = 32400;
function toRel(absoluteDs: number): number {
  return absoluteDs > 1 ? absoluteDs - ZERO_TIME_DS : absoluteDs; // preserve sentinels 0 and 1
}
function toRelSec(absoluteSec: number): number {
  return absoluteSec > 0 ? absoluteSec - ZERO_TIME_SECS : absoluteSec;
}
/** Convert a MeOS punch string from absolute seconds to ZeroTime-relative seconds */
function toRelPunches(punchStr: string): string {
  if (!punchStr) return punchStr;
  return punchStr.replace(/(\d+)-(\d+)\.(\d)/g, (_match, type, secs, tenths) => {
    const relSecs = parseInt(secs, 10) - ZERO_TIME_SECS;
    return `${type}-${relSecs}.${tenths}`;
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseUrl(url: string) {
  const m = url.match(/mysql:\/\/([^:@]+)(?::([^@]*))?@([^:/]+)(?::(\d+))?\/(.+)/);
  if (!m) throw new Error(`Invalid MySQL URL: ${url}`);
  return { user: m[1], password: m[2] ?? "", host: m[3], port: Number(m[4] ?? 3306), database: m[5] };
}

async function recreateDb() {
  const { user, password, host, port } = parseUrl(DB_URL);
  const conn = await mysql.createConnection({ host, port, user, password, multipleStatements: true });
  try {
    await conn.execute(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    await conn.execute(`CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb3 COLLATE utf8mb3_general_ci`);

    // Register in MeOSMain
    const mainConn = await mysql.createConnection({ ...parseUrl(MAIN_DB_URL), multipleStatements: true });
    try {
      await mainConn.execute(`DELETE FROM oEvent WHERE NameId = ?`, [DB_NAME]);
      await mainConn.execute(
        `INSERT INTO oEvent (Name, Date, NameId, Removed) VALUES (?, ?, ?, 0)`,
        ["My example tävling", "2026-04-15", DB_NAME],
      );
    } finally {
      await mainConn.end();
    }
  } finally {
    await conn.end();
  }
}

function pushSchema() {
  console.log("  Pushing Prisma schema...");
  execSync("pnpm prisma db push --skip-generate", {
    cwd: resolve(__dirname, "../../packages/api"),
    env: { ...process.env, DATABASE_URL: DB_URL },
    stdio: "inherit",
  });
}

function dumpToSql() {
  console.log(`  Dumping to ${SEED_SQL}...`);
  const { user, password, host, port } = parseUrl(DB_URL);
  const passArg = password ? `-p${password}` : "";
  execSync(
    `mysqldump -h ${host} -P ${port} -u ${user} ${passArg} --no-tablespaces --routines=0 --triggers=0 ${DB_NAME} > "${SEED_SQL}"`,
    { stdio: ["ignore", "inherit", "inherit"] },
  );
}

// ─── Data ───────────────────────────────────────────────────────────────────

async function seed(prisma: PrismaClient) {
  console.log("  Seeding clubs...");
  await seedClubs(prisma);
  console.log("  Seeding controls...");
  await seedControls(prisma);
  console.log("  Seeding courses...");
  await seedCourses(prisma);
  console.log("  Seeding classes...");
  await seedClasses(prisma);
  console.log("  Seeding runners...");
  await seedRunners(prisma);
  console.log("  Seeding card readout data...");
  await seedCards(prisma);
  console.log("  Seeding oEvent settings...");
  await seedEvent(prisma);
}

async function seedClubs(prisma: PrismaClient) {
  // 27 clubs from the original mysqldump (Ids preserved for FK consistency)
  const clubs = [
    { Id: 1, Name: "Degerfors OK", District: 18 },
    { Id: 2, Name: "Ankarsrums OK", District: 14 },
    { Id: 3, Name: "Bodafors OK", District: 14 },
    { Id: 4, Name: "Burseryds IF", District: 14 },
    { Id: 5, Name: "Domnarvets GOIF", District: 3 },
    { Id: 6, Name: "Gamleby OK", District: 14 },
    { Id: 7, Name: "Grangärde OK", District: 3 },
    { Id: 8, Name: "Halmstad OK", District: 7 },
    { Id: 9, Name: "Hedesunda IF", District: 5 },
    { Id: 10, Name: "OK Forsarna", District: 9 },
    { Id: 11, Name: "Hultsfreds OK", District: 14 },
    { Id: 12, Name: "Häverödals SK", District: 17 },
    { Id: 13, Name: "IFK Kiruna", District: 11 },
    { Id: 14, Name: "K 3 IF", District: 20 },
    { Id: 15, Name: "Kjula IF", District: 16 },
    { Id: 16, Name: "Krokeks OK", District: 23 },
    { Id: 17, Name: "Laxå OK", District: 12 },
    { Id: 18, Name: "Ljusne-Ala OK", District: 8 },
    { Id: 20, Name: "Niilivaara IS", District: 11 },
    { Id: 21, Name: "Nyköpings OK", District: 16 },
    { Id: 22, Name: "Robertsfors IK", District: 19 },
    { Id: 23, Name: "OK Roto", District: 2 },
    { Id: 24, Name: "Sigtuna OK", District: 17 },
    { Id: 25, Name: "Skellefteå OK", District: 19 },
    { Id: 26, Name: "FK Snapphanarna", District: 13 },
    { Id: 28, Name: "IK Surd", District: 6 },
    { Id: 30, Name: "OK Tranan", District: 20 },
    { Id: 888888888, Name: "Vacant", District: 0 },
  ];
  for (const c of clubs) {
    await prisma.oClub.create({ data: { Id: c.Id, Name: c.Name, District: c.District } });
  }
}

async function seedControls(prisma: PrismaClient) {
  const controls = [
    { Id: 34, Name: "", Numbers: "34" },
    { Id: 37, Name: "", Numbers: "37" },
    { Id: 39, Name: "", Numbers: "39" },
    { Id: 40, Name: "", Numbers: "40" },
    { Id: 41, Name: "", Numbers: "41" },
    { Id: 42, Name: "", Numbers: "42" },
    { Id: 44, Name: "", Numbers: "44" },
    { Id: 50, Name: "Radio 1", Numbers: "50" },
    { Id: 53, Name: "", Numbers: "53" },
    { Id: 54, Name: "", Numbers: "54" },
    { Id: 60, Name: "", Numbers: "60" },
    { Id: 61, Name: "", Numbers: "61" },
    { Id: 64, Name: "", Numbers: "64" },
    { Id: 67, Name: "", Numbers: "67" },
    { Id: 77, Name: "", Numbers: "77" },
    { Id: 78, Name: "", Numbers: "78" },
    { Id: 79, Name: "", Numbers: "79" },
    { Id: 81, Name: "", Numbers: "81" },
    { Id: 89, Name: "", Numbers: "89" },
    { Id: 93, Name: "", Numbers: "93" },
    { Id: 100, Name: "Förvarning", Numbers: "100" },
    { Id: 150, Name: "Radio 2", Numbers: "150" },
    { Id: 200, Name: "Pre-start", Numbers: "200" },
  ];
  for (const c of controls) {
    await prisma.oControl.create({ data: { Id: c.Id, Name: c.Name, Numbers: c.Numbers } });
  }
}

async function seedCourses(prisma: PrismaClient) {
  const courses = [
    { Id: 1, Name: "Bana 1", Controls: "67;39;78;53;44;50;60;41;42;37;150;64;42;77;54;100;", Length: 7340 },
    { Id: 2, Name: "Bana 2", Controls: "81;50;40;150;100;", Length: 7060 },
    { Id: 3, Name: "Bana 3", Controls: "61;34;50;79;89;150;93;100;", Length: 3400 },
  ];
  for (const c of courses) {
    await prisma.oCourse.create({
      data: { Id: c.Id, Name: c.Name, Controls: c.Controls, Length: c.Length, NumberMaps: 30 },
    });
  }
}

async function seedClasses(prisma: PrismaClient) {
  const classes = [
    { Id: 1, Name: "Öppen 1", Course: 1, SortIndex: 10, ClassType: "Open", StartBlock: 1, AllowQuickEntry: 1 },
    { Id: 2, Name: "Öppen 2", Course: 2, SortIndex: 20, ClassType: "Open", StartBlock: 0, AllowQuickEntry: 1 },
    { Id: 3, Name: "Öppen 3", Course: 3, SortIndex: 30, ClassType: "Open", StartBlock: 0, AllowQuickEntry: 1 },
  ];
  for (const c of classes) {
    await prisma.oClass.create({
      data: {
        Id: c.Id,
        Name: c.Name,
        Course: c.Course,
        SortIndex: c.SortIndex,
        ClassType: c.ClassType,
        StartBlock: c.StartBlock,
        AllowQuickEntry: c.AllowQuickEntry,
        ClassFee: 110,
        HighClassFee: 165,
        ClassFeeRed: 70,
        HighClassFeeRed: 105,
      },
    });
  }
}

async function seedRunners(prisma: PrismaClient) {
  // oRunner columns used: Id, Name, CardNo, Club, Class, StartNo, StartTime, FinishTime, Status, Card
  // Status: 1=OK, 0=unknown/NoResult, 3=MP, 4=DNS, 50=DNS (missing punch is status 3)
  const runners = [
    // Class 1 (Öppen 1) — 25 runners
    { Id: 8,  Name: "Monica Henriksson",  CardNo: 500803, Club: 2,  Class: 1, StartNo: 1,  StartTime: 456600, FinishTime: 502350, Status: 3,  Card: 27 },
    { Id: 14, Name: "Malin Johannesson",  CardNo: 501438, Club: 16, Class: 1, StartNo: 2,  StartTime: 1,      FinishTime: 502850, Status: 1,  Card: 13 },
    { Id: 10, Name: "Nilsson Collryd",    CardNo: 501061, Club: 20, Class: 1, StartNo: 3,  StartTime: 1,      FinishTime: 498630, Status: 1,  Card: 5  },
    { Id: 22, Name: "Roger Thörnblom",    CardNo: 502141, Club: 15, Class: 1, StartNo: 4,  StartTime: 1,      FinishTime: 498080, Status: 1,  Card: 41 },
    { Id: 21, Name: "Albin Bergman",      CardNo: 2220164,Club: 12, Class: 1, StartNo: 5,  StartTime: 1,      FinishTime: 0,      Status: 0,  Card: 0  },
    { Id: 25, Name: "Vakant",             CardNo: 0,       Club: 888888888, Class: 1, StartNo: 6, StartTime: 1, FinishTime: 0, Status: 0, Card: 0 },
    { Id: 12, Name: "Helena Bergström",   CardNo: 501259, Club: 13, Class: 1, StartNo: 7,  StartTime: 1,      FinishTime: 503970, Status: 1,  Card: 9  },
    { Id: 11, Name: "Magnus Johansson",   CardNo: 501162, Club: 15, Class: 1, StartNo: 8,  StartTime: 1,      FinishTime: 0,      Status: 4,  Card: 19 },
    { Id: 9,  Name: "Bo-Göran Persson",   CardNo: 500944, Club: 15, Class: 1, StartNo: 9,  StartTime: 1,      FinishTime: 501770, Status: 3,  Card: 7  },
    { Id: 19, Name: "Gun Karlsson",       CardNo: 501929, Club: 10, Class: 1, StartNo: 10, StartTime: 1,      FinishTime: 507740, Status: 3,  Card: 44 },
    { Id: 2,  Name: "Thommie Antonsson",  CardNo: 500196, Club: 4,  Class: 1, StartNo: 11, StartTime: 1,      FinishTime: 504460, Status: 1,  Card: 4  },
    { Id: 18, Name: "Monica Johansson",   CardNo: 501807, Club: 15, Class: 1, StartNo: 12, StartTime: 1,      FinishTime: 507050, Status: 1,  Card: 42 },
    { Id: 4,  Name: "Charlotte Olovsson", CardNo: 500416, Club: 7,  Class: 1, StartNo: 13, StartTime: 1,      FinishTime: 507590, Status: 1,  Card: 31 },
    { Id: 6,  Name: "Eva Rådberg",        CardNo: 500671, Club: 25, Class: 1, StartNo: 14, StartTime: 1,      FinishTime: 0,      Status: 0,  Card: 0  },
    { Id: 24, Name: "Vakant",             CardNo: 0,       Club: 888888888, Class: 1, StartNo: 15, StartTime: 1, FinishTime: 0, Status: 0, Card: 0 },
    { Id: 17, Name: "Björn Carlsson",     CardNo: 501685, Club: 5,  Class: 1, StartNo: 16, StartTime: 1,      FinishTime: 505790, Status: 1,  Card: 23 },
    { Id: 15, Name: "Simon Johansson",    CardNo: 501524, Club: 21, Class: 1, StartNo: 17, StartTime: 1,      FinishTime: 502920, Status: 1,  Card: 40 },
    { Id: 16, Name: "Filip Johansson",    CardNo: 501588, Club: 9,  Class: 1, StartNo: 18, StartTime: 1,      FinishTime: 499220, Status: 1,  Card: 35 },
    { Id: 5,  Name: "Ted Björkman",       CardNo: 500545, Club: 23, Class: 1, StartNo: 19, StartTime: 1,      FinishTime: 507180, Status: 1,  Card: 39 },
    { Id: 7,  Name: "Stig Gösswein",      CardNo: 500699, Club: 4,  Class: 1, StartNo: 20, StartTime: 1,      FinishTime: 503730, Status: 1,  Card: 10 },
    { Id: 3,  Name: "Annelie Najvik",     CardNo: 500319, Club: 15, Class: 1, StartNo: 21, StartTime: 1,      FinishTime: 500110, Status: 1,  Card: 1  },
    { Id: 1,  Name: "Linda Klick",        CardNo: 500188, Club: 7,  Class: 1, StartNo: 22, StartTime: 1,      FinishTime: 507790, Status: 1,  Card: 25 },
    { Id: 13, Name: "Tova Askeljung",     CardNo: 501320, Club: 3,  Class: 1, StartNo: 23, StartTime: 1,      FinishTime: 501270, Status: 1,  Card: 38 },
    { Id: 23, Name: "Vakant",             CardNo: 0,       Club: 888888888, Class: 1, StartNo: 24, StartTime: 1, FinishTime: 0, Status: 0, Card: 0 },
    { Id: 20, Name: "Johan Jonsson",      CardNo: 501957, Club: 15, Class: 1, StartNo: 25, StartTime: 1,      FinishTime: 501350, Status: 1,  Card: 43 },

    // Class 2 (Öppen 2) — 14 runners
    { Id: 26, Name: "Ann Sjödin",         CardNo: 502583, Club: 15, Class: 2, StartNo: 1,  StartTime: 1, FinishTime: 0,      Status: 4,  Card: 11 },
    { Id: 30, Name: "Stefan Hersén",      CardNo: 502935, Club: 12, Class: 2, StartNo: 2,  StartTime: 1, FinishTime: 498980, Status: 1,  Card: 37 },
    { Id: 37, Name: "Vakant",             CardNo: 0,       Club: 888888888, Class: 2, StartNo: 3, StartTime: 1, FinishTime: 0, Status: 0, Card: 0 },
    { Id: 31, Name: "Stig Vedin",         CardNo: 503101, Club: 22, Class: 2, StartNo: 4,  StartTime: 1, FinishTime: 502410, Status: 1,  Card: 14 },
    { Id: 33, Name: "Oskar Svensson",     CardNo: 503267, Club: 8,  Class: 2, StartNo: 5,  StartTime: 1, FinishTime: 499150, Status: 1,  Card: 32 },
    { Id: 27, Name: "Kirsten Nilsson",    CardNo: 502673, Club: 18, Class: 2, StartNo: 6,  StartTime: 1, FinishTime: 503320, Status: 1,  Card: 2  },
    { Id: 36, Name: "Kim Johansson",      CardNo: 503525, Club: 15, Class: 2, StartNo: 7,  StartTime: 1, FinishTime: 496700, Status: 1,  Card: 29 },
    { Id: 38, Name: "Vakant",             CardNo: 0,       Club: 888888888, Class: 2, StartNo: 8, StartTime: 1, FinishTime: 0, Status: 0, Card: 0 },
    { Id: 34, Name: "Ewa Fröjd",          CardNo: 503381, Club: 6,  Class: 2, StartNo: 9,  StartTime: 1, FinishTime: 503960, Status: 1,  Card: 12 },
    { Id: 28, Name: "Åsa Robertsson",     CardNo: 502718, Club: 17, Class: 2, StartNo: 10, StartTime: 1, FinishTime: 506430, Status: 0,  Card: 3  },
    { Id: 35, Name: "Leif Frisell",       CardNo: 503457, Club: 12, Class: 2, StartNo: 11, StartTime: 1, FinishTime: 503920, Status: 1,  Card: 21 },
    { Id: 39, Name: "Vakant",             CardNo: 0,       Club: 888888888, Class: 2, StartNo: 12, StartTime: 1, FinishTime: 0, Status: 0, Card: 0 },
    { Id: 29, Name: "Gunnar Wickberg",    CardNo: 502846, Club: 6,  Class: 2, StartNo: 13, StartTime: 1, FinishTime: 504800, Status: 1,  Card: 22 },
    { Id: 32, Name: "Sara Stridfeldt",    CardNo: 503129, Club: 28, Class: 2, StartNo: 14, StartTime: 1, FinishTime: 502450, Status: 1,  Card: 33 },

    // Class 3 (Öppen 3) — 15 runners
    { Id: 40, Name: "Börje Löfgren",      CardNo: 503962, Club: 9,  Class: 3, StartNo: 1,  StartTime: 1, FinishTime: 488960, Status: 1,  Card: 8  },
    { Id: 48, Name: "Isabella Johansson", CardNo: 504678, Club: 1,  Class: 3, StartNo: 2,  StartTime: 1, FinishTime: 494580, Status: 3,  Card: 36 },
    { Id: 43, Name: "Ann Thulin",         CardNo: 504188, Club: 15, Class: 3, StartNo: 3,  StartTime: 1, FinishTime: 496200, Status: 1,  Card: 6  },
    { Id: 52, Name: "Vakant",             CardNo: 0,       Club: 888888888, Class: 3, StartNo: 4, StartTime: 1, FinishTime: 0, Status: 0, Card: 0 },
    { Id: 49, Name: "Hjalmar Enström",    CardNo: 504804, Club: 30, Class: 3, StartNo: 5,  StartTime: 1, FinishTime: 490040, Status: 1,  Card: 34 },
    { Id: 51, Name: "Kristina Pettersson",CardNo: 504987, Club: 15, Class: 3, StartNo: 6,  StartTime: 1, FinishTime: 493920, Status: 1,  Card: 20 },
    { Id: 50, Name: "Thomas Hilmersson",  CardNo: 504862, Club: 21, Class: 3, StartNo: 7,  StartTime: 1, FinishTime: 496030, Status: 1,  Card: 18 },
    { Id: 47, Name: "Susanne Jansson",    CardNo: 504636, Club: 15, Class: 3, StartNo: 8,  StartTime: 1, FinishTime: 488200, Status: 1,  Card: 17 },
    { Id: 53, Name: "Vakant",             CardNo: 0,       Club: 888888888, Class: 3, StartNo: 9, StartTime: 1, FinishTime: 0, Status: 0, Card: 0 },
    { Id: 41, Name: "Leif Wallström",     CardNo: 503981, Club: 3,  Class: 3, StartNo: 10, StartTime: 1, FinishTime: 494590, Status: 1,  Card: 30 },
    { Id: 44, Name: "Hampus Berggren",    CardNo: 504347, Club: 2,  Class: 3, StartNo: 11, StartTime: 1, FinishTime: 494830, Status: 1,  Card: 15 },
    { Id: 46, Name: "Ronny Backman",      CardNo: 504542, Club: 8,  Class: 3, StartNo: 12, StartTime: 1, FinishTime: 486830, Status: 1,  Card: 26 },
    { Id: 45, Name: "Mats Mollén",        CardNo: 504368, Club: 15, Class: 3, StartNo: 13, StartTime: 1, FinishTime: 496340, Status: 1,  Card: 28 },
    { Id: 54, Name: "Vakant",             CardNo: 0,       Club: 888888888, Class: 3, StartNo: 14, StartTime: 1, FinishTime: 0, Status: 0, Card: 0 },
    { Id: 42, Name: "Vanja Engvall",      CardNo: 504134, Club: 15, Class: 3, StartNo: 15, StartTime: 1, FinishTime: 486600, Status: 1,  Card: 16 },
  ];

  for (const r of runners) {
    await prisma.oRunner.create({
      data: {
        Id: r.Id, Name: r.Name, CardNo: r.CardNo, Club: r.Club,
        Class: r.Class, StartNo: r.StartNo, StartTime: toRel(r.StartTime),
        FinishTime: toRel(r.FinishTime), Status: r.Status, Card: r.Card,
        EntryDate: 20150415,
        Fee: r.CardNo === 0 ? 0 : 110,
      },
    });
  }
}

async function seedCards(prisma: PrismaClient) {
  // Card readout data for runners who have finished (punch string = MeOS wire format)
  const cards = [
    { Id: 27,  CardNo: 500803,  Punches: "3-68400.0;67-45929.0;39-46198.0;78-46467.0;53-46736.0;44-47005.0;60-47543.0;41-47812.0;42-48082.0;37-48351.0;150-48620.0;64-48889.0;42-49158.0;77-49427.0;54-49696.0;100-49965.0;2-50235.0;" },
    { Id: 13,  CardNo: 501438,  Punches: "" },
    { Id: 5,   CardNo: 501061,  Punches: "3-68400.0;67-45926.0;39-46172.0;78-46418.0;53-46664.0;44-46910.0;50-47156.0;60-47402.0;41-47648.0;42-47894.0;37-48140.0;150-48386.0;64-48632.0;42-48878.0;77-49124.0;54-49370.0;100-49616.0;2-49863.0;" },
    { Id: 41,  CardNo: 502141,  Punches: "3-68400.0;67-45932.0;39-46174.0;78-46416.0;53-46658.0;44-46901.0;50-47143.0;60-47385.0;41-47627.0;42-47870.0;37-48112.0;150-48354.0;64-48596.0;42-48839.0;77-49081.0;54-49323.0;100-49565.0;2-49808.0;" },
    { Id: 9,   CardNo: 501259,  Punches: "3-68400.0;67-45995.0;39-46270.0;78-46545.0;53-46820.0;44-47095.0;50-47370.0;60-47645.0;41-47920.0;42-48196.0;37-48471.0;150-48746.0;64-49021.0;42-49296.0;77-49571.0;54-49846.0;100-50121.0;2-50397.0;" },
    { Id: 19,  CardNo: 501162,  Punches: "3-68400.0;67-45999.0;39-46268.0;78-46537.0;53-46807.0;44-47076.0;50-47345.0;60-47615.0;41-47884.0;42-48153.0;37-48422.0;150-48692.0;64-48961.0;42-49230.0;77-49500.0;54-49769.0;100-50038.0;" },
    { Id: 7,   CardNo: 500944,  Punches: "3-68400.0;67-46001.0;78-46523.0;53-46784.0;44-47045.0;50-47306.0;60-47567.0;41-47828.0;42-48089.0;37-48350.0;150-48611.0;64-48872.0;42-49133.0;54-49655.0;100-49916.0;2-50177.0;" },
    { Id: 44,  CardNo: 501929,  Punches: "3-68400.0;67-46045.0;39-46341.0;78-46636.0;53-46932.0;44-47227.0;60-47818.0;41-48114.0;42-48409.0;37-48705.0;150-49000.0;64-49296.0;42-49591.0;77-49887.0;54-50182.0;100-50478.0;2-50774.0;" },
    { Id: 4,   CardNo: 500196,  Punches: "3-68400.0;67-46035.0;39-46311.0;78-46586.0;53-46862.0;44-47138.0;50-47413.0;60-47689.0;41-47965.0;42-48240.0;37-48516.0;150-48792.0;64-49067.0;42-49343.0;77-49619.0;54-49894.0;100-50170.0;2-50446.0;" },
    { Id: 42,  CardNo: 501807,  Punches: "3-68400.0;67-46060.0;39-46350.0;78-46640.0;53-46931.0;44-47221.0;50-47511.0;60-47802.0;41-48092.0;42-48382.0;37-48672.0;150-48963.0;64-49253.0;42-49543.0;77-49834.0;54-50124.0;100-50414.0;2-50705.0;" },
    { Id: 31,  CardNo: 500416,  Punches: "3-68400.0;67-46072.0;39-46365.0;78-46658.0;53-46951.0;44-47244.0;50-47537.0;60-47830.0;41-48123.0;42-48415.0;37-48708.0;150-49001.0;64-49294.0;42-49587.0;77-49880.0;54-50173.0;100-50466.0;2-50759.0;" },
    { Id: 23,  CardNo: 501685,  Punches: "3-68400.0;67-46090.0;39-46371.0;78-46651.0;53-46932.0;44-47212.0;50-47493.0;60-47773.0;41-48054.0;42-48334.0;37-48615.0;150-48895.0;64-49176.0;42-49456.0;77-49737.0;54-50017.0;100-50298.0;2-50579.0;" },
    { Id: 40,  CardNo: 501524,  Punches: "3-68400.0;67-46083.0;39-46346.0;78-46609.0;53-46872.0;44-47135.0;50-47398.0;60-47661.0;41-47924.0;42-48187.0;37-48450.0;150-48713.0;64-48976.0;42-49239.0;77-49502.0;54-49765.0;100-50028.0;2-50292.0;" },
    { Id: 35,  CardNo: 501588,  Punches: "3-68400.0;67-46070.0;39-46311.0;78-46552.0;53-46792.0;44-47033.0;50-47274.0;60-47514.0;41-47755.0;42-47996.0;37-48237.0;150-48477.0;64-48718.0;42-48959.0;77-49199.0;54-49440.0;100-49681.0;2-49922.0;" },
    { Id: 39,  CardNo: 500545,  Punches: "3-68400.0;67-46126.0;39-46413.0;78-46700.0;53-46987.0;44-47274.0;50-47561.0;60-47848.0;41-48135.0;42-48422.0;37-48709.0;150-48996.0;64-49283.0;42-49570.0;77-49857.0;54-50144.0;100-50431.0;2-50718.0;" },
    { Id: 10,  CardNo: 500699,  Punches: "3-68400.0;67-46116.0;39-46382.0;78-46648.0;53-46914.0;44-47180.0;50-47446.0;60-47712.0;41-47978.0;42-48244.0;37-48510.0;150-48776.0;64-49042.0;42-49308.0;77-49574.0;54-49840.0;100-50106.0;2-50373.0;" },
    { Id: 1,   CardNo: 500319,  Punches: "3-68400.0;67-46104.0;39-46348.0;78-46592.0;53-46836.0;44-47080.0;50-47325.0;60-47569.0;41-47813.0;42-48057.0;37-48301.0;150-48545.0;64-48790.0;42-49034.0;77-49278.0;54-49522.0;100-49766.0;2-50011.0;" },
    { Id: 25,  CardNo: 500188,  Punches: "3-68400.0;67-46158.0;39-46447.0;78-46736.0;53-47025.0;44-47313.0;50-47602.0;60-47891.0;41-48180.0;42-48468.0;37-48757.0;150-49046.0;64-49335.0;42-49623.0;77-49912.0;54-50201.0;100-50490.0;2-50779.0;" },
    { Id: 38,  CardNo: 501320,  Punches: "3-68400.0;67-46129.0;39-46379.0;78-46629.0;53-46879.0;44-47129.0;50-47378.0;60-47628.0;41-47878.0;42-48128.0;37-48378.0;150-48628.0;64-48877.0;42-49127.0;77-49377.0;54-49627.0;100-49877.0;2-50127.0;" },
    { Id: 43,  CardNo: 501957,  Punches: "3-68400.0;67-46149.0;39-46398.0;78-46647.0;53-46896.0;44-47145.0;50-47394.0;60-47643.0;41-47892.0;42-48142.0;37-48391.0;150-48640.0;64-48889.0;42-49138.0;77-49387.0;54-49636.0;100-49885.0;2-50135.0;" },
    // Class 2 cards
    { Id: 11,  CardNo: 502583,  Punches: "3-68400.0;81-46444.0;50-47228.0;40-48012.0;150-48796.0;100-49580.0;" },
    { Id: 37,  CardNo: 502935,  Punches: "3-68400.0;81-46374.0;50-47079.0;40-47784.0;150-48488.0;100-49193.0;2-49898.0;" },
    { Id: 14,  CardNo: 503101,  Punches: "3-68400.0;81-46448.0;50-47207.0;40-47965.0;150-48724.0;100-49482.0;2-50241.0;" },
    { Id: 32,  CardNo: 503267,  Punches: "3-68400.0;81-46402.0;50-47105.0;40-47807.0;150-48510.0;100-49212.0;2-49915.0;" },
    { Id: 2,   CardNo: 502673,  Punches: "3-68400.0;81-46480.0;50-47250.0;40-48021.0;150-48791.0;100-49561.0;2-50332.0;" },
    { Id: 29,  CardNo: 503525,  Punches: "3-68400.0;81-46378.0;50-47036.0;40-47695.0;150-48353.0;100-49011.0;2-49670.0;" },
    { Id: 12,  CardNo: 503381,  Punches: "3-68400.0;81-46516.0;50-47292.0;40-48068.0;150-48844.0;100-49620.0;2-50396.0;" },
    { Id: 3,   CardNo: 502718,  Punches: "3-68400.0;81-46565.0;50-47381.0;40-48196.0;150-49012.0;100-49827.0;2-50643.0;" },
    { Id: 21,  CardNo: 503457,  Punches: "3-68400.0;81-46532.0;50-47304.0;40-48076.0;150-48848.0;100-49620.0;2-50392.0;" },
    { Id: 22,  CardNo: 502846,  Punches: "3-68400.0;81-46563.0;50-47346.0;40-48130.0;150-48913.0;100-49696.0;2-50480.0;" },
    { Id: 33,  CardNo: 503129,  Punches: "3-68400.0;81-46532.0;50-47275.0;40-48017.0;150-48760.0;100-49502.0;2-50245.0;" },
    // Class 3 cards
    { Id: 8,   CardNo: 503962,  Punches: "3-68400.0;61-46019.0;34-46379.0;50-46738.0;79-47098.0;89-47457.0;150-47817.0;93-48176.0;100-48536.0;2-48896.0;" },
    { Id: 36,  CardNo: 504678,  Punches: "3-68400.0;34-46511.0;50-46932.0;79-47353.0;89-47774.0;150-48195.0;93-48616.0;100-49037.0;2-49458.0;" },
    { Id: 6,   CardNo: 504188,  Punches: "3-68400.0;61-46117.0;34-46555.0;50-46993.0;79-47431.0;89-47868.0;150-48306.0;93-48744.0;100-49182.0;2-49620.0;" },
    { Id: 34,  CardNo: 504804,  Punches: "3-68400.0;61-46067.0;34-46434.0;50-46801.0;79-47168.0;89-47535.0;150-47902.0;93-48269.0;100-48636.0;2-49004.0;" },
    { Id: 20,  CardNo: 504987,  Punches: "3-68400.0;61-46119.0;34-46528.0;50-46937.0;79-47346.0;89-47755.0;150-48164.0;93-48573.0;100-48982.0;2-49392.0;" },
    { Id: 18,  CardNo: 504862,  Punches: "3-68400.0;61-46151.0;34-46582.0;50-47014.0;79-47445.0;89-47877.0;150-48308.0;93-48740.0;100-49171.0;2-49603.0;" },
    { Id: 17,  CardNo: 504636,  Punches: "3-68400.0;61-46073.0;34-46416.0;50-46760.0;79-47103.0;89-47446.0;150-47790.0;93-48133.0;100-48476.0;2-48820.0;" },
    { Id: 30,  CardNo: 503981,  Punches: "3-68400.0;61-46162.0;34-46574.0;50-46986.0;79-47398.0;89-47810.0;150-48222.0;93-48634.0;100-49046.0;2-49459.0;" },
    { Id: 15,  CardNo: 504347,  Punches: "3-68400.0;61-46173.0;34-46587.0;50-47001.0;79-47414.0;89-47828.0;150-48242.0;93-48655.0;100-49069.0;2-49483.0;" },
    { Id: 26,  CardNo: 504542,  Punches: "3-68400.0;61-46093.0;34-46417.0;50-46741.0;79-47064.0;89-47388.0;150-47712.0;93-48035.0;100-48359.0;2-48683.0;" },
    { Id: 28,  CardNo: 504368,  Punches: "3-68400.0;61-46208.0;34-46636.0;50-47064.0;79-47492.0;89-47921.0;150-48349.0;93-48777.0;100-49205.0;2-49634.0;" },
    { Id: 16,  CardNo: 504134,  Punches: "3-68400.0;61-46117.0;34-46435.0;50-46753.0;79-47071.0;89-47388.0;150-47706.0;93-48024.0;100-48342.0;2-48660.0;" },
    // Card 24 (not in dump but referenced by runner 24 which has a card=5 - corrected: actually none use 24)
    { Id: 24,  CardNo: 502118,  Punches: "3-68400.0;67-45955.0;39-46210.0;78-46466.0;53-46721.0;44-46977.0;50-47232.0;60-47488.0;41-47743.0;42-47999.0;37-48254.0;150-48510.0;64-48765.0;42-49021.0;77-49276.0;54-49532.0;100-49787.0;2-50043.0;" },
  ];

  for (const c of cards) {
    await prisma.oCard.create({
      data: { Id: c.Id, CardNo: c.CardNo, Punches: toRelPunches(c.Punches) },
    });
  }

  // Free punches (Albin Bergman's card pre-checks) — times are ZeroTime-relative
  await prisma.oPunch.createMany({
    data: [
      { Id: 1, CardNo: 2220164, Time: toRel(598400), Type: 200, Unit: 200, Origin: 1225432524 },
      { Id: 2, CardNo: 2220164, Time: toRel(617970), Type: 200, Unit: 200, Origin: 299824060  },
      { Id: 3, CardNo: 2220164, Time: toRel(618700), Type: 200, Unit: 200, Origin: 418152654  },
    ],
  });
}

async function seedEvent(prisma: PrismaClient) {
  // Minimal oEvent row — the important fields for E2E tests
  await prisma.oEvent.create({
    data: {
      Id: 1,
      Name: "My example tävling",
      Date: "2026-04-15",
      NameId: "itest",
      ZeroTime: ZERO_TIME_DS, // 09:00:00 — must match the toRel/toRelSec constants
    },
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Building itest seed database...`);

  console.log("  Recreating MySQL database...");
  await recreateDb();

  pushSchema();

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  try {
    await seed(prisma);
  } finally {
    await prisma.$disconnect();
  }

  dumpToSql();

  console.log(`Done! Regenerated: e2e/seed.sql`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
