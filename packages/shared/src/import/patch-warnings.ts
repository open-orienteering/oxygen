/**
 * `PATCH_ISSUE` (docs/map-import.md §3.6, docs/map-patches.md §5 defaults):
 * the import report's warning for promoted corrections that no longer apply
 * when a club version is imported again. The ops are skipped and the job
 * succeeds; the warning is report-only, never part of the document.
 */

import type { BakeIssue } from "../map-document/patch-bake.js";
import type { ImportWarning, ImportWarningDetail } from "./report.js";

export function patchIssueWarnings(issues: readonly BakeIssue[]): { warnings: ImportWarning[]; details: ImportWarningDetail[] } {
  if (issues.length === 0) return { warnings: [], details: [] };
  return {
    warnings: [{ code: "PATCH_ISSUE", count: issues.length, message: "promoted corrections that no longer apply to the source were skipped" }],
    details: issues.map((i) => ({ code: "PATCH_ISSUE", message: `layer ${i.layer + 1}, ${i.opId}: ${i.code}` })),
  };
}
