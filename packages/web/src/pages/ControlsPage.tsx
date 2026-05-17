import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";

/**
 * Controls page — simplified during the post-MeOS migration. Shows a
 * basic roster of controls; the full hardware programming flow + AIR+
 * config panel + backup-punch importer are being re-ported alongside
 * the rest of the device-manager pipeline.
 */
export function ControlsPage() {
  const { t } = useTranslation("controls");
  void t;
  const controls = trpc.control.list.useQuery();

  return (
    <div className="p-6">
      <h1 className="mb-4 text-2xl font-semibold">Controls</h1>
      <p className="mb-4 text-sm text-amber-700 dark:text-amber-300">
        Detailed control configuration (SI station programming, AIR+
        toggles, backup-punch import) is being re-ported against the
        new PostgreSQL schema. The control roster below remains
        available.
      </p>

      {controls.isLoading && <div>Loading…</div>}
      {controls.error && (
        <div className="text-red-600">Failed to load controls: {controls.error.message}</div>
      )}
      {controls.data && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="px-2 py-1">ID</th>
              <th className="px-2 py-1">Name</th>
              <th className="px-2 py-1">Codes</th>
              <th className="px-2 py-1">Status</th>
              <th className="px-2 py-1">Time adjust</th>
              <th className="px-2 py-1">Runners</th>
            </tr>
          </thead>
          <tbody>
            {controls.data.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="px-2 py-1 font-mono">{c.id}</td>
                <td className="px-2 py-1">{c.name}</td>
                <td className="px-2 py-1 font-mono">{c.codes}</td>
                <td className="px-2 py-1">{c.status}</td>
                <td className="px-2 py-1">{c.timeAdjust}</td>
                <td className="px-2 py-1">{c.runnerCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default ControlsPage;
