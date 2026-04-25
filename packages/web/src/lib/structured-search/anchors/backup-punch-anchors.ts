import type { AnchorDef, FilterOperator } from "../types";

export type MatchStatus = "matched" | "no_runner" | "no_result" | "time_mismatch" | "unknown";

/** Backup punch row, matching `BackupPunch` in BackupPunchesPage. */
export interface BackupPunchRow {
  id: number;
  controlId: number;
  controlCodes: string;
  controlName: string;
  cardNo: number;
  punchTime: number;
  punchDatetime: string | null;
  subSecond: number | null;
  stationSerial: number | null;
  importedAt: string;
  pushedToPunch: boolean;
  runnerName: string | null;
  runnerId: number | null;
  runnerStatus: number | null;
  registeredTime: number | null;
  matchStatus: MatchStatus;
}

function matchString(actual: string, op: FilterOperator, value: string): boolean {
  const lower = actual.toLowerCase();
  const lowerVal = value.toLowerCase();
  switch (op) {
    case "eq":
      return lower === lowerVal;
    case "contains":
      return lower.includes(lowerVal);
    case "wildcard": {
      const regex = new RegExp(
        "^" + lowerVal.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
        "i",
      );
      return regex.test(actual);
    }
    case "in":
      return value
        .split(",")
        .some((v) => lower === v.trim().toLowerCase());
    default:
      return lower.includes(lowerVal);
  }
}

function matchNumber(actual: number, op: FilterOperator, value: string): boolean {
  const num = parseFloat(value);
  if (isNaN(num)) return false;
  switch (op) {
    case "eq":
      return actual === num;
    case "gt":
      return actual > num;
    case "lt":
      return actual < num;
    case "gte":
      return actual >= num;
    case "lte":
      return actual <= num;
    default:
      return actual === num;
  }
}

function matchBool(actual: boolean, value: string): boolean {
  const v = value.toLowerCase();
  if (v === "yes" || v === "true" || v === "1" || v === "on") return actual;
  if (v === "no" || v === "false" || v === "0" || v === "off") return !actual;
  return false;
}

const MATCH_ALIASES: Record<string, MatchStatus[]> = {
  matched: ["matched"],
  ok: ["matched"],
  anomalies: ["no_runner", "no_result", "time_mismatch"],
  anomaly: ["no_runner", "no_result", "time_mismatch"],
  bad: ["no_runner", "no_result", "time_mismatch"],
  no_runner: ["no_runner"],
  "no-runner": ["no_runner"],
  no_result: ["no_result"],
  "no-result": ["no_result"],
  time_mismatch: ["time_mismatch"],
  "time-mismatch": ["time_mismatch"],
  unknown: ["unknown"],
};

export type BackupPunchAnchorData = {
  controls?: { id: number; code: string }[];
};

export function createBackupPunchAnchors(
  getLabel: (key: string) => string,
): AnchorDef<BackupPunchRow>[] {
  return [
    {
      key: "control",
      label: getLabel("control"),
      type: "number",
      operators: ["eq", "in"],
      defaultOperator: "eq",
      color: "amber",
      suggest: (query: string, data: unknown) => {
        const d = data as BackupPunchAnchorData | undefined;
        if (!d?.controls) return [];
        const lower = query.toLowerCase();
        return d.controls
          .filter((c) => c.code.toLowerCase().includes(lower) || String(c.id).includes(query))
          .slice(0, 12)
          .map((c) => ({ key: c.code, label: c.code }));
      },
      match: (item, op, value) => {
        const values = op === "in"
          ? value.split(",").map((v) => v.trim())
          : [value];
        return values.some((v) => {
          if (matchString(item.controlCodes, "contains", v)) return true;
          const num = parseInt(v, 10);
          if (!isNaN(num) && item.controlId === num) return true;
          return false;
        });
      },
    },
    {
      key: "card",
      label: getLabel("card"),
      type: "number",
      operators: ["eq", "in", "gt", "lt", "gte", "lte"],
      defaultOperator: "eq",
      color: "cyan",
      match: (item, op, value) => {
        if (op === "in") {
          return value
            .split(",")
            .some((v) => matchNumber(item.cardNo, "eq", v.trim()));
        }
        return matchNumber(item.cardNo, op, value);
      },
    },
    {
      key: "runner",
      label: getLabel("runner"),
      type: "string",
      operators: ["contains", "wildcard", "eq"],
      defaultOperator: "contains",
      color: "slate",
      match: (item, op, value) => matchString(item.runnerName ?? "", op, value),
    },
    {
      key: "match",
      label: getLabel("matchStatus"),
      type: "enum",
      operators: ["eq", "in"],
      defaultOperator: "eq",
      color: "green",
      suggest: () => [
        { key: "matched", label: "Matched" },
        { key: "anomalies", label: "Anomalies (any unmatched)" },
        { key: "no_runner", label: "No runner" },
        { key: "no_result", label: "No result" },
        { key: "time_mismatch", label: "Time mismatch" },
        { key: "unknown", label: "Unknown" },
      ],
      match: (item, op, value) => {
        const values = op === "in"
          ? value.split(",").map((v) => v.trim().toLowerCase())
          : [value.toLowerCase()];
        return values.some((v) => {
          const aliases = MATCH_ALIASES[v];
          if (aliases) return aliases.includes(item.matchStatus);
          return item.matchStatus === v;
        });
      },
    },
    {
      key: "pushed",
      label: getLabel("pushed"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "indigo",
      suggest: () => [
        { key: "yes", label: "Pushed to oPunch" },
        { key: "no", label: "Not pushed" },
      ],
      match: (item, _op, value) => matchBool(item.pushedToPunch, value),
    },
  ];
}
