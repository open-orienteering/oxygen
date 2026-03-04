import type { SortDirection } from "../hooks/useSort";

/**
 * Clickable table header cell with sort indicator.
 * If `active` is undefined the column is not sortable (renders plain th).
 */
export function SortHeader({
  label,
  active,
  direction,
  onClick,
  className = "",
  align = "left",
}: {
  label: string;
  /** Is this column currently the active sort column? undefined = not sortable */
  active?: boolean;
  direction?: SortDirection;
  onClick?: () => void;
  className?: string;
  align?: "left" | "right";
}) {
  const sortable = active !== undefined;

  return (
    <th
      className={`px-4 py-2.5 font-medium text-slate-500 select-none ${
        align === "right" ? "text-right" : "text-left"
      } ${sortable ? "cursor-pointer hover:text-slate-700 group" : ""} ${className}`}
      onClick={sortable ? onClick : undefined}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortable && (
          <span className={`inline-flex flex-col text-[8px] leading-[8px] ${active ? "text-blue-600" : "text-slate-300 opacity-0 group-hover:opacity-100"} transition-opacity`}>
            <span className={active && direction === "asc" ? "text-blue-600" : "text-slate-300"}>&#9650;</span>
            <span className={active && direction === "desc" ? "text-blue-600" : "text-slate-300"}>&#9660;</span>
          </span>
        )}
      </span>
    </th>
  );
}
