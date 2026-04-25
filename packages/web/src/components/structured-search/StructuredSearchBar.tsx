import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { FilterToken, AnchorDef } from "../../lib/structured-search/types";
import { FilterPill } from "./FilterPill";
import {
  SuggestionDropdown,
  type Suggestion,
} from "./SuggestionDropdown";

interface StructuredSearchBarProps {
  tokens: FilterToken[];
  onTokensChange: (tokens: FilterToken[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anchors: AnchorDef<any>[];
  placeholder?: string;
  suggestionData?: unknown;
}

let nextTokenId = 0;
function newTokenId(): string {
  return `st_${++nextTokenId}`;
}

/**
 * Parse a raw input segment into a FilterToken.
 * Handles anchor:value, operator detection, etc.
 */
function parseInputToToken(
  raw: string,
  anchorMap: Map<string, AnchorDef>,
): FilterToken | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const key = trimmed.slice(0, colonIdx).toLowerCase();
    const anchor = anchorMap.get(key);
    if (anchor) {
      let value = trimmed.slice(colonIdx + 1);
      // Strip surrounding quotes
      if (value.startsWith('"') && value.endsWith('"'))
        value = value.slice(1, -1);
      if (!value) return null;

      // Detect operator from value prefix
      let operator = anchor.defaultOperator;
      if (value.startsWith(">=")) {
        operator = "gte";
        value = value.slice(2);
      } else if (value.startsWith("<=")) {
        operator = "lte";
        value = value.slice(2);
      } else if (value.startsWith(">")) {
        operator = "gt";
        value = value.slice(1);
      } else if (value.startsWith("<")) {
        operator = "lt";
        value = value.slice(1);
      } else if (value.includes(",")) {
        operator = "in";
      } else if (value.includes("*")) {
        operator = "wildcard";
      }

      if (!value) return null;
      return { id: newTokenId(), anchor: anchor.key, operator, value };
    }
  }

  // Free text
  let value = trimmed;
  if (value.startsWith('"') && value.endsWith('"'))
    value = value.slice(1, -1);
  return {
    id: newTokenId(),
    anchor: "",
    operator: "contains",
    value,
  };
}

export function StructuredSearchBar({
  tokens,
  onTokensChange,
  anchors,
  placeholder = "Search or filter...",
  suggestionData,
}: StructuredSearchBarProps) {
  const { t } = useTranslation("common");
  const [inputValue, setInputValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [pendingValues, setPendingValues] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const anchorMap = useMemo(
    () => new Map(anchors.map((a) => [a.key.toLowerCase(), a])),
    [anchors],
  );

  // Determine suggestion context: are we typing an anchor or a value?
  const suggestionContext = useMemo(() => {
    const colonIdx = inputValue.indexOf(":");
    if (colonIdx > 0) {
      const key = inputValue.slice(0, colonIdx).toLowerCase();
      const anchor = anchorMap.get(key);
      if (anchor) {
        return { mode: "value" as const, anchor, query: inputValue.slice(colonIdx + 1) };
      }
    }
    return { mode: "anchor" as const, anchor: null, query: inputValue };
  }, [inputValue, anchorMap]);

  // Multi-select mode: active when anchor supports "in" operator and has suggestions
  const isMultiSelect =
    suggestionContext.mode === "value" &&
    suggestionContext.anchor != null &&
    suggestionContext.anchor.operators.includes("in") &&
    suggestionContext.anchor.suggest != null;

  // Build suggestions list
  const suggestions = useMemo((): Suggestion[] => {
    if (!inputValue && !showSuggestions) return [];

    if (suggestionContext.mode === "value") {
      const { anchor, query } = suggestionContext;
      if (anchor?.suggest) {
        const items = anchor.suggest(query, suggestionData);
        return items.map((item) => ({ type: "value", item }));
      }
      return [];
    }

    // Anchor mode: filter anchors by typed prefix
    const query = suggestionContext.query.toLowerCase();
    const matchingAnchors = anchors.filter(
      (a) =>
        a.key.toLowerCase().includes(query) ||
        a.label.toLowerCase().includes(query),
    );

    const anchorSuggestions: Suggestion[] = matchingAnchors.map((anchor) => ({ type: "anchor", anchor }));

    // In free-text mode with 3+ chars, also show name suggestions from anchors with suggest fn
    if (query.length >= 3) {
      for (const anchor of anchors) {
        if (anchor.suggest && anchor.type === "string") {
          const items = anchor.suggest(query, suggestionData);
          for (const item of items.slice(0, 5)) {
            anchorSuggestions.push({ type: "value", item: { ...item, key: `${anchor.key}:${item.key}` } });
          }
        }
      }
    }

    return anchorSuggestions;
  }, [inputValue, showSuggestions, suggestionContext, anchors, suggestionData]);

  // Reset highlight when suggestions change
  useEffect(() => {
    setHighlightIndex(-1);
  }, [suggestions.length]);

  // True whenever the user has an active anchor in value-entry mode
  // (input ends with e.g. `club:`). We use this to keep the suggestion
  // dropdown open regardless of the showSuggestions flag — mouse-driven
  // anchor selection can otherwise race with surrounding click/blur events
  // and end up with the dropdown collapsed even though the input now reads
  // `club:`. Escape and click-outside clear the input entirely (below) so
  // this stays a real "user is editing this anchor" signal.
  const isAnchorValueMode = suggestionContext.mode === "value" && suggestionContext.anchor != null;

  // Hint shown in the dropdown when an anchor is active but no value suggestions exist yet.
  // Mirrors the behavior of typing `anchor:` from the keyboard so click and keyboard feel identical.
  const dropdownHint = useMemo(() => {
    if (suggestionContext.mode !== "value") return undefined;
    if (suggestions.length > 0) return undefined;
    const anchor = suggestionContext.anchor;
    if (!anchor) return undefined;
    if (anchor.type === "number") {
      return t("structuredSearchHintNumber");
    }
    return t("structuredSearchHintTypeToSearch");
  }, [suggestionContext, suggestions.length, t]);

  const commitToken = useCallback(
    (raw: string) => {
      const token = parseInputToToken(raw, anchorMap);
      if (token) {
        onTokensChange([...tokens, token]);
      }
      setInputValue("");
      setShowSuggestions(false);
    },
    [tokens, onTokensChange, anchorMap],
  );

  const togglePendingValue = useCallback(
    (key: string) => {
      setPendingValues((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        // Update input to reflect selections
        if (suggestionContext.anchor) {
          setInputValue(`${suggestionContext.anchor.key}:`);
        }
        return next;
      });
    },
    [suggestionContext.anchor],
  );

  const commitPendingValues = useCallback(() => {
    if (pendingValues.size === 0 || !suggestionContext.anchor) return;
    const value = [...pendingValues].join(",");
    commitToken(`${suggestionContext.anchor.key}:${value}`);
    setPendingValues(new Set());
  }, [pendingValues, suggestionContext.anchor, commitToken]);

  const removeToken = useCallback(
    (id: string) => {
      onTokensChange(tokens.filter((t) => t.id !== id));
    },
    [tokens, onTokensChange],
  );

  const handlePillClick = useCallback(
    (id: string) => {
      // Convert pill back to text for editing
      const token = tokens.find((t) => t.id === id);
      if (!token) return;

      // Multi-select re-editing: open dropdown with values pre-checked
      if (token.anchor) {
        const anchor = anchorMap.get(token.anchor);
        if (anchor?.operators.includes("in") && anchor.suggest) {
          const values = token.value.split(",").filter(Boolean);
          setPendingValues(new Set(values));
          onTokensChange(tokens.filter((t) => t.id !== id));
          setInputValue(`${token.anchor}:`);
          setShowSuggestions(true);
          setTimeout(() => inputRef.current?.focus(), 0);
          return;
        }
      }

      let text: string;
      if (!token.anchor) {
        text = token.value.includes(" ") ? `"${token.value}"` : token.value;
      } else {
        let val = token.value;
        if (token.operator === "gt") val = `>${val}`;
        else if (token.operator === "lt") val = `<${val}`;
        else if (token.operator === "gte") val = `>=${val}`;
        else if (token.operator === "lte") val = `<=${val}`;
        if (val.includes(" ")) val = `"${val}"`;
        text = `${token.anchor}:${val}`;
      }

      onTokensChange(tokens.filter((t) => t.id !== id));
      setInputValue(text);
      setShowSuggestions(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [tokens, onTokensChange, anchorMap],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0,
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1,
        );
      } else if (e.key === " " && isMultiSelect && highlightIndex >= 0 && highlightIndex < suggestions.length) {
        // Space toggles a value in multi-select mode
        e.preventDefault();
        const s = suggestions[highlightIndex];
        if (s.type === "value") togglePendingValue(s.item.key);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (isMultiSelect && pendingValues.size > 0) {
          // If highlighting an item, toggle it first, then commit all
          if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
            const s = suggestions[highlightIndex];
            if (s.type === "value") {
              // Toggle and commit in one step
              const next = new Set(pendingValues);
              if (next.has(s.item.key)) next.delete(s.item.key);
              else next.add(s.item.key);
              if (next.size > 0 && suggestionContext.anchor) {
                commitToken(`${suggestionContext.anchor.key}:${[...next].join(",")}`);
                setPendingValues(new Set());
                return;
              }
            }
          }
          commitPendingValues();
        } else if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
          handleSuggestionSelect(suggestions[highlightIndex]);
        } else if (inputValue.trim()) {
          commitToken(inputValue);
        }
      } else if (e.key === "Escape") {
        if (pendingValues.size > 0) {
          commitPendingValues();
        } else {
          // In value mode (input is `club:` etc.) clear the input so the
          // dropdown actually closes — visibility is now driven by
          // isAnchorValueMode, not just showSuggestions.
          if (suggestionContext.mode === "value") {
            setInputValue("");
          }
          setShowSuggestions(false);
          setHighlightIndex(-1);
        }
      } else if (e.key === "Backspace" && !inputValue) {
        // Remove last token
        if (tokens.length > 0) {
          const last = tokens[tokens.length - 1];
          handlePillClick(last.id);
        }
      } else if (e.key === "Tab" && (inputValue.trim() || pendingValues.size > 0)) {
        e.preventDefault();
        if (isMultiSelect && pendingValues.size > 0) {
          commitPendingValues();
        } else if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
          handleSuggestionSelect(suggestions[highlightIndex]);
        } else if (inputValue.trim()) {
          commitToken(inputValue);
        }
      }
    },
    [inputValue, tokens, suggestions, highlightIndex, commitToken, handlePillClick, isMultiSelect, pendingValues, togglePendingValue, commitPendingValues, suggestionContext.anchor],
  );

  const handleSuggestionSelect = useCallback(
    (suggestion: Suggestion) => {
      if (suggestion.type === "anchor") {
        // Insert anchor key with colon, ready for value typing
        setInputValue(`${suggestion.anchor.key}:`);
        setPendingValues(new Set());
        setShowSuggestions(true);
        setHighlightIndex(-1);
        inputRef.current?.focus();
      } else if (isMultiSelect) {
        // Multi-select: toggle value instead of committing
        togglePendingValue(suggestion.item.key);
        inputRef.current?.focus();
      } else {
        // Single-select: insert the value and commit
        const key = suggestion.item.key;
        const colonIdx = inputValue.indexOf(":");
        if (colonIdx > 0) {
          // We're in value mode — prepend the anchor prefix
          const prefix = inputValue.slice(0, colonIdx + 1);
          commitToken(`${prefix}${key}`);
        } else if (key.includes(":")) {
          // Free-text name suggestion like "name:Anna Svensson"
          const value = key.split(":").slice(1).join(":");
          commitToken(`${key.split(":")[0]}:${value.includes(" ") ? `"${value}"` : value}`);
        } else {
          commitToken(key);
        }
      }
    },
    [inputValue, commitToken, isMultiSelect, togglePendingValue],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);
      setShowSuggestions(true);
    },
    [],
  );

  // Close suggestions when clicking outside the entire search bar.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (containerRef.current && !containerRef.current.contains(target)) {
        if (pendingValues.size > 0 && suggestionContext.anchor) {
          const value = [...pendingValues].join(",");
          const raw = `${suggestionContext.anchor.key}:${value}`;
          const token = parseInputToToken(raw, anchorMap);
          if (token) {
            onTokensChange([...tokens, token]);
          }
          setPendingValues(new Set());
          setInputValue("");
        } else if (suggestionContext.mode === "value") {
          // Cancel an in-progress anchor entry on click outside (the dropdown
          // is otherwise pinned open by isAnchorValueMode).
          setInputValue("");
        }
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [pendingValues, suggestionContext.mode, suggestionContext.anchor, anchorMap, tokens, onTokensChange]);

  // Global "/" keyboard shortcut to focus search
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement)?.isContentEditable) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener("keydown", handleGlobalKey);
    return () => document.removeEventListener("keydown", handleGlobalKey);
  }, []);

  const clearAll = useCallback(() => {
    onTokensChange([]);
    setInputValue("");
    inputRef.current?.focus();
  }, [onTokensChange]);

  const hasContent = tokens.length > 0 || inputValue.length > 0;

  return (
    <div ref={containerRef} className="relative flex-1">
      <div
        className={`flex flex-wrap items-center gap-1.5 w-full pl-9 pr-8 py-1.5 min-h-[38px] border rounded-lg text-sm bg-white transition-colors
          ${showSuggestions ? "border-blue-400 ring-2 ring-blue-100" : "border-slate-200"}
          focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100`}
        onClick={() => {
          inputRef.current?.focus();
          setShowSuggestions(true);
        }}
      >
        {/* Search icon */}
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>

        {/* Rendered pills */}
        {tokens.map((token) => (
          <FilterPill
            key={token.id}
            token={token}
            anchor={anchorMap.get(token.anchor) as AnchorDef | undefined}
            onRemove={removeToken}
            onClick={handlePillClick}
          />
        ))}

        {/* Input field */}
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          placeholder={tokens.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] outline-none bg-transparent text-sm text-slate-900 placeholder:text-slate-400"
          aria-label="Search filter input"
          aria-expanded={(showSuggestions || isAnchorValueMode) && (suggestions.length > 0 || !!dropdownHint)}
          role="combobox"
          aria-autocomplete="list"
        />

        {/* "/" shortcut hint */}
        {!hasContent && (
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs text-slate-400 border border-slate-200 rounded font-mono pointer-events-none">/</kbd>
        )}

        {/* Clear button */}
        {hasContent && (
          <button
            type="button"
            onClick={clearAll}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Clear all filters"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Suggestions dropdown */}
      <SuggestionDropdown
        suggestions={suggestions}
        highlightIndex={highlightIndex}
        onSelect={handleSuggestionSelect}
        visible={(showSuggestions || isAnchorValueMode) && (suggestions.length > 0 || !!dropdownHint)}
        multiSelect={isMultiSelect}
        selectedKeys={pendingValues}
        onToggle={isMultiSelect ? (s) => {
          if (s.type === "value") togglePendingValue(s.item.key);
        } : undefined}
        onCommitMulti={isMultiSelect ? commitPendingValues : undefined}
        hint={dropdownHint}
      />
    </div>
  );
}
