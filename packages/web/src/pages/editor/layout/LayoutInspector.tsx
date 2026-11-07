/**
 * Layout mode's inspector sections (docs/course-layout.md §2; 08 §5.2 "in
 * Layout mode the template/sheet properties"): the sheet or template
 * (picker, the template link, print scale, block, page and appearance in
 * template scope), the selection's properties, the scope's objects with
 * the sheet's validation issues (`validate.ts` codes), the graphics
 * library for the image tool.
 */

import { useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { CourseMapObject, MapFillMode, MapTemplateSettings } from "@oxygen/shared";
import { trpc } from "../../../lib/trpc";
import { fillModePatch } from "../../../lib/map-layout-editor";
import { fileToBase64 } from "../../../lib/file-to-base64";
import type { SheetGeometry } from "../../../lib/editor/layout";
import { InspectorSection } from "../Inspector";
import type { LayoutSelection, LayoutTarget, LayoutTool } from "./bindings";
import { FILL_MODES, type EditorSheet, type LayoutSnapshot } from "./model";
import { NumberField, TextField } from "./fields";

type T = ReturnType<typeof useTranslation<"editor">>["t"];

function objectLabel(o: CourseMapObject, t: T): string {
  if (o.kind === "text") return o.text.trim() || t("layoutKind_text");
  if ((o.kind === "rectangle" || o.kind === "path") && o.fillMode !== "none" && o.fillMode !== "solid") return t(`layoutFill_${o.fillMode}`);
  return t(`layoutKind_${o.kind}`);
}

export function LayoutInspector(p: {
  loading: boolean;
  data: EditorSheet | null;
  snap: LayoutSnapshot | null;
  geometry: SheetGeometry | null;
  courseName: string | null;
  sheets: { seq: number; name: string }[];
  selection: LayoutSelection;
  selectedObject: CourseMapObject | null;
  editable: CourseMapObject[];
  lockedCount: number;
  issues: { code: string; message: string; objectId?: string }[];
  coarse: boolean;
  tool: LayoutTool;
  purple: string;
  onOpen: (target: LayoutTarget | null) => void;
  onSelect: (s: LayoutSelection) => void;
  onPatch: (p: Partial<LayoutSnapshot>) => void;
  onObject: (id: string, patch: Partial<CourseMapObject>) => void;
  onDelete: () => void;
  onPlaceImage: (graphicId: number) => void;
  /** No sheet to show: what creates one (`NoSheetActions`). */
  noSheet: ReactNode;
  /** Sheet scope: rename / add / delete (`SheetActions`). */
  sheetActions: ReactNode;
  /** Template scope: new / delete (`TemplateActions`). */
  templateActions: ReactNode;
  canEdit: boolean;
}) {
  const { t } = useTranslation("editor");
  const { data, snap } = p;
  if (!data || !snap) {
    return (
      <InspectorSection title={t("layoutSheet")} testId="editor-layout-sheet">
        {p.loading ? (
          <p data-testid="editor-layout-loading" className="px-2.5 pb-2 text-[11px] text-slate-500">{t("layoutLoading")}</p>
        ) : (
          <div data-testid="editor-layout-no-sheet" className="px-2.5 pb-2">{p.noSheet}</div>
        )}
      </InspectorSection>
    );
  }
  const template = data.scope === "template";
  const settings = snap.settings;
  const patchSettings = (s: Partial<MapTemplateSettings>) => p.onPatch({ settings: { ...settings, ...s } });
  const o = p.selectedObject;
  return (
    <>
      <InspectorSection title={template ? t("layoutTemplate") : t("layoutSheet")} testId="editor-layout-sheet"
        aside={template ? data.template.name : data.sheet?.name}>
        <div className="px-2.5 pb-2 space-y-1.5" data-testid="editor-layout-scope" data-scope={data.scope} data-sheet={data.sheet?.seq ?? ""} data-template={data.template.seq}>
          {!template && p.sheets.length > 1 && (
            <select data-testid="editor-layout-sheet-picker" value={data.sheet?.seq} onChange={(e) => p.onOpen({ sheet: Number(e.target.value) })}
              className="w-full px-1.5 py-1 border border-slate-200 rounded-md bg-white text-xs">
              {p.sheets.map((s) => <option key={s.seq} value={s.seq}>{s.name}</option>)}
            </select>
          )}
          {template ? (
            <>
              {p.coarse && <p data-testid="editor-layout-desktop-note" className="text-[11px] text-amber-700">{t("layoutDesktopOnly")}</p>}
              <p className="text-[11px] text-slate-500">{p.courseName ? t("layoutPreviewWith", { course: p.courseName }) : t("layoutPreviewNone")}</p>
              {p.canEdit && (
                <TextField label={t("layoutTemplateName")} value={snap.templateName} testId="editor-layout-template-name"
                  onCommit={(v) => { const name = v.trim(); if (name && name !== snap.templateName) p.onPatch({ templateName: name }); }} />
              )}
              {data.sheet === null && (
                <button type="button" data-testid="editor-layout-back-to-sheet" onClick={() => p.onOpen(null)} className="text-[11px] text-purple-700 hover:underline cursor-pointer">
                  {t("layoutBackToSheet")}
                </button>
              )}
              <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                <span>{t("layoutPaper")}</span>
                <select data-testid="editor-layout-paper-size" value={snap.paper} onChange={(e) => p.onPatch({ paper: e.target.value })}
                  className="w-20 px-1 py-0.5 border border-slate-200 rounded bg-white text-xs">
                  {["A3", "A4", "A5"].map((v) => <option key={v} value={v}>{v}</option>)}
                  {snap.paper === "custom" && <option value="custom">{t("layoutPaperCustom")}</option>}
                </select>
              </label>
              <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                <span>{t("layoutOrientation")}</span>
                <select data-testid="editor-layout-orientation" value={snap.orientation} onChange={(e) => p.onPatch({ orientation: e.target.value })}
                  className="w-24 px-1 py-0.5 border border-slate-200 rounded bg-white text-xs">
                  <option value="portrait">{t("layoutPortrait")}</option>
                  <option value="landscape">{t("layoutLandscape")}</option>
                </select>
              </label>
              {p.templateActions}
            </>
          ) : (
            <>
              <button type="button" data-testid="editor-layout-edit-template" onClick={() => p.onOpen({ template: data.template.seq })}
                className="text-[11px] text-purple-700 hover:underline cursor-pointer">
                {t("layoutEditTemplate", { name: data.template.name })}
              </button>
              {p.lockedCount > 0 && <p data-testid="editor-layout-locked" className="text-[11px] text-slate-500">{t("layoutTemplateLocked", { count: p.lockedCount })}</p>}
              {p.sheetActions}
            </>
          )}
          <NumberField label={t("layoutPrintScale")} value={snap.printScale} min={500} max={100_000} step={500} testId="editor-layout-print-scale"
            onCommit={(v) => p.onPatch({ printScale: Math.round(v) })} />
          {template && (
            <NumberField label={t("layoutMargin")} value={settings.printMarginMm} min={0} max={50} step={0.5} testId="editor-layout-margin"
              onCommit={(v) => {
                // The frame keeps its distance to the margin, as the template table does.
                const d = v - settings.printMarginMm, f = settings.mapFrame;
                patchSettings({ printMarginMm: v, mapFrame: { x: f.x + d, y: f.y + d, width: Math.max(10, f.width - 2 * d), height: Math.max(10, f.height - 2 * d) } });
              }} />
          )}
          <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <input type="checkbox" data-testid="editor-layout-description-visible" checked={snap.description.visible}
              onChange={(e) => p.onPatch({ description: { ...snap.description, visible: e.target.checked } })} />
            {t("layoutDescriptionVisible")}
          </label>
          <NumberField label={t("layoutCellSize")} value={snap.description.cellSizeMm} min={3} max={15} step={0.5} testId="editor-layout-cell-size"
            onCommit={(v) => p.onPatch({ description: { ...snap.description, cellSizeMm: v } })} />
          {template && (
            <div className="pt-1 space-y-1 border-t border-slate-100">
              <p className="text-[11px] font-medium text-slate-600">{t("layoutAppearance")}</p>
              <NumberField label={t("layoutCircle")} value={settings.appearance.circleRadiusMm} min={0.5} max={20} step={0.1} testId="editor-layout-circle"
                onCommit={(v) => patchSettings({ appearance: { ...settings.appearance, circleRadiusMm: v } })} />
              <NumberField label={t("layoutLineWidth")} value={settings.appearance.lineWidthMm} min={0.05} max={10} step={0.05} testId="editor-layout-line"
                onCommit={(v) => patchSettings({ appearance: { ...settings.appearance, lineWidthMm: v } })} />
              <NumberField label={t("layoutNumber")} value={settings.appearance.numberHeightMm} min={0.5} max={30} step={0.1} testId="editor-layout-number"
                onCommit={(v) => patchSettings({ appearance: { ...settings.appearance, numberHeightMm: v } })} />
              <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                <span>{t("layoutPurple")}</span>
                <input type="color" data-testid="editor-layout-purple" value={settings.appearance.purple}
                  onChange={(e) => patchSettings({ appearance: { ...settings.appearance, purple: e.target.value } })} />
              </label>
            </div>
          )}
        </div>
      </InspectorSection>
      <InspectorSection title={t("selection")} testId="editor-layout-selection-panel">
        <div className="px-2.5 pb-2 space-y-1.5" data-testid="editor-layout-selected" data-kind={p.selection?.kind ?? ""} data-object-id={o?.id ?? ""}>
          {p.selection?.kind === "frame" && (
            <p className="text-[11px] text-slate-500">{template ? t("layoutFrameTemplate") : t("layoutFrameHint")}</p>
          )}
          {p.selection?.kind === "description" && <p className="text-[11px] text-slate-500">{t("layoutDescription")}</p>}
          {!p.selection && <p className="text-[11px] text-slate-400">{t("nothingSelected")}</p>}
          {o && <ObjectProperties o={o} t={t} purple={p.purple} onPatch={(patch) => p.onObject(o.id, patch)} />}
          {(o || p.selection?.kind === "description") && (
            <button type="button" data-testid="editor-layout-delete" onClick={p.onDelete} className="text-[11px] text-red-600 hover:underline cursor-pointer">
              {o ? t("layoutDelete") : t("layoutHideDescription")}
            </button>
          )}
        </div>
      </InspectorSection>
      <InspectorSection title={t("layoutObjects")} testId="editor-layout-objects" aside={String(p.editable.length)}>
        <ul className="px-2.5 pb-2 space-y-0.5">
          {p.editable.length === 0 && <li className="text-[11px] text-slate-400">{t("layoutNoObjects")}</li>}
          {p.editable.map((obj) => (
            <li key={obj.id}>
              <button type="button" data-testid="editor-layout-object-row" data-object-id={obj.id} data-kind={obj.kind} data-anchor={obj.anchor}
                data-geometry={JSON.stringify(obj)}
                onClick={() => p.onSelect({ kind: "object", id: obj.id })}
                className={`w-full text-left truncate text-[11px] px-1 py-0.5 rounded cursor-pointer ${p.selection?.kind === "object" && p.selection.id === obj.id ? "bg-purple-50 text-purple-700" : "text-slate-600 hover:bg-slate-50"}`}>
                {objectLabel(obj, t)}
              </button>
            </li>
          ))}
        </ul>
        <ul className="px-2.5 pb-2 space-y-0.5" data-testid="editor-layout-issues">
          {p.issues.map((i, n) => (
            <li key={`${i.code}-${n}`} data-testid="editor-layout-issue" data-code={i.code} className="text-[11px] text-amber-700">{t(`layoutIssue_${i.code}` as "layoutIssue_object_outside_page")}</li>
          ))}
        </ul>
      </InspectorSection>
      <GraphicsSection t={t} active={p.tool.kind === "place" && p.tool.what === "image" ? p.tool.graphicId ?? null : null} onPlace={p.onPlaceImage} />
      <span hidden data-testid="editor-layout-state" data-centre={`${snap.centre.x},${snap.centre.y}`} data-print-scale={snap.printScale}
        data-description={JSON.stringify(snap.description)} />
    </>
  );
}

function ObjectProperties({ o, t, purple, onPatch }: { o: CourseMapObject; t: T; purple: string; onPatch: (p: Partial<CourseMapObject>) => void }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium text-slate-600">{t(`layoutKind_${o.kind}`)}</p>
      {o.kind === "text" && (
        <>
          <TextField label={t("layoutText")} value={o.text} testId="editor-layout-text" onCommit={(text) => onPatch({ text })} />
          <NumberField label={t("layoutFontSize")} value={o.fontSizeMm} min={1} max={100} step={0.5} testId="editor-layout-font-size" onCommit={(fontSizeMm) => onPatch({ fontSizeMm })} />
          <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>{t("layoutAlign")}</span>
            <select data-testid="editor-layout-align" value={o.align ?? "left"} onChange={(e) => onPatch({ align: e.target.value as "left" })}
              className="w-24 px-1 py-0.5 border border-slate-200 rounded bg-white text-xs">
              {(["left", "center", "right"] as const).map((v) => <option key={v} value={v}>{t(`layoutAlign_${v}`)}</option>)}
            </select>
          </label>
          <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>{t("layoutColour")}</span>
            <input type="color" data-testid="editor-layout-colour" value={o.color} onChange={(e) => onPatch({ color: e.target.value })} />
          </label>
        </>
      )}
      {(o.kind === "rectangle" || o.kind === "path") && (
        <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>{t("layoutFill")}</span>
          <select data-testid="editor-layout-fill" value={o.fillMode} onChange={(e) => onPatch(fillModePatch(o, e.target.value as MapFillMode, purple) as Partial<CourseMapObject>)}
            className="w-32 px-1 py-0.5 border border-slate-200 rounded bg-white text-xs">
            {FILL_MODES.map((m) => <option key={m} value={m}>{t(`layoutFill_${m}`)}</option>)}
          </select>
        </label>
      )}
      {(o.kind === "line" || o.kind === "rectangle" || o.kind === "path") && (
        <>
          <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
            <span>{t("layoutStroke")}</span>
            <input type="color" data-testid="editor-layout-stroke" value={o.stroke ?? "#000000"} onChange={(e) => onPatch({ stroke: e.target.value })} />
          </label>
          <NumberField label={t("layoutStrokeWidth")} value={o.strokeWidthMm ?? 0.35} min={0.05} max={10} step={0.05} testId="editor-layout-stroke-width"
            onCommit={(strokeWidthMm) => onPatch({ strokeWidthMm })} />
        </>
      )}
      <p className="text-[11px] text-slate-400" data-testid="editor-layout-anchor" data-anchor={o.anchor}>{t(`layoutAnchor_${o.anchor}`)}</p>
    </div>
  );
}

function GraphicsSection({ t, active, onPlace }: { t: T; active: number | null; onPlace: (id: number) => void }) {
  const utils = trpc.useUtils();
  const graphics = trpc.graphics.list.useQuery();
  const upload = trpc.graphics.upload.useMutation({ onSuccess: () => void utils.graphics.list.invalidate() });
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <InspectorSection title={t("layoutGraphics")} testId="editor-layout-graphics" defaultOpen={false}>
      <div className="px-2.5 pb-2 space-y-1">
        {(graphics.data ?? []).length === 0 && <p className="text-[11px] text-slate-400">{t("layoutNoGraphics")}</p>}
        {(graphics.data ?? []).map((g) => (
          <div key={g.id} className="flex items-center gap-1.5 text-[11px] text-slate-600">
            <span className="truncate flex-1">{g.name}</span>
            <button type="button" data-testid={`editor-layout-graphic-place-${g.id}`} aria-pressed={active === g.id} onClick={() => onPlace(g.id)}
              className={`px-1.5 py-0.5 rounded border cursor-pointer ${active === g.id ? "border-purple-300 bg-purple-50 text-purple-700" : "border-slate-200 hover:bg-slate-50"}`}>
              {t("layoutPlace")}
            </button>
          </div>
        ))}
        <input ref={input} type="file" accept=".svg,.png,image/svg+xml,image/png" className="hidden" data-testid="editor-layout-graphic-upload"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            void fileToBase64(file).then((fileDataBase64) => upload.mutateAsync({ name: file.name, scope: "event", fileDataBase64 }));
          }} />
        <button type="button" onClick={() => input.current?.click()} disabled={upload.isPending}
          className="text-[11px] text-purple-700 hover:underline cursor-pointer disabled:opacity-50">{t("layoutUpload")}</button>
      </div>
    </InspectorSection>
  );
}

