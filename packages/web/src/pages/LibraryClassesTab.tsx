import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ClubClassPreset } from "@oxygen/shared";
import { trpc } from "../lib/trpc";

type Draft = {
  name: string;
  sex: "" | "M" | "F";
  lowAge: string;
  highAge: string;
  classType: string;
  noTiming: boolean;
  freeStart: boolean;
  allowQuickEntry: boolean;
  sortIndex: string;
};

const emptyDraft: Draft = {
  name: "",
  sex: "",
  lowAge: "0",
  highAge: "0",
  classType: "",
  noTiming: false,
  freeStart: false,
  allowQuickEntry: false,
  sortIndex: "0",
};

function fromPreset(preset: ClubClassPreset): Draft {
  return {
    name: preset.name,
    sex: preset.sex,
    lowAge: String(preset.lowAge),
    highAge: String(preset.highAge),
    classType: preset.classType,
    noTiming: preset.noTiming,
    freeStart: preset.freeStart,
    allowQuickEntry: preset.allowQuickEntry,
    sortIndex: String(preset.sortIndex),
  };
}

function toInput(draft: Draft) {
  return {
    name: draft.name.trim(),
    sex: draft.sex,
    lowAge: Number.parseInt(draft.lowAge, 10) || 0,
    highAge: Number.parseInt(draft.highAge, 10) || 0,
    classType: draft.classType,
    noTiming: draft.noTiming,
    freeStart: draft.freeStart,
    allowQuickEntry: draft.allowQuickEntry,
    sortIndex: Number.parseInt(draft.sortIndex, 10) || 0,
  };
}

export function LibraryClassesTab() {
  const { t } = useTranslation("library");
  const utils = trpc.useUtils();
  const list = trpc.classPreset.list.useQuery();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editing, setEditing] = useState<ClubClassPreset | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);

  const create = trpc.classPreset.create.useMutation({
    onSuccess: () => {
      setDraft(emptyDraft);
      void utils.classPreset.list.invalidate();
    },
  });
  const update = trpc.classPreset.update.useMutation({
    onSuccess: () => {
      setEditing(null);
      void utils.classPreset.list.invalidate();
    },
  });
  const remove = trpc.classPreset.delete.useMutation({
    onSuccess: () => void utils.classPreset.list.invalidate(),
  });

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim()) return;
    create.mutate(toInput(draft));
  };

  return (
    <div>
      <p className="mb-4 text-sm text-slate-600">{t("classesHelp")}</p>
      <form
        onSubmit={submitCreate}
        className="mb-6 space-y-3 rounded-xl border border-slate-200 bg-white p-4"
      >
        <h2 className="text-sm font-medium text-slate-800">{t("addClassPreset")}</h2>
        <PresetFields draft={draft} onChange={setDraft} nameTestId="preset-add-name" />
        <button
          type="submit"
          data-testid="preset-add-submit"
          disabled={!draft.name.trim() || create.isPending}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {t("addClassPreset")}
        </button>
        {create.error && <p className="text-sm text-red-600">{create.error.message}</p>}
      </form>

      {(list.data?.length ?? 0) === 0 && (
        <p className="py-8 text-center text-sm text-slate-500">{t("emptyClassPresets")}</p>
      )}
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500">
              <th className="px-3 py-2">{t("presetName")}</th>
              <th className="px-3 py-2">{t("presetSex")}</th>
              <th className="px-3 py-2">{t("presetAges")}</th>
              <th className="px-3 py-2">{t("presetType")}</th>
              <th className="px-3 py-2">{t("presetOptions")}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(list.data ?? []).map((preset) => (
              <tr key={preset.id} data-testid={`preset-row-${preset.name}`}>
                <td className="px-3 py-2 font-medium">{preset.name}</td>
                <td className="px-3 py-2">{preset.sex || t("presetOpen")}</td>
                <td className="px-3 py-2">{preset.lowAge || 0}–{preset.highAge || "∞"}</td>
                <td className="px-3 py-2">{preset.classType || "—"}</td>
                <td className="px-3 py-2 text-xs text-slate-500">
                  {[
                    preset.noTiming ? t("presetNoTiming") : "",
                    preset.freeStart ? t("presetFreeStart") : "",
                    preset.allowQuickEntry ? t("presetQuickEntry") : "",
                  ].filter(Boolean).join(", ") || "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  <button
                    type="button"
                    className="mr-2 text-blue-700"
                    onClick={() => {
                      setEditing(preset);
                      setEditDraft(fromPreset(preset));
                    }}
                  >
                    {t("edit")}
                  </button>
                  <button
                    type="button"
                    data-testid={`preset-delete-${preset.name}`}
                    className="text-red-600"
                    onClick={() => {
                      if (window.confirm(t("deleteClassPresetBody", { name: preset.name }))) {
                        remove.mutate({ id: preset.id });
                      }
                    }}
                  >
                    {t("delete")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <form
            className="max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-xl bg-white p-6 shadow-lg"
            onSubmit={(event) => {
              event.preventDefault();
              if (!editDraft.name.trim()) return;
              update.mutate({ id: editing.id, ...toInput(editDraft) });
            }}
          >
            <h2 className="font-semibold">{t("editClassPreset")}</h2>
            <PresetFields draft={editDraft} onChange={setEditDraft} />
            <div className="flex justify-end gap-2">
              <button type="button" className="rounded-lg border px-3 py-1.5" onClick={() => setEditing(null)}>
                {t("cancel")}
              </button>
              <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-white">
                {t("save")}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

function PresetFields({
  draft,
  onChange,
  nameTestId,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  nameTestId?: string;
}) {
  const { t } = useTranslation("library");
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value });
  const textFields: Array<{
    key: "lowAge" | "highAge" | "classType" | "sortIndex";
    label: string;
    type?: string;
    placeholder?: string;
  }> = [
    { key: "lowAge", label: t("presetLowAge"), type: "number" },
    { key: "highAge", label: t("presetHighAge"), type: "number" },
    { key: "classType", label: t("presetType") },
    { key: "sortIndex", label: t("presetSortIndex"), type: "number" },
  ];
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label className="text-xs text-slate-500 sm:col-span-2">
          {t("presetName")}
          <input
            data-testid={nameTestId}
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            className="mt-1 block w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-900"
            required
          />
        </label>
        <label className="text-xs text-slate-500">
          {t("presetSex")}
          <select
            value={draft.sex}
            onChange={(event) => set("sex", event.target.value as Draft["sex"])}
            className="mt-1 block w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-900"
          >
            <option value="">{t("presetOpen")}</option>
            <option value="M">{t("presetMen")}</option>
            <option value="F">{t("presetWomen")}</option>
          </select>
        </label>
        {textFields.map((field) => (
          <label key={field.key} className="text-xs text-slate-500">
            {field.label}
            <input
              type={field.type ?? "text"}
              min={field.type === "number" ? 0 : undefined}
              placeholder={field.placeholder}
              value={draft[field.key]}
              onChange={(event) => set(field.key, event.target.value)}
              className="mt-1 block w-full rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-900"
            />
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-4 text-sm text-slate-700">
        {([
          ["noTiming", "presetNoTiming"],
          ["freeStart", "presetFreeStart"],
          ["allowQuickEntry", "presetQuickEntry"],
        ] as const).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft[key]}
              onChange={(event) => set(key, event.target.checked)}
            />
            {t(label)}
          </label>
        ))}
      </div>
    </>
  );
}
