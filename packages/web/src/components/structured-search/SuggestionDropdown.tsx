import { useEffect, useRef } from "react";
import type { AnchorDef, SuggestionItem } from "../../lib/structured-search/types";

interface AnchorSuggestion {
  type: "anchor";
  anchor: AnchorDef;
}

interface ValueSuggestion {
  type: "value";
  item: SuggestionItem;
}

export type Suggestion = AnchorSuggestion | ValueSuggestion;

interface SuggestionDropdownProps {
  suggestions: Suggestion[];
  highlightIndex: number;
  onSelect: (suggestion: Suggestion) => void;
  visible: boolean;
  multiSelect?: boolean;
  selectedKeys?: Set<string>;
  onToggle?: (suggestion: Suggestion) => void;
  onCommitMulti?: () => void;
}

/** Tailwind color classes for anchor key badges */
const ANCHOR_COLOR_MAP: Record<string, string> = {
  slate:   "bg-slate-100 text-slate-600",
  purple:  "bg-purple-100 text-purple-600",
  teal:    "bg-teal-100 text-teal-600",
  amber:   "bg-amber-100 text-amber-600",
  green:   "bg-green-100 text-green-600",
  indigo:  "bg-indigo-100 text-indigo-600",
  pink:    "bg-pink-100 text-pink-600",
  emerald: "bg-emerald-100 text-emerald-600",
  sky:     "bg-sky-100 text-sky-600",
  violet:  "bg-violet-100 text-violet-600",
  orange:  "bg-orange-100 text-orange-600",
  cyan:    "bg-cyan-100 text-cyan-600",
  yellow:  "bg-yellow-100 text-yellow-600",
  rose:    "bg-rose-100 text-rose-600",
};

function CheckboxIcon({ checked }: { checked: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center w-4 h-4 rounded border shrink-0 transition-colors ${
        checked
          ? "bg-blue-500 border-blue-500 text-white"
          : "border-slate-300 bg-white"
      }`}
    >
      {checked && (
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      )}
    </span>
  );
}

export function SuggestionDropdown({
  suggestions,
  highlightIndex,
  onSelect,
  visible,
  multiSelect,
  selectedKeys,
  onToggle,
  onCommitMulti,
}: SuggestionDropdownProps) {
  const listRef = useRef<HTMLUListElement>(null);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIndex >= 0 && listRef.current) {
      // Account for hint row offset in multi-select mode
      const offset = multiSelect ? 1 : 0;
      const item = listRef.current.children[highlightIndex + offset] as HTMLElement;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex, multiSelect]);

  if (!visible || suggestions.length === 0) return null;

  const selectedCount = selectedKeys?.size ?? 0;

  return (
    <ul
      ref={listRef}
      className="absolute left-0 right-0 top-full mt-1 z-50 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto py-1"
      role="listbox"
    >
      {/* Keyboard hint for multi-select mode */}
      {multiSelect && (
        <li className="px-3 py-1 text-[11px] text-slate-400 border-b border-slate-100 select-none">
          Space to toggle · Enter to apply
        </li>
      )}

      {suggestions.map((suggestion, index) => {
        const isHighlighted = index === highlightIndex;

        if (suggestion.type === "anchor") {
          const { anchor } = suggestion;
          const colorClass = ANCHOR_COLOR_MAP[anchor.color] ?? "bg-slate-100 text-slate-600";
          return (
            <li
              key={`anchor-${anchor.key}`}
              role="option"
              aria-selected={isHighlighted}
              className={`px-3 py-1.5 cursor-pointer flex items-center gap-2 text-sm ${
                isHighlighted ? "bg-blue-50" : "hover:bg-slate-50"
              }`}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(suggestion);
              }}
            >
              <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${colorClass}`}>
                {anchor.key}
              </span>
              <span className="text-slate-600">{anchor.label}</span>
            </li>
          );
        }

        // Value suggestion
        const { item } = suggestion;
        const isSelected = multiSelect && selectedKeys?.has(item.key);

        return (
          <li
            key={`value-${item.key}`}
            role="option"
            aria-selected={isHighlighted}
            className={`px-3 py-1.5 cursor-pointer flex items-center gap-2 text-sm ${
              isHighlighted
                ? "bg-blue-50"
                : isSelected
                  ? "bg-blue-50/50"
                  : "hover:bg-slate-50"
            }`}
            onMouseDown={(e) => {
              e.preventDefault();
              if (multiSelect && onToggle) {
                onToggle(suggestion);
              } else {
                onSelect(suggestion);
              }
            }}
          >
            {multiSelect && <CheckboxIcon checked={!!isSelected} />}
            <span className="text-slate-900">{item.label}</span>
            {item.description && (
              <span className="text-slate-400 text-xs">{item.description}</span>
            )}
          </li>
        );
      })}

      {/* Sticky footer with apply button */}
      {multiSelect && selectedCount > 0 && (
        <li className="sticky bottom-0 border-t border-slate-100 bg-white px-3 py-1.5 flex items-center justify-between select-none">
          <span className="text-xs text-slate-500">{selectedCount} selected</span>
          <button
            type="button"
            className="text-xs font-medium text-blue-600 hover:text-blue-800 cursor-pointer"
            onMouseDown={(e) => {
              e.preventDefault();
              onCommitMulti?.();
            }}
          >
            Apply
          </button>
        </li>
      )}
    </ul>
  );
}
