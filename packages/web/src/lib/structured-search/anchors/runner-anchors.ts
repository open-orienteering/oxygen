import { RunnerStatus, type RunnerInfo } from "@oxygen/shared";
import { getCardType, type SICardType } from "../../si-protocol";
import type { AnchorDef, FilterOperator, SuggestionItem } from "../types";

const CURRENT_YEAR = new Date().getFullYear();

/** Status aliases map text → numeric status values */
const STATUS_ALIASES: Record<string, number[]> = {
  ok: [RunnerStatus.OK],
  mp: [RunnerStatus.MissingPunch],
  dnf: [RunnerStatus.DNF],
  dns: [RunnerStatus.DNS],
  dq: [RunnerStatus.DQ],
  overtime: [RunnerStatus.OverMaxTime],
  cancel: [RunnerStatus.Cancel],
  nc: [RunnerStatus.NotCompeting],
};

function matchString(
  actual: string,
  op: FilterOperator,
  value: string,
): boolean {
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

function matchNumber(
  actual: number,
  op: FilterOperator,
  value: string,
): boolean {
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

function matchStatus(runner: RunnerInfo, op: FilterOperator, value: string): boolean {
  const values = op === "in" ? value.split(",").map((v) => v.trim().toLowerCase()) : [value.toLowerCase()];

  return values.some((v) => {
    if (v === "not-started") {
      return runner.status === 0 && runner.finishTime === 0 && runner.startTime === 0;
    }
    if (v === "started" || v === "in-forest") {
      return runner.status === 0 && runner.finishTime === 0 && runner.startTime > 0;
    }
    if (v === "finished") {
      return runner.status > 0 || runner.finishTime > 0;
    }

    const alias = STATUS_ALIASES[v];
    if (alias) return alias.includes(runner.status);

    const num = parseInt(v, 10);
    if (!isNaN(num)) return runner.status === num;

    return false;
  });
}

/** Normalize user-typed card type string to SICardType */
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

function matchCardType(cardNo: number, typeStr: string): boolean {
  const alias = CARD_TYPE_ALIASES[typeStr.toLowerCase()];
  if (alias) return getCardType(cardNo) === alias;
  // Try as a plain card number
  const num = parseInt(typeStr, 10);
  if (!isNaN(num)) return cardNo === num;
  return false;
}

/**
 * Parse a time string (HH:MM:SS, H:MM:SS, MM:SS, M:SS) to deciseconds.
 * Returns null if the format is invalid.
 */
export function parseTimeValue(str: string): number | null {
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

function matchControlCodes(codes: number[] | undefined, op: FilterOperator, value: string): boolean {
  if (!codes || codes.length === 0) return false;
  const values = op === "in" ? value.split(",").map((v) => v.trim()) : [value];
  return values.some((v) => {
    const num = parseInt(v, 10);
    if (isNaN(num)) return false;
    return codes.includes(num);
  });
}

export type RunnerAnchorData = {
  classes: { id: number; name: string }[];
  clubs: { id: number; name: string }[];
  runners?: { name: string }[];
};

export function createRunnerAnchors(
  getLabel: (key: string) => string,
): AnchorDef<RunnerInfo>[] {
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
        const d = data as RunnerAnchorData | undefined;
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
        const d = data as RunnerAnchorData | undefined;
        if (!d?.classes) return [];
        const lower = query.toLowerCase();
        return d.classes
          .filter((c) => c.name.toLowerCase().includes(lower))
          .slice(0, 10)
          .map((c) => ({ key: c.name, label: c.name }));
      },
      match: (item, op, value) =>
        matchString(item.className ?? "", op, value),
    },
    {
      key: "club",
      label: getLabel("club"),
      type: "string",
      operators: ["eq", "wildcard", "in"],
      defaultOperator: "eq",
      color: "teal",
      suggest: (query: string, data: unknown) => {
        const d = data as RunnerAnchorData | undefined;
        if (!d?.clubs) return [];
        const lower = query.toLowerCase();
        return d.clubs
          .filter((c) => c.name.toLowerCase().includes(lower))
          .slice(0, 10)
          .map((c) => ({ key: c.name, label: c.name }));
      },
      match: (item, op, value) =>
        matchString(item.clubName ?? "", op, value),
    },
    {
      key: "card",
      label: getLabel("card"),
      type: "number",
      operators: ["eq", "in"],
      defaultOperator: "eq",
      color: "amber",
      suggest: () => [
        { key: "si5", label: "SI-5", description: "1–499 999" },
        { key: "si6", label: "SI-6", description: "500 000–999 999" },
        { key: "si9", label: "SI-9", description: "1 000 000–1 999 999" },
        { key: "si8", label: "SI-8", description: "2 000 000–2 999 999" },
        { key: "pcard", label: "pCard", description: "4 000 000–4 999 999" },
        { key: "tcard", label: "tCard", description: "6 000 000–6 999 999" },
        { key: "si10", label: "SI-10", description: "7 000 000–7 999 999" },
        { key: "siac", label: "SIAC", description: "8 000 000–9 999 999" },
      ],
      match: (item, op, value) => {
        if (op === "in") {
          return value.split(",").some((v) => matchCardType(item.cardNo, v.trim()));
        }
        return matchCardType(item.cardNo, value);
      },
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
      key: "age",
      label: getLabel("age"),
      type: "number",
      operators: ["eq", "gt", "lt", "gte", "lte"],
      defaultOperator: "eq",
      color: "indigo",
      match: (item, op, value) => {
        if (!item.birthYear) return false;
        const age = CURRENT_YEAR - item.birthYear;
        return matchNumber(age, op, value);
      },
    },
    {
      key: "sex",
      label: getLabel("sex"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "pink",
      suggest: () => [
        { key: "m", label: "Male" },
        { key: "f", label: "Female" },
      ],
      match: (item, op, value) => {
        if (!item.sex) return false;
        return item.sex.toLowerCase().startsWith(value.toLowerCase());
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
      key: "paid",
      label: getLabel("paid"),
      type: "enum",
      operators: ["eq"],
      defaultOperator: "eq",
      color: "emerald",
      suggest: () => [
        { key: "yes", label: "Paid" },
        { key: "no", label: "Unpaid" },
        { key: "partial", label: "Partially paid" },
      ],
      match: (item, op, value) => {
        const fee = item.fee ?? 0;
        const paid = item.paid ?? 0;
        const v = value.toLowerCase();
        if (v === "yes") return fee > 0 && paid >= fee;
        if (v === "no") return fee > 0 && paid === 0;
        if (v === "partial") return fee > 0 && paid > 0 && paid < fee;
        return false;
      },
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
      ],
      match: (item, op, value) => {
        const v = value.toLowerCase();
        if (v === "assigned") return item.startTime > 0;
        if (v === "none") return item.startTime === 0;
        return false;
      },
    },
    {
      key: "nation",
      label: getLabel("nationality"),
      type: "string",
      operators: ["eq", "wildcard"],
      defaultOperator: "eq",
      color: "violet",
      match: (item, op, value) =>
        matchString(item.nationality ?? "", op, value),
    },
    // ─── New anchors ────────────────────────────────────────
    {
      key: "punched",
      label: getLabel("punched"),
      type: "number",
      operators: ["eq", "in"],
      defaultOperator: "eq",
      color: "orange",
      match: (item, op, value) =>
        matchControlCodes(item.punchControlCodes, op, value),
    },
    {
      key: "visited",
      label: getLabel("visited"),
      type: "number",
      operators: ["eq", "in"],
      defaultOperator: "eq",
      color: "orange",
      match: (item, op, value) =>
        matchControlCodes(item.punchControlCodes, op, value),
    },
    {
      key: "control",
      label: getLabel("control"),
      type: "number",
      operators: ["eq", "in"],
      defaultOperator: "eq",
      color: "cyan",
      match: (item, op, value) =>
        matchControlCodes(item.courseControlCodes, op, value),
    },
    {
      key: "rank",
      label: getLabel("rank"),
      type: "number",
      operators: ["eq", "gt", "lt", "gte", "lte"],
      defaultOperator: "eq",
      color: "yellow",
      match: (item, op, value) => {
        if (item.rank == null || item.rank <= 0) return false;
        return matchNumber(item.rank, op, value);
      },
    },
    {
      key: "scheduled",
      label: getLabel("scheduled"),
      type: "number",
      operators: ["gt", "lt", "gte", "lte", "eq"],
      defaultOperator: "gte",
      color: "sky",
      suggest: () => [
        { key: ">10:00:00", label: "After 10:00" },
        { key: "<12:00:00", label: "Before 12:00" },
      ],
      match: (item, op, value) => matchTime(item.startTime, op, value),
    },
    {
      key: "started",
      label: getLabel("started"),
      type: "number",
      operators: ["gt", "lt", "gte", "lte", "eq"],
      defaultOperator: "gte",
      color: "sky",
      match: (item, op, value) => matchTime(item.cardStartTime ?? 0, op, value),
    },
    {
      key: "forest",
      label: getLabel("forest"),
      type: "number",
      operators: ["gt", "lt", "gte", "lte"],
      defaultOperator: "gt",
      color: "rose",
      suggest: () => [
        { key: ">0:30:00", label: "Over 30 min" },
        { key: ">1:00:00", label: "Over 1 hour" },
        { key: "<0:45:00", label: "Under 45 min" },
      ],
      match: (item, op, value) => {
        const effectiveStart = item.startTime;
        if (effectiveStart <= 0) return false;

        // Subtract the NoTiming/BadNoTiming leg adjustment so the search
        // matches the canonical (displayed) running time everywhere else
        // in the app. In-forest runners haven't finished and don't have
        // a meaningful adjustment yet — they fall through to raw time.
        const adjustment = item.runningTimeAdjustment ?? 0;

        let runningTime: number;
        if (item.finishTime > 0) {
          runningTime = Math.max(0, item.finishTime - effectiveStart - adjustment);
        } else {
          // In-forest: compute current running time
          const now = new Date();
          const meosNow = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 10;
          runningTime = meosNow - effectiveStart;
          if (runningTime < 0) return false;
        }
        return matchTime(runningTime, op, value);
      },
    },
  ];
}
