/**
 * Seed builder for the `itest` E2E test event ("My example tävling").
 *
 * Runs against the database identified by DATABASE_URL — set by
 * `e2e/global-setup.ts` to the dedicated `oxygen_e2e` database. The
 * builder programmatically creates the full reference event used by most
 * of the E2E suite (3 classes, 3 courses, 23 controls, 54 runners,
 * 44 card readouts, 3 free punches).
 *
 * Run standalone (e.g. during development) with:
 *   DATABASE_URL="postgresql://oxygen:oxygen@localhost:5433/oxygen_e2e?schema=oxygen" \
 *     pnpm exec tsx e2e/seed-builder/build-itest.ts
 */
import {
  newPrisma,
  recreateEvent,
  toRel,
  toRelPunches,
  punchStringToJsonb,
  meosStatusToEnum,
} from "./shared.js";

const NAME_ID = "itest";
const NAME = "My example tävling";
const DATE = "2026-04-15";

// ─── Reference data ────────────────────────────────────────

// 27 clubs from the original MeOS dump. In the new schema clubs are not a
// per-event entity; we plant them in `club_directory` so that the runners
// (which reference `eventorClubId`) can be resolved to display names.
const CLUBS = [
  { id: 1n, name: "Degerfors OK" },
  { id: 2n, name: "Ankarsrums OK" },
  { id: 3n, name: "Bodafors OK" },
  { id: 4n, name: "Burseryds IF" },
  { id: 5n, name: "Domnarvets GOIF" },
  { id: 6n, name: "Gamleby OK" },
  { id: 7n, name: "Grangärde OK" },
  { id: 8n, name: "Halmstad OK" },
  { id: 9n, name: "Hedesunda IF" },
  { id: 10n, name: "OK Forsarna" },
  { id: 11n, name: "Hultsfreds OK" },
  { id: 12n, name: "Häverödals SK" },
  { id: 13n, name: "IFK Kiruna" },
  { id: 14n, name: "K 3 IF" },
  { id: 15n, name: "Kjula IF" },
  { id: 16n, name: "Krokeks OK" },
  { id: 17n, name: "Laxå OK" },
  { id: 18n, name: "Ljusne-Ala OK" },
  { id: 20n, name: "Niilivaara IS" },
  { id: 21n, name: "Nyköpings OK" },
  { id: 22n, name: "Robertsfors IK" },
  { id: 23n, name: "OK Roto" },
  { id: 24n, name: "Sigtuna OK" },
  { id: 25n, name: "Skellefteå OK" },
  { id: 26n, name: "FK Snapphanarna" },
  { id: 28n, name: "IK Surd" },
  { id: 30n, name: "OK Tranan" },
];

// 23 controls (id ↔ code).
const CONTROLS: Array<{ code: number; name?: string }> = [
  { code: 34 },
  { code: 37 },
  { code: 39 },
  { code: 40 },
  { code: 41 },
  { code: 42 },
  { code: 44 },
  { code: 50, name: "Radio 1" },
  { code: 53 },
  { code: 54 },
  { code: 60 },
  { code: 61 },
  { code: 64 },
  { code: 67 },
  { code: 77 },
  { code: 78 },
  { code: 79 },
  { code: 81 },
  { code: 89 },
  { code: 93 },
  { code: 100, name: "Förvarning" },
  { code: 150, name: "Radio 2" },
  { code: 200, name: "Pre-start" },
];

// 3 courses with their control sequences (semicolon was the MeOS format).
const COURSES = [
  {
    legacyId: 1,
    name: "Bana 1",
    controls: [67, 39, 78, 53, 44, 50, 60, 41, 42, 37, 150, 64, 42, 77, 54, 100],
    lengthM: 7340,
    numberMaps: 30,
  },
  {
    legacyId: 2,
    name: "Bana 2",
    controls: [81, 50, 40, 150, 100],
    lengthM: 7060,
    numberMaps: 30,
  },
  {
    legacyId: 3,
    name: "Bana 3",
    controls: [61, 34, 50, 79, 89, 150, 93, 100],
    lengthM: 3400,
    numberMaps: 30,
  },
];

// 3 classes.
const CLASSES = [
  {
    legacyId: 1,
    name: "Öppen 1",
    courseLegacyId: 1,
    sortIndex: 10,
    classType: "Open",
    startBlock: 1,
    allowQuickEntry: true,
  },
  {
    legacyId: 2,
    name: "Öppen 2",
    courseLegacyId: 2,
    sortIndex: 20,
    classType: "Open",
    startBlock: 0,
    allowQuickEntry: true,
  },
  {
    legacyId: 3,
    name: "Öppen 3",
    courseLegacyId: 3,
    sortIndex: 30,
    classType: "Open",
    startBlock: 0,
    allowQuickEntry: true,
  },
];

interface SeedRunner {
  name: string;
  cardNo: number;
  clubLegacyId: number; // 0 = vacant / no club
  classLegacyId: number;
  startNo: number;
  startTimeAbs: number;
  finishTimeAbs: number;
  status: number;
  cardLegacyId: number; // 0 = no card linked
}

// 54 runners — exactly mirrors the old MeOS seed.
const RUNNERS: SeedRunner[] = [
  // Class 1 (Öppen 1) — 25 runners (3 vacant)
  { name: "Monica Henriksson", cardNo: 500803, clubLegacyId: 2, classLegacyId: 1, startNo: 1, startTimeAbs: 456600, finishTimeAbs: 502350, status: 3, cardLegacyId: 27 },
  { name: "Malin Johannesson", cardNo: 501438, clubLegacyId: 16, classLegacyId: 1, startNo: 2, startTimeAbs: 1, finishTimeAbs: 502850, status: 1, cardLegacyId: 13 },
  { name: "Nilsson Collryd", cardNo: 501061, clubLegacyId: 20, classLegacyId: 1, startNo: 3, startTimeAbs: 1, finishTimeAbs: 498630, status: 1, cardLegacyId: 5 },
  { name: "Roger Thörnblom", cardNo: 502141, clubLegacyId: 15, classLegacyId: 1, startNo: 4, startTimeAbs: 1, finishTimeAbs: 498080, status: 1, cardLegacyId: 41 },
  { name: "Albin Bergman", cardNo: 2220164, clubLegacyId: 12, classLegacyId: 1, startNo: 5, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Vakant", cardNo: 0, clubLegacyId: 0, classLegacyId: 1, startNo: 6, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Helena Bergström", cardNo: 501259, clubLegacyId: 13, classLegacyId: 1, startNo: 7, startTimeAbs: 1, finishTimeAbs: 503970, status: 1, cardLegacyId: 9 },
  { name: "Magnus Johansson", cardNo: 501162, clubLegacyId: 15, classLegacyId: 1, startNo: 8, startTimeAbs: 1, finishTimeAbs: 0, status: 4, cardLegacyId: 19 },
  { name: "Bo-Göran Persson", cardNo: 500944, clubLegacyId: 15, classLegacyId: 1, startNo: 9, startTimeAbs: 1, finishTimeAbs: 501770, status: 3, cardLegacyId: 7 },
  { name: "Gun Karlsson", cardNo: 501929, clubLegacyId: 10, classLegacyId: 1, startNo: 10, startTimeAbs: 1, finishTimeAbs: 507740, status: 3, cardLegacyId: 44 },
  { name: "Thommie Antonsson", cardNo: 500196, clubLegacyId: 4, classLegacyId: 1, startNo: 11, startTimeAbs: 1, finishTimeAbs: 504460, status: 1, cardLegacyId: 4 },
  { name: "Monica Johansson", cardNo: 501807, clubLegacyId: 15, classLegacyId: 1, startNo: 12, startTimeAbs: 1, finishTimeAbs: 507050, status: 1, cardLegacyId: 42 },
  { name: "Charlotte Olovsson", cardNo: 500416, clubLegacyId: 7, classLegacyId: 1, startNo: 13, startTimeAbs: 1, finishTimeAbs: 507590, status: 1, cardLegacyId: 31 },
  { name: "Eva Rådberg", cardNo: 500671, clubLegacyId: 25, classLegacyId: 1, startNo: 14, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Vakant", cardNo: 0, clubLegacyId: 0, classLegacyId: 1, startNo: 15, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Björn Carlsson", cardNo: 501685, clubLegacyId: 5, classLegacyId: 1, startNo: 16, startTimeAbs: 1, finishTimeAbs: 505790, status: 1, cardLegacyId: 23 },
  { name: "Simon Johansson", cardNo: 501524, clubLegacyId: 21, classLegacyId: 1, startNo: 17, startTimeAbs: 1, finishTimeAbs: 502920, status: 1, cardLegacyId: 40 },
  { name: "Filip Johansson", cardNo: 501588, clubLegacyId: 9, classLegacyId: 1, startNo: 18, startTimeAbs: 1, finishTimeAbs: 499220, status: 1, cardLegacyId: 35 },
  { name: "Ted Björkman", cardNo: 500545, clubLegacyId: 23, classLegacyId: 1, startNo: 19, startTimeAbs: 1, finishTimeAbs: 507180, status: 1, cardLegacyId: 39 },
  { name: "Stig Gösswein", cardNo: 500699, clubLegacyId: 4, classLegacyId: 1, startNo: 20, startTimeAbs: 1, finishTimeAbs: 503730, status: 1, cardLegacyId: 10 },
  { name: "Annelie Najvik", cardNo: 500319, clubLegacyId: 15, classLegacyId: 1, startNo: 21, startTimeAbs: 1, finishTimeAbs: 500110, status: 1, cardLegacyId: 1 },
  { name: "Linda Klick", cardNo: 500188, clubLegacyId: 7, classLegacyId: 1, startNo: 22, startTimeAbs: 1, finishTimeAbs: 507790, status: 1, cardLegacyId: 25 },
  { name: "Tova Askeljung", cardNo: 501320, clubLegacyId: 3, classLegacyId: 1, startNo: 23, startTimeAbs: 1, finishTimeAbs: 501270, status: 1, cardLegacyId: 38 },
  { name: "Vakant", cardNo: 0, clubLegacyId: 0, classLegacyId: 1, startNo: 24, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Johan Jonsson", cardNo: 501957, clubLegacyId: 15, classLegacyId: 1, startNo: 25, startTimeAbs: 1, finishTimeAbs: 501350, status: 1, cardLegacyId: 43 },

  // Class 2 (Öppen 2) — 14 runners (3 vacant)
  { name: "Ann Sjödin", cardNo: 502583, clubLegacyId: 15, classLegacyId: 2, startNo: 1, startTimeAbs: 1, finishTimeAbs: 0, status: 4, cardLegacyId: 11 },
  { name: "Stefan Hersén", cardNo: 502935, clubLegacyId: 12, classLegacyId: 2, startNo: 2, startTimeAbs: 1, finishTimeAbs: 498980, status: 1, cardLegacyId: 37 },
  { name: "Vakant", cardNo: 0, clubLegacyId: 0, classLegacyId: 2, startNo: 3, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Stig Vedin", cardNo: 503101, clubLegacyId: 22, classLegacyId: 2, startNo: 4, startTimeAbs: 1, finishTimeAbs: 502410, status: 1, cardLegacyId: 14 },
  { name: "Oskar Svensson", cardNo: 503267, clubLegacyId: 8, classLegacyId: 2, startNo: 5, startTimeAbs: 1, finishTimeAbs: 499150, status: 1, cardLegacyId: 32 },
  { name: "Kirsten Nilsson", cardNo: 502673, clubLegacyId: 18, classLegacyId: 2, startNo: 6, startTimeAbs: 1, finishTimeAbs: 503320, status: 1, cardLegacyId: 2 },
  { name: "Kim Johansson", cardNo: 503525, clubLegacyId: 15, classLegacyId: 2, startNo: 7, startTimeAbs: 1, finishTimeAbs: 496700, status: 1, cardLegacyId: 29 },
  { name: "Vakant", cardNo: 0, clubLegacyId: 0, classLegacyId: 2, startNo: 8, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Ewa Fröjd", cardNo: 503381, clubLegacyId: 6, classLegacyId: 2, startNo: 9, startTimeAbs: 1, finishTimeAbs: 503960, status: 1, cardLegacyId: 12 },
  { name: "Åsa Robertsson", cardNo: 502718, clubLegacyId: 17, classLegacyId: 2, startNo: 10, startTimeAbs: 1, finishTimeAbs: 506430, status: 0, cardLegacyId: 3 },
  { name: "Leif Frisell", cardNo: 503457, clubLegacyId: 12, classLegacyId: 2, startNo: 11, startTimeAbs: 1, finishTimeAbs: 503920, status: 1, cardLegacyId: 21 },
  { name: "Vakant", cardNo: 0, clubLegacyId: 0, classLegacyId: 2, startNo: 12, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Gunnar Wickberg", cardNo: 502846, clubLegacyId: 6, classLegacyId: 2, startNo: 13, startTimeAbs: 1, finishTimeAbs: 504800, status: 1, cardLegacyId: 22 },
  { name: "Sara Stridfeldt", cardNo: 503129, clubLegacyId: 28, classLegacyId: 2, startNo: 14, startTimeAbs: 1, finishTimeAbs: 502450, status: 1, cardLegacyId: 33 },

  // Class 3 (Öppen 3) — 15 runners (3 vacant)
  { name: "Börje Löfgren", cardNo: 503962, clubLegacyId: 9, classLegacyId: 3, startNo: 1, startTimeAbs: 1, finishTimeAbs: 488960, status: 1, cardLegacyId: 8 },
  { name: "Isabella Johansson", cardNo: 504678, clubLegacyId: 1, classLegacyId: 3, startNo: 2, startTimeAbs: 1, finishTimeAbs: 494580, status: 3, cardLegacyId: 36 },
  { name: "Ann Thulin", cardNo: 504188, clubLegacyId: 15, classLegacyId: 3, startNo: 3, startTimeAbs: 1, finishTimeAbs: 496200, status: 1, cardLegacyId: 6 },
  { name: "Vakant", cardNo: 0, clubLegacyId: 0, classLegacyId: 3, startNo: 4, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Hjalmar Enström", cardNo: 504804, clubLegacyId: 30, classLegacyId: 3, startNo: 5, startTimeAbs: 1, finishTimeAbs: 490040, status: 1, cardLegacyId: 34 },
  { name: "Kristina Pettersson", cardNo: 504987, clubLegacyId: 15, classLegacyId: 3, startNo: 6, startTimeAbs: 1, finishTimeAbs: 493920, status: 1, cardLegacyId: 20 },
  { name: "Thomas Hilmersson", cardNo: 504862, clubLegacyId: 21, classLegacyId: 3, startNo: 7, startTimeAbs: 1, finishTimeAbs: 496030, status: 1, cardLegacyId: 18 },
  { name: "Susanne Jansson", cardNo: 504636, clubLegacyId: 15, classLegacyId: 3, startNo: 8, startTimeAbs: 1, finishTimeAbs: 488200, status: 1, cardLegacyId: 17 },
  { name: "Vakant", cardNo: 0, clubLegacyId: 0, classLegacyId: 3, startNo: 9, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Leif Wallström", cardNo: 503981, clubLegacyId: 3, classLegacyId: 3, startNo: 10, startTimeAbs: 1, finishTimeAbs: 494590, status: 1, cardLegacyId: 30 },
  { name: "Hampus Berggren", cardNo: 504347, clubLegacyId: 2, classLegacyId: 3, startNo: 11, startTimeAbs: 1, finishTimeAbs: 494830, status: 1, cardLegacyId: 15 },
  { name: "Ronny Backman", cardNo: 504542, clubLegacyId: 8, classLegacyId: 3, startNo: 12, startTimeAbs: 1, finishTimeAbs: 486830, status: 1, cardLegacyId: 26 },
  { name: "Mats Mollén", cardNo: 504368, clubLegacyId: 15, classLegacyId: 3, startNo: 13, startTimeAbs: 1, finishTimeAbs: 496340, status: 1, cardLegacyId: 28 },
  { name: "Vakant", cardNo: 0, clubLegacyId: 0, classLegacyId: 3, startNo: 14, startTimeAbs: 1, finishTimeAbs: 0, status: 0, cardLegacyId: 0 },
  { name: "Vanja Engvall", cardNo: 504134, clubLegacyId: 15, classLegacyId: 3, startNo: 15, startTimeAbs: 1, finishTimeAbs: 486600, status: 1, cardLegacyId: 16 },
];

interface SeedCard {
  legacyId: number;
  cardNo: number;
  punches: string;
}

// 44 card readouts — punches are in absolute seconds (MeOS format). The
// helpers convert to ZeroTime-relative for storage.
const CARDS: SeedCard[] = [
  { legacyId: 27, cardNo: 500803, punches: "3-68400.0;67-45929.0;39-46198.0;78-46467.0;53-46736.0;44-47005.0;60-47543.0;41-47812.0;42-48082.0;37-48351.0;150-48620.0;64-48889.0;42-49158.0;77-49427.0;54-49696.0;100-49965.0;2-50235.0;" },
  { legacyId: 13, cardNo: 501438, punches: "" },
  { legacyId: 5, cardNo: 501061, punches: "3-68400.0;67-45926.0;39-46172.0;78-46418.0;53-46664.0;44-46910.0;50-47156.0;60-47402.0;41-47648.0;42-47894.0;37-48140.0;150-48386.0;64-48632.0;42-48878.0;77-49124.0;54-49370.0;100-49616.0;2-49863.0;" },
  { legacyId: 41, cardNo: 502141, punches: "3-68400.0;67-45932.0;39-46174.0;78-46416.0;53-46658.0;44-46901.0;50-47143.0;60-47385.0;41-47627.0;42-47870.0;37-48112.0;150-48354.0;64-48596.0;42-48839.0;77-49081.0;54-49323.0;100-49565.0;2-49808.0;" },
  { legacyId: 9, cardNo: 501259, punches: "3-68400.0;67-45995.0;39-46270.0;78-46545.0;53-46820.0;44-47095.0;50-47370.0;60-47645.0;41-47920.0;42-48196.0;37-48471.0;150-48746.0;64-49021.0;42-49296.0;77-49571.0;54-49846.0;100-50121.0;2-50397.0;" },
  { legacyId: 19, cardNo: 501162, punches: "3-68400.0;67-45999.0;39-46268.0;78-46537.0;53-46807.0;44-47076.0;50-47345.0;60-47615.0;41-47884.0;42-48153.0;37-48422.0;150-48692.0;64-48961.0;42-49230.0;77-49500.0;54-49769.0;100-50038.0;" },
  { legacyId: 7, cardNo: 500944, punches: "3-68400.0;67-46001.0;78-46523.0;53-46784.0;44-47045.0;50-47306.0;60-47567.0;41-47828.0;42-48089.0;37-48350.0;150-48611.0;64-48872.0;42-49133.0;54-49655.0;100-49916.0;2-50177.0;" },
  { legacyId: 44, cardNo: 501929, punches: "3-68400.0;67-46045.0;39-46341.0;78-46636.0;53-46932.0;44-47227.0;60-47818.0;41-48114.0;42-48409.0;37-48705.0;150-49000.0;64-49296.0;42-49591.0;77-49887.0;54-50182.0;100-50478.0;2-50774.0;" },
  { legacyId: 4, cardNo: 500196, punches: "3-68400.0;67-46035.0;39-46311.0;78-46586.0;53-46862.0;44-47138.0;50-47413.0;60-47689.0;41-47965.0;42-48240.0;37-48516.0;150-48792.0;64-49067.0;42-49343.0;77-49619.0;54-49894.0;100-50170.0;2-50446.0;" },
  { legacyId: 42, cardNo: 501807, punches: "3-68400.0;67-46060.0;39-46350.0;78-46640.0;53-46931.0;44-47221.0;50-47511.0;60-47802.0;41-48092.0;42-48382.0;37-48672.0;150-48963.0;64-49253.0;42-49543.0;77-49834.0;54-50124.0;100-50414.0;2-50705.0;" },
  { legacyId: 31, cardNo: 500416, punches: "3-68400.0;67-46072.0;39-46365.0;78-46658.0;53-46951.0;44-47244.0;50-47537.0;60-47830.0;41-48123.0;42-48415.0;37-48708.0;150-49001.0;64-49294.0;42-49587.0;77-49880.0;54-50173.0;100-50466.0;2-50759.0;" },
  { legacyId: 23, cardNo: 501685, punches: "3-68400.0;67-46090.0;39-46371.0;78-46651.0;53-46932.0;44-47212.0;50-47493.0;60-47773.0;41-48054.0;42-48334.0;37-48615.0;150-48895.0;64-49176.0;42-49456.0;77-49737.0;54-50017.0;100-50298.0;2-50579.0;" },
  { legacyId: 40, cardNo: 501524, punches: "3-68400.0;67-46083.0;39-46346.0;78-46609.0;53-46872.0;44-47135.0;50-47398.0;60-47661.0;41-47924.0;42-48187.0;37-48450.0;150-48713.0;64-48976.0;42-49239.0;77-49502.0;54-49765.0;100-50028.0;2-50292.0;" },
  { legacyId: 35, cardNo: 501588, punches: "3-68400.0;67-46070.0;39-46311.0;78-46552.0;53-46792.0;44-47033.0;50-47274.0;60-47514.0;41-47755.0;42-47996.0;37-48237.0;150-48477.0;64-48718.0;42-48959.0;77-49199.0;54-49440.0;100-49681.0;2-49922.0;" },
  { legacyId: 39, cardNo: 500545, punches: "3-68400.0;67-46126.0;39-46413.0;78-46700.0;53-46987.0;44-47274.0;50-47561.0;60-47848.0;41-48135.0;42-48422.0;37-48709.0;150-48996.0;64-49283.0;42-49570.0;77-49857.0;54-50144.0;100-50431.0;2-50718.0;" },
  { legacyId: 10, cardNo: 500699, punches: "3-68400.0;67-46116.0;39-46382.0;78-46648.0;53-46914.0;44-47180.0;50-47446.0;60-47712.0;41-47978.0;42-48244.0;37-48510.0;150-48776.0;64-49042.0;42-49308.0;77-49574.0;54-49840.0;100-50106.0;2-50373.0;" },
  { legacyId: 1, cardNo: 500319, punches: "3-68400.0;67-46104.0;39-46348.0;78-46592.0;53-46836.0;44-47080.0;50-47325.0;60-47569.0;41-47813.0;42-48057.0;37-48301.0;150-48545.0;64-48790.0;42-49034.0;77-49278.0;54-49522.0;100-49766.0;2-50011.0;" },
  { legacyId: 25, cardNo: 500188, punches: "3-68400.0;67-46158.0;39-46447.0;78-46736.0;53-47025.0;44-47313.0;50-47602.0;60-47891.0;41-48180.0;42-48468.0;37-48757.0;150-49046.0;64-49335.0;42-49623.0;77-49912.0;54-50201.0;100-50490.0;2-50779.0;" },
  { legacyId: 38, cardNo: 501320, punches: "3-68400.0;67-46129.0;39-46379.0;78-46629.0;53-46879.0;44-47129.0;50-47378.0;60-47628.0;41-47878.0;42-48128.0;37-48378.0;150-48628.0;64-48877.0;42-49127.0;77-49377.0;54-49627.0;100-49877.0;2-50127.0;" },
  { legacyId: 43, cardNo: 501957, punches: "3-68400.0;67-46149.0;39-46398.0;78-46647.0;53-46896.0;44-47145.0;50-47394.0;60-47643.0;41-47892.0;42-48142.0;37-48391.0;150-48640.0;64-48889.0;42-49138.0;77-49387.0;54-49636.0;100-49885.0;2-50135.0;" },
  // Class 2 cards
  { legacyId: 11, cardNo: 502583, punches: "3-68400.0;81-46444.0;50-47228.0;40-48012.0;150-48796.0;100-49580.0;" },
  { legacyId: 37, cardNo: 502935, punches: "3-68400.0;81-46374.0;50-47079.0;40-47784.0;150-48488.0;100-49193.0;2-49898.0;" },
  { legacyId: 14, cardNo: 503101, punches: "3-68400.0;81-46448.0;50-47207.0;40-47965.0;150-48724.0;100-49482.0;2-50241.0;" },
  { legacyId: 32, cardNo: 503267, punches: "3-68400.0;81-46402.0;50-47105.0;40-47807.0;150-48510.0;100-49212.0;2-49915.0;" },
  { legacyId: 2, cardNo: 502673, punches: "3-68400.0;81-46480.0;50-47250.0;40-48021.0;150-48791.0;100-49561.0;2-50332.0;" },
  { legacyId: 29, cardNo: 503525, punches: "3-68400.0;81-46378.0;50-47036.0;40-47695.0;150-48353.0;100-49011.0;2-49670.0;" },
  { legacyId: 12, cardNo: 503381, punches: "3-68400.0;81-46516.0;50-47292.0;40-48068.0;150-48844.0;100-49620.0;2-50396.0;" },
  { legacyId: 3, cardNo: 502718, punches: "3-68400.0;81-46565.0;50-47381.0;40-48196.0;150-49012.0;100-49827.0;2-50643.0;" },
  { legacyId: 21, cardNo: 503457, punches: "3-68400.0;81-46532.0;50-47304.0;40-48076.0;150-48848.0;100-49620.0;2-50392.0;" },
  { legacyId: 22, cardNo: 502846, punches: "3-68400.0;81-46563.0;50-47346.0;40-48130.0;150-48913.0;100-49696.0;2-50480.0;" },
  { legacyId: 33, cardNo: 503129, punches: "3-68400.0;81-46532.0;50-47275.0;40-48017.0;150-48760.0;100-49502.0;2-50245.0;" },
  // Class 3 cards
  { legacyId: 8, cardNo: 503962, punches: "3-68400.0;61-46019.0;34-46379.0;50-46738.0;79-47098.0;89-47457.0;150-47817.0;93-48176.0;100-48536.0;2-48896.0;" },
  { legacyId: 36, cardNo: 504678, punches: "3-68400.0;34-46511.0;50-46932.0;79-47353.0;89-47774.0;150-48195.0;93-48616.0;100-49037.0;2-49458.0;" },
  { legacyId: 6, cardNo: 504188, punches: "3-68400.0;61-46117.0;34-46555.0;50-46993.0;79-47431.0;89-47868.0;150-48306.0;93-48744.0;100-49182.0;2-49620.0;" },
  { legacyId: 34, cardNo: 504804, punches: "3-68400.0;61-46067.0;34-46434.0;50-46801.0;79-47168.0;89-47535.0;150-47902.0;93-48269.0;100-48636.0;2-49004.0;" },
  { legacyId: 20, cardNo: 504987, punches: "3-68400.0;61-46119.0;34-46528.0;50-46937.0;79-47346.0;89-47755.0;150-48164.0;93-48573.0;100-48982.0;2-49392.0;" },
  { legacyId: 18, cardNo: 504862, punches: "3-68400.0;61-46151.0;34-46582.0;50-47014.0;79-47445.0;89-47877.0;150-48308.0;93-48740.0;100-49171.0;2-49603.0;" },
  { legacyId: 17, cardNo: 504636, punches: "3-68400.0;61-46073.0;34-46416.0;50-46760.0;79-47103.0;89-47446.0;150-47790.0;93-48133.0;100-48476.0;2-48820.0;" },
  { legacyId: 30, cardNo: 503981, punches: "3-68400.0;61-46162.0;34-46574.0;50-46986.0;79-47398.0;89-47810.0;150-48222.0;93-48634.0;100-49046.0;2-49459.0;" },
  { legacyId: 15, cardNo: 504347, punches: "3-68400.0;61-46173.0;34-46587.0;50-47001.0;79-47414.0;89-47828.0;150-48242.0;93-48655.0;100-49069.0;2-49483.0;" },
  { legacyId: 26, cardNo: 504542, punches: "3-68400.0;61-46093.0;34-46417.0;50-46741.0;79-47064.0;89-47388.0;150-47712.0;93-48035.0;100-48359.0;2-48683.0;" },
  { legacyId: 28, cardNo: 504368, punches: "3-68400.0;61-46208.0;34-46636.0;50-47064.0;79-47492.0;89-47921.0;150-48349.0;93-48777.0;100-49205.0;2-49634.0;" },
  { legacyId: 16, cardNo: 504134, punches: "3-68400.0;61-46117.0;34-46435.0;50-46753.0;79-47071.0;89-47388.0;150-47706.0;93-48024.0;100-48342.0;2-48660.0;" },
  { legacyId: 24, cardNo: 502118, punches: "3-68400.0;67-45955.0;39-46210.0;78-46466.0;53-46721.0;44-46977.0;50-47232.0;60-47488.0;41-47743.0;42-47999.0;37-48254.0;150-48510.0;64-48765.0;42-49021.0;77-49276.0;54-49532.0;100-49787.0;2-50043.0;" },
];

// ─── Main ──────────────────────────────────────────────────

async function main() {
  console.log(`  [seed:itest] Building "${NAME_ID}"...`);
  const prisma = newPrisma();

  try {
    // 1. Recreate event (cascades children).
    const { id: eventId } = await recreateEvent(prisma, {
      nameId: NAME_ID,
      name: NAME,
      date: DATE,
    });

    // 2. Global club directory (idempotent — shared across events).
    for (const club of CLUBS) {
      await prisma.clubDirectory.upsert({
        where: { eventorId: club.id },
        create: { eventorId: club.id, name: club.name },
        update: {},
      });
    }

    // 3. Controls — keep a code → UUID map for course/punch wiring.
    const controlByCode = new Map<number, string>();
    for (const c of CONTROLS) {
      const row = await prisma.control.create({
        data: {
          eventId,
          codes: String(c.code),
          name: c.name ?? "",
        },
        select: { id: true },
      });
      controlByCode.set(c.code, row.id);
    }

    // 4. Courses + course_controls (sequence map).
    const courseIdByLegacy = new Map<number, string>();
    for (const c of COURSES) {
      const course = await prisma.course.create({
        data: {
          eventId,
          name: c.name,
          lengthM: c.lengthM,
          numberOfMaps: c.numberMaps,
        },
        select: { id: true },
      });
      courseIdByLegacy.set(c.legacyId, course.id);

      // Insert ordered controls.
      let pos = 0;
      for (const code of c.controls) {
        const controlId = controlByCode.get(code);
        if (!controlId) throw new Error(`Course ${c.name}: unknown control code ${code}`);
        await prisma.courseControl.create({
          data: { courseId: course.id, position: pos++, controlId },
        });
      }
    }

    // 5. Classes (link to courses).
    const classIdByLegacy = new Map<number, string>();
    for (const cl of CLASSES) {
      const courseId = courseIdByLegacy.get(cl.courseLegacyId);
      const cls = await prisma.class.create({
        data: {
          eventId,
          name: cl.name,
          courseId,
          sortIndex: cl.sortIndex,
          classType: cl.classType,
          startBlock: cl.startBlock,
          allowQuickEntry: cl.allowQuickEntry,
          classFeeCents: 11000,
          highClassFeeCents: 16500,
          classFeeRedCents: 7000,
          highClassFeeRedCents: 10500,
        },
        select: { id: true },
      });
      classIdByLegacy.set(cl.legacyId, cls.id);
    }

    // 6. Cards + CardReadouts. Order matters: insert readouts first, then
    //    cards referencing them. Then we can link runners.
    interface CardRef {
      cardId: string;
      cardNo: number;
    }
    const cardByLegacyId = new Map<number, CardRef>();
    for (const card of CARDS) {
      const punchesJsonb = punchStringToJsonb(card.punches);
      // CardReadout stores punches as parsed JSONB (absolute deciseconds).
      const readout = await prisma.cardReadout.create({
        data: {
          eventId,
          cardNo: card.cardNo,
          cardType: "SI Card",
          punches: punchesJsonb as never,
        },
        select: { id: true },
      });
      const cardRow = await prisma.card.create({
        data: {
          eventId,
          cardNo: card.cardNo,
          readoutId: readout.id,
          readCount: 1,
          punchesRaw: toRelPunches(card.punches),
        },
        select: { id: true },
      });
      cardByLegacyId.set(card.legacyId, { cardId: cardRow.id, cardNo: card.cardNo });
    }

    // 7. Runners.
    for (const r of RUNNERS) {
      const classId = classIdByLegacy.get(r.classLegacyId);
      const courseLegacy = CLASSES.find((c) => c.legacyId === r.classLegacyId)?.courseLegacyId;
      const courseId = courseLegacy != null ? courseIdByLegacy.get(courseLegacy) : null;
      const cardRef = r.cardLegacyId > 0 ? cardByLegacyId.get(r.cardLegacyId) : null;
      const clubMeta = r.clubLegacyId > 0
        ? CLUBS.find((c) => c.id === BigInt(r.clubLegacyId))
        : null;
      await prisma.runner.create({
        data: {
          eventId,
          classId,
          courseId,
          cardId: cardRef?.cardId ?? null,
          name: r.name,
          cardNo: r.cardNo,
          startNo: r.startNo,
          startTime: toRel(r.startTimeAbs),
          finishTime: toRel(r.finishTimeAbs),
          status: meosStatusToEnum(r.status),
          clubName: clubMeta?.name ?? "",
          eventorClubId: clubMeta ? clubMeta.id : null,
          entryDate: 20150415,
          feeCents: r.cardNo === 0 ? 0 : 11000,
        },
      });
    }

    // 8. Free punches for Albin Bergman's pre-start scans (card 2220164).
    //    Stored ZeroTime-relative in deciseconds. Times in the legacy seed
    //    were 598400, 617970, 618700 (absolute deciseconds).
    const albinFreePunches = [
      { time: 598400, type: 200, unit: 200, origin: 1225432524 },
      { time: 617970, type: 200, unit: 200, origin: 299824060 },
      { time: 618700, type: 200, unit: 200, origin: 418152654 },
    ];
    for (const p of albinFreePunches) {
      await prisma.punch.create({
        data: {
          eventId,
          cardNo: 2220164,
          controlCode: p.type,
          time: toRel(p.time),
          source: "online_input",
        },
      });
    }

    console.log(`  [seed:itest] Done.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[seed:itest] failed:", err);
  process.exit(1);
});
