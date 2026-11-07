/**
 * The Layout inspector's small fields: a draft while typing, one commit on
 * blur or Enter (one write, one undo entry).
 */

import { useState } from "react";
import { parseClampedNumberDraft } from "../../../lib/map-layout-editor";

export function NumberField({ label, value, min, max, step = 1, testId, onCommit }: {
  label: string; value: number; min: number; max: number; step?: number; testId: string; onCommit: (v: number) => void;
}) {
  const [draftText, setDraftText] = useState<string | null>(null);
  const commit = () => {
    if (draftText === null) return;
    const v = parseClampedNumberDraft(draftText, value, min, max);
    setDraftText(null);
    if (v !== value) onCommit(v);
  };
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
      <span>{label}</span>
      <input data-testid={testId} type="number" min={min} max={max} step={step} value={draftText ?? String(value)}
        onChange={(e) => setDraftText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
        className="w-20 px-1.5 py-0.5 border border-slate-200 rounded text-xs text-slate-700" />
    </label>
  );
}

export function TextField({ label, value, testId, onCommit }: { label: string; value: string; testId: string; onCommit: (v: string) => void }) {
  const [draftText, setDraftText] = useState<string | null>(null);
  const commit = () => { if (draftText !== null && draftText !== value) onCommit(draftText); setDraftText(null); };
  return (
    <label className="flex flex-col gap-0.5 text-[11px] text-slate-500">
      <span>{label}</span>
      <input data-testid={testId} value={draftText ?? value} onChange={(e) => setDraftText(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); }} className="px-1.5 py-0.5 border border-slate-200 rounded text-xs text-slate-700" />
    </label>
  );
}
