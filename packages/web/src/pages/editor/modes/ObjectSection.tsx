/**
 * The object inspector (docs/course-editor.md §7; 08 §4.5, §5.2): a
 * selected course object's kind props and scope, plus the filter region's
 * symbol picker — the document's symbols by their match (or source code),
 * or its colours, and `invert` ("show only these"). Every change is one
 * write (`courseObject.update`) and one undo entry; the page writes.
 */

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { course, mapDocument } from "@oxygen/shared";

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
        <label className="block text-[11px] text-slate-500">{t("propBorder")}
          <select data-testid="editor-prop-border" className={FIELD} value={o.props.border ?? "none"}
            onChange={(e) => p.onProps({ border: e.target.value as "none" | "solid" | "dashed" })}>
            <option value="none">{t("borderNone")}</option>
            <option value="solid">{t("borderSolid")}</option>
            <option value="dashed">{t("borderDashed")}</option>
          </select>
        </label>
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
            <input data-testid="editor-prop-margin" type="number" min={0} step={1} className={FIELD} defaultValue={o.props.marginMm ?? 10}
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
      return <FilterProps props={o.props} document={p.document} onProps={p.onProps} />;
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

function FilterProps({ props, document, onProps }: { props: FilterProps; document: ObjectSectionProps["document"]; onProps: (p: Props) => void }) {
  const { t } = useTranslation("editor");
  const [query, setQuery] = useState("");
  const by: Pick3 = props.symbols === "all" ? "all" : Array.isArray(props.symbols) ? "symbols" : "colours";
  const picked = new Set(Array.isArray(props.symbols) ? props.symbols : typeof props.symbols === "object" ? props.symbols.colours : []);
  const symbols = useMemo(() => (document?.symbols ?? []).map((s, index) => ({
    index,
    code: s.code,
    name: s.name,
    // "through their matches" (08 §5.3): the canonical id an applied match draws, else the source code.
    match: s.match?.canonicalId && s.match.state === "auto" ? s.match.canonicalId : null,
  })).filter((s) => !query || `${s.code} ${s.name} ${s.match ?? ""}`.toLowerCase().includes(query.toLowerCase())), [document, query]);
  const set = (next: Partial<FilterProps>) => onProps({ ...props, ...next });
  const toggle = (i: number) => {
    const next = new Set(picked);
    if (next.has(i)) next.delete(i); else next.add(i);
    const list = [...next].sort((a, b) => a - b);
    set({ symbols: by === "colours" ? { colours: list } : list });
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
      {by === "symbols" && (
        <div>
          <input data-testid="editor-filter-search" className={FIELD} placeholder={t("filterSearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <ul className="mt-1 max-h-40 overflow-y-auto border border-slate-100 rounded-md">
            {symbols.map((s) => (
              <li key={s.index}>
                <label className="flex items-center gap-1.5 px-1.5 py-0.5 hover:bg-slate-50">
                  <input type="checkbox" data-testid={`editor-filter-symbol-${s.code}`} checked={picked.has(s.index)} onChange={() => toggle(s.index)} />
                  <span className="font-mono text-[10px] text-slate-500">{s.match ?? s.code}</span>
                  <span className="truncate">{s.name}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {by === "colours" && (
        <ul className="max-h-40 overflow-y-auto border border-slate-100 rounded-md">
          {(document?.colours ?? []).map((c, index) => (
            <li key={index}>
              <label className="flex items-center gap-1.5 px-1.5 py-0.5 hover:bg-slate-50">
                <input type="checkbox" data-testid={`editor-filter-colour-${index}`} checked={picked.has(index)} onChange={() => toggle(index)} />
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
