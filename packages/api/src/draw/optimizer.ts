/**
 * Multi-class corridor optimizer.
 *
 * Assigns classes to parallel start corridors and computes first-start times.
 * Conflicting classes (same course or overlapping opening controls) are grouped
 * into the same corridor so they run sequentially, guaranteeing no simultaneous
 * starts on shared terrain. Groups are distributed across corridors via LPT
 * (Longest Processing Time first) for balanced total depth.
 */

export interface ClassCourseInfo {
  classId: number;
  runnerCount: number;
  courseId: number;
  /** First N control codes of the course (for overlap detection) */
  initialControls: number[];
  /** Per-class interval in deciseconds */
  interval: number;
  /** If provided, the class is pinned to this first-start time */
  fixedFirstStart?: number;
  /** Pin to a specific corridor (user override from drag) */
  corridorHint?: number;
  /** Stacking order within corridor (lower = earlier) */
  orderHint?: number;
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
  detectCourseOverlap: boolean;
}

/**
 * Build an adjacency graph of classes whose courses conflict.
 * Two classes conflict if they share the same course ID, or if their initial
 * controls overlap (runners would be on the same terrain early on).
 */
function buildConflictGraph(
  classes: ClassCourseInfo[],
  detectOverlap: boolean,
): Map<number, Set<number>> {
  const graph = new Map<number, Set<number>>();
  for (const c of classes) {
    graph.set(c.classId, new Set());
  }

  for (let i = 0; i < classes.length; i++) {
    for (let j = i + 1; j < classes.length; j++) {
      const a = classes[i];
      const b = classes[j];

      let conflicts = false;

      if (a.courseId > 0 && a.courseId === b.courseId) {
        conflicts = true;
      } else if (detectOverlap && a.initialControls.length > 0 && b.initialControls.length > 0) {
        const overlapCount = countInitialOverlap(a.initialControls, b.initialControls);
        if (overlapCount >= 3) {
          conflicts = true;
        }
      }

      if (conflicts) {
        graph.get(a.classId)!.add(b.classId);
        graph.get(b.classId)!.add(a.classId);
      }
    }
  }

  return graph;
}

function countInitialOverlap(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let count = 0;
  for (let i = 0; i < len; i++) {
    if (a[i] === b[i]) count++;
    else break;
  }
  return count;
}

function classDuration(cls: ClassCourseInfo): number {
  return Math.max(0, (cls.runnerCount - 1) * cls.interval);
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
): Map<number, number> {
  const corridorMap = new Map<number, number>();
  const corridorLoad = new Array(maxCorridors).fill(0);
  const classById = new Map(classes.map((c) => [c.classId, c]));
  const baseInterval = 600; // used for load estimation between classes

  // Pin classes with corridorHint first
  const pinned = new Set<number>();
  for (const cls of classes) {
    if (cls.corridorHint !== undefined) {
      const cor = Math.min(cls.corridorHint, maxCorridors - 1);
      corridorMap.set(cls.classId, cor);
      corridorLoad[cor] += classDuration(cls) + baseInterval;
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
      total += classDuration(cls) + baseInterval;
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
 * 1. Builds conflict graph and groups conflicting classes into components.
 * 2. Assigns components to corridors for balanced duration (LPT).
 * 3. Stacks classes sequentially within each corridor.
 * 4. Cross-corridor offsetting for any residual conflicts (rare after grouping).
 */
export function optimizeStartTimes(
  classes: ClassCourseInfo[],
  settings: OptimizerSettings,
): CorridorAssignment[] {
  if (classes.length === 0) return [];

  const fixedClasses = classes.filter((c) => c.fixedFirstStart !== undefined);
  const autoClasses = classes.filter((c) => c.fixedFirstStart === undefined);

  const conflicts = buildConflictGraph(autoClasses, settings.detectCourseOverlap);
  const corridorMap = assignCorridors(autoClasses, settings.maxParallelStarts, conflicts);

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

  // Schedule fixed classes first
  for (const cls of fixedClasses) {
    const dur = classDuration(cls);
    scheduled.push({
      classId: cls.classId,
      corridor: -1,
      startTime: cls.fixedFirstStart!,
      endTime: cls.fixedFirstStart! + dur,
    });
    results.push({
      classId: cls.classId,
      corridor: -1,
      computedFirstStart: cls.fixedFirstStart!,
    });
  }

  // Process corridors in order
  const sortedCorridors = [...corridors.keys()].sort((a, b) => a - b);

  for (const corridor of sortedCorridors) {
    const classList = corridors.get(corridor)!;
    let nextStart = settings.firstStart;

    for (const cls of classList) {
      let start = nextStart;
      const dur = classDuration(cls);

      // Cross-corridor conflict check (only needed for residual conflicts
      // where components couldn't be fully grouped, e.g. due to pinning)
      const conflictIds = conflicts.get(cls.classId);
      if (conflictIds && conflictIds.size > 0) {
        let shifted = true;
        while (shifted) {
          shifted = false;
          for (const sc of scheduled) {
            if (!conflictIds.has(sc.classId)) continue;
            if (sc.corridor === corridor) continue;
            if (start < sc.endTime + settings.baseInterval &&
                start + dur > sc.startTime - settings.baseInterval) {
              start = sc.endTime + settings.baseInterval;
              shifted = true;
            }
          }
        }
      }

      scheduled.push({
        classId: cls.classId,
        corridor,
        startTime: start,
        endTime: start + dur,
      });
      results.push({
        classId: cls.classId,
        corridor,
        computedFirstStart: start,
      });

      nextStart = start + dur + settings.baseInterval;
    }
  }

  return results;
}
