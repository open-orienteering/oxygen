import type { StartListEntry } from "@oxygen/shared";
import type { AnchorDef, FilterOperator } from "../types";

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

export type StartListAnchorData = {
  classes: { id: number; name: string }[];
  clubs: { id: number; name: string }[];
  runners?: { name: string }[];
};

export function createStartListAnchors(
  getLabel: (key: string) => string,
): AnchorDef<StartListEntry>[] {
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
        const d = data as StartListAnchorData | undefined;
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
        const d = data as StartListAnchorData | undefined;
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
        const d = data as StartListAnchorData | undefined;
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
      key: "card",
      label: getLabel("card"),
      type: "number",
      operators: ["eq", "in"],
      defaultOperator: "eq",
      color: "amber",
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
      key: "bib",
      label: getLabel("bib"),
      type: "string",
      operators: ["eq", "contains"],
      defaultOperator: "eq",
      color: "slate",
      match: (item, op, value) => matchString(item.bib ?? "", op, value),
    },
    {
      key: "start",
      label: getLabel("start"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "sky",
      suggest: () => [
        { key: "assigned", label: "Has start time" },
        { key: "none", label: "No start time" },
        { key: "in-forest", label: "In forest" },
        { key: "not-started", label: "Not started" },
      ],
      match: (item, op, value) => {
        const v = value.toLowerCase();
        if (v === "assigned") return item.startTime > 0;
        if (v === "none") return item.startTime === 0;
        if (v === "in-forest") return !!item.hasStarted || !!item.hasPunches;
        if (v === "not-started") return !item.hasStarted && !item.hasPunches;
        return false;
      },
    },
  ];
}
