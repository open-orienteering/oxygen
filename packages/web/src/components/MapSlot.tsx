import { useMapState } from "../lib/map-props-store";
import { MapPanel, type MapPanelPublicProps } from "./MapPanel";
import { useIsWideViewport } from "./map-pane-shared";

/**
 * Page-facing API for the persistent map pane.
 *
 * Each page that wants to drive the map renders `<MapSlot ...props />`
 * (no children — earlier children-portal API removed). At runtime:
 *
 * - **Wide viewport:** the props are published to the shell-owned
 *   `map-props-store`. The persistent `<MapPanel>` in `MapPane` consumes
 *   them and reconfigures without remounting. The slot itself renders
 *   nothing locally. Whether the pane is visually shown is up to the
 *   user's collapsed preference — but we publish either way so the
 *   "show map" header button knows there's content to re-reveal.
 *
 * - **Narrow viewport:** the slot renders `<MapPanel>` inline at this
 *   location, matching the legacy in-page placement. MapPanel still
 *   remounts on navigation in this branch, but narrow isn't the
 *   perf-critical path.
 */
export function MapSlot(props: MapPanelPublicProps) {
  const isWide = useIsWideViewport();

  // Always call the hook (`null` when narrow so the store clears when
  // the user resizes to narrow on a page with an active slot).
  useMapState(isWide ? props : null);

  if (isWide) return null;
  return <MapPanel {...props} />;
}
