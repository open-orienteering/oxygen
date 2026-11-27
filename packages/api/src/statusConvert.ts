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

import { z } from "zod";
import {
  RunnerStatus,
  ControlStatus,
  type RunnerStatusValue,
  type ControlStatusValue,
} from "@oxygen/shared";
import {
  RunnerStatus as PgRunnerStatus,
  ControlStatus as PgControlStatus,
} from "./generated/prisma/client.js";

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
  readout: ControlStatus.Readout,
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

/**
 * Wire schema for a numeric runner status: an integer that is one of the
 * `RunnerStatus` constants. Anything else (7, 999) is refused instead of being
 * stored as "unknown" by `valueToRunnerStatus` (RES-24 / API-13).
 */
const RUNNER_STATUS_VALUES: ReadonlySet<number> = new Set(Object.values(RunnerStatus));
export const runnerStatusValueSchema = z
  .number()
  .int()
  .refine((v) => RUNNER_STATUS_VALUES.has(v), { message: "Unknown runner status" });

/** True when `v` is one of the `RunnerStatus` constants. */
export function isRunnerStatusValue(v: unknown): v is RunnerStatusValue {
  return typeof v === "number" && RUNNER_STATUS_VALUES.has(v);
}
