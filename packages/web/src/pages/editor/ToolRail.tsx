/**
 * The tool rail (docs/course-editor.md §2): `V` (select / move) only until
 * D5 adds the creation tools (`S`, `K`, `M`, `A`, `T`, gaps, snapping).
 */

import { useTranslation } from "react-i18next";

export function ToolRail() {
  const { t } = useTranslation("editor");
  return (
    <div data-testid="editor-tool-rail" className="pointer-events-auto flex flex-col gap-1 bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm p-1 self-start">
      <button
        type="button"
        data-testid="editor-tool-V"
        aria-pressed="true"
        title={t("toolSelect")}
        aria-label={t("toolSelect")}
        className="w-8 h-8 rounded-md bg-purple-100 text-purple-700 text-xs font-semibold cursor-default"
      >
        V
      </button>
    </div>
  );
}
