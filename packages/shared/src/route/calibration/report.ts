/**
 * A calibration's report (docs/course-elevation.md §7.9.6): the fitted
 * model and what it rests on, in aggregates only — no coordinate, no
 * id, no name, no file, no row per runner, leg or course.
 */

import { z } from "zod";
import { COST_CLASSES, type CostClass, type CostModelData } from "../cost-model.js";
import { GRADE_EDGES } from "./attribute.js";
import { REJECTIONS, type MapObservations, type Rejection } from "./dataset.js";
import { median, quantile, type FitResult } from "./fit.js";
import type { PredictionError } from "./validate.js";

const passable = COST_CLASSES.filter((c) => c !== "blocked" && c !== "blockedSoft") as Exclude<CostClass, "blocked" | "blockedSoft">[];
const classEnum = z.enum(COST_CLASSES);
const num = z.number().finite();
const errorSchema = z.strictObject({ legs: z.number().int(), medianAbs: num.nullable(), p90Abs: num.nullable(), bias: num.nullable() });

export const calibrationReportSchema = z.strictObject({
  version: z.literal(1),
  model: z.strictObject({
    id: z.string().max(64),
    basedOn: z.string().max(300),
    classFactor: z.strictObject(Object.fromEntries(passable.map((c) => [c, num])) as Record<(typeof passable)[number], typeof num>),
    slope: z.strictObject({ up: num, down: num, kneeGrade: num, steepDown: num }),
    calibrated: z.array(classEnum),
    anchor: classEnum.optional(),
    slopeCalibrated: z.boolean(),
  }),
  classes: z.array(z.strictObject({
    class: classEnum,
    metres: z.number().int(),
    seconds: z.number().int(),
    runners: z.number().int(),
    legs: z.number().int(),
    /** Different control pairs with a leg's worth of the class. */
    pairs: z.number().int(),
    factor: num,
    baseFactor: num,
    interval: z.tuple([num, num]).nullable(),
    calibrated: z.boolean(),
    anchor: z.boolean(),
    /** Why the base factor was kept, when it was. */
    kept: z.enum(["no-track", "little-track", "anchor", "not-settled"]).nullable(),
  })),
  slope: z.strictObject({ upFitted: z.boolean(), downFitted: z.boolean(), calibrated: z.boolean(), heightShare: num }),
  grades: z.array(z.strictObject({ from: num.nullable(), to: num.nullable(), metres: z.number().int() })),
  alongTrack: z.strictObject({ fitted: errorSchema, base: errorSchema }).nullable(),
  againstFinder: z.strictObject({ legs: z.number().int(), median: num.nullable(), shareUnder095: num.nullable() }).nullable(),
  counts: z.strictObject({
    maps: z.number().int(), courses: z.number().int(), tracks: z.number().int(), tracksUsed: z.number().int(), runners: z.number().int(),
    legs: z.number().int(),
    /** Legs the fitted model misses by more than a factor of two. */
    outliers: z.number().int(),
    rejected: z.partialRecord(z.enum(REJECTIONS), z.number().int()),
  }),
  /** Per map, by position on the command line only. */
  maps: z.array(z.strictObject({ medianMissM: num.nullable(), blockedShare: num, outsidePoints: z.number().int(), legs: z.number().int(), warnings: z.array(z.string()) })),
});
export type CalibrationReport = z.infer<typeof calibrationReportSchema>;

/** Under this many runs a report is not written: its aggregates would describe a few people. */
export const MIN_REPORT_RUNS = 5;

const finite = (v: number): number | null => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
const to10 = (v: number) => Math.round(v / 10) * 10;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function buildReport(input: {
  model: CostModelData;
  base: CostModelData;
  fit: FitResult;
  sets: readonly MapObservations[];
  alongTrack: { fitted: PredictionError; base: PredictionError } | null;
  finder: readonly number[] | null;
}): CalibrationReport {
  const { fit, sets, base } = input;
  const all = sets.flatMap((s) => s.observations);
  const rejected: Partial<Record<Rejection, number>> = {};
  for (const s of sets) for (const k of REJECTIONS) if (s.rejected[k]) rejected[k] = (rejected[k] ?? 0) + s.rejected[k]!;
  const gradeM = new Array<number>(GRADE_EDGES.length + 1).fill(0);
  let heightM = 0, totalM = 0;
  for (const o of all) {
    o.f.gradeM.forEach((m, b) => { gradeM[b] += m; });
    heightM += o.f.heightM;
    totalM += o.f.totalM;
  }
  const err = (e: PredictionError) => ({ legs: e.legs, medianAbs: finite(e.medianAbs), p90Abs: finite(e.p90Abs), bias: finite(e.bias) });
  const report: CalibrationReport = {
    version: 1,
    model: { ...input.model, calibrated: [...input.model.calibrated] },
    classes: passable.map((c) => {
      const i = COST_CLASSES.indexOf(c);
      const s = fit.support[i];
      const anchor = fit.anchor === i;
      return {
        class: c, metres: to10(s.metres), seconds: to10(s.seconds), runners: s.runners, legs: s.legs, pairs: s.pairs,
        factor: r3(fit.factors[i]), baseFactor: base.classFactor[c],
        interval: fit.interval[i] ? [r3(fit.interval[i]![0]), r3(fit.interval[i]![1])] as [number, number] : null,
        calibrated: fit.calibrated[i], anchor,
        kept: anchor ? "anchor" : fit.calibrated[i] ? null : s.metres === 0 ? "no-track" : !fit.supported[i] ? "little-track" : "not-settled",
      };
    }),
    slope: { upFitted: fit.slopeUpFitted, downFitted: fit.slopeDownFitted, calibrated: fit.slopeCalibrated, heightShare: totalM > 0 ? r3(heightM / totalM) : 0 },
    grades: gradeM.map((m, b) => ({ from: b === 0 ? null : GRADE_EDGES[b - 1], to: b === GRADE_EDGES.length ? null : GRADE_EDGES[b], metres: to10(m) })),
    alongTrack: input.alongTrack ? { fitted: err(input.alongTrack.fitted), base: err(input.alongTrack.base) } : null,
    againstFinder: input.finder ? {
      legs: input.finder.length, median: finite(median([...input.finder])),
      shareUnder095: input.finder.length > 0 ? r3(input.finder.filter((r) => r < 0.95).length / input.finder.length) : null,
    } : null,
    counts: {
      maps: sets.length, courses: sets.reduce((n, s) => n + s.courses, 0), tracks: sets.reduce((n, s) => n + s.tracks, 0),
      tracksUsed: sets.reduce((n, s) => n + s.tracksUsed, 0), runners: fit.runners, legs: all.length, outliers: fit.outliers, rejected,
    },
    maps: sets.map((s) => ({ medianMissM: finite(Math.round(s.medianMissM * 10) / 10), blockedShare: r3(s.blockedShare), outsidePoints: s.outside, legs: s.observations.length, warnings: s.warnings })),
  };
  // Strict: a key that is not an aggregate does not get out.
  return calibrationReportSchema.parse(report);
}

export { quantile };
