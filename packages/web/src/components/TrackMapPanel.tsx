/**
 * Track / route map panel — being re-ported. Renders synced GPS routes
 * (Livelox / GPX) over the event map. Pending the Livelox-to-PG
 * pipeline re-port.
 */
interface Props {
  classId?: number;
  className?: string;
}

export function TrackMapPanel({ classId, className }: Props) {
  void classId;
  return (
    <div
      className={
        className ??
        "rounded-lg bg-gray-100 p-4 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-300"
      }
    >
      Track replay pending re-port.
    </div>
  );
}
