import { trpc } from "../lib/trpc";

/**
 * Runner inline detail — being re-ported in full. This minimal version
 * shows the core fields without the punch-editor / readout pipeline.
 */
interface Props {
  runnerId: number;
  onClose?: () => void;
  /** Optional table colSpan when embedded as a row inside another table. */
  colSpan?: number;
}

export function RunnerInlineDetail({ runnerId, onClose, colSpan }: Props) {
  void colSpan;
  const runner = trpc.runner.getById.useQuery({ id: runnerId });
  if (runner.isLoading) return <div className="p-4 text-sm">Loading…</div>;
  if (!runner.data)
    return <div className="p-4 text-sm text-red-600">Runner not found.</div>;
  const r = runner.data;
  return (
    <div className="p-4 space-y-2">
      <div className="flex justify-between">
        <h3 className="text-lg font-semibold">{r.name}</h3>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400"
          >
            Close
          </button>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-1 text-sm">
        <dt className="text-gray-500">Card</dt>
        <dd>{r.cardNo || "—"}</dd>
        <dt className="text-gray-500">Club</dt>
        <dd>{r.clubName || "—"}</dd>
        <dt className="text-gray-500">Class</dt>
        <dd>{r.className || "—"}</dd>
        <dt className="text-gray-500">Start no</dt>
        <dd>{r.startNo || "—"}</dd>
        <dt className="text-gray-500">Status</dt>
        <dd>{r.status}</dd>
      </dl>
      <p className="pt-2 text-xs text-amber-700 dark:text-amber-300">
        Full edit + punch panel pending re-port.
      </p>
    </div>
  );
}
