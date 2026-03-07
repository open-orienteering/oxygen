import {
  RunnerStatus,
  type RunnerStatusValue,
} from "@oxygen/shared";
import { useRunnerStatusLabel } from "../hooks/useStatusLabels";

export function StatusBadge({ status }: { status: RunnerStatusValue }) {
  const statusLabel = useRunnerStatusLabel();
  const label = statusLabel(status);
  let classes = "px-2 py-0.5 rounded-full text-xs font-medium ";
  switch (status) {
    case RunnerStatus.OK:
      classes += "bg-green-100 text-green-800";
      break;
    case RunnerStatus.MissingPunch:
    case RunnerStatus.DQ:
      classes += "bg-red-100 text-red-800";
      break;
    case RunnerStatus.DNF:
      classes += "bg-orange-100 text-orange-800";
      break;
    case RunnerStatus.DNS:
      classes += "bg-slate-100 text-slate-600";
      break;
    default:
      classes += "bg-slate-100 text-slate-500";
  }
  return <span className={classes}>{label}</span>;
}
