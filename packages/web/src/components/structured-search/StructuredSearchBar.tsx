import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type {
  AnchorDef,
  Atom,
  FilterNode,
} from "../../lib/structured-search/types";
import { isOrGroup } from "../../lib/structured-search/types";
import {
  appendAtom,
  popLastEntry,
  removeChildFromGroup as removeChildFromGroupOp,
} from "../../lib/structured-search/edit-ops";
import { FilterPill } from "./FilterPill";
import { OrGroupPill } from "./OrGroupPill";
import {
  SuggestionDropdown,
  type Suggestion,
} from "./SuggestionDropdown";

interface StructuredSearchBarProps {
  tokens: FilterNode[];
  onTokensChange: (tokens: FilterNode[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anchors: AnchorDef<any>[];
  placeholder?: string;
  suggestionData?: unknown;
}

let nextTokenId = 0;
function newTokenId(prefix = "st"): string {
  return `${prefix}_${++nextTokenId}`;
}

/**
 * Parse a raw input segment into an Atom.
 * Handles anchor:value, operator detection, etc.
 */
function parseInputToAtom(
  raw: string,
  anchorMap: Map<string, AnchorDef>,
): Atom | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0) {
    const key = trimmed.slice(0, colonIdx).toLowerCase();
    const anchor = anchorMap.get(key);
    if (anchor) {
      let value = trimmed.slice(colonIdx + 1);
      if (value.startsWith('"') && value.endsWith('"'))
        value = value.slice(1, -1);
      if (!value) return null;

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
      return {
        kind: "atom",
        id: newTokenId(),
        anchor: anchor.key,
        operator,
        value,
      };
    }
  }

  let value = trimmed;
  if (value.startsWith('"') && value.endsWith('"'))
    value = value.slice(1, -1);
  return {
    kind: "atom",
    id: newTokenId(),
    anchor: "",
    operator: "contains",
    value,
  };
}

/** Format an atom back into editable text (with operator/quote prefixes). */
function atomToText(atom: Atom): string {
  if (!atom.anchor) {
    return atom.value.includes(" ") ? `"${atom.value}"` : atom.value;
  }
  let val = atom.value;
  if (atom.operator === "gt") val = `>${val}`;
  else if (atom.operator === "lt") val = `<${val}`;
  else if (atom.operator === "gte") val = `>=${val}`;
  else if (atom.operator === "lte") val = `<=${val}`;
  if (val.includes(" ")) val = `"${val}"`;
  return `${atom.anchor}:${val}`;
}

export function StructuredSearchBar({
  tokens,
  onTokensChange,
  anchors,
  placeholder,
  suggestionData,
}: StructuredSearchBarProps) {
  const { t } = useTranslation("common");
  const [inputValue, setInputValue] = useState("");
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const [pendingValues, setPendingValues] = useState<Set<string>>(new Set());
  /** When true, next committed atom should be marked negated. */
  const [pendingNot, setPendingNot] = useState(false);
  /**
   * When set, the next committed atom is appended to this OR group.
   * "auto" → fold into / extend the immediately-previous root node.
   * <id>  → extend an existing OR group with this id.
   */
  const [orMode, setOrMode] = useState<null | "auto" | string>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const anchorMap = useMemo(
    () => new Map(anchors.map((a) => [a.key.toLowerCase(), a])),
    [anchors],
  );
  const anchorMapByKey = useMemo(
    () => new Map(anchors.map((a) => [a.key, a])),
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

  const isMultiSelect =
    suggestionContext.mode === "value" &&
    suggestionContext.anchor != null &&
    suggestionContext.anchor.operators.includes("in") &&
    suggestionContext.anchor.suggest != null;

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

    const query = suggestionContext.query.toLowerCase();
    const matchingAnchors = anchors.filter(
      (a) =>
        a.key.toLowerCase().includes(query) ||
        a.label.toLowerCase().includes(query),
    );

    const anchorSuggestions: Suggestion[] = matchingAnchors.map((anchor) => ({ type: "anchor", anchor }));

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

  useEffect(() => {
    setHighlightIndex(-1);
  }, [suggestions.length]);

  const isAnchorValueMode = suggestionContext.mode === "value" && suggestionContext.anchor != null;

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

  // ─── Tree edit helpers ────────────────────────────────────────────

  const appendNode = useCallback(
    (atom: Atom) => {
      const finalAtom: Atom = pendingNot ? { ...atom, negated: true } : atom;
      const next = appendAtom(tokens, finalAtom, orMode, newTokenId);
      onTokensChange(next);
      setPendingNot(false);
      if (orMode) setOrMode(null);
    },
    [tokens, onTokensChange, pendingNot, orMode],
  );

  const commitToken = useCallback(
    (raw: string) => {
      const atom = parseInputToAtom(raw, anchorMap);
      if (atom) appendNode(atom);
      setInputValue("");
      setShowSuggestions(false);
    },
    [anchorMap, appendNode],
  );

  const togglePendingValue = useCallback(
    (key: string) => {
      setPendingValues((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
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

  const removeNode = useCallback(
    (id: string) => {
      onTokensChange(tokens.filter((n) => n.id !== id));
    },
    [tokens, onTokensChange],
  );

  const removeChildFromGroup = useCallback(
    (groupId: string, childId: string) => {
      onTokensChange(removeChildFromGroupOp(tokens, groupId, childId));
    },
    [tokens, onTokensChange],
  );

  const handlePillClick = useCallback(
    (id: string) => {
      const node = tokens.find((n) => n.id === id);
      if (!node || isOrGroup(node)) return;
      const atom = node;

      if (atom.anchor) {
        const anchor = anchorMap.get(atom.anchor.toLowerCase());
        if (anchor?.operators.includes("in") && anchor.suggest) {
          const values = atom.value.split(",").filter(Boolean);
          setPendingValues(new Set(values));
          onTokensChange(tokens.filter((n) => n.id !== id));
          setInputValue(`${atom.anchor}:`);
          setPendingNot(!!atom.negated);
          setShowSuggestions(true);
          setTimeout(() => inputRef.current?.focus(), 0);
          return;
        }
      }

      onTokensChange(tokens.filter((n) => n.id !== id));
      setInputValue(atomToText(atom));
      setPendingNot(!!atom.negated);
      setShowSuggestions(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [tokens, onTokensChange, anchorMap],
  );

  const handleEditChild = useCallback(
    (groupId: string, childId: string) => {
      const group = tokens.find((n) => n.id === groupId);
      if (!group || !isOrGroup(group)) return;
      const child = group.children.find((c) => c.id === childId);
      if (!child) return;

      const next = removeChildFromGroupOp(tokens, groupId, childId);
      onTokensChange(next);
      setInputValue(atomToText(child));
      setPendingNot(!!child.negated);
      // If the group survived (still ≥2 children), re-typing appends to it.
      const survived = next.find((n) => n.id === groupId && isOrGroup(n));
      if (survived) setOrMode(groupId);
      setShowSuggestions(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [tokens, onTokensChange],
  );

  const handleAddBranch = useCallback(
    (groupId: string) => {
      setOrMode(groupId);
      setInputValue("");
      setShowSuggestions(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [],
  );

  const toggleAtomNegation = useCallback(
    (id: string) => {
      onTokensChange(
        tokens.map((n) => {
          if (n.id !== id || isOrGroup(n)) return n;
          return { ...n, negated: !n.negated };
        }),
      );
    },
    [tokens, onTokensChange],
  );

  const toggleGroupNegation = useCallback(
    (id: string) => {
      onTokensChange(
        tokens.map((n) => {
          if (n.id !== id || !isOrGroup(n)) return n;
          return { ...n, negated: !n.negated };
        }),
      );
    },
    [tokens, onTokensChange],
  );

  // ─── Keyboard handling ─────────────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // `|` keystroke: commits the current text and arms OR-mode for the
      // next atom. We suppress this only when the cursor is inside an
      // unclosed quote — that's the one case where `|` is a literal value
      // character (e.g. `name:"a|b"` while still typing the closing quote).
      if (e.key === "|") {
        const quoteCount = (inputValue.match(/"/g) ?? []).length;
        const insideOpenQuote = quoteCount % 2 === 1;
        if (!insideOpenQuote) {
          e.preventDefault();
          if (isMultiSelect && pendingValues.size > 0) {
            commitPendingValues();
          } else if (inputValue.trim()) {
            commitToken(inputValue);
          }
          // Default to "auto" (extend the previous root) unless we're already
          // appending to a specific group.
          setOrMode((prev) => prev ?? "auto");
          return;
        }
      }

      // `!` at position 0 of empty input toggles the NOT-pending chip.
      if (
        e.key === "!" &&
        !inputValue &&
        !isMultiSelect
      ) {
        e.preventDefault();
        setPendingNot((p) => !p);
        return;
      }

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
        e.preventDefault();
        const s = suggestions[highlightIndex];
        if (s.type === "value") togglePendingValue(s.item.key);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (isMultiSelect && pendingValues.size > 0) {
          if (highlightIndex >= 0 && highlightIndex < suggestions.length) {
            const s = suggestions[highlightIndex];
            if (s.type === "value") {
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
          if (suggestionContext.mode === "value") {
            setInputValue("");
          }
          setShowSuggestions(false);
          setHighlightIndex(-1);
          setOrMode(null);
          setPendingNot(false);
        }
      } else if (e.key === "Backspace" && !inputValue) {
        // Clear NOT-pending first if present.
        if (pendingNot) {
          setPendingNot(false);
          return;
        }
        if (orMode) {
          setOrMode(null);
          return;
        }
        if (tokens.length > 0) {
          const last = tokens[tokens.length - 1];
          if (isOrGroup(last)) {
            onTokensChange(popLastEntry(tokens));
          } else {
            handlePillClick(last.id);
          }
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
    [
      inputValue,
      tokens,
      suggestions,
      highlightIndex,
      commitToken,
      handlePillClick,
      isMultiSelect,
      pendingValues,
      togglePendingValue,
      commitPendingValues,
      suggestionContext.anchor,
      suggestionContext.mode,
      anchorMap,
      pendingNot,
      orMode,
      onTokensChange,
    ],
  );

  const handleSuggestionSelect = useCallback(
    (suggestion: Suggestion) => {
      if (suggestion.type === "anchor") {
        setInputValue(`${suggestion.anchor.key}:`);
        setPendingValues(new Set());
        setShowSuggestions(true);
        setHighlightIndex(-1);
        inputRef.current?.focus();
      } else if (isMultiSelect) {
        togglePendingValue(suggestion.item.key);
        inputRef.current?.focus();
      } else {
        const key = suggestion.item.key;
        const colonIdx = inputValue.indexOf(":");
        if (colonIdx > 0) {
          const prefix = inputValue.slice(0, colonIdx + 1);
          commitToken(`${prefix}${key}`);
        } else if (key.includes(":")) {
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

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      const target = e.target as Node;
      if (containerRef.current && !containerRef.current.contains(target)) {
        if (pendingValues.size > 0 && suggestionContext.anchor) {
          const value = [...pendingValues].join(",");
          const raw = `${suggestionContext.anchor.key}:${value}`;
          const atom = parseInputToAtom(raw, anchorMap);
          if (atom) {
            // appendNode would re-trigger via state; simulate inline.
            const finalAtom: Atom = pendingNot ? { ...atom, negated: true } : atom;
            onTokensChange([...tokens, finalAtom]);
          }
          setPendingValues(new Set());
          setInputValue("");
          setPendingNot(false);
        } else if (suggestionContext.mode === "value") {
          setInputValue("");
        }
        setShowSuggestions(false);
        setOrMode(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [pendingValues, suggestionContext.mode, suggestionContext.anchor, anchorMap, tokens, onTokensChange, pendingNot]);

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
    setPendingNot(false);
    setOrMode(null);
    inputRef.current?.focus();
  }, [onTokensChange]);

  const hasContent = tokens.length > 0 || inputValue.length > 0 || pendingNot || orMode !== null;
  const effectivePlaceholder = placeholder ?? t("structuredSearchPlaceholder");

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

        {tokens.map((node) =>
          isOrGroup(node) ? (
            <OrGroupPill
              key={node.id}
              group={node}
              anchorMap={anchorMapByKey as Map<string, AnchorDef>}
              onRemoveGroup={removeNode}
              onRemoveChild={removeChildFromGroup}
              onEditChild={handleEditChild}
              onAddBranch={handleAddBranch}
              onToggleNegation={toggleGroupNegation}
            />
          ) : (
            <FilterPill
              key={node.id}
              token={node}
              anchor={anchorMapByKey.get(node.anchor) as AnchorDef | undefined}
              onRemove={removeNode}
              onClick={handlePillClick}
              onToggleNegation={toggleAtomNegation}
            />
          ),
        )}

        {/* Indicators for in-progress modifiers */}
        {pendingNot && (
          <span
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs font-bold text-rose-700 bg-rose-100 border border-rose-200 select-none"
            title={t("structuredSearchPendingNot")}
            data-testid="pending-not"
          >
            !
          </span>
        )}
        {orMode && (
          <span
            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase text-slate-600 bg-slate-100 border border-slate-200 select-none"
            title={t("structuredSearchOrInProgress")}
            data-testid="or-mode-indicator"
          >
            {t("structuredSearchPillOr")}
          </span>
        )}

        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setShowSuggestions(true)}
          placeholder={tokens.length === 0 ? effectivePlaceholder : ""}
          className="flex-1 min-w-[120px] outline-none bg-transparent text-sm text-slate-900 placeholder:text-slate-400"
          aria-label="Search filter input"
          aria-expanded={(showSuggestions || isAnchorValueMode) && (suggestions.length > 0 || !!dropdownHint)}
          role="combobox"
          aria-autocomplete="list"
        />

        {!hasContent && (
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 px-1.5 py-0.5 text-xs text-slate-400 border border-slate-200 rounded font-mono pointer-events-none">/</kbd>
        )}

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
