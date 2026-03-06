/** Status values matching MeOS RunnerStatus */
export const RunnerStatus = {
  Unknown: 0,
  OK: 1,
  NoTiming: 2,
  MissingPunch: 3,
  DNF: 4,
  DQ: 5,
  OverMaxTime: 6,
  OutOfCompetition: 15,
  DNS: 20,
  Cancel: 21,
  NotCompeting: 99,
} as const;

export type RunnerStatusValue =
  (typeof RunnerStatus)[keyof typeof RunnerStatus];

export function runnerStatusLabel(status: RunnerStatusValue): string {
  switch (status) {
    case RunnerStatus.OK:
      return "OK";
    case RunnerStatus.DNS:
      return "Did Not Start";
    case RunnerStatus.DNF:
      return "Did Not Finish";
    case RunnerStatus.MissingPunch:
      return "Missing Punch";
    case RunnerStatus.DQ:
      return "Disqualified";
    case RunnerStatus.OverMaxTime:
      return "Over max time";
    case RunnerStatus.Cancel:
      return "Cancelled";
    case RunnerStatus.NoTiming:
      return "No timing";
    case RunnerStatus.OutOfCompetition:
      return "Out of competition";
    case RunnerStatus.NotCompeting:
      return "Not competing";
    case RunnerStatus.Unknown:
    default:
      return "Unknown";
  }
}

/** Descriptive explanation for each status (used in filter selects) */
export function runnerStatusDescription(status: RunnerStatusValue): string {
  switch (status) {
    case RunnerStatus.OK:
      return "Finished with all controls punched";
    case RunnerStatus.DNS:
      return "Did not start";
    case RunnerStatus.DNF:
      return "Did not finish -- retired during race";
    case RunnerStatus.MissingPunch:
      return "Finished but missing one or more controls";
    case RunnerStatus.DQ:
      return "Disqualified";
    case RunnerStatus.OverMaxTime:
      return "Exceeded maximum allowed time";
    case RunnerStatus.Cancel:
      return "Entry cancelled";
    case RunnerStatus.NoTiming:
      return "Finished without timing data";
    case RunnerStatus.OutOfCompetition:
      return "Running outside of competition";
    case RunnerStatus.NotCompeting:
      return "Not competing (exhibition entry)";
    case RunnerStatus.Unknown:
    default:
      return "No result registered yet";
  }
}

/**
 * Logical status groups for filtering and dashboard.
 * These combine MeOS statuses into orienteering-meaningful categories.
 */
export type LogicalStatus =
  | "not-started"   // Unknown status, no result, no punches, and time < start
  | "in-forest"     // Unknown status, no result, but (punches exists or time >= start)
  | "finished"      // Has a result (Status > 0) or has finish time
  | number;         // Specific MeOS status value

/** All status filter options for select dropdowns */
export const STATUS_FILTER_OPTIONS: {
  value: string;
  label: string;
  description: string;
}[] = [
    { value: "", label: "All statuses", description: "Show all runners" },
    { value: "not-started", label: "Not yet started", description: "Waiting to start" },
    { value: "in-forest", label: "In the forest", description: "Started but no result yet" },
    { value: "finished", label: "Finished", description: "Has a result (any)" },
    { value: String(RunnerStatus.OK), label: "OK", description: "Finished with all controls punched" },
    { value: String(RunnerStatus.MissingPunch), label: "MP -- Missing Punch", description: "Missing one or more controls" },
    { value: String(RunnerStatus.DNF), label: "DNF -- Did Not Finish", description: "Retired during race" },
    { value: String(RunnerStatus.DNS), label: "DNS -- Did Not Start", description: "Did not start" },
    { value: String(RunnerStatus.DQ), label: "DQ -- Disqualified", description: "Disqualified" },
    { value: String(RunnerStatus.OverMaxTime), label: "Over Max Time", description: "Exceeded maximum allowed time" },
    { value: String(RunnerStatus.Cancel), label: "Cancelled", description: "Entry cancelled" },
    { value: String(RunnerStatus.NotCompeting), label: "Not Competing", description: "Exhibition entry" },
  ];

/** Status summary counts for the dashboard */
export interface StatusCounts {
  notStarted: number;
  inForest: number;
  finished: number;
  /** Runners waiting to start (Unknown status, no start time — excludes DNS/Cancel) */
  startListCount: number;
  /** Runners with a result booked (Status !== 0) */
  resultCount: number;
}

/**
 * MeOS stores all times in DECISECONDS (tenths of a second).
 * ZeroTime 288000 = 28800.0 seconds = 08:00:00
 * StartTime 456600 = 45660.0 seconds = 12:41:00
 */

/** Convert MeOS deciseconds to seconds */
export function meosToSeconds(deciseconds: number): number {
  return Math.floor(deciseconds / 10);
}

/** Convert seconds to MeOS deciseconds */
export function secondsToMeos(seconds: number): number {
  return seconds * 10;
}

/** Format a MeOS time (deciseconds since midnight) to HH:MM:SS */
export function formatMeosTime(deciseconds: number): string {
  if (deciseconds <= 0) return "-";
  const totalSec = Math.floor(deciseconds / 10);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

/** Format a MeOS running time (deciseconds) to M:SS or H:MM:SS */
export function formatRunningTime(deciseconds: number): string {
  if (deciseconds <= 0) return "-";
  const totalSec = Math.floor(deciseconds / 10);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Parse a HH:MM:SS time string to MeOS deciseconds */
export function parseMeosTime(time: string): number {
  const parts = time.split(":").map(Number);
  let seconds = 0;
  if (parts.length === 3) {
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    seconds = parts[0] * 60 + parts[1];
  }
  return seconds * 10; // Convert to deciseconds for MeOS storage
}

export type EventorEnvironment = "prod" | "test";

/** Competition summary as returned by the MeOSMain database */
export interface CompetitionInfo {
  id: number;
  name: string;
  annotation: string;
  date: string;
  nameId: string;
  /** If the competition uses a remote DB, the host:port string */
  remoteHost?: string;
  /** The Eventor environment this competition is linked to, if any */
  eventorEnv?: EventorEnvironment;
  /** Eventor event ID (oEvent.ExtId). Used to build QR links on receipts. */
  eventorEventId?: number;
}

/** Class summary */
export interface ClassInfo {
  id: number;
  name: string;
  courseId: number;
  sortIndex: number;
  runnerCount?: number;
  /** Normal entry fee in whole currency units (e.g. 110 = 110 SEK) */
  classFee?: number;
}

/** Club summary */
export interface ClubInfo {
  id: number;
  name: string;
  eventorId?: number;
}

/** Club summary for management page */
export interface ClubSummary {
  id: number;
  name: string;
  shortName: string;
  runnerCount: number;
  extId: number;
}

/** Club detail for expanded view */
export interface ClubDetail {
  id: number;
  name: string;
  shortName: string;
  district: number;
  nationality: string;
  country: string;
  careOf: string;
  street: string;
  city: string;
  zip: string;
  email: string;
  phone: string;
  extId: number;
  runners: { id: number; name: string; className: string; cardNo: number }[];
}

/** Course summary */
export interface CourseInfo {
  id: number;
  name: string;
  length: number;
  controls: string;
  controlCount: number;
  numberOfMaps?: number;
}

/** Runner summary (list view) */
export interface RunnerInfo {
  id: number;
  name: string;
  cardNo: number;
  clubId: number;
  clubName?: string;
  classId: number;
  className?: string;
  startNo: number;
  startTime: number;
  finishTime: number;
  status: RunnerStatusValue;
}

/** Runner detail (for editing) */
export interface RunnerDetail {
  id: number;
  name: string;
  cardNo: number;
  clubId: number;
  clubName?: string;
  classId: number;
  className?: string;
  startNo: number;
  startTime: number;
  finishTime: number;
  status: RunnerStatusValue;
  birthYear: number;
  sex: string;
  nationality: string;
  phone: string;
  fee: number;
  paid: number;
  bib: string;
  entryDate: number; // YYYYMMDD as int
}

/** Input for creating/updating a runner */
export interface RunnerInput {
  name: string;
  cardNo?: number;
  clubId?: number;
  classId: number;
  startNo?: number;
  startTime?: number;
  birthYear?: number;
  sex?: string;
  nationality?: string;
  phone?: string;
}

/** Competition dashboard overview */
export interface CompetitionDashboard {
  competition: CompetitionInfo;
  classes: ClassInfo[];
  courses: CourseInfo[];
  totalRunners: number;
  totalClubs: number;
  totalCourses: number;
  totalControls: number;
  statusCounts: StatusCounts;
  organizer?: {
    name: string;
    eventorId: number; // Eventor organisation ID (for logo)
  };
}

/** Start list entry */
export interface StartListEntry {
  id: number;
  startNo: number;
  name: string;
  clubId: number;
  clubName: string;
  className: string;
  classId: number;
  startTime: number;
  cardNo: number;
  bib: string;
  hasPunches?: boolean;
  hasStarted?: boolean;
}

/** Result list entry */
export interface ResultEntry {
  id: number;
  place: number;
  name: string;
  clubId: number;
  clubName: string;
  className: string;
  classId: number;
  startTime: number;
  finishTime: number;
  runningTime: number;
  timeBehind: number;
  status: RunnerStatusValue;
  startNo: number;
  hasPunches?: boolean;
  hasStarted?: boolean;
  noTiming?: boolean;
}

// --------------- Control types ---------------

/** MeOS Control status values */
export const ControlStatus = {
  OK: 0,
  Bad: 1,
  Multiple: 2,
  Start: 4,
  Finish: 5,
  Rogaining: 6,
  NoTiming: 7,
  Optional: 8,
  BadNoTiming: 9,
  RogainingRequired: 10,
  Check: 11,
} as const;

export type ControlStatusValue =
  (typeof ControlStatus)[keyof typeof ControlStatus];

export function controlStatusLabel(status: ControlStatusValue): string {
  switch (status) {
    case ControlStatus.OK:
      return "OK";
    case ControlStatus.Bad:
      return "Bad";
    case ControlStatus.Multiple:
      return "Multiple";
    case ControlStatus.Start:
      return "Start";
    case ControlStatus.Finish:
      return "Finish";
    case ControlStatus.Rogaining:
      return "Rogaining";
    case ControlStatus.NoTiming:
      return "No Timing";
    case ControlStatus.Optional:
      return "Optional";
    case ControlStatus.BadNoTiming:
      return "Bad (No Timing)";
    case ControlStatus.RogainingRequired:
      return "Rogaining Required";
    case ControlStatus.Check:
      return "Check";
    default:
      return "Unknown";
  }
}

export function controlStatusDescription(status: ControlStatusValue): string {
  switch (status) {
    case ControlStatus.OK:
      return "Normal control";
    case ControlStatus.Bad:
      return "Control is ignored (malfunctioning)";
    case ControlStatus.Multiple:
      return "All specified codes must be visited (any order)";
    case ControlStatus.Start:
      return "Start control";
    case ControlStatus.Finish:
      return "Finish control";
    case ControlStatus.Rogaining:
      return "Rogaining (score) control";
    case ControlStatus.NoTiming:
      return "No timing at this control";
    case ControlStatus.Optional:
      return "Optional control";
    case ControlStatus.BadNoTiming:
      return "Bad, no timing impact";
    case ControlStatus.RogainingRequired:
      return "Required rogaining control";
    case ControlStatus.Check:
      return "Check control (pre-start)";
    default:
      return "";
  }
}

/** Options for control status select dropdowns */
export const CONTROL_STATUS_OPTIONS: {
  value: number;
  label: string;
  description: string;
}[] = [
    { value: ControlStatus.OK, label: "OK", description: "Normal control" },
    { value: ControlStatus.Bad, label: "Bad", description: "Ignored (malfunctioning)" },
    { value: ControlStatus.Multiple, label: "Multiple", description: "All codes must be visited" },
    { value: ControlStatus.NoTiming, label: "No Timing", description: "No timing at this control" },
    { value: ControlStatus.Optional, label: "Optional", description: "Optional control" },
    { value: ControlStatus.Start, label: "Start", description: "Start control" },
    { value: ControlStatus.Finish, label: "Finish", description: "Finish control" },
    { value: ControlStatus.Check, label: "Check", description: "Check control (pre-start)" },
  ];

/** Radio type for control configuration */
export type RadioType = "normal" | "internal_radio" | "public_radio";

/** AIR+ override for a control */
export type AirPlusOverride = "default" | "on" | "off";

/** Control configuration from oxygen_control_config */
export interface ControlConfig {
  radioType: RadioType;
  airPlus: AirPlusOverride;
  batteryVoltage: number | null;
  batteryLow: boolean | null;
  checkedAt: string | null; // ISO timestamp
  memoryClearedAt: string | null; // ISO timestamp
}

/** Control summary (list view) */
export interface ControlInfo {
  id: number;
  name: string;
  codes: string; // semicolon-separated punch codes (the Numbers field)
  status: ControlStatusValue;
  timeAdjust: number;
  minTime: number;
  runnerCount: number; // total runners on courses that include this control
  config: ControlConfig | null; // null if no oxygen_control_config row
}

/** Control detail with course usage */
export interface ControlDetail extends ControlInfo {
  courses: {
    courseId: number;
    courseName: string;
    occurrences: number; // how many times it appears in the course
    runnerCount: number; // runners in classes using this course
  }[];
}

// --------------- Course management types ---------------

/** Course summary for list view */
export interface CourseSummary {
  id: number;
  name: string;
  controls: string; // semicolon-separated control codes
  controlCount: number;
  length: number; // in meters
  climb: number;
  numberOfMaps: number;
  firstAsStart: boolean;
  lastAsFinish: boolean;
}

/** Course detail with class usage */
export interface CourseDetail extends CourseSummary {
  classes: {
    classId: number;
    className: string;
    runnerCount: number;
  }[];
  controlCodes: number[]; // parsed control list
}

/** Class with its course details (used in lists endpoint) */
export interface ClassDetail {
  id: number;
  name: string;
  courseId: number;
  courseName: string;
  courseLength: number;
  controlCount: number;
  runnerCount: number;
  firstStart: number;
  startInterval: number;
  sortIndex: number;
}

// --------------- Class management types ---------------

/** Class summary for list view */
export interface ClassSummary {
  id: number;
  name: string;
  courseId: number;
  courseName: string;
  courseIds: number[]; // all courses (forked or single)
  courseNames: string[];
  runnerCount: number;
  sortIndex: number;
  sex: string;
  lowAge: number;
  highAge: number;
  freeStart: boolean;
  noTiming: boolean;
  classType: string;
  /** Entry fee in whole currency units (e.g. 110 = 110 SEK) */
  classFee: number;
}

/** Full class detail for editing */
export interface ClassManageDetail extends ClassSummary {
  longName: string;
  firstStart: number;
  startInterval: number;
  courseLength: number;
  controlCount: number;
  runners: { id: number; name: string; status: number }[];
}

// --------------- Start draw types ---------------

export type DrawMethod = "random" | "clubSeparation" | "seeded" | "simultaneous";

export interface ClassDrawConfig {
  classId: number;
  method: DrawMethod;
  interval: number; // deciseconds between starts (default 1200 = 2 min)
  firstStart?: number; // override; if omitted, optimizer calculates it
  corridorHint?: number; // pin to a specific corridor (from previous preview)
  orderHint?: number; // stacking order within corridor (lower = earlier)
}

export interface DrawSettings {
  firstStart: number; // global first start (deciseconds, default ZeroTime)
  baseInterval: number; // minimum gap between any two starts (default 600 = 1 min)
  maxParallelStarts: number; // max corridors (default 10)
  detectCourseOverlap: boolean; // default true
}

export interface DrawPreviewEntry {
  runnerId: number;
  name: string;
  clubName: string;
  startTime: number;
  startNo: number;
}

export interface DrawPreviewClass {
  classId: number;
  className: string;
  courseName: string;
  corridor: number;
  computedFirstStart: number;
  entries: DrawPreviewEntry[];
}

export interface DrawPreviewResult {
  classes: DrawPreviewClass[];
  warnings: string[];
}

/**
 * Parse MeOS MultiCourse string into array of course-ID arrays (per stage).
 * Format: "courseId1 courseId2; courseId3 courseId4;"
 * For simple forking (single stage), returns one inner array.
 */
export function parseMultiCourse(mc: string | null | undefined): number[][] {
  if (!mc || mc === "@") return [];
  return mc
    .split(";")
    .map((stage) =>
      stage
        .trim()
        .split(/\s+/)
        .map((s) => parseInt(s, 10))
        .filter((n) => !isNaN(n) && n > 0),
    )
    .filter((stage) => stage.length > 0);
}

/**
 * Encode an array of course IDs into MeOS MultiCourse format.
 * For simple forking, wraps all IDs in a single stage.
 */
export function encodeMultiCourse(courseIds: number[]): string {
  if (courseIds.length === 0) return "";
  if (courseIds.length === 1) return "";
  return courseIds.join(" ") + ";";
}
