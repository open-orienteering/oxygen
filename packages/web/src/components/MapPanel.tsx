/**
 * Public props for the MapPanel component (used by MapSlot / map-props-store).
 * The full prop set returns once the OCAD + course-geometry pipeline is
 * re-ported; the placeholder ignores them all.
 */
export interface MapPanelPublicProps {
  selectedCourseId?: number | null;
  selectedClassId?: number | null;
  highlightedRunnerId?: number | null;
  fillContainer?: boolean;
  onPaneCollapse?: () => void;
  [key: string]: unknown;
}

/**
 * Event map panel — being re-ported. The OCAD map renderer + course
 * geometry overlay pipeline is staged with the rest of the post-MeOS
 * work.
 */
export function MapPanel(_props: MapPanelPublicProps = {}) {
  void _props;
  return (
    <div className="rounded-lg border bg-gray-50 p-6 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-300">
      <p>
        The event map view is being re-ported against the new PostgreSQL
        schema. Coming back online shortly.
      </p>
    </div>
  );
}
