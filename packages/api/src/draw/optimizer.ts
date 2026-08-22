/**
 * Multi-class corridor optimizer.
 *
 * Assigns classes to parallel start corridors and computes first-start times.
 * Classes on the same course are grouped into one corridor so they run
 * sequentially; groups are distributed across corridors via LPT (Longest
 * Processing Time first) for balanced total depth.
 *
 * A class occupies its corridor until the end of its last runner's *slot*
 * (last start + interval), so consecutive classes in a corridor abut instead
 * of leaving a hole. Corridors can additionally be phase-shifted against each
 * other (`staggerOffset`) so N parallel corridors on a 2-minute interval yield
 * N/2 starters per minute rather than N starters every second minute.
 *
 * Classes that share a first control may still run in parallel — they just
 * have to interleave. The scheduler tracks every start heading for each first
 * control and delays a class until all of its starts sit at least
 * `minFirstControlGap` apart from the ones already booked on that control.
 * Two classes on a 2-minute interval sharing control 31 therefore end up on
 * alternating minutes rather than one waiting for the other to finish.
 */

export interface ClassCourseInfo {
  classId: number;
  runnerCount: number;
  courseId: number;
  /** First control codes of the course; only the first is used for spacing. */
  initialControls: number[];
  /** Per-class interval in deciseconds */
  interval: number;
  /** If provided, the class is pinned to this first-start time */
  fixedFirstStart?: number;
  /** Pin to a specific corridor (user override from drag) */
  corridorHint?: number;
  /** Stacking order within corridor (lower = earlier) */
  orderHint?: number;
  /**
   * Manual shift in deciseconds applied to this class's block. For the first
   * class in a corridor it replaces the corridor's stagger phase; for stacked
   * classes it shifts the block relative to its computed position.
   */
  startOffset?: number;
}

export interface CorridorAssignment {
  classId: number;
  corridor: number;
  computedFirstStart: number;
}

export interface OptimizerSettings {
  firstStart: number;
  baseInterval: number;
  maxParallelStarts: number;
  /** Enforce `minFirstControlGap` between starts heading for the same control. */
  detectCourseOverlap: boolean;
  /**
   * Phase shift between adjacent corridors in deciseconds. 0 or undefined
   * disables staggering; corridor k is shifted by `k * staggerOffset`, wrapped
   * within the interval of the corridor's first class.
   */
  staggerOffset?: number;
  /**
   * Minimum time in deciseconds between two runners heading for the same
   * first control. Defaults to `DEFAULT_FIRST_CONTROL_GAP` (one minute).
   */
  minFirstControlGap?: number;
}

/** One minute — the usual spacing between runners towards a shared control. */
export const DEFAULT_FIRST_CONTROL_GAP = 600;

/**
 * Build an adjacency graph of classes that must share a corridor.
 * Only a shared course qualifies: those runners follow the same route the
 * whole way, so they belong in one sequential block. Classes that merely
 * share a first control are spaced at the control instead (see
 * `firstControlShift`), which lets them run in parallel corridors.
 */
function buildConflictGraph(
  classes: ClassCourseInfo[],
): Map<number, Set<number>> {
  const graph = new Map<number, Set<number>>();
  for (const c of classes) {
    graph.set(c.classId, new Set());
  }

  for (let i = 0; i < classes.length; i++) {
    for (let j = i + 1; j < classes.length; j++) {
      const a = classes[i];
      const b = classes[j];
      if (a.courseId > 0 && a.courseId === b.courseId) {
        graph.get(a.classId)!.add(b.classId);
        graph.get(b.classId)!.add(a.classId);
      }
    }
  }

  return graph;
}

/** The control a class's runners head for first, or null if unknown. */
function firstControl(cls: ClassCourseInfo): number | null {
  return cls.initialControls[0] ?? null;
}

/**
 * Every start time a class produces from a given first start. A mass start
 * (interval 0) is a single instant at the control no matter how many runners
 * it has.
 */
function classStartTimes(cls: ClassCourseInfo, firstStart: number): number[] {
  if (cls.runnerCount <= 0) return [];
  if (cls.interval <= 0) return [firstStart];
  return Array.from(
    { length: cls.runnerCount },
    (_, i) => firstStart + i * cls.interval,
  );
}

/**
 * Smallest start ≥ `start` at which none of the class's starts land within
 * `gap` of a start already booked on the same control, or null if `start`
 * already works. Resolves one collision at a time; the caller re-checks.
 */
function firstControlShift(
  cls: ClassCourseInfo,
  start: number,
  booked: number[],
  gap: number,
): number | null {
  if (gap <= 0 || booked.length === 0) return null;
  for (const t of classStartTimes(cls, start)) {
    // Nearest booked start on either side of t.
    let lo = 0;
    let hi = booked.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (booked[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    for (const idx of [lo - 1, lo]) {
      const other = booked[idx];
      if (other === undefined) continue;
      if (Math.abs(other - t) < gap) return start + (other + gap - t);
    }
  }
  return null;
}

function insertSorted(list: number[], value: number): void {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, value);
}

/** Span from the class's first start to its last runner's start. */
function classDuration(cls: ClassCourseInfo): number {
  return Math.max(0, (cls.runnerCount - 1) * cls.interval);
}

/**
 * The block a class occupies in its corridor: first start through the end of
 * its last runner's slot, widened to at least `baseInterval` so classes with
 * a short interval still leave a usable gap at the start gate. The next class
 * in the corridor starts exactly where this block ends.
 */
function classBlockSpan(cls: ClassCourseInfo, baseInterval: number): number {
  if (cls.runnerCount <= 0) return baseInterval;
  return classDuration(cls) + Math.max(cls.interval, baseInterval);
}

/**
 * Phase shift for a corridor. Wrapping within the interval keeps every
 * corridor inside the same start window while spreading starters evenly
 * across the minutes of that interval.
 */
function corridorPhase(
  corridor: number,
  staggerOffset: number | undefined,
  interval: number,
): number {
  if (!staggerOffset || corridor <= 0) return 0;
  const raw = corridor * staggerOffset;
  return interval > 0 ? raw % interval : raw;
}

/**
 * Find connected components in the conflict graph via BFS.
 * Each component is a group of classes that are transitively connected
 * through course conflicts and must share a corridor.
 */
function findConflictComponents(
  classIds: number[],
  conflicts: Map<number, Set<number>>,
): number[][] {
  const visited = new Set<number>();
  const components: number[][] = [];

  for (const id of classIds) {
    if (visited.has(id)) continue;
    const component: number[] = [];
    const queue = [id];
    visited.add(id);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      component.push(cur);
      for (const neighbor of conflicts.get(cur) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }

  return components;
}

/**
 * Assign classes to corridors for balanced total duration.
 *
 * Conflicting classes are grouped into connected components and assigned
 * to the same corridor as a unit. Components are distributed via LPT
 * (largest total duration first → shortest corridor).
 *
 * Classes with corridorHint are pinned first; remaining components are
 * distributed for balance.
 */
function assignCorridors(
  classes: ClassCourseInfo[],
  maxCorridors: number,
  conflicts: Map<number, Set<number>>,
  baseInterval: number,
): Map<number, number> {
  const corridorMap = new Map<number, number>();
  const corridorLoad = new Array(maxCorridors).fill(0);
  const classById = new Map(classes.map((c) => [c.classId, c]));

  // Pin classes with corridorHint first
  const pinned = new Set<number>();
  for (const cls of classes) {
    if (cls.corridorHint !== undefined) {
      const cor = Math.min(cls.corridorHint, maxCorridors - 1);
      corridorMap.set(cls.classId, cor);
      corridorLoad[cor] += classBlockSpan(cls, baseInterval);
      pinned.add(cls.classId);
    }
  }

  // Build components from unpinned classes only
  const unpinnedIds = classes
    .filter((c) => !pinned.has(c.classId))
    .map((c) => c.classId);

  const components = findConflictComponents(unpinnedIds, conflicts);

  // Compute total duration for each component
  const componentDurations = components.map((comp) => {
    let total = 0;
    for (const id of comp) {
      const cls = classById.get(id)!;
      total += classBlockSpan(cls, baseInterval);
    }
    return { members: comp, duration: total };
  });

  // Sort components by total duration descending (LPT)
  componentDurations.sort((a, b) => b.duration - a.duration);

  // Assign each component to the shortest corridor
  for (const comp of componentDurations) {
    let bestCor = 0;
    for (let i = 1; i < maxCorridors; i++) {
      if (corridorLoad[i] < corridorLoad[bestCor]) {
        bestCor = i;
      }
    }
    for (const id of comp.members) {
      corridorMap.set(id, bestCor);
    }
    corridorLoad[bestCor] += comp.duration;
  }

  return corridorMap;
}

/**
 * Main optimizer entry point.
 *
 * 1. Groups same-course classes into components.
 * 2. Assigns components to corridors for balanced duration (LPT).
 * 3. Stacks classes slot-tight within each corridor, phase-shifted by the
 *    corridor stagger and any per-class offset.
 * 4. Delays classes until they clear both same-course blocks in other
 *    corridors and the minimum gap on their first control.
 */
export function optimizeStartTimes(
  classes: ClassCourseInfo[],
  settings: OptimizerSettings,
): CorridorAssignment[] {
  if (classes.length === 0) return [];

  const fixedClasses = classes.filter((c) => c.fixedFirstStart !== undefined);
  const autoClasses = classes.filter((c) => c.fixedFirstStart === undefined);

  const conflicts = buildConflictGraph(autoClasses);
  const corridorMap = assignCorridors(
    autoClasses,
    settings.maxParallelStarts,
    conflicts,
    settings.baseInterval,
  );

  // Group by corridor
  const corridors = new Map<number, ClassCourseInfo[]>();
  for (const cls of autoClasses) {
    const cor = corridorMap.get(cls.classId) ?? 0;
    const list = corridors.get(cor) ?? [];
    list.push(cls);
    corridors.set(cor, list);
  }

  // Sort within each corridor: by orderHint (if set), then by duration desc
  for (const [, classList] of corridors) {
    classList.sort((a, b) => {
      const aHint = a.orderHint ?? Infinity;
      const bHint = b.orderHint ?? Infinity;
      if (aHint !== bHint) return aHint - bHint;
      return classDuration(b) - classDuration(a);
    });
  }

  interface ScheduledClass {
    classId: number;
    corridor: number;
    startTime: number;
    endTime: number;
  }

  const scheduled: ScheduledClass[] = [];
  const results: CorridorAssignment[] = [];

  // Start times already booked on each first control, ascending.
  const controlBookings = new Map<number, number[]>();
  const gap = settings.detectCourseOverlap
    ? (settings.minFirstControlGap ?? DEFAULT_FIRST_CONTROL_GAP)
    : 0;

  function book(cls: ClassCourseInfo, start: number): void {
    const control = firstControl(cls);
    if (gap <= 0 || control === null) return;
    const booked = controlBookings.get(control) ?? [];
    for (const t of classStartTimes(cls, start)) insertSorted(booked, t);
    controlBookings.set(control, booked);
  }

  // Schedule fixed classes first — they cannot move, so they claim their
  // slots at the control before anything else is placed.
  for (const cls of fixedClasses) {
    scheduled.push({
      classId: cls.classId,
      corridor: -1,
      startTime: cls.fixedFirstStart!,
      endTime: cls.fixedFirstStart! + classBlockSpan(cls, settings.baseInterval),
    });
    results.push({
      classId: cls.classId,
      corridor: -1,
      computedFirstStart: cls.fixedFirstStart!,
    });
    book(cls, cls.fixedFirstStart!);
  }

  // Process corridors in order
  const sortedCorridors = [...corridors.keys()].sort((a, b) => a - b);

  for (const corridor of sortedCorridors) {
    const classList = corridors.get(corridor)!;
    const phase = corridorPhase(
      corridor,
      settings.staggerOffset,
      classList[0]?.interval ?? 0,
    );
    let nextStart = settings.firstStart + phase;
    let isFirstInCorridor = true;

    for (const cls of classList) {
      // A per-class offset replaces the stagger phase for the corridor's
      // leading class, and shifts stacked classes relative to their slot.
      let start = isFirstInCorridor
        ? settings.firstStart + (cls.startOffset ?? phase)
        : nextStart + (cls.startOffset ?? 0);
      isFirstInCorridor = false;
      const span = classBlockSpan(cls, settings.baseInterval);
      const control = firstControl(cls);
      const booked = control !== null ? controlBookings.get(control) : undefined;

      // Delay until the class clears both constraints. Every step moves
      // `start` strictly forward, so the loop terminates; the bound is there
      // to keep a pathological input from spinning.
      const conflictIds = conflicts.get(cls.classId);
      const maxSteps = scheduled.length + (booked?.length ?? 0) + 2;
      for (let step = 0; step < maxSteps; step++) {
        // Same-course block in another corridor (residual conflict, e.g. when
        // pinning split a component across corridors).
        let shifted = false;
        if (conflictIds && conflictIds.size > 0) {
          for (const sc of scheduled) {
            if (!conflictIds.has(sc.classId)) continue;
            if (sc.corridor === corridor) continue;
            if (start < sc.endTime && start + span > sc.startTime) {
              start = sc.endTime;
              shifted = true;
            }
          }
        }
        if (shifted) continue;

        const clearedAt =
          booked !== undefined
            ? firstControlShift(cls, start, booked, gap)
            : null;
        if (clearedAt === null) break;
        start = clearedAt;
      }

      scheduled.push({
        classId: cls.classId,
        corridor,
        startTime: start,
        endTime: start + span,
      });
      results.push({
        classId: cls.classId,
        corridor,
        computedFirstStart: start,
      });
      book(cls, start);

      nextStart = start + span;
    }
  }

  return results;
}
