/**
 * Kiosk — being re-ported. The self-service registration / readout
 * flow involves WebSerial + the punch matcher, both staged with the
 * rest of the post-MeOS work.
 */
export function KioskPage() {
  return (
    <div className="p-6">
      <h1 className="mb-2 text-2xl font-semibold">Kiosk</h1>
      <p className="text-sm text-amber-700 dark:text-amber-300">
        The kiosk view is being re-ported against the new PostgreSQL
        schema. Coming back online shortly.
      </p>
    </div>
  );
}

export default KioskPage;
