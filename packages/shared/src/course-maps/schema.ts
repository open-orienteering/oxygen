import { z } from "zod";

export const pointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type MapPoint = z.infer<typeof pointSchema>;

export const pathVertexSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  hIn: pointSchema.optional(),
  hOut: pointSchema.optional(),
});
export type PathVertex = z.infer<typeof pathVertexSchema>;

export const rectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});
export type MapRect = z.infer<typeof rectSchema>;

export const mapWindowSchema = z.object({
  minX: z.number().finite(),
  minY: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  /**
   * Clockwise page-space rotation (degrees) applied to the map content
   * about the window centre when drawing it into the frame. Set to the
   * negated in-paper meridian tilt of the base map drawing so the drawn
   * north lines stand vertical on the page. Absent / 0 = paper-up.
   */
  rotationDeg: z.number().finite().optional(),
});
export type MapWindow = z.infer<typeof mapWindowSchema>;

export const objectAnchorSchema = z.enum(["page", "map"]);
export type MapObjectAnchor = z.infer<typeof objectAnchorSchema>;
export const mapFontFamilySchema = z.enum([
  "sans",
  "serif",
  "mono",
  "condensed",
]);
export type MapFontFamily = z.infer<typeof mapFontFamilySchema>;

const objectBase = {
  id: z.string().min(1),
  anchor: objectAnchorSchema,
};

export const mapTextObjectSchema = z.object({
  ...objectBase,
  kind: z.literal("text"),
  x: z.number().finite(),
  y: z.number().finite(),
  text: z.string(),
  fontSizeMm: z.number().finite().positive().max(100),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  fontFamily: mapFontFamilySchema.optional(),
  maxWidthMm: z.number().finite().positive().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
});

export const mapLineObjectSchema = z.object({
  ...objectBase,
  kind: z.literal("line"),
  x1: z.number().finite(),
  y1: z.number().finite(),
  x2: z.number().finite(),
  y2: z.number().finite(),
  stroke: z.string().regex(/^#[0-9a-f]{6}$/i),
  strokeWidthMm: z.number().finite().positive().max(20),
});

/**
 * How a rectangle or closed path is filled.
 * - `none` — stroke only (or invisible if no stroke)
 * - `solid` — solid colour from `fill`
 * - `whiteout` — opaque white, drawn under the course overlay
 * - `outOfBounds` — ISOM 709 purple cross-hatch
 */
export const mapFillModeSchema = z.enum([
  "none",
  "solid",
  "whiteout",
  "outOfBounds",
]);
export type MapFillMode = z.infer<typeof mapFillModeSchema>;

export const mapPathObjectSchema = z.object({
  ...objectBase,
  kind: z.literal("path"),
  points: z.array(pathVertexSchema).min(2),
  stroke: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  strokeWidthMm: z.number().finite().positive().max(20).optional(),
  fill: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  fillMode: mapFillModeSchema.default("none"),
  closed: z.boolean().default(false),
});

export const mapRectangleObjectSchema = z.object({
  ...objectBase,
  kind: z.literal("rectangle"),
  ...rectSchema.shape,
  stroke: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  strokeWidthMm: z.number().finite().positive().max(20).optional(),
  fill: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  fillMode: mapFillModeSchema.default("none"),
});

/** Uploaded SVG/PNG graphic (club logo, sponsor art …) placed on the page. */
export const mapImageCropSchema = z.object({
  /** Left edge as a fraction of the source graphic [0, 1). */
  x: z.number().finite().min(0).max(1),
  /** Top edge as a fraction of the source graphic [0, 1). */
  y: z.number().finite().min(0).max(1),
  /** Visible width as a fraction of the source (must leave room for x). */
  width: z.number().finite().positive().max(1),
  /** Visible height as a fraction of the source (must leave room for y). */
  height: z.number().finite().positive().max(1),
});

export const mapImageObjectSchema = z.object({
  ...objectBase,
  kind: z.literal("image"),
  graphicId: z.number().int().positive(),
  ...rectSchema.shape,
  /** Optional crop window; absent = full graphic. */
  crop: mapImageCropSchema.optional(),
});

const courseMapObjectUnion = z.discriminatedUnion("kind", [
  mapTextObjectSchema,
  mapLineObjectSchema,
  mapPathObjectSchema,
  mapRectangleObjectSchema,
  mapImageObjectSchema,
]);

/**
 * Normalize legacy whiteout kinds into rectangle/path with `fillMode:
 * "whiteout"` so stored JSON, club payloads and in-flight autosaves still
 * parse after the schema merge.
 */
export function normalizeCourseMapObject(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const object = raw as Record<string, unknown>;
  if (object.kind === "whiteoutRect") {
    const { kind: _kind, ...rest } = object;
    return { ...rest, kind: "rectangle", fillMode: "whiteout" };
  }
  if (object.kind === "whiteoutPolygon") {
    const { kind: _kind, ...rest } = object;
    return { ...rest, kind: "path", fillMode: "whiteout", closed: true };
  }
  return raw;
}

export const courseMapObjectSchema = z.preprocess(
  normalizeCourseMapObject,
  courseMapObjectUnion,
);
export type CourseMapObject = z.infer<typeof courseMapObjectUnion>;

/** True when the object is an opaque white-out drawn under the course overlay. */
export function isWhiteoutObject(object: CourseMapObject): boolean {
  return (
    (object.kind === "rectangle" || object.kind === "path") &&
    object.fillMode === "whiteout"
  );
}

/** True when the object uses the ISOM 709 out-of-bounds hatch fill. */
export function isOutOfBoundsObject(object: CourseMapObject): boolean {
  return (
    (object.kind === "rectangle" || object.kind === "path") &&
    object.fillMode === "outOfBounds"
  );
}

export const paperSizeSchema = z.enum(["A3", "A4", "A5", "custom"]);
export type PaperSize = z.infer<typeof paperSizeSchema>;
export const paperOrientationSchema = z.enum(["portrait", "landscape"]);
export type PaperOrientation = z.infer<typeof paperOrientationSchema>;

export const mapAppearanceSchema = z.object({
  purple: z.string().regex(/^#[0-9a-f]{6}$/i),
  circleRadiusMm: z.number().finite().positive().max(20),
  lineWidthMm: z.number().finite().positive().max(10),
  numberHeightMm: z.number().finite().positive().max(30),
});
export type MapAppearance = z.infer<typeof mapAppearanceSchema>;

export const descriptionBlockSchema = z.object({
  visible: z.boolean(),
  x: z.number().finite(),
  y: z.number().finite(),
  cellSizeMm: z.number().finite().min(3).max(15),
});
export type DescriptionBlockSettings = z.infer<typeof descriptionBlockSchema>;

export const mapTemplateSettingsSchema = z.object({
  printMarginMm: z.number().finite().min(0).max(50).default(3),
  mapFrame: rectSchema,
  description: descriptionBlockSchema,
  appearance: mapAppearanceSchema,
});
export type MapTemplateSettings = z.infer<typeof mapTemplateSettingsSchema>;

export const courseMapSchema = z
  .object({
    paper: paperSizeSchema,
    orientation: paperOrientationSchema,
    paperWidthMm: z.number().finite().positive().max(2_000).optional(),
    paperHeightMm: z.number().finite().positive().max(2_000).optional(),
    printScale: z.number().int().positive().max(100_000),
    ...mapTemplateSettingsSchema.shape,
    objects: z.array(courseMapObjectSchema),
  })
  .superRefine((value, ctx) => {
    if (
      value.paper === "custom" &&
      (value.paperWidthMm === undefined || value.paperHeightMm === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Custom paper requires paperWidthMm and paperHeightMm",
      });
    }
  });
export type CourseMapDocument = z.infer<typeof courseMapSchema>;

export const courseMapOverridesSchema = z.object({
  printScale: z.number().int().positive().max(100_000).optional(),
  mapFrame: rectSchema.optional(),
  description: descriptionBlockSchema.partial().optional(),
});
export type CourseMapOverrides = z.infer<typeof courseMapOverridesSchema>;

/**
 * ISOM 2017-2 overprint defaults: purple is the sRGB equivalent of the
 * offset CMYK 35·85·0·0 ("PMS Purple", Appendix 1); circle Ø 5 mm, lines
 * 0.35 mm, control numbers 4.0 mm digit height (symbol 704) — all at the
 * base map scale, enlarged together with the map for larger print scales.
 */
export const defaultMapAppearance: MapAppearance = {
  purple: "#a626ff",
  circleRadiusMm: 2.5,
  lineWidthMm: 0.35,
  numberHeightMm: 4,
};
