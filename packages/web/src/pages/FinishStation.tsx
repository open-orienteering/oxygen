/**
 * Finish station — being re-ported. The full WebSerial card-reading
 * pipeline is staged with the rest of the post-MeOS work.
 */
export function FinishStation() {
  return (
    <div className="p-6">
      <h1 className="mb-2 text-2xl font-semibold">Finish station</h1>
      <p className="text-sm text-amber-700 dark:text-amber-300">
        The finish-station view is being re-ported against the new
        PostgreSQL schema. Coming back online shortly.
      </p>
    </div>
  );
}

export default FinishStation;
