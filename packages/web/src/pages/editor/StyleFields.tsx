/**
 * Style fields (J7; docs/course-editor.md §7 "Inspector"): opacity, blend,
 * rotation, flips, size with the aspect lock, and crop, for the object
 * kinds that have them (`show`). Each commit is one change (`onChange`,
 * the next props; size and crop also give the geometry), so one write and
 * one undo entry. The writes' rules are `lib/editor/style-fields.ts`.
 * `testIdPrefix` lets Layout mode (J8) reuse it under its own ids.
 */

import { useTranslation } from "react-i18next";
import { NumberField } from "./layout/fields";
import { cropChange, FULL_CROP, sizeChange, stylePatch, type StyleValue } from "../../lib/editor/style-fields";
import { imageBox } from "../../lib/editor/image-box";

type Pt = { x: number; y: number };

export interface StyleFieldsProps<P extends StyleValue> {
  props: P;
  /** The box (image): size and crop edit it. */
  geometry?: readonly Pt[];
  /** `lock`: the aspect-lock checkbox with the size fields (default shown; Layout's rectangle has none, J8). */
  show: { blend?: boolean; rotation?: boolean; flip?: boolean; size?: boolean; crop?: boolean; lock?: boolean };
  aspectLock: boolean;
  onAspectLock: () => void;
  /** One write: the next props (style), the next geometry (size), or both (crop). */
  onChange: (next: { props?: P; geometry?: [Pt, Pt] }) => void;
  testIdPrefix?: string;
}

const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

export function StyleFields<P extends StyleValue>(p: StyleFieldsProps<P>) {
  const { t } = useTranslation("editor");
  const id = (s: string) => `${p.testIdPrefix ?? "editor-style"}-${s}`;
  const v = p.props;
  const set = (patch: Parameters<typeof stylePatch>[1]) => p.onChange({ props: stylePatch(v, patch) });
  const box = p.geometry ? imageBox(p.geometry) : null;
  const crop = v.crop ?? FULL_CROP;
  const setCrop = (next: typeof FULL_CROP) => {
    if (!p.geometry) return;
    const r = cropChange(p.geometry, v, v.crop, next);
    p.onChange({ props: stylePatch(v, { crop: r.crop }), geometry: r.geometry });
  };
  const pct = (f: number) => Math.round(f * 100);
  return (
    <div data-testid={id("fields")} className="space-y-1">
      <NumberField label={t("styleOpacity")} value={pct(v.opacity ?? 1)} min={0} max={100} testId={id("opacity")} onCommit={(n) => set({ opacityPct: n })} />
      {p.show.blend && (
        <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
          <span>{t("styleBlend")}</span>
          <select data-testid={id("blend")} value={v.blend ?? "normal"} onChange={(e) => set({ blend: e.target.value as "normal" | "multiply" })}
            className="w-24 px-1 py-0.5 border border-slate-200 rounded text-xs text-slate-700 bg-white">
            <option value="normal">{t("blendNormal")}</option>
            <option value="multiply">{t("blendMultiply")}</option>
          </select>
        </label>
      )}
      {p.show.rotation && (
        <NumberField label={t("styleRotation")} value={round(v.rotationDeg ?? 0, 1)} min={-360} max={360} step={1} testId={id("rotation")} onCommit={(n) => set({ rotationDeg: n })} />
      )}
      {p.show.flip && (
        <div className="flex gap-3 text-[11px] text-slate-600">
          <label className="flex items-center gap-1"><input type="checkbox" data-testid={id("flip-h")} checked={!!v.flipH} onChange={(e) => set({ flipH: e.target.checked })} />{t("styleFlipH")}</label>
          <label className="flex items-center gap-1"><input type="checkbox" data-testid={id("flip-v")} checked={!!v.flipV} onChange={(e) => set({ flipV: e.target.checked })} />{t("styleFlipV")}</label>
        </div>
      )}
      {p.show.size && box && p.geometry && (
        <>
          <NumberField label={t("styleWidth")} value={round(box.w)} min={1} max={1000} step={0.5} testId={id("width")}
            onCommit={(n) => p.onChange({ geometry: sizeChange(p.geometry!, "width", n, p.aspectLock) })} />
          <NumberField label={t("styleHeight")} value={round(box.h)} min={1} max={1000} step={0.5} testId={id("height")}
            onCommit={(n) => p.onChange({ geometry: sizeChange(p.geometry!, "height", n, p.aspectLock) })} />
          {(p.show.lock ?? true) && (
            <label className="flex items-center gap-1 text-[11px] text-slate-600">
              <input type="checkbox" data-testid={id("lock")} checked={p.aspectLock} onChange={p.onAspectLock} />{t("styleAspectLock")}
            </label>
          )}
        </>
      )}
      {p.show.crop && p.geometry && (
        <fieldset className="space-y-1">
          <legend className="text-[11px] text-slate-500">{t("styleCrop")}</legend>
          <NumberField label={t("styleCropX")} value={pct(crop.x)} min={0} max={99} testId={id("crop-x")} onCommit={(n) => setCrop({ ...crop, x: n / 100 })} />
          <NumberField label={t("styleCropY")} value={pct(crop.y)} min={0} max={99} testId={id("crop-y")} onCommit={(n) => setCrop({ ...crop, y: n / 100 })} />
          <NumberField label={t("styleCropW")} value={pct(crop.width)} min={1} max={100} testId={id("crop-w")} onCommit={(n) => setCrop({ ...crop, width: n / 100 })} />
          <NumberField label={t("styleCropH")} value={pct(crop.height)} min={1} max={100} testId={id("crop-h")} onCommit={(n) => setCrop({ ...crop, height: n / 100 })} />
          {v.crop && (
            <button type="button" data-testid={id("crop-reset")} onClick={() => setCrop(FULL_CROP)}
              className="text-[11px] text-purple-700 hover:underline cursor-pointer">{t("styleCropReset")}</button>
          )}
        </fieldset>
      )}
    </div>
  );
}
