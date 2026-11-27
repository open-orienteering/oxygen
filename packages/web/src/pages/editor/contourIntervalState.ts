/** The state and helpers behind the contour interval UI (docs/course-elevation.md §0.43); components are in ContourInterval.tsx. */

import { useEffect } from "react";
import { useCapabilities } from "../../context/CapabilitiesContext";
import { trpc } from "../../lib/trpc";

/** The values offered as suggestions; any value above 0 up to 100 with two decimals is accepted (§0.43). */
export const INTERVAL_SUGGESTIONS = [2, 2.5, 5, 10, 20, 25] as const;
const OPEN_MAP_INFO = "oxygen:open-map-info";

/** Opens the map info dialog (the top bar's `MapInfoButton` listens). */
export const openMapInfoAtInterval = (): void => { window.dispatchEvent(new CustomEvent(OPEN_MAP_INFO)); };

/** The map info button's listener. */
export function useOpenMapInfoRequest(open: () => void): void {
  useEffect(() => {
    window.addEventListener(OPEN_MAP_INFO, open);
    return () => window.removeEventListener(OPEN_MAP_INFO, open);
  }, [open]);
}

export { parseContourInterval as parseInterval } from "@oxygen/shared/src/terrain/profile/index.js";

export function useContourInterval() {
  const utils = trpc.useUtils();
  // A club map's value is its uploader's or an admin's to change (the server says so in `mayChange`).
  const canEditCourses = useCapabilities().has("courses.edit");
  const meta = trpc.course.mapMetadata.useQuery(undefined, { staleTime: Number.POSITIVE_INFINITY });
  const mutation = trpc.course.setContourInterval.useMutation({
    // The server clears and recomputes the stored climbs in the background (followups 20): what shows them is read again.
    onSuccess: async () => { await Promise.all([utils.course.mapMetadata.invalidate(), utils.course.list.invalidate(), utils.course.detail.invalidate()]); },
  });
  const data = meta.data?.contourInterval ?? null;
  const canEdit = canEditCourses && data?.mayChange !== false;
  const hasContours = meta.data?.terrain ? meta.data.terrain.state === "ready" || meta.data.terrain.state === "pending" : false;
  return {
    data, canEdit, hasContours,
    saving: mutation.isPending,
    error: mutation.error?.message ?? null,
    save: (intervalM: number | null) => mutation.mutateAsync({ intervalM }).then(() => undefined, () => undefined),
  };
}

