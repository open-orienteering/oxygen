import { RunnerStatus, type ResultEntry, type RunnerStatusValue } from "@oxygen/shared";
import type { AnchorDef, FilterOperator } from "../types";

const STATUS_ALIASES: Record<string, RunnerStatusValue[]> = {
  ok: [RunnerStatus.OK],
  mp: [RunnerStatus.MissingPunch],
  dnf: [RunnerStatus.DNF],
  dns: [RunnerStatus.DNS],
  dq: [RunnerStatus.DQ],
  overtime: [RunnerStatus.OverMaxTime],
  cancel: [RunnerStatus.Cancel],
  nc: [RunnerStatus.NotCompeting],
};

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

/** Parse a HH:MM:SS / MM:SS / M:SS into deciseconds. */
function parseTimeValue(str: string): number | null {
  const parts = str.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 10;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 10;
  return null;
}

function matchTime(actual: number, op: FilterOperator, value: string): boolean {
  if (actual <= 0) return false;
  const target = parseTimeValue(value);
  if (target === null) return false;
  return matchNumber(actual, op, String(target));
}

function matchStatus(entry: ResultEntry, op: FilterOperator, value: string): boolean {
  const values = op === "in" ? value.split(",").map((v) => v.trim().toLowerCase()) : [value.toLowerCase()];

  return values.some((v) => {
    if (v === "not-started") {
      return !(entry.status > 0 || entry.finishTime > 0 || entry.hasPunches || entry.hasStarted);
    }
    if (v === "in-forest" || v === "started") {
      return !(entry.status > 0 || entry.finishTime > 0) && (!!entry.hasPunches || !!entry.hasStarted);
    }
    if (v === "finished") {
      return entry.status > 0 || entry.finishTime > 0;
    }

    const alias = STATUS_ALIASES[v];
    if (alias) return alias.includes(entry.status);

    const num = parseInt(v, 10);
    if (!isNaN(num)) return entry.status === num;

    return false;
  });
}

export type ResultAnchorData = {
  classes: { id: number; name: string }[];
  clubs: { id: number; name: string }[];
  runners?: { name: string }[];
};

export function createResultAnchors(
  getLabel: (key: string) => string,
): AnchorDef<ResultEntry>[] {
  return [
    {
      key: "name",
      label: getLabel("name"),
      type: "string",
      operators: ["contains", "wildcard"],
      defaultOperator: "contains",
      color: "slate",
      suggest: (query: string, data: unknown) => {
        if (query.length < 3) return [];
        const d = data as ResultAnchorData | undefined;
        if (!d?.runners) return [];
        const lower = query.toLowerCase();
        const seen = new Set<string>();
        return d.runners
          .filter((r) => {
            if (seen.has(r.name)) return false;
            if (!r.name.toLowerCase().includes(lower)) return false;
            seen.add(r.name);
            return true;
          })
          .slice(0, 8)
          .map((r) => ({ key: r.name, label: r.name }));
      },
      match: (item, op, value) => matchString(item.name, op, value),
    },
    {
      key: "class",
      label: getLabel("class"),
      type: "string",
      operators: ["eq", "wildcard", "in"],
      defaultOperator: "eq",
      color: "purple",
      suggest: (query: string, data: unknown) => {
        const d = data as ResultAnchorData | undefined;
        if (!d?.classes) return [];
        const lower = query.toLowerCase();
        return d.classes
          .filter((c) => c.name.toLowerCase().includes(lower))
          .slice(0, 10)
          .map((c) => ({ key: c.name, label: c.name }));
      },
      match: (item, op, value) => matchString(item.className ?? "", op, value),
    },
    {
      key: "club",
      label: getLabel("club"),
      type: "string",
      operators: ["eq", "wildcard", "in"],
      defaultOperator: "eq",
      color: "teal",
      suggest: (query: string, data: unknown) => {
        const d = data as ResultAnchorData | undefined;
        if (!d?.clubs) return [];
        const lower = query.toLowerCase();
        return d.clubs
          .filter((c) => c.name.toLowerCase().includes(lower))
          .slice(0, 10)
          .map((c) => ({ key: c.name, label: c.name }));
      },
      match: (item, op, value) => matchString(item.clubName ?? "", op, value),
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
        { key: "not-started", label: "Not started" },
        { key: "in-forest", label: "In forest" },
        { key: "finished", label: "Finished" },
      ],
      match: matchStatus,
    },
    {
      key: "place",
      label: getLabel("place"),
      type: "number",
      operators: ["eq", "gt", "lt", "gte", "lte"],
      defaultOperator: "lte",
      color: "yellow",
      match: (item, op, value) => {
        if (item.place == null || item.place <= 0) return false;
        return matchNumber(item.place, op, value);
      },
    },
    {
      key: "time",
      label: getLabel("time"),
      type: "number",
      operators: ["gt", "lt", "gte", "lte", "eq"],
      defaultOperator: "lte",
      color: "rose",
      match: (item, op, value) => matchTime(item.runningTime, op, value),
    },
    {
      key: "behind",
      label: getLabel("behind"),
      type: "number",
      operators: ["gt", "lt", "gte", "lte", "eq"],
      defaultOperator: "lte",
      color: "orange",
      match: (item, op, value) => matchTime(item.timeBehind, op, value),
    },
  ];
}
