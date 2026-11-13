/**
 * Terrain inputs of a map document by canonical id (docs/map-terrain.md §1).
 */

import type { MapDocument } from "../../map-document/codec.js";
import type { DocumentSymbol } from "../../map-document/header.js";
import { flattenObject, polylineLength } from "./flatten.js";
import type { CliffLine, ContourInputs, ContourPiece, TerrainClass } from "./types.js";

/** Pieces shorter than this are dropped, mm (§1.4). */
const MIN_PIECE_MM = 0.02;
/** A glyph stroke ending further than this off the line is a tag, µm (§1.2). */
const TAG_OFFSET_UM = 100;

/** Canonical code of a symbol (`ISOM2017-2:101.b` → `101.b`) in any match state, or "" (§1.1). */
export function canonicalCode(sym: DocumentSymbol): string {
  const id = sym.match?.canonicalId;
  if (!id) return "";
  const k = id.indexOf(":");
  return k < 0 ? id : id.slice(k + 1);
}

const family = (code: string, ...bases: string[]): boolean => bases.some((b) => code === b || code.startsWith(`${b}.`));

/** The terrain class of a symbol, or null when terrain ignores it (§1.1). */
export function classifyTerrainSymbol(sym: DocumentSymbol): TerrainClass | null {
  if (sym.hidden) return null;
  const code = canonicalCode(sym);
  if (sym.kind === "line") {
    if (code === "101") return "contour";
    if (code === "102") return "index";
    if (code === "103") return "form";
    if (family(code, "201", "202")) return "cliff";
  } else if (sym.kind === "point") {
    if (code === "101.b") return "tick";
    if (code === "103.b") return "formTick";
  } else if (sym.kind === "area") {
    if (family(code, "301", "302")) return "water";
  }
  const num = parseFloat(code || sym.code);
  return num >= 101 && num < 600 ? "other" : null;
}

/** Tag side of a cliff symbol from its definition: +1 left of the drawing direction, −1 right, 0 untagged (§1.2). */
export function cliffTagSide(sym: DocumentSymbol): -1 | 0 | 1 {
  const r = sym.render;
  if (!r || r.type !== "line") return 0;
  for (const g of r.glyphs ?? []) {
    for (const p of g.glyph.parts) {
      const y = p.kind === "stroke" ? p.geometry?.coords[3] : undefined;
      if (y !== undefined && Math.abs(y) > TAG_OFFSET_UM) return y > 0 ? 1 : -1;
    }
  }
  return 0;
}

/** Every terrain input of the document, in document order (§1). */
export function contourInputs(doc: MapDocument): ContourInputs {
  const H = doc.header;
  const classes = H.symbols.map(classifyTerrainSymbol);
  const tagSides = H.symbols.map((s, i) => (classes[i] === "cliff" ? cliffTagSide(s) : 0));
  const out: ContourInputs = {
    groundMPerMm: H.mapScale / 1000,
    contours: [],
    formLines: [],
    ticks: [],
    formTicks: [],
    cliffs: [],
    water: [],
    extentParts: [],
    counts: { contourObjects: 0, indexObjects: 0, formObjects: 0, ticks: 0, formTicks: 0, cliffObjects: 0, taggedCliffs: 0, waterAreas: 0 },
  };
  const c = out.counts;
  for (let i = 0; i < H.objects.count; i++) {
    const sym = doc.attrs.symbolIdx[i];
    const cls = classes[sym];
    if (!cls) continue;
    const parts = flattenObject(doc, i);
    for (const p of parts) out.extentParts.push(p);
    switch (cls) {
      case "contour":
      case "index":
      case "form": {
        if (cls === "contour") c.contourObjects++;
        else if (cls === "index") c.indexObjects++;
        else c.formObjects++;
        const list = cls === "form" ? out.formLines : out.contours;
        for (const pts of parts) {
          if (pts.length < 4 || polylineLength(pts) < MIN_PIECE_MM) continue;
          const n = pts.length;
          const closed = n >= 8 && Math.hypot(pts[0] - pts[n - 2], pts[1] - pts[n - 1]) < 1e-6;
          const piece: ContourPiece = { pts, closed, index: cls === "index", object: i };
          list.push(piece);
        }
        break;
      }
      case "tick":
      case "formTick": {
        if (!parts[0] || parts[0].length < 2) break;
        const t = { x: parts[0][0], y: parts[0][1], angleRad: ((doc.attrs.angle[i] / 10) * Math.PI) / 180, object: i };
        if (cls === "tick") {
          out.ticks.push(t);
          c.ticks++;
        } else {
          out.formTicks.push(t);
          c.formTicks++;
        }
        break;
      }
      case "cliff": {
        c.cliffObjects++;
        const tagSide = tagSides[sym] as CliffLine["tagSide"];
        if (tagSide !== 0) c.taggedCliffs++;
        for (const pts of parts) if (pts.length >= 4) out.cliffs.push({ pts, tagSide, object: i });
        break;
      }
      case "water":
        c.waterAreas++;
        out.water.push({ rings: parts.filter((p) => p.length >= 6), object: i });
        break;
      case "other":
        break;
    }
  }
  return out;
}
