import {
  ControlStatus,
  CONTROL_STATUS_OPTIONS,
  type ControlInfo,
  type RadioType,
} from "@oxygen/shared";
import type { AnchorDef, FilterOperator } from "../types";

const BATTERY_LOW = 2.5;
const BATTERY_WARN = 2.7;

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

const STATUS_ALIASES: Record<string, number> = {
  ok: ControlStatus.OK,
  regular: ControlStatus.OK,
  bad: ControlStatus.Bad,
  multiple: ControlStatus.Multiple,
  start: ControlStatus.Start,
  finish: ControlStatus.Finish,
  check: ControlStatus.Check,
  clear: ControlStatus.Clear,
  notiming: ControlStatus.NoTiming,
  "no-timing": ControlStatus.NoTiming,
  optional: ControlStatus.Optional,
};

function matchStatus(actual: number, op: FilterOperator, value: string): boolean {
  const values = op === "in" ? value.split(",").map((v) => v.trim()) : [value];
  return values.some((raw) => {
    const v = raw.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(STATUS_ALIASES, v)) {
      return actual === STATUS_ALIASES[v];
    }
    const num = parseInt(v, 10);
    if (!isNaN(num)) return actual === num;
    return false;
  });
}

const RADIO_ALIASES: Record<string, RadioType> = {
  normal: "normal",
  none: "normal",
  internal: "internal_radio",
  internal_radio: "internal_radio",
  srr_internal: "internal_radio",
  public: "public_radio",
  public_radio: "public_radio",
  srr_public: "public_radio",
};

export type ControlAnchorData = {
  courses?: { id: number; name: string }[];
};

export function createControlAnchors(
  getLabel: (key: string) => string,
): AnchorDef<ControlInfo>[] {
  return [
    {
      key: "code",
      label: getLabel("code"),
      type: "number",
      operators: ["eq", "in", "gt", "lt", "gte", "lte"],
      defaultOperator: "eq",
      color: "amber",
      match: (item, op, value) => {
        // Match against any of the punch codes, falling back to id
        if (op === "in") {
          return value
            .split(",")
            .some((v) => {
              const num = parseInt(v.trim(), 10);
              if (isNaN(num)) return false;
              return item.id === num
                || item.codes.split(";").map((c) => parseInt(c.trim(), 10)).includes(num);
            });
        }
        const num = parseFloat(value);
        if (isNaN(num)) return false;
        if (matchNumber(item.id, op, value)) return true;
        return item.codes
          .split(";")
          .map((c) => parseInt(c.trim(), 10))
          .filter((n) => !isNaN(n))
          .some((n) => matchNumber(n, op, value));
      },
    },
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
      key: "status",
      label: getLabel("status"),
      type: "enum",
      operators: ["eq", "in"],
      defaultOperator: "eq",
      color: "green",
      suggest: () =>
        CONTROL_STATUS_OPTIONS.map((opt) => ({
          key: opt.label.toLowerCase().replace(/\s+/g, "-"),
          label: opt.label,
          description: opt.description,
        })),
      match: (item, op, value) => matchStatus(item.status, op, value),
    },
    {
      key: "radio",
      label: getLabel("radio"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "indigo",
      suggest: () => [
        { key: "normal", label: "Normal" },
        { key: "internal", label: "Internal Radio (SRR)" },
        { key: "public", label: "Public Radio (SRR)" },
      ],
      match: (item, _op, value) => {
        const target = RADIO_ALIASES[value.toLowerCase()];
        if (!target) return false;
        return (item.config?.radioType ?? "normal") === target;
      },
    },
    {
      key: "runners",
      label: getLabel("runners"),
      type: "number",
      operators: ["eq", "gt", "lt", "gte", "lte"],
      defaultOperator: "gte",
      color: "cyan",
      match: (item, op, value) => matchNumber(item.runnerCount, op, value),
    },
    {
      key: "battery",
      label: getLabel("battery"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "rose",
      suggest: () => [
        { key: "low", label: "Low (< 2.5V)" },
        { key: "warn", label: "Warning (< 2.7V)" },
        { key: "ok", label: "OK (≥ 2.7V)" },
        { key: "missing", label: "Not measured" },
      ],
      match: (item, _op, value) => {
        const v = value.toLowerCase();
        const volts = item.config?.batteryVoltage;
        if (v === "missing") return volts == null || volts <= 0;
        if (volts == null || volts <= 0) return false;
        if (v === "low") return volts < BATTERY_LOW || !!item.config?.batteryLow;
        if (v === "warn") return volts >= BATTERY_LOW && volts < BATTERY_WARN;
        if (v === "ok") return volts >= BATTERY_WARN;
        return false;
      },
    },
    {
      key: "checked",
      label: getLabel("checked"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "emerald",
      suggest: () => [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ],
      match: (item, _op, value) => matchBool(!!item.config?.checkedAt, value),
    },
  ];
}
