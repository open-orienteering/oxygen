/**
 * Guard for applying a card readout's computed result to a runner row
 * (work package 2, RES-01 / SI-10; docs/system/registration-and-readout.md §3a).
 *
 * Pure: the server (`applyResult`, backup push, `result.applied` ingest) and
 * the ingest of queued `result.applied` entries use the same decision (the web offline path does not yet). Conservative by
 * design: a DQ or a hand-set status/finish is never overwritten by a read,
 * and a read that would replace a result with a worse one asks the operator.
 */
import { RunnerStatus } from "./types.js";

export type ReadoutGuardReason =
  | "dq"
  | "manual-status"
  | "manual-finish"
  | "no-finish"
  | "stale-punches";

export type ReadoutGuardOutcome =
  | "apply"
  | "unchanged"
  | "needsConfirmation"
  | "protected";

export interface ReadoutGuardCurrent {
  status: number;
  /** ZeroTime-relative or absolute: only "0 or not" and equality matter. */
  finishTime: number;
  startTime: number;
  statusManual: boolean;
  finishManual: boolean;
}

export interface ReadoutGuardNext {
  status: number;
  finishTime: number;
  startTime: number;
  /** false when the reader says the punches are an old card's (not fresh). */
  punchesFresh?: boolean;
}

export interface ReadoutGuardDecision {
  outcome: ReadoutGuardOutcome;
  reason?: ReadoutGuardReason;
  /** Values to write when `outcome === "apply"`. */
  write: { status: number; finishTime: number; startTime: number };
}

/** A status that counts as a recorded result (not "unknown"). */
function hasResultStatus(status: number): boolean {
  return status !== RunnerStatus.Unknown;
}

/** True when the runner row already carries a result worth protecting. */
export function hasStoredResult(c: Pick<ReadoutGuardCurrent, "status" | "finishTime">): boolean {
  return hasResultStatus(c.status) || c.finishTime !== 0;
}

/**
 * Decide what a read may do to the stored result.
 *
 * Order: protected (DQ, manual status) → manual finish kept → worse read
 * needs confirmation → identical values are a no-op → apply.
 * `confirmed` lets an operator-approved worse read through, never a DQ or a
 * manual status.
 */
export function decideReadoutApply(
  current: ReadoutGuardCurrent,
  next: ReadoutGuardNext,
  confirmed = false,
): ReadoutGuardDecision {
  const keep = {
    status: current.status,
    finishTime: current.finishTime,
    startTime: current.startTime,
  };
  // The read agrees with what is stored: nothing to protect or ask about.
  if (
    next.status === current.status &&
    next.finishTime === current.finishTime &&
    next.startTime === current.startTime
  ) {
    return { outcome: "unchanged", write: keep };
  }
  if (current.status === RunnerStatus.DQ) {
    return { outcome: "protected", reason: "dq", write: keep };
  }
  if (current.statusManual && hasResultStatus(current.status)) {
    // A hand-set DNS / Cancel / NotCompeting asks (a runner can start after
    // all); every other hand-set result is protected until changed by hand.
    const asks =
      current.status === RunnerStatus.DNS ||
      current.status === RunnerStatus.Cancel ||
      current.status === RunnerStatus.NotCompeting;
    if (!asks) {
      return { outcome: "protected", reason: "manual-status", write: keep };
    }
    if (!confirmed) {
      return { outcome: "needsConfirmation", reason: "manual-status", write: keep };
    }
  }

  let finishTime = next.finishTime;
  if (current.finishManual && current.finishTime !== 0) {
    // A keyed-in finish stays; the read may still fill the status in.
    finishTime = current.finishTime;
  }

  if (!confirmed) {
    // A read the reader marks as not fresh (an old card's punches) asks even
    // when the runner has no result yet: it would write last week's times.
    if (next.punchesFresh === false) {
      return { outcome: "needsConfirmation", reason: "stale-punches", write: keep };
    }
    if (hasStoredResult(current) && finishTime === 0) {
      return { outcome: "needsConfirmation", reason: "no-finish", write: keep };
    }
  }

  const write = { status: next.status, finishTime, startTime: next.startTime };
  if (
    write.status === current.status &&
    write.finishTime === current.finishTime &&
    write.startTime === current.startTime
  ) {
    return { outcome: "unchanged", write };
  }
  return { outcome: "apply", write };
}
