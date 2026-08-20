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
 */

export interface UndoEntry {
  /** Reverse the original change. */
  undo: () => Promise<unknown> | unknown;
  /** Re-apply the original change. */
  redo: () => Promise<unknown> | unknown;
}

export class UndoStack {
  private past: UndoEntry[] = [];
  private future: UndoEntry[] = [];
  private readonly cap: number;

  constructor(cap: number = 50) {
    this.cap = cap;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Record a completed change. Clears the redo branch. */
  push(entry: UndoEntry): void {
    this.past.push(entry);
    if (this.past.length > this.cap) {
      this.past.splice(0, this.past.length - this.cap);
    }
    this.future = [];
  }

  /** @returns false when there was nothing to undo. */
  async undo(): Promise<boolean> {
    const entry = this.past.pop();
    if (!entry) return false;
    await entry.undo(); // a throw drops the entry — see module docs
    this.future.push(entry);
    return true;
  }

  /** @returns false when there was nothing to redo. */
  async redo(): Promise<boolean> {
    const entry = this.future.pop();
    if (!entry) return false;
    await entry.redo();
    this.past.push(entry);
    return true;
  }
}
