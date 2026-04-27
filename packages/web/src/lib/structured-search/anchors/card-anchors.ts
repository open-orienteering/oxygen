import { getCardType, type SICardType } from "../../si-protocol";
import type { AnchorDef, FilterOperator } from "../types";

const BATTERY_LOW = 2.5;
const BATTERY_WARN = 2.7;

/** Shape of a row from `trpc.cardReadout.cardList` (kept minimal — we only filter on these fields). */
export interface CardListItem {
  id: number;
  cardNo: number;
  cardType: string;
  batteryVoltage: number | null;
  punchCount: number;
  hasPunches: boolean;
  modified: string;
  runner: {
    id: number;
    name: string;
    clubName: string;
    clubId: number;
    className: string;
    status: number;
    isRentalCard: boolean;
    cardReturned: boolean;
  } | null;
}

const CARD_TYPE_ALIASES: Record<string, SICardType> = {
  si5: "SI5", "si-5": "SI5",
  si6: "SI6", "si-6": "SI6",
  si8: "SI8", "si-8": "SI8",
  si9: "SI9", "si-9": "SI9",
  si10: "SI10", "si-10": "SI10",
  si11: "SI11", "si-11": "SI11",
  siac: "SIAC",
  pcard: "pCard",
  tcard: "tCard",
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

function matchBool(actual: boolean, value: string): boolean {
  const v = value.toLowerCase();
  if (v === "yes" || v === "true" || v === "1" || v === "on") return actual;
  if (v === "no" || v === "false" || v === "0" || v === "off") return !actual;
  return false;
}

function resolveCardType(card: CardListItem): SICardType {
  return (card.cardType as SICardType) || getCardType(card.cardNo);
}

export type CardAnchorData = {
  classes: { id: number; name: string }[];
  clubs: { id: number; name: string }[];
};

export function createCardAnchors(
  getLabel: (key: string) => string,
): AnchorDef<CardListItem>[] {
  return [
    {
      key: "card",
      label: getLabel("cardNo"),
      type: "number",
      operators: ["eq", "in", "gt", "lt", "gte", "lte"],
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
      key: "type",
      label: getLabel("type"),
      type: "enum",
      operators: ["eq", "in"],
      defaultOperator: "eq",
      color: "violet",
      suggest: () => [
        { key: "si5", label: "SI-5", description: "1–499 999" },
        { key: "si6", label: "SI-6", description: "500 000–999 999" },
        { key: "si9", label: "SI-9", description: "1 000 000–1 999 999" },
        { key: "si8", label: "SI-8", description: "2 000 000–2 999 999" },
        { key: "pcard", label: "pCard", description: "4 000 000–4 999 999" },
        { key: "tcard", label: "tCard", description: "6 000 000–6 999 999" },
        { key: "si10", label: "SI-10", description: "7 000 000–7 999 999" },
        { key: "siac", label: "SIAC", description: "8 000 000–9 999 999" },
        { key: "si11", label: "SI-11", description: "" },
      ],
      match: (item, op, value) => {
        const cardType = resolveCardType(item);
        const values = op === "in"
          ? value.split(",").map((v) => v.trim())
          : [value];
        return values.some((v) => {
          const target = CARD_TYPE_ALIASES[v.toLowerCase()];
          if (target) return cardType === target;
          return cardType.toLowerCase() === v.toLowerCase();
        });
      },
    },
    {
      key: "rental",
      label: getLabel("rental"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "orange",
      suggest: () => [
        { key: "yes", label: "Yes (rental card)" },
        { key: "no", label: "No (own card)" },
      ],
      match: (item, _op, value) =>
        matchBool(!!item.runner?.isRentalCard, value),
    },
    {
      key: "returned",
      label: getLabel("returned"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "emerald",
      suggest: () => [
        { key: "yes", label: "Returned" },
        { key: "no", label: "Not returned" },
      ],
      match: (item, _op, value) => {
        if (!item.runner?.isRentalCard) return false;
        return matchBool(!!item.runner.cardReturned, value);
      },
    },
    {
      key: "linked",
      label: getLabel("linked"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "indigo",
      suggest: () => [
        { key: "yes", label: "Linked to runner" },
        { key: "no", label: "Unlinked" },
      ],
      match: (item, _op, value) => matchBool(!!item.runner, value),
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
        const volts = item.batteryVoltage;
        if (v === "missing") return volts == null || volts <= 0;
        if (volts == null || volts <= 0) return false;
        if (v === "low") return volts < BATTERY_LOW;
        if (v === "warn") return volts >= BATTERY_LOW && volts < BATTERY_WARN;
        if (v === "ok") return volts >= BATTERY_WARN;
        return false;
      },
    },
    {
      key: "punches",
      label: getLabel("punches"),
      type: "number",
      operators: ["eq", "gt", "lt", "gte", "lte"],
      defaultOperator: "gte",
      color: "cyan",
      match: (item, op, value) => matchNumber(item.punchCount, op, value),
    },
    {
      key: "runner",
      label: getLabel("runner"),
      type: "string",
      operators: ["contains", "wildcard", "eq"],
      defaultOperator: "contains",
      color: "slate",
      match: (item, op, value) => matchString(item.runner?.name ?? "", op, value),
    },
    {
      key: "club",
      label: getLabel("club"),
      type: "string",
      operators: ["eq", "wildcard", "in", "contains"],
      defaultOperator: "eq",
      color: "teal",
      suggest: (query: string, data: unknown) => {
        const d = data as CardAnchorData | undefined;
        if (!d?.clubs) return [];
        const lower = query.toLowerCase();
        return d.clubs
          .filter((c) => c.name.toLowerCase().includes(lower))
          .slice(0, 10)
          .map((c) => ({ key: c.name, label: c.name }));
      },
      match: (item, op, value) => matchString(item.runner?.clubName ?? "", op, value),
    },
    {
      key: "class",
      label: getLabel("class"),
      type: "string",
      operators: ["eq", "wildcard", "in", "contains"],
      defaultOperator: "eq",
      color: "purple",
      suggest: (query: string, data: unknown) => {
        const d = data as CardAnchorData | undefined;
        if (!d?.classes) return [];
        const lower = query.toLowerCase();
        return d.classes
          .filter((c) => c.name.toLowerCase().includes(lower))
          .slice(0, 10)
          .map((c) => ({ key: c.name, label: c.name }));
      },
      match: (item, op, value) => matchString(item.runner?.className ?? "", op, value),
    },
  ];
}
