import type { ReactNode } from "react";

export type ToolbarTone = "purple" | "emerald" | "blue";

const ACTIVE_TONE: Record<ToolbarTone, string> = {
  purple: "bg-purple-100 text-purple-700 font-medium",
  emerald: "bg-emerald-100 text-emerald-700 font-medium",
  blue: "bg-blue-100 text-blue-700 font-medium",
};

/**
 * Icon + label toolbar button for the map / editor toolbars.
 *
 * The label is visible from `sm` up and collapses to the icon alone on a
 * phone, where a row of text buttons ("Auto slits", "Descriptions", …)
 * does not fit. The label always feeds `aria-label` and (unless a richer
 * `title` is given) the tooltip, so the button keeps its accessible name
 * and Playwright's `getByRole("button", { name })` on both breakpoints.
 *
 * `iconOnly` keeps it a pure icon everywhere (undo / redo). Padding grows
 * on phones so the hit area is a comfortable touch target.
 */
export function ToolbarButton({
  icon,
  label,
  title,
  onClick,
  active,
  tone = "purple",
  disabled = false,
  iconOnly = false,
  testId,
  className = "",
}: {
  icon: ReactNode;
  label: string;
  /** Tooltip; defaults to `label`. */
  title?: string;
  onClick: () => void;
  /** Pressed / toggled state — also sets `aria-pressed`. Leave undefined
   *  for plain action buttons (undo / redo) so they are not announced as
   *  toggles. */
  active?: boolean;
  tone?: ToolbarTone;
  disabled?: boolean;
  iconOnly?: boolean;
  testId?: string;
  className?: string;
}) {
  // A toggled button that is briefly disabled (mutation in flight) keeps
  // its "on" colour rather than flashing grey.
  const state = disabled
    ? active
      ? `${ACTIVE_TONE[tone]} opacity-60 cursor-wait`
      : "text-slate-300 cursor-not-allowed"
    : active
      ? `${ACTIVE_TONE[tone]} cursor-pointer`
      : "text-slate-500 hover:text-slate-700 hover:bg-slate-100 cursor-pointer";
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 shrink-0 rounded-md text-xs transition-colors p-2 sm:px-2 sm:py-1 ${state} ${className}`}
    >
      <span className="inline-flex shrink-0 [&>svg]:w-5 [&>svg]:h-5 sm:[&>svg]:w-4 sm:[&>svg]:h-4">
        {icon}
      </span>
      {!iconOnly && <span className="hidden sm:inline">{label}</span>}
    </button>
  );
}
