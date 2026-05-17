/**
 * Bidirectional mapping between the numeric `RunnerStatus` constants in
 * `@oxygen/shared` (kept for offline matcher / BroadcastChannel
 * compatibility) and the PG `runner_status` / `control_status` ENUM string
 * literals stored in the database.
 *
 * After the PG migration the database is authoritative on the enum string
 * form; routers translate at the API boundary so the wire format stays
 * numeric for the existing web clients.
 */

import {
  RunnerStatus,
  ControlStatus,
  type RunnerStatusValue,
  type ControlStatusValue,
} from "@oxygen/shared";
import {
  RunnerStatus as PgRunnerStatus,
  ControlStatus as PgControlStatus,
} from "@prisma/client";

// ─── RunnerStatus ──────────────────────────────────────────

const runnerEnumToValue: Record<PgRunnerStatus, RunnerStatusValue> = {
  unknown: RunnerStatus.Unknown,
  ok: RunnerStatus.OK,
  no_timing: RunnerStatus.NoTiming,
  missing_punch: RunnerStatus.MissingPunch,
  dnf: RunnerStatus.DNF,
  dq: RunnerStatus.DQ,
  over_max_time: RunnerStatus.OverMaxTime,
  out_of_competition: RunnerStatus.OutOfCompetition,
  dns: RunnerStatus.DNS,
  cancel: RunnerStatus.Cancel,
  not_competing: RunnerStatus.NotCompeting,
};

const runnerValueToEnum: Record<number, PgRunnerStatus> = Object.fromEntries(
  Object.entries(runnerEnumToValue).map(([e, v]) => [v, e]),
) as Record<number, PgRunnerStatus>;

/** PG enum → numeric RunnerStatus constant. */
export function runnerStatusToValue(s: PgRunnerStatus): RunnerStatusValue {
  return runnerEnumToValue[s] ?? RunnerStatus.Unknown;
}

/** Numeric RunnerStatus constant → PG enum. */
export function valueToRunnerStatus(v: number): PgRunnerStatus {
  return runnerValueToEnum[v] ?? "unknown";
}

// ─── ControlStatus ─────────────────────────────────────────

const controlEnumToValue: Record<PgControlStatus, ControlStatusValue> = {
  ok: ControlStatus.OK,
  bad: ControlStatus.Bad,
  multiple: ControlStatus.Multiple,
  start: ControlStatus.Start,
  finish: ControlStatus.Finish,
  no_timing: ControlStatus.NoTiming,
  optional: ControlStatus.Optional,
  bad_no_timing: ControlStatus.BadNoTiming,
  check: ControlStatus.Check,
  clear: ControlStatus.Clear,
};

const controlValueToEnum: Record<number, PgControlStatus> = Object.fromEntries(
  Object.entries(controlEnumToValue).map(([e, v]) => [v, e]),
) as Record<number, PgControlStatus>;

/** PG enum → numeric ControlStatus constant. */
export function controlStatusToValue(s: PgControlStatus): ControlStatusValue {
  return controlEnumToValue[s] ?? ControlStatus.OK;
}

/** Numeric ControlStatus constant → PG enum. */
export function valueToControlStatus(v: number): PgControlStatus {
  return controlValueToEnum[v] ?? "ok";
}
