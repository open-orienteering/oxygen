import type { ClassSummary } from "@oxygen/shared";
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

export type ClassAnchorData = {
  courses?: { id: number; name: string }[];
};

export function createClassAnchors(
  getLabel: (key: string) => string,
): AnchorDef<ClassSummary>[] {
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
      key: "course",
      label: getLabel("course"),
      type: "string",
      operators: ["eq", "contains", "wildcard"],
      defaultOperator: "contains",
      color: "purple",
      suggest: (query: string, data: unknown) => {
        const d = data as ClassAnchorData | undefined;
        if (!d?.courses) return [];
        const lower = query.toLowerCase();
        return d.courses
          .filter((c) => c.name.toLowerCase().includes(lower))
          .slice(0, 10)
          .map((c) => ({ key: c.name, label: c.name }));
      },
      match: (item, op, value) =>
        item.courseNames.some((n) => matchString(n, op, value)),
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
      key: "fee",
      label: getLabel("fee"),
      type: "number",
      operators: ["eq", "gt", "lt", "gte", "lte"],
      defaultOperator: "eq",
      color: "emerald",
      match: (item, op, value) => matchNumber(item.classFee, op, value),
    },
    {
      key: "sex",
      label: getLabel("sex"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "pink",
      suggest: () => [
        { key: "open", label: "Open" },
        { key: "men", label: "Men" },
        { key: "women", label: "Women" },
      ],
      match: (item, _op, value) => {
        const v = value.toLowerCase();
        if (v === "men" || v === "m") return item.sex === "M";
        if (v === "women" || v === "w" || v === "f") return item.sex === "F" || item.sex === "W";
        if (v === "open" || v === "o") return !item.sex;
        return item.sex.toLowerCase() === v;
      },
    },
    {
      key: "type",
      label: getLabel("classType"),
      type: "string",
      operators: ["eq", "contains"],
      defaultOperator: "eq",
      color: "indigo",
      match: (item, op, value) => matchString(item.classType ?? "", op, value),
    },
    {
      key: "freeStart",
      label: getLabel("freeStart"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "sky",
      suggest: () => [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ],
      match: (item, _op, value) => matchBool(item.freeStart, value),
    },
    {
      key: "noTiming",
      label: getLabel("noTiming"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "rose",
      suggest: () => [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ],
      match: (item, _op, value) => matchBool(item.noTiming, value),
    },
    {
      key: "quickEntry",
      label: getLabel("allowQuickEntry"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "green",
      suggest: () => [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ],
      match: (item, _op, value) => matchBool(item.allowQuickEntry, value),
    },
    {
      key: "forked",
      label: getLabel("courseForked"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "violet",
      suggest: () => [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ],
      match: (item, _op, value) => matchBool(item.courseIds.length > 1, value),
    },
  ];
}
