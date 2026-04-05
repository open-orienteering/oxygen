import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { ReplayData } from "@oxygen/shared";

export type StartMode = "real" | "mass" | "legs";
export type FollowMode = "off" | "all";

export interface ReplayState {
  /** Elapsed time in ms from the logical start of the current segment. */
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

  getRouteTime: (participantId: string) => number;
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
  const [elapsedMs, setElapsedMs] = useState(0);
  const [visibleParticipants, setVisibleParticipants] = useState<Set<string>>(
    new Set(),
  );
  const [restartControlIdx, setRestartControlIdx] = useState<number | null>(null);
  const [currentLeg, setCurrentLeg] = useState(0);

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
    if (startMode === "real") return globalEnd - globalStart;
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
  }, [startMode, globalEnd, globalStart, maxIndividualDuration, controlSplits, currentLeg, restartControlIdx, data, visibleParticipants, raceStarts]);

  // ── Init when data changes ──
  useEffect(() => {
    if (!data) return;
    if (config?.initialVisibleIds) {
      setVisibleParticipants(new Set(config.initialVisibleIds));
    } else {
      setVisibleParticipants(new Set(data.routes.map((r) => r.participantId)));
    }
    setElapsedMs(0);
    setRestartControlIdx(null);
    setCurrentLeg(0);
    if (config?.autoPlay) {
      setIsPlaying(true);
    } else {
      setIsPlaying(false);
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps -- config is stable

  // ── Animation loop ──
  const lastFrameRef = useRef<number>(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }

    lastFrameRef.current = performance.now();

    const tick = (now: number) => {
      const dt = now - lastFrameRef.current;
      lastFrameRef.current = now;

      setElapsedMs((prev) => {
        const next = prev + dt * speed;
        if (next >= totalDurationMs) {
          if (startMode === "legs" && currentLeg < totalLegs - 1) {
            // Auto-advance to next leg
            setCurrentLeg((l) => l + 1);
            return 0;
          }
          setIsPlaying(false);
          return totalDurationMs;
        }
        return next;
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, speed, totalDurationMs, startMode, currentLeg, totalLegs]);

  const play = useCallback(() => {
    setElapsedMs((prev) => (prev >= totalDurationMs ? 0 : prev));
    setIsPlaying(true);
  }, [totalDurationMs]);

  const pause = useCallback(() => setIsPlaying(false), []);

  const togglePlay = useCallback(() => {
    setIsPlaying((p) => {
      if (!p) {
        setElapsedMs((prev) => (prev >= totalDurationMs ? 0 : prev));
      }
      return !p;
    });
  }, [totalDurationMs]);

  const setElapsedWrapped = useCallback(
    (ms: number) => setElapsedMs(Math.max(0, Math.min(totalDurationMs, ms))),
    [totalDurationMs],
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
      setCurrentLeg(Math.min(controlIdx, Math.max(0, totalLegs - 1)));
      setElapsedMs(0);
      setIsPlaying(true);
      return;
    }
    setRestartControlIdx(controlIdx);
    setElapsedMs(0);
    if (controlIdx != null) {
      setIsPlaying(true);
    }
  }, [startMode, totalLegs]);

  const nextLeg = useCallback(() => {
    if (currentLeg < totalLegs - 1) {
      setCurrentLeg((l) => l + 1);
      setElapsedMs(0);
    }
  }, [currentLeg, totalLegs]);

  const prevLeg = useCallback(() => {
    if (currentLeg > 0) {
      setCurrentLeg((l) => l - 1);
      setElapsedMs(0);
    }
  }, [currentLeg]);

  // ── Convert elapsed → waypoint time ──
  const getRouteTime = useCallback(
    (participantId: string) => {
      const raceStart = raceStarts.get(participantId) ?? globalStart;

      // Legs mode: offset from split time at current leg's start control.
      // For leg 0, the start control is the start triangle which has no split
      // time — use raceStartMs directly instead.
      // Each runner's time is capped at the leg's END control split time,
      // so they freeze and wait for the slowest runner before the next leg.
      if (startMode === "legs") {
        let legStartTime: number | undefined;
        if (currentLeg === 0) {
          legStartTime = raceStart;
        } else {
          legStartTime = controlSplits[currentLeg]?.get(participantId);
        }
        if (legStartTime !== undefined) {
          // Cap at the end control split time (runner stops there when done)
          const legEndSplit = controlSplits[currentLeg + 1]?.get(participantId);
          const cappedElapsed = legEndSplit !== undefined
            ? Math.min(elapsedMs, legEndSplit - legStartTime)
            : elapsedMs;
          return legStartTime + cappedElapsed;
        }
        return raceStart - 1; // no split data → hide
      }

      // Control restart: offset from split time at that control
      if (restartControlIdx != null && controlSplits[restartControlIdx]) {
        const splitTime = controlSplits[restartControlIdx].get(participantId);
        if (splitTime !== undefined) return splitTime + elapsedMs;
        return raceStart - 1;
      }

      if (startMode === "real") return globalStart + elapsedMs;

      // Mass start: offset from each runner's race start
      return raceStart + elapsedMs;
    },
    [startMode, elapsedMs, raceStarts, globalStart, controlSplits, currentLeg, restartControlIdx],
  );

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
  };
}
