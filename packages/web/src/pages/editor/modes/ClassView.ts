/**
 * Class view (docs/course-layout.md §6; research 08 §5.4 "the course as
 * the class prints it — the layout preview without leaving Course mode"):
 * Course mode's tools stay live while the course layer draws through the
 * class's sheet — `courseMap.resolveSheet { classSeq }`, the class's own
 * sheet or its course's with the override applied — as Layout mode draws a
 * sheet: the overprint at the class's scale, the page part, the map clipped
 * to the frame.
 */

import { useEffect, useMemo, useRef } from "react";
import { trpc } from "../../../lib/trpc";
import type { LayoutRequest } from "../../../lib/course-layer-request";
import { pageBounds } from "../../../lib/editor/layout";
import { geometryOf, layoutRequestOf, sheetKeyOf, snapshotOf, type EditorSheet } from "../layout/model";

export interface ClassView {
  /** The course layer's sheet; null outside Class view or before the read. */
  layout: LayoutRequest | null;
  data: EditorSheet | null;
  /** The read failed (no sheet for the class's course: `NOT_FOUND`, or no template). */
  missing: boolean;
  /** The status bar's sheet key. */
  sheetKey: string | null;
}

export function useClassView(a: { enabled: boolean; classSeq: number | null; onFit: (bounds: ReturnType<typeof pageBounds>) => void }): ClassView {
  const on = a.enabled && a.classSeq !== null;
  const query = trpc.courseMap.resolveSheet.useQuery({ classSeq: a.classSeq ?? 1 }, { enabled: on, retry: false });
  const data = on && query.data ? query.data : null;
  const geometry = useMemo(() => (data ? geometryOf(data, snapshotOf(data)) : null), [data]);
  const layout = useMemo(() => (data && geometry ? layoutRequestOf(data, snapshotOf(data), geometry) : null), [data, geometry]);
  // A class opens fitted on its page, once per class.
  const fitted = useRef<number | null>(null);
  const { onFit } = a;
  useEffect(() => {
    if (!on) { fitted.current = null; return; }
    if (geometry && fitted.current !== a.classSeq) { fitted.current = a.classSeq; onFit(pageBounds(geometry)); }
  }, [on, geometry, a.classSeq, onFit]);
  const snap = data ? snapshotOf(data) : null;
  return { layout, data, missing: on && query.isError, sheetKey: snap ? sheetKeyOf(snap) : null };
}
