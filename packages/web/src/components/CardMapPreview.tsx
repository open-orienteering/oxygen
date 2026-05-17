interface Props {
  cardNo: number;
  className?: string;
}

/**
 * Card map preview — being re-ported. Renders a runner's route over the
 * map from their card readout. Pending the punch-matcher port.
 */
export function CardMapPreview({ cardNo, className }: Props) {
  void cardNo;
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
