import type { AnchorDef, FilterOperator } from "../types";

export interface MapTemplateSearchRow {
  name: string;
  paper: string;
  orientation: string;
  printScale: number;
  usedBy: number;
}

function matchNumber(actual: number, operator: FilterOperator, value: string) {
  const expected = Number(value);
  if (!Number.isFinite(expected)) return false;
  if (operator === "gt") return actual > expected;
  if (operator === "gte") return actual >= expected;
  if (operator === "lt") return actual < expected;
  if (operator === "lte") return actual <= expected;
  return actual === expected;
}

export function createMapTemplateAnchors<T extends MapTemplateSearchRow>(
  label: (key: string) => string,
): AnchorDef<T>[] {
  return [
    {
      key: "name",
      label: label("templateName"),
      type: "string",
      operators: ["contains"],
      defaultOperator: "contains",
      color: "slate",
      match: (item, _operator, value) =>
        item.name.toLocaleLowerCase().includes(value.toLocaleLowerCase()),
    },
    {
      key: "paper",
      label: label("paper"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "cyan",
      suggest: () =>
        ["A3", "A4", "A5"].map((paper) => ({ key: paper, label: paper })),
      match: (item, _operator, value) => item.paper === value,
    },
    {
      key: "orientation",
      label: label("orientation"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "indigo",
      suggest: () =>
        ["portrait", "landscape"].map((orientation) => ({
          key: orientation,
          label: label(orientation),
        })),
      match: (item, _operator, value) => item.orientation === value,
    },
    {
      key: "scale",
      label: label("printScale"),
      type: "number",
      operators: ["eq", "gt", "gte", "lt", "lte"],
      defaultOperator: "eq",
      color: "emerald",
      match: (item, operator, value) =>
        matchNumber(item.printScale, operator, value),
    },
    {
      key: "used",
      label: label("usedBy"),
      type: "number",
      operators: ["eq", "gt", "gte", "lt", "lte"],
      defaultOperator: "gt",
      color: "amber",
      match: (item, operator, value) =>
        matchNumber(item.usedBy, operator, value),
    },
  ];
}
