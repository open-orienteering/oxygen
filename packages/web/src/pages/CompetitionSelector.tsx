import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import { formatDate } from "../lib/format";
import { LanguageSelector } from "../components/LanguageSelector";

/**
 * Competition selector — simplified during the post-MeOS migration.
 * Lists events from the registry, supports basic create / select /
 * delete. The Eventor event picker is being re-ported alongside the
 * rest of the Eventor sync pipeline.
 */
export function CompetitionSelector() {
  const navigate = useNavigate();
  const { t } = useTranslation("event");
  const competitions = trpc.competition.list.useQuery();
  const selectMutation = trpc.competition.select.useMutation({
    onSuccess: (data) => {
      navigate(`/${data.nameId}`);
    },
  });
  const createMutation = trpc.competition.create.useMutation({
    onSuccess: (data) => {
      competitions.refetch();
      setShowCreate(false);
      navigate(`/${data.nameId}`);
    },
  });
  const deleteMutation = trpc.competition.delete.useMutation({
    onSuccess: () => {
      setDeleteConfirm(null);
      competitions.refetch();
    },
  });

  const [deleteConfirm, setDeleteConfirm] = useState<{
    nameId: string;
    name: string;
  } | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDate, setNewDate] = useState(new Date().toISOString().slice(0, 10));

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4 dark:from-slate-900 dark:to-blue-950">
      <div className="w-full max-w-lg">
        <div className="flex justify-end mb-2">
          <LanguageSelector />
        </div>

        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 text-white text-2xl font-bold mb-4 shadow-lg">
            O2
          </div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-slate-100">
            {t("title")}
          </h1>
          <p className="text-slate-500 mt-2 dark:text-slate-400">
            {t("selectCompetition")}
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden dark:bg-slate-800 dark:border-slate-700">
          {competitions.isLoading && (
            <div className="p-6 text-center text-slate-500 dark:text-slate-400">
              Loading…
            </div>
          )}
          {competitions.error && (
            <div className="p-6 text-center text-red-600">
              Failed to load events: {competitions.error.message}
            </div>
          )}
          {competitions.data && competitions.data.length === 0 && (
            <div className="p-6 text-center text-slate-500 dark:text-slate-400">
              No events yet. Create one to get started.
            </div>
          )}
          {competitions.data && competitions.data.length > 0 && (
            <ul className="divide-y divide-slate-200 dark:divide-slate-700">
              {competitions.data.map((c) => (
                <li
                  key={c.nameId}
                  className="flex items-center justify-between p-4 hover:bg-slate-50 dark:hover:bg-slate-700"
                >
                  <button
                    type="button"
                    onClick={() => selectMutation.mutate({ nameId: c.nameId })}
                    className="flex-1 text-left"
                  >
                    <div className="font-medium">{c.name}</div>
                    <div className="text-sm text-slate-500 dark:text-slate-400">
                      {formatDate(c.date)} {c.annotation && `· ${c.annotation}`}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setDeleteConfirm({ nameId: c.nameId, name: c.name })
                    }
                    className="ml-2 px-3 py-1 text-sm text-red-600 hover:bg-red-50 rounded-md dark:hover:bg-red-900/40"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Create new event
          </button>
        </div>

        <p className="mt-4 text-center text-xs text-amber-700 dark:text-amber-300">
          The Eventor event picker is being re-ported against the new
          PostgreSQL schema. Coming back online shortly.
        </p>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-800">
            <h2 className="mb-4 text-lg font-semibold">Create event</h2>
            <label className="mb-3 block text-sm">
              <span className="mb-1 block text-slate-700 dark:text-slate-300">
                Name
              </span>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-600 dark:bg-slate-700"
              />
            </label>
            <label className="mb-4 block text-sm">
              <span className="mb-1 block text-slate-700 dark:text-slate-300">
                Date
              </span>
              <input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-600 dark:bg-slate-700"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-md bg-slate-200 px-4 py-2 text-sm dark:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!newName || createMutation.isPending}
                onClick={() =>
                  createMutation.mutate({ name: newName, date: newDate })
                }
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-slate-800">
            <h2 className="mb-2 text-lg font-semibold">Delete event?</h2>
            <p className="mb-4 text-sm text-slate-600 dark:text-slate-300">
              Are you sure you want to delete <b>{deleteConfirm.name}</b>?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                className="rounded-md bg-slate-200 px-4 py-2 text-sm dark:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() =>
                  deleteMutation.mutate({ nameId: deleteConfirm.nameId })
                }
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default CompetitionSelector;
