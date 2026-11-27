/**
 * Bounded undo/redo stack of inverse-mutation pairs for the course editor.
 *
 * Each entry carries two async closures: `undo` reverses the original
 * change, `redo` re-applies it. The editor pushes an entry after every
 * successful mutation (move → control.update with the prior position,
 * sequence change → course.update with the prior controlIds, delete →
 * control.restore, …).
 *
 * Failure semantics: if an entry's undo/redo throws (e.g. the server
 * rejects a restore because the code was reused), the entry is dropped
 * and the error propagates to the caller for display — the rest of the
 * stack stays usable. No retry: the stack cannot know whether the
 * failure is permanent.
 *
 * Undo and redo run one at a time, in the order they were asked for (CRS-050): a held or double Ctrl+Z queues the
 * second behind the first, which picks its entry only once the first has settled, so the redo branch keeps the
 * order of the undos. An entry may carry `rows` (the D6 guard's tokens, docs/course-editor.md §3); `run`, given to
 * the constructor, wraps each step and may hand back new rows for the entry.
 */

export interface UndoEntry {
  /** Reverse the original change. */
  undo: () => Promise<unknown> | unknown;
  /** Re-apply the original change. */
  redo: () => Promise<unknown> | unknown;
  /** The rows the entry's last step wrote and their tokens after it (D6); `run` reads and renews them. */
  rows?: { kind: string; id: number; version: string }[];
}

/** Runs one step of an entry; may return the entry's new `rows`. */
export type UndoStepRunner = (entry: UndoEntry, step: () => Promise<unknown> | unknown, which: "undo" | "redo") => Promise<UndoEntry["rows"] | void>;

export class UndoStack {
  private past: UndoEntry[] = [];
  private future: UndoEntry[] = [];
  private readonly cap: number;
  private readonly runStep: UndoStepRunner;
  /** The undo / redo in flight and the ones queued behind it. */
  private tail: Promise<unknown> = Promise.resolve();

  private readonly lock: <T>(op: () => Promise<T>) => Promise<T>;

  /**
   * `lock`: wraps each undo / redo from picking its entry to the step's end (the editor's write gate, held alone),
   * so an entry is picked only once every write asked for before it has settled — a gesture in flight records its
   * entry first, and the undo takes that one.
   */
  constructor(cap: number = 50, runStep?: UndoStepRunner, lock?: <T>(op: () => Promise<T>) => Promise<T>) {
    this.cap = cap;
    this.runStep = runStep ?? (async (_entry, step) => { await step(); });
    this.lock = lock ?? ((op) => op());
  }

  /** Runs `op` once every earlier undo / redo has settled (a refused one does not stop the queue). */
  private queued<T>(inner: () => Promise<T>): Promise<T> {
    const op = () => this.lock(inner);
    const next = this.tail.then(op, op);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** The entry the next `undo` reverses, if any. */
  get top(): UndoEntry | undefined {
    return this.past[this.past.length - 1];
  }

  /** The entry the next `redo` re-applies, if any. */
  get nextRedo(): UndoEntry | undefined {
    return this.future[this.future.length - 1];
  }

  /** Record a completed change. Clears the redo branch. */
  push(entry: UndoEntry): void {
    this.past.push(entry);
    if (this.past.length > this.cap) {
      this.past.splice(0, this.past.length - this.cap);
    }
    this.future = [];
  }

  /**
   * Drop every entry `drop` matches from both branches, keeping the others in order (a promote drops Map mode's
   * patch entries, docs/course-editor.md §13 "Promote"). @returns how many went.
   */
  remove(drop: (entry: UndoEntry) => boolean): number {
    const n = this.past.length + this.future.length;
    this.past = this.past.filter((e) => !drop(e));
    this.future = this.future.filter((e) => !drop(e));
    return n - this.past.length - this.future.length;
  }

  /**
   * @returns false when there was nothing to undo, or `allow` refused the entry (left in place). Queued behind any
   * undo / redo in flight: the entry is the top as that one has settled.
   */
  undo(allow?: (entry: UndoEntry) => boolean): Promise<boolean> {
    return this.queued(async () => {
      const entry = this.past[this.past.length - 1];
      if (!entry || (allow && !allow(entry))) return false;
      this.past.pop();
      const rows = await this.runStep(entry, () => entry.undo(), "undo"); // a throw drops the entry — see module docs
      if (rows) entry.rows = rows;
      this.future.push(entry);
      return true;
    });
  }

  /** @returns false when there was nothing to redo, or `allow` refused the entry. Queued as `undo`. */
  redo(allow?: (entry: UndoEntry) => boolean): Promise<boolean> {
    return this.queued(async () => {
      const entry = this.future[this.future.length - 1];
      if (!entry || (allow && !allow(entry))) return false;
      this.future.pop();
      const rows = await this.runStep(entry, () => entry.redo(), "redo");
      if (rows) entry.rows = rows;
      this.past.push(entry);
      return true;
    });
  }
}
