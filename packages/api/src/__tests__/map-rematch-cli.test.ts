import { describe, it, expect } from "vitest";
import { symbolLibrary } from "@oxygen/shared";
import { formatPlanLine, formatRematchLine, formatRematchSummary, parseRematchArgs } from "../cli/map-rematch-args.js";
import { staleReason, type RematchItemResult, type RematchRun } from "../map-store/rematch.js";

const CURRENT = `ISOM2017-2@${symbolLibrary.SYMBOL_LIBRARY_VERSION}`;

describe("staleReason (docs/map-storage.md §6.9)", () => {
  it("names the first reason a document is not what its source imports to now", () => {
    expect(staleReason({ importerVersion: "ocad-3", libraryVersion: "none" }, true)).toBe("importer");
    // ocad-4 / omap-1 predate stage 5 (docs/map-import.md §5).
    expect(staleReason({ importerVersion: "ocad-4", libraryVersion: CURRENT }, true)).toBe("importer");
    expect(staleReason({ importerVersion: "omap-1", libraryVersion: CURRENT }, true)).toBe("importer");
    // ocad-5 reported reader-dropped symbol types as READER_WARNING and warned on double-line mode 65535.
    expect(staleReason({ importerVersion: "ocad-5", libraryVersion: CURRENT }, true)).toBe("importer");
    // ocad-6 had no text halo from OCAD line framing and no rectangle / line-text symbols (A12).
    expect(staleReason({ importerVersion: "ocad-6", libraryVersion: CURRENT }, true)).toBe("importer");
    // ocad-7 / omap-2 matched without the entries' Swedish names (B7).
    expect(staleReason({ importerVersion: "ocad-7", libraryVersion: CURRENT }, true)).toBe("importer");
    expect(staleReason({ importerVersion: "omap-2", libraryVersion: CURRENT }, true)).toBe("importer");
    // ocad-8 drew OCAD corner symbols on the ends of open lines (B9).
    expect(staleReason({ importerVersion: "ocad-8", libraryVersion: CURRENT }, true)).toBe("importer");
    // ocad-12 / omap-6 had no tab stops, rectangle frame or Mapper box corners (B8).
    expect(staleReason({ importerVersion: "ocad-12", libraryVersion: CURRENT }, true)).toBe("importer");
    expect(staleReason({ importerVersion: "omap-6", libraryVersion: CURRENT }, false)).toBe("importer");
    // ocad-14 drew north-oriented point symbols north-up where their objects carry an angle (C10).
    expect(staleReason({ importerVersion: "ocad-14", libraryVersion: CURRENT }, true)).toBe("importer");
    expect(staleReason({ importerVersion: "ocad-15", libraryVersion: "none" }, true)).toBe("library");
    expect(staleReason({ importerVersion: "ocad-15", libraryVersion: "ISOM2017-2@2026.10.1" }, true)).toBe("library");
    expect(staleReason({ importerVersion: "omap-8", libraryVersion: CURRENT }, false)).toBe("decisions");
    expect(staleReason({ importerVersion: "ocad-15", libraryVersion: CURRENT }, true)).toBeNull();
  });
});

describe("map-rematch CLI", () => {
  it("takes the backfill's flags", () => {
    expect(parseRematchArgs(["--event=itest", "--limit", "2", "--dry-run"])).toEqual({ ok: true, value: { event: "itest", limit: 2, dryRun: true } });
    expect(parseRematchArgs(["--all"])).toMatchObject({ ok: false });
  });

  const item = { kind: "club" as const, id: "v1", name: "Skogen (skogen.ocd)", sourceHash: "s".repeat(64), documentHash: "abcdef0123456789aa", reason: "importer" as const };
  const run = (over: Partial<RematchRun> = {}): RematchRun => ({ dryRun: false, total: 3, processed: 3, done: 2, failed: 1, startedAt: new Date(1000), finishedAt: new Date(2500), ...over });

  it("formats plan, item and summary lines", () => {
    expect(formatPlanLine(item)).toBe("  club Skogen (skogen.ocd) abcdef012345 (importer)");
    const done: RematchItemResult = { ...item, outcome: "done", jobId: "j", newDocumentHash: "0123456789abcdef00", error: null };
    expect(formatRematchLine(done, { processed: 1, total: 3 })).toBe("[1/3] club Skogen (skogen.ocd) abcdef012345 (importer) → 0123456789ab");
    expect(formatRematchLine({ ...done, newDocumentHash: item.documentHash }, { processed: 1, total: 3 })).toContain("(unchanged)");
    expect(formatRematchLine({ ...done, outcome: "failed", newDocumentHash: null, error: "boom" }, { processed: 2, total: 3 })).toBe("[2/3] club Skogen (skogen.ocd) abcdef012345 (importer) → FAILED: boom");
    expect(formatRematchSummary(run())).toBe("re-match done: 2 re-matched, 1 failed, 3 total in 1.5 s");
    expect(formatRematchSummary(run({ dryRun: true }))).toBe("dry run: 3 pin(s) would be re-matched");
  });
});
