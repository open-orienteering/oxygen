import { useState } from "react";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import type { ClubControlType } from "@oxygen/shared";

export function LibraryControlsTab() {
  const { t } = useTranslation("library");
  const utils = trpc.useUtils();
  const list = trpc.controlSeries.list.useQuery();
  const createSeries = trpc.controlSeries.createSeries.useMutation({
    onSuccess: () => void utils.controlSeries.list.invalidate(),
  });
  const updateSeries = trpc.controlSeries.updateSeries.useMutation({
    onSuccess: () => void utils.controlSeries.list.invalidate(),
  });
  const moveSeries = trpc.controlSeries.moveSeries.useMutation({
    onSuccess: () => void utils.controlSeries.list.invalidate(),
  });
  const deleteSeries = trpc.controlSeries.deleteSeries.useMutation({
    onSuccess: () => {
      setPendingDelete(null);
      void utils.controlSeries.list.invalidate();
    },
  });
  const addControls = trpc.controlSeries.addControls.useMutation({
    onSuccess: () => void utils.controlSeries.list.invalidate(),
  });
  const updateControl = trpc.controlSeries.updateControl.useMutation({
    onSuccess: () => void utils.controlSeries.list.invalidate(),
  });
  const deleteControl = trpc.controlSeries.deleteControl.useMutation({
    onSuccess: () => void utils.controlSeries.list.invalidate(),
  });

  const [newName, setNewName] = useState("");
  const [newOwner, setNewOwner] = useState("");
  const [newBorrowed, setNewBorrowed] = useState(false);
  const [newNotes, setNewNotes] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editOwner, setEditOwner] = useState("");
  const [editBorrowed, setEditBorrowed] = useState(false);
  const [editNotes, setEditNotes] = useState("");
  const [from, setFrom] = useState("31");
  const [to, setTo] = useState("40");
  const [addType, setAddType] = useState<ClubControlType>("normal");
  const [addResult, setAddResult] = useState<{ added: number; skipped: number } | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(
    null,
  );

  const series = list.data ?? [];

  return (
    <div>
      <p className="text-sm text-slate-600 mb-4">{t("controlsHelp")}</p>

      <form
        data-testid="series-create-form"
        className="bg-white rounded-xl border border-slate-200 p-4 mb-6 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newName.trim()) return;
          createSeries.mutate({
            name: newName.trim(),
            ownerName: newOwner.trim(),
            borrowed: newBorrowed,
            notes: newNotes,
          });
          setNewName("");
          setNewOwner("");
          setNewBorrowed(false);
          setNewNotes("");
        }}
      >
        <div className="font-medium text-sm text-slate-800">{t("createSeries")}</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            data-testid="series-create-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("seriesName")}
            className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm"
          />
          <input
            data-testid="series-create-owner"
            value={newOwner}
            onChange={(e) => setNewOwner(e.target.value)}
            placeholder={t("ownerName")}
            className="px-2 py-1.5 border border-slate-200 rounded-lg text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            data-testid="series-create-borrowed"
            type="checkbox"
            checked={newBorrowed}
            onChange={(e) => setNewBorrowed(e.target.checked)}
          />
          {t("borrowed")}
        </label>
        <input
          data-testid="series-create-notes"
          value={newNotes}
          onChange={(e) => setNewNotes(e.target.value)}
          placeholder={t("notes")}
          className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm"
        />
        <button
          type="submit"
          data-testid="series-create-submit"
          className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 cursor-pointer"
        >
          {t("createSeries")}
        </button>
      </form>

      {series.length === 0 && (
        <p className="text-sm text-slate-500 text-center py-8">{t("emptySeries")}</p>
      )}

      <ul className="space-y-3">
        {series.map((row, idx) => (
          <li
            key={row.id}
            data-testid={`series-card-${row.name}`}
            className="bg-white rounded-xl border border-slate-200 p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <button
                type="button"
                data-testid={`series-expand-${row.name}`}
                className="text-left cursor-pointer"
                onClick={() => {
                  setExpandedId((id) => (id === row.id ? null : row.id));
                  setAddResult(null);
                }}
              >
                <div className="font-semibold text-slate-900">{row.name}</div>
                {row.borrowed && (
                  <div className="text-xs text-amber-700 mt-0.5">
                    {t("borrowedFrom", { name: row.ownerName || t("unknownOwner") })}
                  </div>
                )}
                <div className="text-xs text-slate-500 mt-1">
                  {t("seriesCounts", {
                    total: row.counts.total,
                    srr: row.counts.srr,
                    inactive: row.counts.total - row.counts.active,
                  })}
                </div>
              </button>
              <div className="flex gap-1">
                <button
                  type="button"
                  data-testid={`series-move-up-${row.name}`}
                  disabled={idx === 0}
                  className="px-2 py-1 text-xs border border-slate-200 rounded-lg cursor-pointer disabled:opacity-40"
                  onClick={() => moveSeries.mutate({ id: row.id, direction: "up" })}
                >
                  {t("moveUp")}
                </button>
                <button
                  type="button"
                  data-testid={`series-move-down-${row.name}`}
                  disabled={idx === series.length - 1}
                  className="px-2 py-1 text-xs border border-slate-200 rounded-lg cursor-pointer disabled:opacity-40"
                  onClick={() => moveSeries.mutate({ id: row.id, direction: "down" })}
                >
                  {t("moveDown")}
                </button>
                <button
                  type="button"
                  data-testid={`series-edit-${row.name}`}
                  className="px-2 py-1 text-xs border border-slate-200 rounded-lg cursor-pointer"
                  onClick={() => {
                    setEditId(row.id);
                    setEditName(row.name);
                    setEditOwner(row.ownerName);
                    setEditBorrowed(row.borrowed);
                    setEditNotes(row.notes);
                  }}
                >
                  {t("edit")}
                </button>
                <button
                  type="button"
                  data-testid={`series-delete-${row.name}`}
                  className="px-2 py-1 text-xs text-red-600 border border-red-100 rounded-lg cursor-pointer"
                  onClick={() => setPendingDelete({ id: row.id, name: row.name })}
                >
                  {t("delete")}
                </button>
              </div>
            </div>

            {expandedId === row.id && (
              <div className="mt-4 border-t border-slate-100 pt-3">
                <form
                  className="flex flex-wrap items-end gap-2 mb-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const fromN = Number(from);
                    const toN = Number(to);
                    const result = await addControls.mutateAsync({
                      seriesId: row.id,
                      from: fromN,
                      to: toN,
                      type: addType,
                    });
                    setAddResult(result);
                  }}
                >
                  <label className="text-xs text-slate-500">
                    {t("rangeFrom")}
                    <input
                      data-testid="series-add-from"
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                      className="block mt-0.5 w-20 px-2 py-1 border border-slate-200 rounded"
                    />
                  </label>
                  <label className="text-xs text-slate-500">
                    {t("rangeTo")}
                    <input
                      data-testid="series-add-to"
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      className="block mt-0.5 w-20 px-2 py-1 border border-slate-200 rounded"
                    />
                  </label>
                  <select
                    data-testid="series-add-type"
                    value={addType}
                    onChange={(e) => setAddType(e.target.value as ClubControlType)}
                    className="px-2 py-1 border border-slate-200 rounded text-sm"
                  >
                    <option value="normal">{t("typeNormal")}</option>
                    <option value="srr">{t("typeSrr")}</option>
                  </select>
                  <button
                    type="submit"
                    data-testid="series-add-submit"
                    className="px-3 py-1 text-sm bg-slate-800 text-white rounded-lg cursor-pointer"
                  >
                    {t("addRange")}
                  </button>
                </form>
                {addResult && (
                  <p data-testid="series-add-result" className="text-xs text-slate-600 mb-2">
                    {t("addResult", addResult)}
                  </p>
                )}
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500">
                      <th className="py-1">{t("code")}</th>
                      <th>{t("type")}</th>
                      <th>{t("active")}</th>
                      <th>{t("notes")}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {row.controls.map((c) => (
                      <tr key={c.id} data-testid={`series-control-${c.code}`}>
                        <td className="py-1 font-mono">{c.code}</td>
                        <td>
                          <button
                            type="button"
                            data-testid={`series-control-type-${c.code}`}
                            className="text-xs px-2 py-0.5 rounded-full border border-slate-200 cursor-pointer"
                            onClick={() =>
                              updateControl.mutate({
                                id: c.id,
                                type: c.type === "srr" ? "normal" : "srr",
                              })
                            }
                          >
                            {c.type === "srr" ? t("typeSrr") : t("typeNormal")}
                          </button>
                        </td>
                        <td>
                          <input
                            data-testid={`series-control-active-${c.code}`}
                            type="checkbox"
                            checked={c.active}
                            onChange={(e) =>
                              updateControl.mutate({ id: c.id, active: e.target.checked })
                            }
                          />
                        </td>
                        <td>
                          <input
                            defaultValue={c.notes}
                            className="w-full px-1 py-0.5 border border-slate-100 rounded text-xs"
                            onBlur={(e) => {
                              if (e.target.value !== c.notes) {
                                updateControl.mutate({ id: c.id, notes: e.target.value });
                              }
                            }}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            data-testid={`series-control-delete-${c.code}`}
                            className="text-xs text-red-600 cursor-pointer"
                            onClick={() => deleteControl.mutate({ id: c.id })}
                          >
                            {t("delete")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </li>
        ))}
      </ul>

      {editId && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <form
            data-testid="series-edit-modal"
            className="bg-white rounded-xl p-6 max-w-sm w-full shadow-lg space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              updateSeries.mutate({
                id: editId,
                name: editName.trim(),
                ownerName: editOwner,
                borrowed: editBorrowed,
                notes: editNotes,
              });
              setEditId(null);
            }}
          >
            <h2 className="font-semibold">{t("editSeries")}</h2>
            <input
              data-testid="series-edit-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm"
            />
            <input
              data-testid="series-edit-owner"
              value={editOwner}
              onChange={(e) => setEditOwner(e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm"
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editBorrowed}
                onChange={(e) => setEditBorrowed(e.target.checked)}
              />
              {t("borrowed")}
            </label>
            <input
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-sm"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-sm border rounded-lg cursor-pointer"
                onClick={() => setEditId(null)}
              >
                {t("cancel")}
              </button>
              <button
                type="submit"
                data-testid="series-edit-save"
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg cursor-pointer"
              >
                {t("save")}
              </button>
            </div>
          </form>
        </div>
      )}

      {pendingDelete && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div
            data-testid="series-delete-confirm"
            className="bg-white rounded-xl p-6 max-w-sm w-full shadow-lg"
          >
            <h2 className="font-semibold mb-2">{t("deleteSeriesTitle")}</h2>
            <p className="text-sm text-slate-600 mb-4">
              {t("deleteSeriesBody", { name: pendingDelete.name })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 text-sm border rounded-lg cursor-pointer"
                onClick={() => setPendingDelete(null)}
              >
                {t("cancel")}
              </button>
              <button
                type="button"
                data-testid="series-delete-confirm-btn"
                className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-lg cursor-pointer"
                onClick={() => deleteSeries.mutate({ id: pendingDelete.id })}
              >
                {t("confirmDeleteSeries")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
