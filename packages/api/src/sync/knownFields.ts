/**
 * Version skew between a venue box and the cloud (review SYNC-17): a row from
 * the peer may carry columns this node's schema does not have (the peer is
 * newer), and handing it to Prisma verbatim fails the whole checkout or
 * refresh. `knownFields` keeps the columns of this node's generated model and
 * logs the others once, so a box one migration behind still checks out and
 * refreshes (the missing column takes its default, as for any old row).
 *
 * The model's columns come from the generated `Prisma.<Model>ScalarFieldEnum`,
 * so a migration needs no list to maintain here; the columns an earlier
 * release dropped (E5) are simply not in it either.
 */

import { Prisma } from "../generated/prisma/client.js";

const fieldsByModel = new Map<string, ReadonlySet<string> | null>();
const warned = new Set<string>();

/** Test seam: forget which names were already reported. */
export function _resetKnownFieldsWarnings(): void {
  warned.clear();
}

/** The scalar column names of a model by its delegate name (`courseMap`), or null for an unknown model. */
function columnsOf(model: string): ReadonlySet<string> | null {
  let cols = fieldsByModel.get(model);
  if (cols === undefined) {
    const key = `${model.charAt(0).toUpperCase()}${model.slice(1)}ScalarFieldEnum`;
    const enumObj = (Prisma as unknown as Record<string, Record<string, string> | undefined>)[key];
    cols = enumObj ? new Set(Object.values(enumObj)) : null;
    fieldsByModel.set(model, cols);
  }
  return cols;
}

/** `row` without the keys the `model` table of this schema has no column for. */
export function knownFields<T extends Record<string, unknown>>(model: string, row: T): T {
  const cols = columnsOf(model);
  if (!cols) return row;
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (cols.has(k)) out[k] = v;
    else dropped.push(k);
  }
  const fresh = dropped.filter((k) => !warned.has(`${model}.${k}`));
  if (fresh.length > 0) {
    for (const k of fresh) warned.add(`${model}.${k}`);
    console.warn(
      `[sync] ${model}: ignoring column(s) this schema does not have: ${fresh.join(", ")} (the peer runs a different version).`,
    );
  }
  return out as T;
}
