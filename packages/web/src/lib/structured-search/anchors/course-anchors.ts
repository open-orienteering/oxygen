import type { CourseSummary } from "@oxygen/shared";
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

function matchBool(actual: boolean, value: string): boolean {
  const v = value.toLowerCase();
  if (v === "yes" || v === "true" || v === "1" || v === "on") return actual;
  if (v === "no" || v === "false" || v === "0" || v === "off") return !actual;
  return false;
}

export function createCourseAnchors(
  getLabel: (key: string) => string,
): AnchorDef<CourseSummary>[] {
  return [
    {
      key: "name",
      label: getLabel("name"),
      type: "string",
      operators: ["contains", "wildcard"],
      defaultOperator: "contains",
      color: "slate",
      match: (item, op, value) => matchString(item.name, op, value),
    },
    {
      key: "controls",
      label: getLabel("controls"),
      type: "number",
      operators: ["eq", "gt", "lt", "gte", "lte"],
      defaultOperator: "gte",
      color: "cyan",
      match: (item, op, value) => matchNumber(item.controlCount, op, value),
    },
    {
      key: "length",
      label: getLabel("length"),
      type: "number",
      operators: ["eq", "gt", "lt", "gte", "lte"],
      defaultOperator: "gte",
      color: "indigo",
      match: (item, op, value) => {
        // Accept either meters (>2000) or km (e.g. 2.5)
        const num = parseFloat(value);
        if (isNaN(num)) return false;
        const meters = Math.abs(num) < 100 ? num * 1000 : num;
        return matchNumber(item.length, op, String(meters));
      },
    },
    {
      key: "maps",
      label: getLabel("maps"),
      type: "number",
      operators: ["eq", "gt", "lt", "gte", "lte"],
      defaultOperator: "eq",
      color: "amber",
      match: (item, op, value) => matchNumber(item.numberOfMaps, op, value),
    },
    {
      key: "start",
      label: getLabel("firstAsStartShort"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "sky",
      suggest: () => [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ],
      match: (item, _op, value) => matchBool(item.firstAsStart, value),
    },
    {
      key: "finish",
      label: getLabel("lastAsFinishShort"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "emerald",
      suggest: () => [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ],
      match: (item, _op, value) => matchBool(item.lastAsFinish, value),
    },
  ];
}
