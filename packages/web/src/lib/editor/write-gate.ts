/**
 * The editor's write gate (docs/course-editor.md §3 "Undo after another editor's change"): ordinary writes run side
 * by side (`shared`); an undo or redo step runs alone (`exclusive`), after every ordinary write started before it has
 * settled and before any started after it. So the D6 guard of a step (`EditorWrites.guarded`) sees only the step's
 * own writes, and a structure edit is never built on a structure an undo is about to replace. First come, first
 * served: a step waiting holds back the ordinary writes asked for after it.
 */
export class WriteGate {
  private shared = 0;
  private exclusive = false;
  private readonly waiting: { exclusive: boolean; go: () => void }[] = [];

  /** Runs `fn` beside other ordinary writes, once no undo / redo step asked before it is running. */
  async runShared<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire(false);
    try {
      return await fn();
    } finally {
      this.shared--;
      this.pump();
    }
  }

  /** Runs `fn` alone, once every write asked before it has settled. */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire(true);
    try {
      return await fn();
    } finally {
      this.exclusive = false;
      this.pump();
    }
  }

  /**
   * An undo / redo step: `runExclusive`, then one macrotask before `fn`, so a gesture whose write settled just
   * before records its undo entry (the `run(...)` then `record(...)` of its caller, microtasks later) before the
   * step picks the entry it reverses (CRS-050).
   */
  runStep<T>(fn: () => Promise<T>): Promise<T> {
    return this.runExclusive(async () => {
      await new Promise((r) => setTimeout(r, 0));
      return fn();
    });
  }

  private canGo(exclusive: boolean): boolean {
    return exclusive ? !this.exclusive && this.shared === 0 : !this.exclusive;
  }

  private take(exclusive: boolean): void {
    if (exclusive) this.exclusive = true;
    else this.shared++;
  }

  private acquire(exclusive: boolean): Promise<void> {
    if (this.waiting.length === 0 && this.canGo(exclusive)) {
      this.take(exclusive);
      return Promise.resolve();
    }
    return new Promise((go) => this.waiting.push({ exclusive, go }));
  }

  private pump(): void {
    while (this.waiting.length > 0 && this.canGo(this.waiting[0]!.exclusive)) {
      const w = this.waiting.shift()!;
      this.take(w.exclusive);
      w.go();
    }
  }
}

/** A queue that runs each op once the one before it has settled (a refused one does not stop it). */
export function serialQueue(): <T>(op: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(op: () => Promise<T>) => {
    const next = tail.then(op, op);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}

/**
 * What a queued structure edit does when its turn comes (docs/course-editor.md §3 "Structure edits", CRS-018): it is
 * dropped when another course is selected since it was asked for, or — for a positional edit (a row's index, a leg's
 * path) — refused with "do it again" when the structure changed meanwhile; otherwise it is built on the structure as
 * it is now.
 */
export function queuedEditAction(at: { courseId: number | null; version: string | null }, now: { courseId: number | null; version: string | null }, positional: boolean): "apply" | "drop" | "again" {
  if (at.courseId === null || now.courseId !== at.courseId || now.version === null) return "drop";
  if (positional && now.version !== at.version) return "again";
  return "apply";
}
