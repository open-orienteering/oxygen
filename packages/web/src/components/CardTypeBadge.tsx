const TYPE_COLORS: Record<string, string> = {
  SI5: "bg-slate-100 text-slate-600",
  SI6: "bg-slate-100 text-slate-600",
  SI8: "bg-blue-100 text-blue-700",
  SI9: "bg-blue-100 text-blue-700",
  SI10: "bg-purple-100 text-purple-700",
  SI11: "bg-purple-100 text-purple-700",
  SIAC: "bg-emerald-100 text-emerald-700",
  pCard: "bg-amber-100 text-amber-700",
  tCard: "bg-amber-100 text-amber-700",
};

export function CardTypeBadge({ type }: { type: string }) {
  if (!type || type === "Unknown") return null;
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-xs font-medium ${TYPE_COLORS[type] ?? "bg-slate-100 text-slate-600"}`}
    >
      {type}
    </span>
  );
}
