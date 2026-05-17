import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

/**
 * Clubs page — simplified during the post-MeOS migration. Clubs are no
 * longer first-class per-event entities: the roster below is derived
 * from the runner list (with a join into the global `club_directory`
 * for Eventor-linked clubs). The full CRUD UI returns once we decide
 * whether clubs become editable in the new model.
 */
export function ClubsPage() {
  const { t } = useTranslation("clubs");
  void t;
  const clubs = trpc.club.list.useQuery({ showAll: true });

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Clubs</h1>
      <p className="mb-4 text-sm text-amber-700 dark:text-amber-300">
        Clubs are now derived from the runner roster (joined with the
        global Eventor club directory). Per-event CRUD is being
        re-thought as part of the post-MeOS migration.
      </p>

      {clubs.isLoading && <div>Loading…</div>}
      {clubs.error && (
        <div className="text-red-600">
          Failed to load clubs: {clubs.error.message}
        </div>
      )}
      {clubs.data && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="px-2 py-1">Eventor ID</th>
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Short name</th>
              <th className="px-2 py-1">Runners</th>
            </tr>
          </thead>
          <tbody>
            {clubs.data.map((c) => (
              <tr key={`${c.id}-${c.name}`} className="border-b">
                <td className="px-2 py-1 font-mono">
                  {c.id > 0 ? c.id : "—"}
                </td>
                <td className="px-2 py-1">{c.name}</td>
                <td className="px-2 py-1">{c.shortName || "—"}</td>
                <td className="px-2 py-1">{c.runnerCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default ClubsPage;
