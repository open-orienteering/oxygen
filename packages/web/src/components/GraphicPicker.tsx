/**
 * The graphics picker (J2, docs/course-layout.md §2): the event's graphics,
 * then the club library's, as thumbnails with name and pixel size; upload
 * (PNG or SVG, at most 16 MiB; the server resamples a PNG over 4096 px),
 * save an event graphic to the club library, delete (a second click
 * confirms). Picking a tile arms the caller's image tool.
 *
 * `testIdPrefix` keeps the Layout inspector's ids (`editor-layout-graphic-…`)
 * so its tests and help keep working; the Course-mode image tool (J7) uses
 * its own.
 */

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { fileToBase64 } from "../lib/file-to-base64";
import { formatBytes } from "../lib/editor/map-info";
import { graphicGroups, graphicSizeLabel, graphicThumbUrl, uploadEach, uploadErrorKey, uploadProblem, type PickerGraphic } from "../lib/graphics-picker";

export function GraphicPicker(p: {
  nameId: string;
  /** The armed graphic, highlighted. */
  active: number | null;
  onPick: (id: number) => void;
  canEdit: boolean;
  testIdPrefix?: string;
}) {
  const { t } = useTranslation("editor");
  const prefix = p.testIdPrefix ?? "graphic-picker";
  const utils = trpc.useUtils();
  const graphics = trpc.graphics.list.useQuery();
  const invalidate = () => void utils.graphics.list.invalidate();
  const upload = trpc.graphics.upload.useMutation({ onSuccess: invalidate });
  const saveToClub = trpc.graphics.saveToClub.useMutation({ onSuccess: invalidate });
  const remove = trpc.graphics.delete.useMutation({ onSuccess: invalidate });
  const input = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  const groups = graphicGroups(graphics.data ?? []);

  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);

  /** One file's check and upload; throws the message to show. */
  const uploadOne = async (file: File) => {
    const problem = uploadProblem(file);
    if (problem) throw new Error(problem === "size" ? t("graphicsTooLarge") : t("graphicsWrongType"));
    try {
      const fileDataBase64 = await fileToBase64(file);
      await upload.mutateAsync({ name: file.name, scope: "event", fileDataBase64 });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const key = uploadErrorKey(message);
      throw new Error(key ? t(key) : t("graphicsUploadFailed", { detail: message }), { cause: e });
    }
  };

  /** J20: several files at once, one after another; each failure is named, the rest still upload. */
  const onFiles = async (files: File[]) => {
    setError(null);
    const failures = await uploadEach(files, uploadOne, (index, total) => setProgress({ index, total }));
    setProgress(null);
    if (failures.length === 0) return;
    setError(files.length === 1 ? failures[0].message : failures.map((f) => t("graphicsFileFailed", { name: f.name, detail: f.message })).join("\n"));
  };

  const tile = (g: PickerGraphic) => {
    const size = graphicSizeLabel(g);
    const armed = p.active === g.id;
    return (
      <li key={g.id} data-testid={`${prefix}-tile`} data-graphic-id={g.id} data-club={g.club ? "true" : "false"}
        className={`flex items-center gap-2 rounded border p-1 ${armed ? "border-purple-300 bg-purple-50" : "border-slate-200"}`}>
        <button type="button" data-testid={`${prefix}-place-${g.id}`} aria-pressed={armed} title={t("layoutPlace")} onClick={() => p.onPick(g.id)}
          className="shrink-0 w-12 h-12 rounded bg-[repeating-conic-gradient(#e2e8f0_0%_25%,#fff_0%_50%)] bg-[length:8px_8px] flex items-center justify-center overflow-hidden cursor-pointer">
          <img src={graphicThumbUrl(p.nameId, g.id, g.version)} alt="" loading="lazy" className="max-w-full max-h-full object-contain" data-testid={`${prefix}-thumb`} />
        </button>
        <div className="min-w-0 flex-1 text-[11px] leading-tight">
          <div className="truncate text-slate-700" title={g.name}>{g.name}</div>
          <div className="text-slate-400">{[size, formatBytes(g.sizeBytes)].filter(Boolean).join(" · ")}</div>
          {p.canEdit && (
            <div className="flex gap-2 mt-0.5">
              {!g.club && (
                <button type="button" data-testid={`${prefix}-save-club-${g.id}`} disabled={saveToClub.isPending}
                  onClick={() => void saveToClub.mutateAsync({ id: g.id }).catch((e: unknown) => setError(t("graphicsActionFailed", { detail: e instanceof Error ? e.message : String(e) })))}
                  className="text-purple-700 hover:underline cursor-pointer disabled:opacity-50">{t("graphicsSaveToClub")}</button>
              )}
              <button type="button" data-testid={`${prefix}-delete-${g.id}`} disabled={remove.isPending}
                onClick={() => {
                  if (confirmDelete !== g.id) {
                    setConfirmDelete(g.id);
                    return;
                  }
                  setConfirmDelete(null);
                  void remove.mutateAsync({ id: g.id }).catch((e: unknown) => setError(t("graphicsActionFailed", { detail: e instanceof Error ? e.message : String(e) })));
                }}
                className={`hover:underline cursor-pointer disabled:opacity-50 ${confirmDelete === g.id ? "text-red-700 font-medium" : "text-slate-500"}`}>
                {confirmDelete === g.id ? t(g.club ? "graphicsDeleteClubConfirm" : "graphicsDeleteConfirm") : t("graphicsDelete")}
              </button>
            </div>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-1.5" data-testid={prefix}>
      {groups.event.length + groups.club.length === 0 && !graphics.isLoading && (
        <p className="text-[11px] text-slate-400">{t("layoutNoGraphics")}</p>
      )}
      {groups.event.length > 0 && (
        <section>
          <h4 className="text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">{t("graphicsEvent")}</h4>
          <ul className="space-y-1" data-testid={`${prefix}-event`}>{groups.event.map(tile)}</ul>
        </section>
      )}
      {groups.club.length > 0 && (
        <section>
          <h4 className="text-[10px] uppercase tracking-wide text-slate-400 mb-0.5">{t("graphicsClub")}</h4>
          <ul className="space-y-1" data-testid={`${prefix}-club`}>{groups.club.map(tile)}</ul>
        </section>
      )}
      {p.canEdit && (
        <>
          <input ref={input} type="file" multiple accept=".svg,.png,image/svg+xml,image/png" className="hidden" data-testid={`${prefix}-upload`}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              if (files.length > 0) void onFiles(files);
            }} />
          <button type="button" onClick={() => input.current?.click()} disabled={progress !== null}
            className="text-[11px] text-purple-700 hover:underline cursor-pointer disabled:opacity-50">
            {progress === null ? t("layoutUpload") : progress.total > 1 ? t("graphicsUploadingCount", { index: progress.index, total: progress.total }) : t("graphicsUploading")}
          </button>
          <p className="text-[10px] text-slate-400">{t("graphicsUploadHint")}</p>
        </>
      )}
      {error && <p className="text-[11px] text-red-700 whitespace-pre-line" role="alert" data-testid={`${prefix}-error`}>{error}</p>}
    </div>
  );
}
