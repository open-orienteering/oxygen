import type { AnchorDef, FilterOperator } from "../types";

export type CourseMapSearchStatus = "ready" | "issues" | "noMap";

export interface CourseMapSearchRow {
  id: number;
  name: string;
  classNames: string[];
  templateNames: string[];
  status: CourseMapSearchStatus;
  mapCount: number;
}

function includes(actual: string, value: string): boolean {
  return actual.toLocaleLowerCase().includes(value.toLocaleLowerCase());
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

export function createCourseMapAnchors<T extends CourseMapSearchRow>(
  label: (key: string) => string,
  templateNames: string[],
): AnchorDef<T>[] {
  return [
    {
      key: "name",
      label: label("course"),
      type: "string",
      operators: ["contains"],
      defaultOperator: "contains",
      color: "slate",
      match: (item, _operator, value) => includes(item.name, value),
    },
    {
      key: "class",
      label: label("classes"),
      type: "string",
      operators: ["contains"],
      defaultOperator: "contains",
      color: "indigo",
      match: (item, _operator, value) =>
        item.classNames.some((name) => includes(name, value)),
    },
    {
      key: "template",
      label: label("template"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "cyan",
      suggest: () =>
        templateNames.map((name) => ({ key: name, label: name })),
      match: (item, _operator, value) =>
        item.templateNames.some(
          (name) => name.toLocaleLowerCase() === value.toLocaleLowerCase(),
        ),
    },
    {
      key: "status",
      label: label("status"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "amber",
      suggest: () =>
        (["ready", "issues", "noMap"] as const).map((status) => ({
          key: status,
          label: label(`status_${status}`),
        })),
      match: (item, _operator, value) => item.status === value,
    },
    {
      key: "maps",
      label: label("mapsColumn"),
      type: "number",
      operators: ["eq", "gt", "gte", "lt", "lte"],
      defaultOperator: "eq",
      color: "emerald",
      match: (item, operator, value) =>
        matchNumber(item.mapCount, operator, value),
    },
  ];
}
