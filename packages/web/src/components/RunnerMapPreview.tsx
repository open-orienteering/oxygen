interface Props {
  runnerId?: number;
  defaultCourseNames?: string[];
  className?: string;
}

/**
 * Runner map preview — being re-ported. Renders a runner's route over
 * the map. Pending the punch-matcher port.
 */
export function RunnerMapPreview({ runnerId, className }: Props) {
  void runnerId;
  return (
    <div
      className={
        className ??
        "rounded-lg bg-gray-100 p-4 text-sm text-gray-600 dark:bg-gray-800 dark:text-gray-300"
      }
    >
      Map preview pending re-port.
    </div>
  );
}
