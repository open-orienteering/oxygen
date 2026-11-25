/**
 * SSR tests for the Eventor sync counts dialog and the per-field marker
 * (docs/system/eventor-sync.md). No DOM runner here, so renderToStaticMarkup.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import "../../i18n/i18n";
import { SyncCounts, type EventorSyncResult } from "../EventorSyncCounts";
import { EventorMarker } from "../EventorMarker";
import { createRunnerAnchors } from "../../lib/structured-search/anchors/runner-anchors";
import { applyFilters } from "../../lib/structured-search/filter";

const base = {
  runners: {
    added: 0, updated: 0, reinstated: 0, wouldCancel: 0, heldBack: 0, keptLocal: 0,
    classChangeBlocked: 0, cardConflicts: 0, duplicateEntries: 0, skippedNoId: 0, skippedResultsOnly: 0,
  },
  classes: { added: 0, updated: 0, keptLocal: 0, detailsIncomplete: false },
  clubs: { added: 0, updated: 0 },
  samples: { wouldCancel: [] as string[], heldBack: [] as string[] },
  cancelIds: [] as string[],
} as unknown as EventorSyncResult;

const withRunners = (r: Partial<EventorSyncResult["runners"]>, samples = base.samples) =>
  ({ ...base, runners: { ...base.runners, ...r }, samples }) as EventorSyncResult;

describe("SyncCounts", () => {
  it("says everything is up to date when all counts are zero", () => {
    const html = renderToStaticMarkup(<SyncCounts result={base} title="T" testId="x" />);
    expect(html).toContain('data-testid="x"');
    expect(html).not.toContain("<li");
  });

  it("lists only the non-zero counts and the names behind cancels and holds", () => {
    const html = renderToStaticMarkup(
      <SyncCounts
        result={withRunners(
          { added: 2, wouldCancel: 1, heldBack: 1, duplicateEntries: 3, skippedNoId: 4 },
          { wouldCancel: ["Anna Ek"], heldBack: ["Bo Berg"] },
        )}
        title="T"
        testId="x"
      />,
    );
    expect(html.match(/<li/g)?.length).toBe(5);
    expect(html).toContain("Anna Ek");
    expect(html).toContain("Bo Berg");
    expect(html).toContain("3");
    expect(html).toContain("4");
  });
});

describe("SyncCounts wording", () => {
  it("uses the singular form for a count of one", () => {
    const html = renderToStaticMarkup(<SyncCounts result={withRunners({ added: 1, skippedResultsOnly: 2 })} title="T" testId="x" />);
    expect(html).toContain("1 runner added");
    expect(html).not.toContain("1 runners");
    expect(html).toContain("2 people");
  });
});

describe("EventorMarker", () => {
  const diff = { field: "cardNo", local: 1, eventor: 777 } as never;

  it("shows Eventor's value and the use button", () => {
    const html = renderToStaticMarkup(<EventorMarker diff={diff} onUse={() => {}} pending={false} error={null} />);
    expect(html).toContain('data-testid="eventor-marker-cardNo"');
    expect(html).toContain('data-testid="eventor-use-cardNo"');
    expect(html).toContain("777");
    expect(html).not.toContain("disabled=");
  });

  it("disables the button while pending and shows an error only when given", () => {
    const pending = renderToStaticMarkup(<EventorMarker diff={diff} onUse={() => {}} pending error="boom" />);
    expect(pending).toContain("disabled=");
    expect(pending).toContain("boom");
  });
});

describe("runner eventor anchor", () => {
  const anchors = createRunnerAnchors((k) => k);
  const items = [
    { id: 1, differsFromEventor: true },
    { id: 2, goneFromEventor: true },
    { id: 3 },
  ] as never[];
  const ids = (v: string) =>
    applyFilters(items, [{ id: "1", anchor: "eventor", operator: "eq" as const, value: v }], anchors as never).map(
      (r: { id: number }) => r.id,
    );

  it("filters differs and gone", () => {
    expect(ids("differs")).toEqual([1]);
    expect(ids("gone")).toEqual([2]);
  });
});
