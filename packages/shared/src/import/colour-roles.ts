/**
 * Colour roles (docs/map-symbols.md §9.3 "Roles"; slice I row I2).
 *
 * The unit that takes a place in the IOF colour order is a colour *use*:
 * one colour reference of one symbol's source `render`. One source colour
 * often serves several IOF rows (brown 50 % as paved area and as road
 * infill; one black as buildings and cultivated-land dots), so the role is
 * decided per use, from the symbol's matched library entry first, else
 * from a rule on the colour's class and percent, the symbol's kind and the
 * part that draws. Pure; nothing in the importer calls it yet (row I3).
 */

import { type RenderPath, renderColourPaths } from "../render/transform.js";
import type { RenderSymbol } from "../render/symbol.js";

/**
 * The part of a symbol a colour reference draws (docs/map-symbols.md §9.3
 * table "Parts"). Line bodies inside an area (`border`) are the area's
 * `area-border`, whatever draws in them.
 */
export type ColourPart =
  | "area-fill"
  | "area-hatch"
  | "area-pattern"
  | "area-border"
  | "line-main"
  | "line-halo"
  | "line-outline"
  | "line-infill"
  | "line-glyph"
  | "point-glyph"
  | "text"
  | "text-halo"
  | "text-shadow"
  | "text-frame";

/** One colour reference of a symbol's render: the colour index, where it sits, and what it draws. */
export interface ColourUse {
  colour: number;
  path: RenderPath;
  part: ColourPart;
}

/** The part a reference at `path` draws in a symbol of `type`. */
export function colourPartOf(type: RenderSymbol["type"], path: RenderPath): ColourPart {
  const [head] = path;
  switch (type) {
    case "area":
      if (head === "fill") return "area-fill";
      if (head === "hatches") return "area-hatch";
      if (head === "patterns") return "area-pattern";
      return "area-border";
    case "line":
      if (head === "main") return path[1] === "halo" ? "line-halo" : "line-main";
      if (head === "borders") return path[1] === "backgroundColour" ? "line-infill" : "line-outline";
      return "line-glyph";
    case "point":
      return "point-glyph";
    case "text":
      if (head === "halo") return "text-halo";
      if (head === "shadow") return "text-shadow";
      if (head === "frame") return "text-frame";
      return "text";
  }
}

/** Every colour reference of `render` as a use, in the IR's order; a colour referenced twice is two uses. */
export function colourUses(render: RenderSymbol): ColourUse[] {
  return renderColourPaths(render).map(({ path, colour }) => ({ colour, path, part: colourPartOf(render.type, path) }));
}

