import type { FilterToken, AnchorDef } from "../../lib/structured-search/types";

/** Tailwind color classes for each anchor color token */
const COLOR_MAP: Record<string, { bg: string; text: string; border: string; close: string }> = {
  slate:   { bg: "bg-slate-100",   text: "text-slate-700",   border: "border-slate-200",   close: "hover:bg-slate-200" },
  purple:  { bg: "bg-purple-100",  text: "text-purple-700",  border: "border-purple-200",  close: "hover:bg-purple-200" },
  teal:    { bg: "bg-teal-100",    text: "text-teal-700",    border: "border-teal-200",    close: "hover:bg-teal-200" },
  amber:   { bg: "bg-amber-100",   text: "text-amber-700",   border: "border-amber-200",   close: "hover:bg-amber-200" },
  green:   { bg: "bg-green-100",   text: "text-green-700",   border: "border-green-200",   close: "hover:bg-green-200" },
  indigo:  { bg: "bg-indigo-100",  text: "text-indigo-700",  border: "border-indigo-200",  close: "hover:bg-indigo-200" },
  pink:    { bg: "bg-pink-100",    text: "text-pink-700",    border: "border-pink-200",    close: "hover:bg-pink-200" },
  emerald: { bg: "bg-emerald-100", text: "text-emerald-700", border: "border-emerald-200", close: "hover:bg-emerald-200" },
  sky:     { bg: "bg-sky-100",     text: "text-sky-700",     border: "border-sky-200",     close: "hover:bg-sky-200" },
  violet:  { bg: "bg-violet-100",  text: "text-violet-700",  border: "border-violet-200",  close: "hover:bg-violet-200" },
  orange:  { bg: "bg-orange-100",  text: "text-orange-700",  border: "border-orange-200",  close: "hover:bg-orange-200" },
  cyan:    { bg: "bg-cyan-100",    text: "text-cyan-700",    border: "border-cyan-200",    close: "hover:bg-cyan-200" },
  yellow:  { bg: "bg-yellow-100",  text: "text-yellow-700",  border: "border-yellow-200",  close: "hover:bg-yellow-200" },
  rose:    { bg: "bg-rose-100",    text: "text-rose-700",    border: "border-rose-200",    close: "hover:bg-rose-200" },
};

const DEFAULT_COLORS = COLOR_MAP.slate;

/** Operator display symbols */
function operatorSymbol(op: string): string {
  switch (op) {
    case "gt": return ">";
    case "lt": return "<";
    case "gte": return ">=";
    case "lte": return "<=";
    case "wildcard": return "~";
    case "in": return ":";
    default: return ":";
  }
}

interface FilterPillProps {
  token: FilterToken;
  anchor?: AnchorDef;
  onRemove: (id: string) => void;
  onClick?: (id: string) => void;
}

export function FilterPill({ token, anchor, onRemove, onClick }: FilterPillProps) {
  const colorKey = token.anchor ? (anchor?.color ?? "slate") : "slate";
  const colors = COLOR_MAP[colorKey] ?? DEFAULT_COLORS;
  const isFreeText = !token.anchor;

  return (
    <span
      className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-md text-xs font-medium border ${colors.bg} ${colors.text} ${colors.border} max-w-[200px] cursor-pointer`}
      onClick={() => onClick?.(token.id)}
      title={isFreeText ? token.value : `${token.anchor}${operatorSymbol(token.operator)}${token.value}`}
    >
      {isFreeText ? (
        <>
          <svg className="w-3 h-3 shrink-0 opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <span className="truncate">{token.value}</span>
        </>
      ) : (
        <>
          <span className="font-semibold shrink-0">{anchor?.label ?? token.anchor}</span>
          <span className="opacity-50">{operatorSymbol(token.operator)}</span>
          <span className="truncate">{token.value}</span>
        </>
      )}
      <button
        type="button"
        className={`ml-0.5 shrink-0 rounded-full p-0.5 ${colors.close} transition-colors`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(token.id);
        }}
        aria-label="Remove filter"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
}
