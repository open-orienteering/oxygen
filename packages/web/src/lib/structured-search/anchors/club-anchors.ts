import type { ClubSummary } from "@oxygen/shared";
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

export function createClubAnchors(
  getLabel: (key: string) => string,
): AnchorDef<ClubSummary>[] {
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
      key: "shortName",
      label: getLabel("shortName"),
      type: "string",
      operators: ["contains", "eq", "wildcard"],
      defaultOperator: "contains",
      color: "purple",
      match: (item, op, value) => matchString(item.shortName, op, value),
    },
    {
      key: "runners",
      label: getLabel("runners"),
      type: "number",
      operators: ["eq", "gt", "lt", "gte", "lte"],
      defaultOperator: "gte",
      color: "amber",
      match: (item, op, value) => matchNumber(item.runnerCount, op, value),
    },
    {
      key: "eventor",
      label: getLabel("eventorId"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "indigo",
      suggest: () => [
        { key: "yes", label: "Linked to Eventor" },
        { key: "no", label: "Not linked to Eventor" },
      ],
      match: (item, _op, value) => matchBool(item.extId > 0, value),
    },
  ];
}
