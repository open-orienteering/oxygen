/**
 * The stored course structure (`courses.structure`, docs/course-layer.md §6;
 * research 08 §4.3).
 *
 * The stored shape is C0's v1 layer input (`CourseStructure`: `version`,
 * `id`, `orderMode`, `items`) with the whole 08 §4.3 item union — control
 * items with `LegProps`, and variation groups — so slice F never reshapes
 * the column. Phase 1 writes control items only: `course.setStructure`
 * refuses a structure with groups. Not stored: `labelOffsets` (one source,
 * `course_controls`; readers fill them in), `extras` and C0's interim
 * file-authored `leg.path` / `pieces` / item `circleGaps` (the slice D split:
 * no `LegProps.path`; authored cuts become `controls.circle_gaps`, D1). Items
 * and legs are strict, so those keys are refused rather than dropped. A
 * structure without groups is a valid layer input as it stands.
 *
 * Site ids are generic: the column holds control UUIDs, the tRPC wire form
 * public control ids (`courseStructureSchemaOf(z.number().int())`).
 */

import { z } from "zod";
import { pointSchema } from "../course-maps/schema.js";
import type { CourseItem, CourseStructure } from "./types.js";

const fractionGapSchema = z
  .object({ from: z.number().min(0).max(1), to: z.number().min(0).max(1) })
  .refine((g) => g.from <= g.to, { message: "gap from > to" });

/** 08 §4.3 `LegProps` (no `path`: bends are for marked routes). */
export const legPropsSchema = z.strictObject({
  style: z.enum(["line", "marked_route", "none"]).optional(),
  gaps: z.array(fractionGapSchema).optional(),
  corridor: z
    .object({
      widthM: z.number().positive(),
      edge: z.boolean(),
      whiteMm: z.number().min(0),
      whiteOpacity: z.number().min(0).max(1),
    })
    .optional(),
  crossing: z.object({ controlId: z.string().min(1), section: z.boolean().optional() }).optional(),
  bends: z.array(pointSchema).optional(),
});
export type LegProps = z.infer<typeof legPropsSchema>;

function controlItemSchemaOf<S extends z.ZodType<string | number>>(siteId: S) {
  return z.strictObject({
    kind: z.literal("control").optional(),
    siteId,
    /** How the item is drawn; default the site's kind. */
    role: z.enum(["control", "start", "finish"]).optional(),
    /** The leg *into* this item. */
    leg: legPropsSchema.optional(),
    /** Hide this visit's number (08 §4.2; mirrored to `course_controls.number_hidden`). */
    numberHidden: z.boolean().optional(),
  });
}

function variationItemSchemaOf<S extends z.ZodType<string | number>>(siteId: S) {
  return z.strictObject({
    kind: z.literal("variation"),
    id: z.string().min(1),
    /** Alternatives hold controls only, so groups never nest. */
    alternatives: z
      .array(z.strictObject({ label: z.string().min(1), items: z.array(controlItemSchemaOf(siteId)).min(1) }))
      .min(2),
    /** Butterfly: the alternatives return to the anchor. */
    loop: z.boolean().optional(),
  });
}

/**
 * The structure schema over a site-id type. Rule codes, reported as issue
 * messages: `VARIATION_OVERLAP` (two groups with no control between them),
 * `VARIATION_UNANCHORED` (a group first or last), `VARIATION_ID_DUPLICATE`,
 * `VARIATION_LABEL_DUPLICATE`.
 */
export function courseStructureSchemaOf<S extends z.ZodType<string | number>>(siteId: S) {
  const item = z.union([variationItemSchemaOf(siteId), controlItemSchemaOf(siteId)]);
  return z
    .strictObject({
      version: z.literal(1),
      id: z.string().min(1),
      orderMode: z.enum(["ordered", "free_order"]),
      items: z.array(item),
      /** Manual number positions by site id; written to `course_controls`, never stored in the column. */
      labelOffsets: z.record(z.string(), z.object({ dx: z.number().finite(), dy: z.number().finite() })).optional(),
    })
    .superRefine((s, ctx) => variationRules(s.items as readonly ItemShape[], ctx));
}

/** What the group rules read of an item, whatever the site-id type. */
type ItemShape = { kind?: "control" | "variation"; id?: string; alternatives?: { label: string }[] };

function variationRules(items: readonly ItemShape[], ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  items.forEach((item, index) => {
    if (item.kind !== "variation") return;
    const path = ["items", index];
    if (index === 0 || index === items.length - 1) {
      ctx.addIssue({ code: "custom", message: "VARIATION_UNANCHORED", path });
    }
    if (items[index + 1]?.kind === "variation") {
      ctx.addIssue({ code: "custom", message: "VARIATION_OVERLAP", path });
    }
    const id = item.id ?? "";
    if (ids.has(id)) ctx.addIssue({ code: "custom", message: "VARIATION_ID_DUPLICATE", path });
    ids.add(id);
    const labels = (item.alternatives ?? []).map((a) => a.label);
    if (new Set(labels).size !== labels.length) {
      ctx.addIssue({ code: "custom", message: "VARIATION_LABEL_DUPLICATE", path });
    }
  });
}

const siteUuid = z.string().min(1);
export const controlItemSchema = controlItemSchemaOf(siteUuid);
export const variationItemSchema = variationItemSchemaOf(siteUuid);
export const courseItemSchema = z.union([variationItemSchema, controlItemSchema]);
/** The column's form: site ids are control UUIDs. */
export const courseStructureSchema = courseStructureSchemaOf(siteUuid);
/** The tRPC wire form: site ids are public control ids. */
export const courseStructureWireSchema = courseStructureSchemaOf(z.number().int());

export type StoredControlItem = z.infer<typeof controlItemSchema>;
export type StoredVariationItem = z.infer<typeof variationItemSchema>;
export type StoredCourseItem = z.infer<typeof courseItemSchema>;
export type StoredCourseStructure = z.infer<typeof courseStructureSchema>;
export type WireCourseStructure = z.infer<typeof courseStructureWireSchema>;

export function hasVariations(s: StoredCourseStructure): boolean {
  return s.items.some((item) => item.kind === "variation");
}

/** A rule that needs the event's sites (08 §4.3): unknown sites, a group spanning a map exchange. */
export interface StructureSiteIssue {
  code: "SITE_UNKNOWN" | "VARIATION_CROSSES_EXCHANGE";
  siteId: string;
}

/** Check a parsed structure against the event's site kinds (`controls.kind` by site id). */
export function structureSiteIssues(
  s: StoredCourseStructure,
  kindById: ReadonlyMap<string, string>,
): StructureSiteIssue[] {
  const issues: StructureSiteIssue[] = [];
  const check = (siteId: string, inGroup: boolean) => {
    const kind = kindById.get(siteId);
    if (kind === undefined) issues.push({ code: "SITE_UNKNOWN", siteId });
    else if (inGroup && kind === "map_exchange") issues.push({ code: "VARIATION_CROSSES_EXCHANGE", siteId });
  };
  for (const item of s.items) {
    if (item.kind === "variation") {
      for (const alt of item.alternatives) for (const c of alt.items) check(c.siteId, true);
    } else {
      check(item.siteId, false);
    }
  }
  return issues;
}

/** A linear structure (no groups) from a site sequence — `course.update { controlIds }` and the backfill. */
export function linearStructure(
  id: string,
  items: readonly CourseItem[],
  opts: { orderMode?: CourseStructure["orderMode"]; labelOffsets?: CourseStructure["labelOffsets"] } = {},
): CourseStructure {
  const out: CourseStructure = {
    version: 1,
    id,
    orderMode: opts.orderMode ?? "ordered",
    items: items.map((item) => ({ ...item })),
  };
  if (opts.labelOffsets && Object.keys(opts.labelOffsets).length > 0) out.labelOffsets = opts.labelOffsets;
  return out;
}

/** The control items in order: a group by its first alternative (08 §4.3: the root course's path). */
export function structureControlItems(s: StoredCourseStructure | CourseStructure): StoredControlItem[] {
  const out: StoredControlItem[] = [];
  for (const item of s.items as readonly StoredCourseItem[]) {
    if (item.kind === "variation") out.push(...item.alternatives[0].items);
    else out.push(item);
  }
  return out;
}

/** The flat site sequence of `structureControlItems`. */
export function structureControlIds(s: StoredCourseStructure | CourseStructure): string[] {
  return structureControlItems(s).map((item) => item.siteId);
}

/** The id an item is named by in `differing`: the site for a control, the group id for a variation. */
function itemId(item: StoredCourseItem): string {
  return item.kind === "variation" ? item.id : item.siteId;
}

/**
 * The item ids that differ between two structures (the `CONFLICT` payload's
 * `differing`, course-layer.md §7): items outside the longest common
 * subsequence of the two item lists (compared whole, legs and gaps included),
 * plus the sites whose label offset changed. Sorted, unique.
 */
export function structureDiff(
  a: StoredCourseStructure | CourseStructure | null,
  b: StoredCourseStructure | CourseStructure | null,
): string[] {
  const ai = (a?.items ?? []) as readonly StoredCourseItem[];
  const bi = (b?.items ?? []) as readonly StoredCourseItem[];
  const ak = ai.map((item) => JSON.stringify(item));
  const bk = bi.map((item) => JSON.stringify(item));
  // LCS table over item keys.
  const n = ak.length;
  const m = bk.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      t[i][j] = ak[i] === bk[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  const out = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ak[i] === bk[j]) {
      i += 1;
      j += 1;
    } else if (j >= m || (i < n && t[i + 1][j] >= t[i][j + 1])) {
      out.add(itemId(ai[i]));
      i += 1;
    } else {
      out.add(itemId(bi[j]));
      j += 1;
    }
  }
  const ao = a?.labelOffsets ?? {};
  const bo = b?.labelOffsets ?? {};
  for (const key of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (JSON.stringify(ao[key]) !== JSON.stringify(bo[key])) out.add(key);
  }
  return [...out].sort();
}
