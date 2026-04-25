import type { AnchorDef, FilterOperator } from "../types";

/** Shape of a route row from `trpc.livelox.listRoutes`. */
export interface TrackRow {
  id: number;
  runnerId: number | null;
  runnerName: string;
  organisation: string;
  classId: number | null;
  className: string;
  liveloxClassId: number | null;
  color: string;
  raceStartMs: number | null;
  result: {
    status: "ok" | "mp" | "dnf" | "dns" | "dq" | "unknown";
    timeMs?: number;
    rank?: number;
    splitTimes?: { controlCode: string; timeMs: number }[];
  } | null;
  syncedAt: string | Date;
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

function parseTimeValueMs(str: string): number | null {
  const parts = str.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 1) return parts[0] * 1000;
  return null;
}

function matchTime(actualMs: number | undefined, op: FilterOperator, value: string): boolean {
  if (actualMs == null || actualMs <= 0) return false;
  const target = parseTimeValueMs(value);
  if (target === null) return false;
  return matchNumber(actualMs, op, String(target));
}

export type TrackAnchorData = {
  classes?: { id: number | null; name: string }[];
  clubs?: { name: string }[];
};

export function createTrackAnchors(
  getLabel: (key: string) => string,
): AnchorDef<TrackRow>[] {
  return [
    {
      key: "name",
      label: getLabel("name"),
      type: "string",
      operators: ["contains", "wildcard"],
      defaultOperator: "contains",
      color: "slate",
      match: (item, op, value) => matchString(item.runnerName, op, value),
    },
    {
      key: "club",
      label: getLabel("club"),
      type: "string",
      operators: ["eq", "wildcard", "in", "contains"],
      defaultOperator: "contains",
      color: "teal",
      suggest: (query: string, data: unknown) => {
        const d = data as TrackAnchorData | undefined;
        if (!d?.clubs) return [];
        const lower = query.toLowerCase();
        const seen = new Set<string>();
        return d.clubs
          .filter((c) => {
            if (seen.has(c.name)) return false;
            if (!c.name.toLowerCase().includes(lower)) return false;
            seen.add(c.name);
            return true;
          })
          .slice(0, 10)
          .map((c) => ({ key: c.name, label: c.name }));
      },
      match: (item, op, value) => matchString(item.organisation, op, value),
    },
    {
      key: "class",
      label: getLabel("class"),
      type: "string",
      operators: ["eq", "wildcard", "in", "contains"],
      defaultOperator: "eq",
      color: "purple",
      suggest: (query: string, data: unknown) => {
        const d = data as TrackAnchorData | undefined;
        if (!d?.classes) return [];
        const lower = query.toLowerCase();
        return d.classes
          .filter((c) => c.name.toLowerCase().includes(lower))
          .slice(0, 10)
          .map((c) => ({ key: c.name, label: c.name }));
      },
      match: (item, op, value) => matchString(item.className, op, value),
    },
    {
      key: "time",
      label: getLabel("time"),
      type: "number",
      operators: ["gt", "lt", "gte", "lte", "eq"],
      defaultOperator: "lte",
      color: "rose",
      match: (item, op, value) => matchTime(item.result?.timeMs, op, value),
    },
    {
      key: "status",
      label: getLabel("status"),
      type: "enum",
      operators: ["eq", "in"],
      defaultOperator: "eq",
      color: "green",
      suggest: () => [
        { key: "ok", label: "OK" },
        { key: "mp", label: "MP — Missing Punch" },
        { key: "dnf", label: "DNF — Did Not Finish" },
        { key: "dns", label: "DNS — Did Not Start" },
        { key: "dq", label: "DQ — Disqualified" },
        { key: "unknown", label: "Unknown" },
      ],
      match: (item, op, value) => {
        const status = item.result?.status ?? "unknown";
        const values = op === "in"
          ? value.split(",").map((v) => v.trim().toLowerCase())
          : [value.toLowerCase()];
        return values.includes(status);
      },
    },
  ];
}
