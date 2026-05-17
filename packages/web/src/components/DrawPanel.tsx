interface Props {
  onClose?: () => void;
  onDrawComplete?: () => void;
}

/**
 * Start-draw panel — temporarily simplified during the
 * MeOS→PostgreSQL migration. The corridor-aware multi-class draw engine
 * is being re-ported against the new schema.
 */
export function DrawPanel({ onClose }: Props = {}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-amber-900 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-100">
      <h2 className="mb-2 text-lg font-semibold">Start draw</h2>
      <p className="text-sm">
        The start-draw engine is being re-ported against the new
        PostgreSQL schema. Coming back online shortly.
      </p>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="mt-3 rounded-md bg-amber-200 px-3 py-1 text-sm dark:bg-amber-800"
        >
          Close
        </button>
      )}
    </div>
  );
}
