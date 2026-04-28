import { useTranslation } from "react-i18next";
import type { AnchorDef, OrGroup } from "../../lib/structured-search/types";
import { FilterPill } from "./FilterPill";

interface OrGroupPillProps {
  group: OrGroup;
  anchorMap: Map<string, AnchorDef>;
  /** Remove the entire group from the root expression. */
  onRemoveGroup: (id: string) => void;
  /** Remove a single child atom from the group. */
  onRemoveChild: (groupId: string, childId: string) => void;
  /** Begin editing a child atom (extracts it back to the input). */
  onEditChild: (groupId: string, childId: string) => void;
  /** Add a new OR-branch — focuses the input primed for a new atom. */
  onAddBranch: (groupId: string) => void;
  /** Toggle the negation of the entire group. */
  onToggleNegation?: (id: string) => void;
}

export function OrGroupPill({
  group,
  anchorMap,
  onRemoveGroup,
  onRemoveChild,
  onEditChild,
  onAddBranch,
  onToggleNegation,
}: OrGroupPillProps) {
  const { t } = useTranslation("common");
  const negated = !!group.negated;
  const wrapperBase =
    "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg border-2 border-dashed bg-slate-50/70";
  const wrapperColor = negated
    ? "border-rose-300 ring-1 ring-rose-200"
    : "border-slate-300";

  return (
    <span
      className={`${wrapperBase} ${wrapperColor}`}
      data-testid="or-group-pill"
      title={
        negated
          ? t("structuredSearchOrGroupNegatedTitle")
          : t("structuredSearchOrGroupTitle")
      }
    >
      {negated && (
        <button
          type="button"
          className="shrink-0 px-1 rounded text-rose-700 bg-rose-100 hover:bg-rose-200 text-xs font-bold"
          onClick={(e) => {
            e.stopPropagation();
            onToggleNegation?.(group.id);
          }}
          aria-label="Toggle negation"
          title="Click to remove NOT"
        >
          !
        </button>
      )}

      {group.children.map((child, idx) => (
        <span key={child.id} className="inline-flex items-center gap-1">
          {idx > 0 && (
            <span
              className="text-[10px] font-bold uppercase text-slate-400 select-none px-0.5"
              aria-hidden="true"
            >
              {t("structuredSearchPillOr")}
            </span>
          )}
          <FilterPill
            token={child}
            anchor={anchorMap.get(child.anchor)}
            onRemove={(id) => onRemoveChild(group.id, id)}
            onClick={(id) => onEditChild(group.id, id)}
          />
        </span>
      ))}

      {/* Trailing affordance: add another OR-branch */}
      <button
        type="button"
        className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-slate-500 hover:text-slate-700 hover:bg-slate-200 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          onAddBranch(group.id);
        }}
        aria-label={t("structuredSearchAddOrBranch")}
        title={t("structuredSearchAddOrBranch")}
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      </button>

      {/* Remove the whole group */}
      <button
        type="button"
        className="shrink-0 ml-0.5 rounded-full p-0.5 text-slate-400 hover:text-slate-700 hover:bg-slate-200 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          onRemoveGroup(group.id);
        }}
        aria-label="Remove group"
      >
        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </span>
  );
}
