/**
 * Columns the E5 drops migration removed (v0.6.1;
 * docs/migrations/2026-vector-map-pipeline.md), by the Prisma field name a
 * checkout snapshot carries them under. A v0.6.0 exporter still sends
 * them; the importer strips them so a venue on v0.6.1 can check out from
 * a cloud on v0.6.0 (the rows verbatim would name fields this schema no
 * longer has). A v0.6.0 importer fills them from their defaults.
 */
export const DROPPED_SNAPSHOT_FIELDS = {
  event: ["mapPipeline", "overprintCutsVersion"],
  course: ["geometry", "geometrySource"],
  mapFile: ["fileData", "fileHash", "renderKey", "colorProfile", "colorOverrides", "northLinesBelow"],
} as const satisfies Record<string, readonly string[]>;

export type DroppedFieldTable = keyof typeof DROPPED_SNAPSHOT_FIELDS;

/** `row` without the fields E5 dropped from `table`. */
export function withoutDroppedFields<T extends Record<string, unknown>>(table: DroppedFieldTable, row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of DROPPED_SNAPSHOT_FIELDS[table]) delete out[k];
  return out as T;
}
