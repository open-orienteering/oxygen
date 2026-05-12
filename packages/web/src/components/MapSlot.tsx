import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  PortaledContext,
  useIsWideViewport,
} from "./map-pane-shared";

interface MapSlotContextValue {
  /**
   * The DOM element children should portal into when the pane is active.
   * `null` means the shell hasn't mounted the pane yet.
   */
  target: HTMLElement | null;
  /**
   * Called by each mounted `<MapSlot>` so the shell can count available
   * slots. Pass `true` on mount, `false` on unmount. The provider counts
   * registrations and surfaces a single `paneActive` flag, which the shell
   * uses to decide whether to expand the pane / show the "show map" button.
   * Slots register whenever the viewport is wide, regardless of the user's
   * collapsed preference — that way the shell knows when to surface the
   * "show map" affordance even while the pane is hidden.
   */
  registerSlot: (active: boolean) => void;
  /**
   * Whether the slot should portal (true) or render inline (false). The
   * provider derives this from the viewport breakpoint, the user's
   * collapsed preference, and the pane target existing.
   */
  shouldPortal: boolean;
}

const MapSlotContext = createContext<MapSlotContextValue>({
  target: null,
  registerSlot: () => {},
  shouldPortal: false,
});

interface ProviderProps {
  target: HTMLElement | null;
  /** Called whenever the count of mounted slots crosses 0. */
  onActiveChange: (active: boolean) => void;
  /** False when the user collapsed the pane; the slot then renders inline. */
  paneEnabled: boolean;
  children: ReactNode;
}

export function MapSlotProvider({
  target,
  onActiveChange,
  paneEnabled,
  children,
}: ProviderProps) {
  const isWide = useIsWideViewport();
  const [count, setCount] = useState(0);

  const registerSlot = useCallback((active: boolean) => {
    setCount((c) => c + (active ? 1 : -1));
  }, []);

  useEffect(() => {
    onActiveChange(count > 0);
  }, [count, onActiveChange]);

  // The slot actually portals only when wide AND the user hasn't collapsed
  // the pane AND the target DOM element exists. Registration is gated only
  // on `isWide` so the shell can keep tracking "is there a map on this
  // page" even while the user hides the pane.
  const shouldPortal = isWide && paneEnabled && target != null;

  const value = useMemo<MapSlotContextValue>(
    () => ({ target, registerSlot, shouldPortal }),
    [target, registerSlot, shouldPortal],
  );

  return (
    <MapSlotContext.Provider value={value}>{children}</MapSlotContext.Provider>
  );
}

interface SlotProps {
  children: ReactNode;
}

/**
 * Wraps a `<MapPanel>` (or any map-shaped JSX) so that on wide viewports
 * it portals into the shell-owned right pane, and on narrow viewports it
 * renders inline at its declared location. The wrapped children are
 * unchanged either way — they remount when the location changes, which is
 * acceptable because the map's underlying queries are cached.
 */
export function MapSlot({ children }: SlotProps) {
  const { target, registerSlot, shouldPortal } = useContext(MapSlotContext);
  const isWide = useIsWideViewport();

  // Slots register whenever the viewport is wide. Whether the slot
  // _actually_ portals is decided by the provider's `shouldPortal`, which
  // additionally considers the user's collapsed preference and the target
  // DOM element being mounted.
  useEffect(() => {
    if (!isWide) return;
    registerSlot(true);
    return () => registerSlot(false);
  }, [isWide, registerSlot]);

  if (shouldPortal && target) {
    return (
      <PortaledContext.Provider value={true}>
        {createPortal(
          <div
            className="h-full w-full"
            data-testid="map-slot-portaled"
          >
            {children}
          </div>,
          target,
        )}
      </PortaledContext.Provider>
    );
  }
  return (
    <PortaledContext.Provider value={false}>{children}</PortaledContext.Provider>
  );
}
