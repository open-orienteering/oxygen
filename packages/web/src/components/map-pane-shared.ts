import { createContext, useContext } from "react";
import { useMediaQuery } from "../hooks/useMediaQuery";

/**
 * Breakpoint (in px) above which the two-pane layout activates. The default
 * is 2200, but power users can override it from DevTools via
 *   localStorage.setItem("oxygen.mapPane.breakpoint", "1920")
 * and reloading. We deliberately don't expose this in a Settings UI yet —
 * it's a niche knob that depends on physical monitor size.
 */
export const DEFAULT_WIDE_BREAKPOINT = 2200;

export function getWideBreakpoint(): number {
  if (typeof window === "undefined") return DEFAULT_WIDE_BREAKPOINT;
  try {
    const raw = window.localStorage.getItem("oxygen.mapPane.breakpoint");
    if (!raw) return DEFAULT_WIDE_BREAKPOINT;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 768) return DEFAULT_WIDE_BREAKPOINT;
    return parsed;
  } catch {
    return DEFAULT_WIDE_BREAKPOINT;
  }
}

/**
 * Reactive hook: true when the viewport is at or above the configured
 * wide-screen breakpoint. Reads the breakpoint synchronously from
 * localStorage per render so a power-user tweak takes effect on the first
 * re-render after reload.
 */
export function useIsWideViewport(): boolean {
  const breakpoint = getWideBreakpoint();
  return useMediaQuery(`(min-width: ${breakpoint}px)`);
}

/**
 * Internal context that flips to `true` only inside the React subtree of a
 * `<MapSlot>` that is currently portaling. Exported so `MapSlot` can set
 * its value; consumers should use `useIsPortaled()` instead of reading the
 * context directly.
 */
export const PortaledContext = createContext(false);

/**
 * Hook for child components (e.g. `MapPanel`) that need to know whether
 * they're currently rendered inside the portaled pane vs. inline. Returns
 * `false` outside any `<MapSlot>`.
 */
export function useIsPortaled(): boolean {
  return useContext(PortaledContext);
}
