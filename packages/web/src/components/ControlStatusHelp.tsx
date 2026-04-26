import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ControlStatus, type ControlStatusValue } from "@oxygen/shared";

/**
 * Inline help panel for the Controls-page status dropdown. A toggleable
 * info button that, when expanded, walks through each settable
 * `oControl.Status` value with:
 *   - the same coloured pill the Controls page uses to render the badge,
 *   - a one-line plain-language description of when to choose it,
 *   - a tiny visual showing how the matcher / time accounting reacts.
 *
 * Mirrors the `DrawMethodHelp` pattern used on the Start-Draw screen so
 * the two surfaces feel consistent.
 *
 * The component only documents statuses we actually evaluate. Special
 * Start / Finish / Check / Clear statuses (used for control-station
 * roles, not match-time decisions) are intentionally out of the table.
 */

function InfoIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="currentColor"
      className="shrink-0"
    >
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Pill matching the existing `ControlStatusBadge` palette in
 * `ControlsPage.tsx` so the help panel reads as a key for the badges
 * the user has already seen.
 */
function StatusPill({ status, label }: { status: ControlStatusValue; label: string }) {
  let cls = "inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold ";
  if (status === ControlStatus.OK) cls += "bg-green-100 text-green-800";
  else if (status === ControlStatus.Bad || status === ControlStatus.BadNoTiming)
    cls += "bg-red-100 text-red-800";
  else if (status === ControlStatus.Multiple) cls += "bg-purple-100 text-purple-800";
  else if (status === ControlStatus.NoTiming) cls += "bg-blue-100 text-blue-800";
  else if (status === ControlStatus.Optional) cls += "bg-amber-100 text-amber-800";
  else cls += "bg-slate-100 text-slate-700";
  return <span className={cls}>{label}</span>;
}

/** A muted box used inside the visual columns. */
function VisualBox({
  children,
  tone = "neutral",
  strike = false,
}: {
  children: ReactNode;
  tone?: "neutral" | "ok" | "muted" | "missing" | "noTiming";
  strike?: boolean;
}) {
  const palette =
    tone === "ok"
      ? "bg-emerald-100 border-emerald-300 text-emerald-800"
      : tone === "missing"
        ? "bg-red-100 border-red-300 text-red-800"
        : tone === "muted"
          ? "bg-slate-100 border-slate-200 text-slate-500"
          : tone === "noTiming"
            ? "bg-blue-100 border-blue-300 text-blue-800"
            : "bg-white border-slate-200 text-slate-700";
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[1.75rem] h-6 px-1.5 rounded border text-[10px] font-mono tabular-nums ${palette} ${
        strike ? "line-through" : ""
      }`}
    >
      {children}
    </span>
  );
}

function VisualArrow() {
  return (
    <svg
      className="w-2.5 h-2.5 text-slate-300 shrink-0 mx-0.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function StatusBlock({
  status,
  label,
  description,
  visual,
}: {
  status: ControlStatusValue;
  label: string;
  description: string;
  visual: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <StatusPill status={status} label={label} />
        <span className="text-[11px] text-slate-500">{description}</span>
      </div>
      <div className="pl-1 flex items-center gap-1 flex-wrap">{visual}</div>
    </div>
  );
}

export function ControlStatusHelp() {
  const { t } = useTranslation("controls");
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1.5" data-testid="control-status-help">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 cursor-pointer"
        data-testid="control-status-help-toggle"
      >
        <InfoIcon />
        {open ? t("statusHelp.hide") : t("statusHelp.show")}
      </button>

      {open && (
        <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
          <StatusBlock
            status={ControlStatus.OK}
            label={t("statusHelp.okLabel")}
            description={t("statusHelp.okDesc")}
            visual={
              <>
                <VisualBox tone="ok">31</VisualBox>
                <VisualArrow />
                <VisualBox tone="ok">32</VisualBox>
                <VisualArrow />
                <VisualBox tone="ok">33</VisualBox>
              </>
            }
          />

          <StatusBlock
            status={ControlStatus.Bad}
            label={t("statusHelp.badLabel")}
            description={t("statusHelp.badDesc")}
            visual={
              <>
                <VisualBox tone="ok">31</VisualBox>
                <VisualArrow />
                <VisualBox tone="muted" strike>
                  32
                </VisualBox>
                <VisualArrow />
                <VisualBox tone="ok">33</VisualBox>
                <span className="text-[10px] text-slate-400 ml-1">
                  {t("statusHelp.badHint")}
                </span>
              </>
            }
          />

          <StatusBlock
            status={ControlStatus.Optional}
            label={t("statusHelp.optionalLabel")}
            description={t("statusHelp.optionalDesc")}
            visual={
              <>
                <VisualBox tone="ok">31</VisualBox>
                <VisualArrow />
                <VisualBox tone="muted">32</VisualBox>
                <VisualArrow />
                <VisualBox tone="ok">33</VisualBox>
                <span className="text-[10px] text-slate-400 ml-1">
                  {t("statusHelp.optionalHint")}
                </span>
              </>
            }
          />

          <StatusBlock
            status={ControlStatus.NoTiming}
            label={t("statusHelp.noTimingLabel")}
            description={t("statusHelp.noTimingDesc")}
            visual={
              <>
                <VisualBox tone="ok">31</VisualBox>
                <VisualArrow />
                <VisualBox tone="noTiming">32</VisualBox>
                <VisualArrow />
                <VisualBox tone="ok">33</VisualBox>
                <span className="text-[10px] text-slate-400 ml-1">
                  {t("statusHelp.noTimingHint")}
                </span>
              </>
            }
          />

          <StatusBlock
            status={ControlStatus.BadNoTiming}
            label={t("statusHelp.badNoTimingLabel")}
            description={t("statusHelp.badNoTimingDesc")}
            visual={
              <>
                <VisualBox tone="ok">31</VisualBox>
                <VisualArrow />
                <VisualBox tone="muted" strike>
                  32
                </VisualBox>
                <VisualArrow />
                <VisualBox tone="noTiming" strike>
                  33
                </VisualBox>
                <span className="text-[10px] text-slate-400 ml-1">
                  {t("statusHelp.badNoTimingHint")}
                </span>
              </>
            }
          />

          <StatusBlock
            status={ControlStatus.Multiple}
            label={t("statusHelp.multipleLabel")}
            description={t("statusHelp.multipleDesc")}
            visual={
              <>
                <VisualBox tone="ok">31a</VisualBox>
                <span className="text-slate-400 text-[10px] mx-1">+</span>
                <VisualBox tone="ok">31b</VisualBox>
                <span className="text-slate-400 text-[10px] mx-1">+</span>
                <VisualBox tone="ok">31c</VisualBox>
                <span className="text-[10px] text-slate-400 ml-1">
                  {t("statusHelp.multipleHint")}
                </span>
              </>
            }
          />
        </div>
      )}
    </div>
  );
}
