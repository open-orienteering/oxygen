/**
 * The object inspector (docs/course-editor.md §7; 08 §4.5, §5.2): a
 * selected course object's kind props and scope, plus the filter region's
 * symbol picker — the document's symbols grouped by heading
 * (`symbol-groups.ts`), or its colours, the eyedropper, and `invert`
 * ("show only these"). Every change is one write (`courseObject.update`)
 * and one undo entry; the page writes.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { vertexRule } from "../../../lib/editor/geometry-edit";
import { TONER_MARGIN_MM } from "../tools/toner-saver";
import { render, type course, type mapDocument } from "@oxygen/shared";
import { filterGroups, groupState, toggleGroup, type SymbolGroup } from "../../../lib/editor/symbol-groups";

type Obj = course.CourseObject;
type Props = Obj["props"];
type FilterProps = Extract<Obj, { kind: "filter_region" }>["props"];

export interface ObjectSectionProps {
  object: Obj;
  /** The document's symbols and colours (filter regions); null until the document is loaded. */
  document: Pick<mapDocument.MapDocumentHeader, "symbols" | "colours"> | null;
  courses: { id: number; name: string }[];
  classes: { id: number; name: string }[];
  onProps: (props: Props) => void;
  onScope: (scope: Obj["scope"]) => void;
  onRegenerate?: () => void;
  onDelete: () => void;
  /** A filter region's grouped symbol list and eyedropper (§6.4, §7); absent until the document is loaded. */
  filter?: {
    groups: SymbolGroup[];
    swatchUrl: (g: SymbolGroup) => string | null;
    /** The eyedropper is armed. */
    picking: boolean;
    onPickToggle: () => void;
    /** What the last pick did: added `label`, found it already in the region, or nothing under the click. */
    note: { kind: "added" | "already"; label: string } | { kind: "miss" } | null;
  };
}

const FIELD = "w-full px-1.5 py-1 border border-slate-200 rounded-md bg-white text-xs";

export function ObjectSection(props: ObjectSectionProps) {
  const { t } = useTranslation("editor");
  // Optimistic: the inspector shows an edit at once; the stored object (its token) takes over when it arrives.
  const [pending, setPending] = useState<{ version: string; props?: Props; scope?: Obj["scope"] } | null>(null);
  const live = pending && pending.version === props.object.version ? pending : null;
  const o = { ...props.object, ...(live?.props ? { props: live.props } : {}), ...(live?.scope ? { scope: live.scope } : {}) } as Obj;
  const p: ObjectSectionProps = {
    ...props,
    object: o,
    onProps: (next) => { setPending({ version: props.object.version, scope: live?.scope, props: next }); props.onProps(next); },
    onScope: (next) => { setPending({ version: props.object.version, props: live?.props, scope: next }); props.onScope(next); },
  };
  return (
    <div data-testid="editor-object" data-object-id={o.id} data-object-kind={o.kind} className="px-2.5 py-1.5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-slate-700">{t(`kind_${o.kind}` as "kind_oob_area")}</span>
        <button type="button" data-testid="editor-object-delete" onClick={p.onDelete}
          className="ml-auto px-2 py-0.5 rounded-md border border-red-200 text-red-600 hover:bg-red-50 cursor-pointer">
          {t("delete")}
        </button>
      </div>
      <KindProps {...p} />
      {vertexRule(o.kind).curves && <p data-testid="editor-geometry-hint" className="text-[10px] text-slate-400">{t("geometryHint")}</p>}
      <ScopeEditor scope={o.scope} courses={p.courses} classes={p.classes} onScope={p.onScope} />
    </div>
  );
}

function KindProps(p: ObjectSectionProps) {
  const { t } = useTranslation("editor");
  const o = p.object;
  switch (o.kind) {
    case "oob_area":
      return (
        <div className="space-y-1">
          <label className="block text-[11px] text-slate-500">{t("propHatch")}
            <select data-testid="editor-prop-hatch" className={FIELD} value={o.props.hatch ?? "709"}
              onChange={(e) => p.onProps({ ...o.props, hatch: e.target.value as "709" | "710" })}>
              <option value="709">{t("hatch709")}</option>
              <option value="710">{t("hatch710")}</option>
            </select>
          </label>
          <label className="block text-[11px] text-slate-500">{t("propBorder")}
            <select data-testid="editor-prop-border" className={FIELD} value={o.props.border ?? "none"}
              onChange={(e) => p.onProps({ ...o.props, border: e.target.value as "none" | "solid" | "dashed" })}>
              <option value="none">{t("borderNone")}</option>
              <option value="solid">{t("borderSolid")}</option>
              <option value="dashed">{t("borderDashed")}</option>
            </select>
          </label>
        </div>
      );
    case "oob_line":
      return (
        <label className="block text-[11px] text-slate-500">{t("propSymbol")}
          <select data-testid="editor-prop-symbol" className={FIELD} value={o.props.symbol ?? "708"}
            onChange={(e) => p.onProps({ symbol: e.target.value as "708" | "711" })}>
            <option value="708">{t("symbol708")}</option>
            <option value="711">{t("symbol711")}</option>
          </select>
        </label>
      );
    case "text":
      return <TextProps props={o.props} onProps={p.onProps} />;
    case "toner_saver":
      return (
        <div className="space-y-1">
          <label className="block text-[11px] text-slate-500">{t("propMargin")}
            <input data-testid="editor-prop-margin" type="number" min={0} step={1} className={FIELD} defaultValue={o.props.marginMm ?? TONER_MARGIN_MM}
              onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0 && v !== o.props.marginMm) p.onProps({ ...o.props, marginMm: v }); }} />
          </label>
          {p.onRegenerate && (
            <button type="button" data-testid="editor-toner-regenerate" onClick={p.onRegenerate}
              className="w-full px-2 py-1 rounded-md border border-purple-200 text-purple-700 hover:bg-purple-50 cursor-pointer">
              {t("regenerateHull")}
            </button>
          )}
        </div>
      );
    case "filter_region":
      return <FilterProps props={o.props} document={p.document} filter={p.filter} onProps={p.onProps} />;
    default:
      return null;
  }
}

function TextProps({ props, onProps }: { props: Extract<Obj, { kind: "text" }>["props"]; onProps: (p: Props) => void }) {
  const { t } = useTranslation("editor");
  return (
    <div className="space-y-1">
      <label className="block text-[11px] text-slate-500">{t("propText")}
        <input data-testid="editor-prop-text" className={FIELD} defaultValue={props.text} key={props.text}
          onBlur={(e) => { if (e.target.value !== props.text) onProps({ ...props, text: e.target.value }); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      </label>
      <label className="block text-[11px] text-slate-500">{t("propFontSize")}
        <input data-testid="editor-prop-font-size" type="number" min={0.5} max={100} step={0.5} className={FIELD} defaultValue={props.fontSizeMm} key={props.fontSizeMm}
          onBlur={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v > 0 && v <= 100 && v !== props.fontSizeMm) onProps({ ...props, fontSizeMm: v }); }} />
      </label>
    </div>
  );
}

type Pick3 = "all" | "symbols" | "colours";

/** A ref callback setting a checkbox's `indeterminate` (React has no prop for it). */
const indeterminate = (on: boolean) => (el: HTMLInputElement | null) => { if (el) el.indeterminate = on; };

function FilterProps({ props, document, filter, onProps }: { props: FilterProps; document: ObjectSectionProps["document"]; filter: ObjectSectionProps["filter"]; onProps: (p: Props) => void }) {
  const { t } = useTranslation("editor");
  const [query, setQuery] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const by: Pick3 = props.symbols === "all" ? "all" : Array.isArray(props.symbols) ? "symbols" : "colours";
  const pickedList = Array.isArray(props.symbols) ? props.symbols : typeof props.symbols === "object" ? props.symbols.colours : [];
  const picked = new Set(pickedList);
  // One entry per heading (§7 "filter region"): variants and duplicates merged, hidden / unused symbols left out.
  const shown = useMemo(() => filterGroups(filter?.groups ?? [], query), [filter?.groups, query]);
  const main = shown.filter((g) => !g.other);
  const other = shown.filter((g) => g.other);
  const set = (next: Partial<FilterProps>) => onProps({ ...props, ...next });
  const toggleColour = (i: number) => {
    const next = new Set(picked);
    if (next.has(i)) next.delete(i); else next.add(i);
    set({ symbols: { colours: [...next].sort((a, b) => a - b) } });
  };
  const row = (g: SymbolGroup) => {
    const state = groupState(g, picked);
    const src = filter?.swatchUrl(g) ?? null;
    return (
      <li key={g.code}>
        <label className="flex items-center gap-1.5 px-1.5 py-0.5 hover:bg-slate-50" title={g.members.map((i) => document?.symbols[i]?.code).join(", ")}>
          <input type="checkbox" data-testid={`editor-filter-symbol-${g.code}`} data-members={g.members.join(",")} checked={state === "all"}
            ref={indeterminate(state === "some")} onChange={() => set({ symbols: toggleGroup(pickedList, g) })} />
          {src
            ? <img data-testid="editor-filter-swatch" src={src} alt="" loading="lazy" className="w-5 h-5 shrink-0 object-contain" />
            : <span className="w-5 h-5 shrink-0" />}
          <span className="font-mono text-[10px] text-slate-500">{g.code}</span>
          <span className="truncate">{g.name}</span>
        </label>
      </li>
    );
  };
  return (
    <div className="space-y-1.5">
      <label className="block text-[11px] text-slate-500">{t("propMode")}
        <select data-testid="editor-filter-mode" className={FIELD} value={props.mode} onChange={(e) => set({ mode: e.target.value as "clip" | "hide" })}>
          <option value="hide">{t("filterHide")}</option>
          <option value="clip">{t("filterClip")}</option>
        </select>
      </label>
      <label className="block text-[11px] text-slate-500">{t("filterBy")}
        <select data-testid="editor-filter-by" className={FIELD} value={by}
          onChange={(e) => set({ symbols: e.target.value === "all" ? "all" : e.target.value === "colours" ? { colours: [] } : [] })}>
          <option value="all">{t("filterAll")}</option>
          <option value="symbols">{t("filterSymbols")}</option>
          <option value="colours">{t("filterColours")}</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
        <input data-testid="editor-filter-invert" type="checkbox" checked={!!props.invert} onChange={(e) => set({ invert: e.target.checked || undefined })} />
        {t("filterInvert")}
      </label>
      {filter && (
        <div>
          <button type="button" data-testid="editor-filter-pick" aria-pressed={filter.picking} onClick={filter.onPickToggle}
            className={`w-full px-2 py-1 rounded-md border cursor-pointer ${filter.picking ? "border-purple-400 bg-purple-50 text-purple-800" : "border-slate-200 text-slate-700 hover:bg-slate-50"}`}>
            {t("filterPick")}
          </button>
          {filter.picking && <p data-testid="editor-filter-pick-hint" className="mt-0.5 text-[10px] text-slate-500">{t("filterPickHint")}</p>}
          {filter.note && <p data-testid="editor-filter-pick-note" data-kind={filter.note.kind} className={`mt-0.5 text-[10px] ${filter.note.kind === "miss" ? "text-amber-700" : "text-slate-600"}`}>
            {filter.note.kind === "miss" ? t("filterPickMiss") : t(filter.note.kind === "added" ? "filterPickAdded" : "filterPickAlready", { label: filter.note.label })}
          </p>}
        </div>
      )}
      {by === "symbols" && (
        <div>
          <input data-testid="editor-filter-search" className={FIELD} placeholder={t("filterSearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul data-testid="editor-filter-symbols" className="mt-1 max-h-48 overflow-y-auto border border-slate-100 rounded-md">
            {main.map(row)}
            {other.length > 0 && (
              <li>
                <button type="button" data-testid="editor-filter-other" aria-expanded={otherOpen || !!query} onClick={() => setOtherOpen((v) => !v)}
                  className="w-full text-left px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-50 cursor-pointer">
                  {otherOpen || query ? "▾" : "▸"} {t("filterOther", { count: other.length })}
                </button>
                {(otherOpen || !!query) && <ul>{other.map(row)}</ul>}
              </li>
            )}
            {shown.length === 0 && <li className="px-1.5 py-0.5 text-[10px] text-slate-400">{t("filterNoMatch")}</li>}
          </ul>
        </div>
      )}
      {by === "colours" && (
        <ul className="max-h-40 overflow-y-auto border border-slate-100 rounded-md">
          {(document?.colours ?? []).map((c, index) => (
            <li key={index}>
              <label className="flex items-center gap-1.5 px-1.5 py-0.5 hover:bg-slate-50">
                <input type="checkbox" data-testid={`editor-filter-colour-${index}`} checked={picked.has(index)} onChange={() => toggleColour(index)} />
                <span className="w-3 h-3 shrink-0 rounded-sm border border-slate-300" style={{ background: render.cmykToHex(c.cmyk) }} />
                <span className="truncate">{c.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ScopeEditor({ scope, courses, classes, onScope }: {
  scope: Obj["scope"]; courses: ObjectSectionProps["courses"]; classes: ObjectSectionProps["classes"]; onScope: (s: Obj["scope"]) => void;
}) {
  const { t } = useTranslation("editor");
  const all = "all" in scope;
  const named = all ? { courses: [], classes: [] } : scope;
  const toggle = (key: "courses" | "classes", id: number) => {
    const list = named[key].includes(id) ? named[key].filter((x) => x !== id) : [...named[key], id];
    onScope({ ...named, [key]: list });
  };
  return (
    <fieldset data-testid="editor-scope" className="space-y-1">
      <legend className="text-[11px] text-slate-500">{t("scope")}</legend>
      <label className="flex items-center gap-1.5 text-slate-600">
        <input type="checkbox" data-testid="editor-scope-all" checked={all}
          onChange={(e) => onScope(e.target.checked ? { all: true } : { courses: [], classes: [] })} />
        {t("scopeAll")}
      </label>
      {!all && (
        <div className="max-h-32 overflow-y-auto border border-slate-100 rounded-md px-1.5 py-0.5">
          {courses.map((c) => (
            <label key={`c${c.id}`} className="flex items-center gap-1.5">
              <input type="checkbox" data-testid={`editor-scope-course-${c.id}`} checked={named.courses.includes(c.id)} onChange={() => toggle("courses", c.id)} />
              {c.name}
            </label>
          ))}
          {classes.length > 0 && <div className="text-[10px] text-slate-400 mt-1">{t("scopeClasses")}</div>}
          {classes.map((c) => (
            <label key={`k${c.id}`} className="flex items-center gap-1.5">
              <input type="checkbox" data-testid={`editor-scope-class-${c.id}`} checked={named.classes.includes(c.id)} onChange={() => toggle("classes", c.id)} />
              {c.name}
            </label>
          ))}
          {named.courses.length === 0 && named.classes.length === 0 && <p className="text-[10px] text-amber-700">{t("scopeParked")}</p>}
        </div>
      )}
    </fieldset>
  );
}
