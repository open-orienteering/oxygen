import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { ReplayData } from "@oxygen/shared";

export type StartMode = "real" | "mass" | "legs";
export type FollowMode = "off" | "all";

/** How often the React-bound `elapsedMs` (used by the timeline UI) is
 *  refreshed during playback. The internal time ref advances every animation
 *  frame; React state only needs to keep the slider/label readable. */
const REACT_REFRESH_MS = 100;

export interface ReplayState {
  /**
   * Elapsed time in ms from the logical start of the current segment.
   * Updates at ~10 Hz during playback so the slider/label stay readable
   * without re-rendering the entire viewer every frame. For the canvas
   * drawing path, prefer `getElapsedMs()`.
   */
  elapsedMs: number;
  isPlaying: boolean;
  speed: number;
  startMode: StartMode;
  followMode: FollowMode;
  /** Total duration of the current segment in ms. */
  totalDurationMs: number;
  /** Set of visible participant IDs. */
  visibleParticipants: Set<string>;
  /** Index of the control to restart from (null = full course). */
  restartControlIdx: number | null;
  /** In legs mode: current leg index (0-based). */
  currentLeg: number;
  /** Total number of legs. */
  totalLegs: number;

  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setSpeed: (speed: number) => void;
  setElapsed: (ms: number) => void;
  setStartMode: (mode: StartMode) => void;
  setFollowMode: (mode: FollowMode) => void;
  toggleParticipant: (id: string) => void;
  showAll: () => void;
  hideAll: () => void;
  showOnly: (ids: string[]) => void;
  restartFromControl: (controlIdx: number | null) => void;
  /** In legs mode, go to next/prev leg. */
  nextLeg: () => void;
  prevLeg: () => void;

  /** Stable: returns the current waypoint time for a participant, reading
   *  from the live time ref. Safe to call inside RAF loops. */
  getRouteTime: (participantId: string) => number;
  /** Stable: returns the current `elapsedMs` from the live time ref. */
  getElapsedMs: () => number;
  /**
   * Subscribe to time changes (fired every animation frame during playback,
   * plus on every external seek). Returns an unsubscribe function.
   */
  subscribeElapsed: (cb: () => void) => () => void;
  /**
   * Advance the playback time by `dtRealMs` real-time milliseconds, scaled by
   * the current speed. Handles end-of-segment / leg auto-advance. Should be
   * called from the orchestrator RAF when `isPlaying` is true.
   */
  advanceTime: (dtRealMs: number) => void;
}

export interface ReplayConfig {
  /** Initial speed multiplier (default 32). */
  defaultSpeed?: number;
  /** Initial follow mode (default "all"). */
  defaultFollowMode?: FollowMode;
  /** Auto-start playback when data loads. */
  autoPlay?: boolean;
  /** Only show these participant IDs initially (others hidden). */
  initialVisibleIds?: string[];
}

export function useReplayState(data: ReplayData | undefined, config?: ReplayConfig): ReplayState {
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(config?.defaultSpeed ?? 32);
  const [startMode, setStartMode] = useState<StartMode>("mass");
  const [followMode, setFollowMode] = useState<FollowMode>(config?.defaultFollowMode ?? "all");
  const [elapsedMs, setElapsedMsState] = useState(0);
  const [visibleParticipants, setVisibleParticipants] = useState<Set<string>>(
    new Set(),
  );
  const [restartControlIdx, setRestartControlIdx] = useState<number | null>(null);
  const [currentLeg, setCurrentLeg] = useState(0);

  // ── Live time ref + pub/sub ───────────────────────────────
  // The canonical "what time is it right now" value lives in this ref so the
  // animation loop can update it 60 times per second without triggering React
  // re-renders. The React `elapsedMs` state above is a throttled mirror used
  // only by UI consumers (slider, label).
  const elapsedRef = useRef(0);
  const subscribersRef = useRef<Set<() => void>>(new Set());
  const lastReactRefreshRef = useRef(0);

  // ── Per-route timing info ──
  const routeInfo = useMemo(() => {
    if (!data) return {
      raceStarts: new Map<string, number>(),
      globalStart: 0, globalEnd: 0,
      maxIndividualDuration: 0,
    };

    const raceStarts = new Map<string, number>();
    let globalStart = Infinity;
    let globalEnd = -Infinity;
    let maxIndividualDuration = 0;

    for (const route of data.routes) {
      if (route.waypoints.length === 0) continue;
      const start = route.raceStartMs ?? route.waypoints[0].timeMs;
      const last = route.waypoints[route.waypoints.length - 1].timeMs;
      raceStarts.set(route.participantId, start);
      if (start < globalStart) globalStart = start;
      if (last > globalEnd) globalEnd = last;
      const dur = last - start;
      if (dur > maxIndividualDuration) maxIndividualDuration = dur;
    }
    if (!isFinite(globalStart)) { globalStart = 0; globalEnd = 0; }
    return { raceStarts, globalStart, globalEnd, maxIndividualDuration };
  }, [data]);

  const { raceStarts, globalStart, globalEnd, maxIndividualDuration } = routeInfo;

  // ── Bounds restricted to visible participants (used in real-time mode) ──
  const visibleBounds = useMemo(() => {
    let start = Infinity, end = -Infinity;
    for (const route of data?.routes ?? []) {
      if (!visibleParticipants.has(route.participantId)) continue;
      if (route.waypoints.length === 0) continue;
      const s = route.raceStartMs ?? route.waypoints[0].timeMs;
      const e = route.waypoints[route.waypoints.length - 1].timeMs;
      if (s < start) start = s;
      if (e > end) end = e;
    }
    if (!isFinite(start)) return { start: globalStart, end: globalEnd };
    return { start, end };
  }, [data?.routes, visibleParticipants, globalStart, globalEnd]);

  // ── Per-participant split times at each control (for control restart + legs) ──
  const controlSplits = useMemo(() => {
    if (!data || data.courses.length === 0) return [];
    const course = data.courses[0];
    // For each control, build a map of participantId → absolute punch time
    return course.controls.map((ctrl) => {
      const map = new Map<string, number>();
      for (const route of data.routes) {
        if (!route.result?.splitTimes) continue;
        const start = raceStarts.get(route.participantId);
        if (start === undefined) continue;
        const split = route.result.splitTimes.find(s => s.controlCode === ctrl.code);
        if (split) {
          map.set(route.participantId, start + split.timeMs);
        }
      }
      return map;
    });
  }, [data, raceStarts]);

  const totalLegs = data?.courses[0]?.controls ? data.courses[0].controls.length - 1 : 0;

  // ── Duration depends on mode ──
  const totalDurationMs = useMemo(() => {
    if (startMode === "real") return visibleBounds.end - visibleBounds.start;
    if (startMode === "legs" && controlSplits.length > 1) {
      // Duration of the current leg: slowest of the VISIBLE runners, plus 2s buffer
      const fromSplits = controlSplits[currentLeg];
      const toSplits = controlSplits[currentLeg + 1];
      if (!fromSplits || !toSplits) return maxIndividualDuration;
      let maxLeg = 0;
      for (const [pid, toTime] of toSplits) {
        if (!visibleParticipants.has(pid)) continue;
        // For leg 0 the from time is raceStart, not fromSplits
        const fromTime = currentLeg === 0
          ? raceStarts.get(pid)
          : fromSplits.get(pid);
        if (fromTime !== undefined) {
          const leg = toTime - fromTime;
          if (leg > maxLeg) maxLeg = leg;
        }
      }
      return (maxLeg || maxIndividualDuration) + 2000; // +2s buffer before auto-advance
    }
    // Mass start or control restart
    if (restartControlIdx != null && controlSplits[restartControlIdx]) {
      // Duration from selected control to end: max time from control to finish
      const fromSplits = controlSplits[restartControlIdx];
      let maxDur = 0;
      for (const route of data?.routes ?? []) {
        if (route.waypoints.length === 0) continue;
        const fromTime = fromSplits.get(route.participantId);
        if (fromTime === undefined) continue;
        const endTime = route.waypoints[route.waypoints.length - 1].timeMs;
        const dur = endTime - fromTime;
        if (dur > maxDur) maxDur = dur;
      }
      return maxDur || maxIndividualDuration;
    }
    return maxIndividualDuration;
  }, [startMode, visibleBounds, maxIndividualDuration, controlSplits, currentLeg, restartControlIdx, data, visibleParticipants, raceStarts]);

  // ── Refs that the orchestrator/advanceTime need to read each frame ──
  // Kept in sync via effects so the closure-free RAF can read the latest
  // values without re-creating the function on every state change.
  //
  // `currentLegRef` and `restartControlIdxRef` additionally have to be
  // updated *synchronously* alongside any elapsed reset (leg auto-advance,
  // manual leg switch, restart-from-control) so the very next subscriber
  // notification reads the new value. Otherwise the canvas draws one
  // frame at "elapsed = 0" against the *previous* leg, snapping every
  // runner backwards before React commits and corrects it next frame.
  const speedRef = useRef(speed);
  const startModeRef = useRef(startMode);
  const currentLegRef = useRef(currentLeg);
  const totalLegsRef = useRef(totalLegs);
  const totalDurationMsRef = useRef(totalDurationMs);
  const restartControlIdxRef = useRef(restartControlIdx);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { startModeRef.current = startMode; }, [startMode]);
  useEffect(() => { currentLegRef.current = currentLeg; }, [currentLeg]);
  useEffect(() => { totalLegsRef.current = totalLegs; }, [totalLegs]);
  useEffect(() => { totalDurationMsRef.current = totalDurationMs; }, [totalDurationMs]);
  useEffect(() => { restartControlIdxRef.current = restartControlIdx; }, [restartControlIdx]);

  // ── Time write helper ─────────────────────────────────────
  const notify = useCallback(() => {
    for (const cb of subscribersRef.current) {
      cb();
    }
  }, []);

  /**
   * Write a new elapsed value to the time ref, notify subscribers, and
   * (throttled) refresh the React state. Pass `flushReact: true` for
   * user-driven seeks where we want the UI to track immediately.
   */
  const writeElapsed = useCallback((next: number, flushReact: boolean) => {
    const clamped = Math.max(0, Math.min(totalDurationMsRef.current, next));
    if (clamped === elapsedRef.current && !flushReact) return;
    elapsedRef.current = clamped;
    notify();
    const now = performance.now();
    if (flushReact || now - lastReactRefreshRef.current >= REACT_REFRESH_MS) {
      lastReactRefreshRef.current = now;
      setElapsedMsState(clamped);
    }
  }, [notify]);

  // ── Init when data changes ──
  useEffect(() => {
    if (!data) return;
    if (config?.initialVisibleIds) {
      setVisibleParticipants(new Set(config.initialVisibleIds));
    } else {
      setVisibleParticipants(new Set(data.routes.map((r) => r.participantId)));
    }
    elapsedRef.current = 0;
    // Sync the leg/restart-control refs synchronously so the `notify()`
    // call below redraws against the reset state, not the previous data's
    // leg/restart selection.
    currentLegRef.current = 0;
    restartControlIdxRef.current = null;
    setElapsedMsState(0);
    notify();
    setRestartControlIdx(null);
    setCurrentLeg(0);
    if (config?.autoPlay) {
      setIsPlaying(true);
    } else {
      setIsPlaying(false);
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps -- config is stable

  // ── advanceTime: called by the orchestrator while playing ─
  const advanceTime = useCallback((dtRealMs: number) => {
    const next = elapsedRef.current + dtRealMs * speedRef.current;
    if (next >= totalDurationMsRef.current) {
      if (startModeRef.current === "legs" && currentLegRef.current < totalLegsRef.current - 1) {
        // Auto-advance to next leg. Sync the ref BEFORE writeElapsed so
        // the synchronous subscriber notification draws the new leg, not
        // a one-frame snapshot of the old leg at elapsed=0.
        const newLeg = currentLegRef.current + 1;
        currentLegRef.current = newLeg;
        setCurrentLeg(newLeg);
        writeElapsed(0, true);
      } else {
        setIsPlaying(false);
        writeElapsed(totalDurationMsRef.current, true);
      }
    } else {
      writeElapsed(next, false);
    }
  }, [writeElapsed]);

  const play = useCallback(() => {
    if (elapsedRef.current >= totalDurationMsRef.current) {
      writeElapsed(0, true);
    }
    setIsPlaying(true);
  }, [writeElapsed]);

  const pause = useCallback(() => setIsPlaying(false), []);

  const togglePlay = useCallback(() => {
    setIsPlaying((p) => {
      if (!p && elapsedRef.current >= totalDurationMsRef.current) {
        writeElapsed(0, true);
      }
      return !p;
    });
  }, [writeElapsed]);

  const setElapsedWrapped = useCallback(
    (ms: number) => writeElapsed(ms, true),
    [writeElapsed],
  );

  const toggleParticipant = useCallback((id: string) => {
    setVisibleParticipants((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const showAll = useCallback(() => {
    if (!data) return;
    setVisibleParticipants(new Set(data.routes.map((r) => r.participantId)));
  }, [data]);

  const hideAll = useCallback(() => setVisibleParticipants(new Set()), []);

  const showOnly = useCallback((ids: string[]) => {
    setVisibleParticipants(new Set(ids));
  }, []);

  const restartFromControl = useCallback((controlIdx: number | null) => {
    if (startMode === "legs" && controlIdx !== null) {
      // In legs mode: jump to the leg that starts at the clicked control.
      // Control at index N is the start of leg N (goes to control N+1).
      const newLeg = Math.min(controlIdx, Math.max(0, totalLegs - 1));
      currentLegRef.current = newLeg;
      setCurrentLeg(newLeg);
      writeElapsed(0, true);
      setIsPlaying(true);
      return;
    }
    restartControlIdxRef.current = controlIdx;
    setRestartControlIdx(controlIdx);
    writeElapsed(0, true);
    if (controlIdx != null) {
      setIsPlaying(true);
    }
  }, [startMode, totalLegs, writeElapsed]);

  const nextLeg = useCallback(() => {
    if (currentLeg < totalLegs - 1) {
      const newLeg = currentLegRef.current + 1;
      currentLegRef.current = newLeg;
      setCurrentLeg(newLeg);
      writeElapsed(0, true);
    }
  }, [currentLeg, totalLegs, writeElapsed]);

  const prevLeg = useCallback(() => {
    if (currentLeg > 0) {
      const newLeg = currentLegRef.current - 1;
      currentLegRef.current = newLeg;
      setCurrentLeg(newLeg);
      writeElapsed(0, true);
    }
  }, [currentLeg, writeElapsed]);

  // ── Convert elapsed → waypoint time ──
  // Stable: reads from `elapsedRef`, `currentLegRef`, and
  // `restartControlIdxRef` so the function identity does NOT change every
  // animation frame, AND so a synchronous leg/control switch (paired with
  // an immediate elapsed reset) is reflected in the very next subscriber
  // draw. Only the structural inputs (mode, splits, etc.) affect identity.
  const getRouteTime = useCallback(
    (participantId: string) => {
      const elapsed = elapsedRef.current;
      const raceStart = raceStarts.get(participantId) ?? globalStart;
      const liveCurrentLeg = currentLegRef.current;
      const liveRestartControlIdx = restartControlIdxRef.current;

      // Legs mode: offset from split time at current leg's start control.
      // For leg 0, the start control is the start triangle which has no split
      // time — use raceStartMs directly instead.
      // Each runner's time is capped at the leg's END control split time,
      // so they freeze and wait for the slowest runner before the next leg.
      if (startMode === "legs") {
        let legStartTime: number | undefined;
        if (liveCurrentLeg === 0) {
          legStartTime = raceStart;
        } else {
          legStartTime = controlSplits[liveCurrentLeg]?.get(participantId);
        }
        if (legStartTime !== undefined) {
          // Cap at the end control split time (runner stops there when done)
          const legEndSplit = controlSplits[liveCurrentLeg + 1]?.get(participantId);
          const cappedElapsed = legEndSplit !== undefined
            ? Math.min(elapsed, legEndSplit - legStartTime)
            : elapsed;
          return legStartTime + cappedElapsed;
        }
        return raceStart - 1; // no split data → hide
      }

      // Control restart: offset from split time at that control
      if (liveRestartControlIdx != null && controlSplits[liveRestartControlIdx]) {
        const splitTime = controlSplits[liveRestartControlIdx].get(participantId);
        if (splitTime !== undefined) return splitTime + elapsed;
        return raceStart - 1;
      }

      if (startMode === "real") return visibleBounds.start + elapsed;

      // Mass start: offset from each runner's race start
      return raceStart + elapsed;
    },
    [startMode, raceStarts, globalStart, visibleBounds, controlSplits],
  );

  const getElapsedMs = useCallback(() => elapsedRef.current, []);

  const subscribeElapsed = useCallback((cb: () => void) => {
    subscribersRef.current.add(cb);
    return () => {
      subscribersRef.current.delete(cb);
    };
  }, []);

  return {
    elapsedMs,
    isPlaying,
    speed,
    startMode,
    followMode,
    totalDurationMs,
    visibleParticipants,
    restartControlIdx,
    currentLeg,
    totalLegs,
    play,
    pause,
    togglePlay,
    setSpeed,
    setElapsed: setElapsedWrapped,
    setStartMode,
    setFollowMode,
    toggleParticipant,
    showAll,
    hideAll,
    showOnly,
    restartFromControl,
    nextLeg,
    prevLeg,
    getRouteTime,
    getElapsedMs,
    subscribeElapsed,
    advanceTime,
  };
}
