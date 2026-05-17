/**
 * Draw engine — stub. The full multi-class corridor-aware algorithm
 * lives in this directory's neighbouring modules (algorithms.ts,
 * optimizer.ts) and is being re-ported against the new schema.
 *
 * Callers (drawRouter.preview / commit) currently throw
 * PRECONDITION_FAILED until this lands.
 */

export interface DrawInput {
  // placeholder
}

export interface DrawPreview {
  classes: never[];
  warnings: string[];
}

export async function runDraw(): Promise<DrawPreview> {
  return { classes: [], warnings: ["Draw engine pending re-port"] };
}
