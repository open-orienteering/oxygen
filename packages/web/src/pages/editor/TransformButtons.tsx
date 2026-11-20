/**
 * A line's or path's turn and flip (J9; docs/course-layout.md §3 "Rotate
 * and flip a line or path"): lines and paths store no angle, so each
 * button bakes the change into the vertices — one write, one undo entry.
 * Shared with Course mode's lines and areas (J11).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NumberField } from "./layout/fields";

export type TransformOp = { kind: "rotate"; deg: number } | { kind: "flip"; axis: "h" | "v" };

const BTN = "px-1.5 py-0.5 border border-slate-200 rounded text-[11px] text-slate-700 hover:bg-slate-50 cursor-pointer";

export function TransformButtons({ onTransform, testIdPrefix }: { onTransform: (op: TransformOp) => void; testIdPrefix: string }) {
  const { t } = useTranslation("editor");
  const [deg, setDeg] = useState(15);
  const id = (s: string) => `${testIdPrefix}-${s}`;
  return (
    <div data-testid={id("buttons")} className="space-y-1">
      <div className="flex items-end gap-1">
        <div className="flex-1">
          <NumberField label={t("transformAngle")} value={deg} min={-360} max={360} step={1} testId={id("angle")} onCommit={setDeg} />
        </div>
        <button type="button" data-testid={id("rotate")} className={BTN} onClick={() => onTransform({ kind: "rotate", deg })}>{t("transformRotate")}</button>
      </div>
      <div className="flex flex-wrap gap-1">
        <button type="button" data-testid={id("rotate90")} className={BTN} onClick={() => onTransform({ kind: "rotate", deg: 90 })}>{t("transformRotate90")}</button>
        <button type="button" data-testid={id("flip-h")} className={BTN} onClick={() => onTransform({ kind: "flip", axis: "h" })}>{t("transformFlipH")}</button>
        <button type="button" data-testid={id("flip-v")} className={BTN} onClick={() => onTransform({ kind: "flip", axis: "v" })}>{t("transformFlipV")}</button>
      </div>
    </div>
  );
}
