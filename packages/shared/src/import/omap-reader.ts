/**
 * OpenOrienteering Mapper file reader (`.omap` / `.xmap`) — import stage 3
 * for the OMAP path (`docs/map-import.md` §4).
 *
 * Produces a faithful, typed mirror of the XML (Mapper's own units and
 * conventions: 0.001 mm coordinates with y growing downward, radians,
 * colour priorities, symbol list indices). Normalisation into Oxygen's
 * `MapDocumentInput` happens in `omap-source.ts`; symbol conversion in
 * `omap-symbols.ts`. Keeping the reader semantic-free makes it testable
 * against the format alone and reusable for cross-checks.
 *
 * Vocabulary follows Mapper's `XMLFileFormat` (format version 6–9; the
 * `<coord>` element form of older files is accepted too). Unknown elements
 * are skipped silently; Mapper does the same.
 */

import { childNamed, childrenNamed, parseXmlTree, type XmlAttributes, type XmlElement } from "./xml.js";

export const OMAP_NAMESPACE = "http://openorienteering.org/apps/mapper/xml/v2";

// ─── Model ───────────────────────────────────────────────────────────────────

export interface OmapColour {
  priority: number;
  name: string;
  /** CMYK fractions 0–1. */
  c: number;
  m: number;
  y: number;
  k: number;
  opacity: number;
  /** Spot-colour definition (`<namedcolor>`) — this colour *is* a spot colour. */
  spotName?: string;
  /** Spot-colour composition (`<component>`): factors of other colours by priority. */
  spotComponents?: { factor: number; spotColour: number }[];
  knockout: boolean;
  cmykMethod?: string;
  rgb?: { method?: string; r: number; g: number; b: number };
}

export interface OmapCoord {
  x: number;
  y: number;
  flags: number;
}

/** Mapper `MapCoord::Flags`. */
export const OMAP_FLAG = {
  curveStart: 1,
  closePoint: 2,
  gapPoint: 4,
  holePoint: 16,
  dashPoint: 32,
} as const;

/** Mapper `Object::Type`. */
export const OMAP_OBJECT_TYPE = { point: 0, path: 1, text: 4 } as const;

export interface OmapObject {
  type: number;
  /** Symbol list index, or -1 when the object has none / it is implied by context. */
  symbol: number;
  /** Radians, counter-clockwise; 0 when the symbol is not rotatable. */
  rotation: number;
  /** Text objects only: 0 left, 1 centre, 2 right. */
  hAlign?: number;
  /** Text objects only: 0 baseline, 1 top, 2 centre, 3 bottom. */
  vAlign?: number;
  tags?: Record<string, string>;
  coords: OmapCoord[];
  /** Path objects: pattern rotation (radians) and origin. */
  patternRotation?: number;
  patternOrigin?: { x: number; y: number };
  /** Text objects with a box: width/height in 0.001 mm. */
  boxSize?: { width: number; height: number };
  text?: string;
}

/** Mapper `Symbol::Type`. */
export const OMAP_SYMBOL_TYPE = { point: 1, line: 2, area: 4, text: 8, combined: 16 } as const;

export interface OmapSymbolBase {
  type: number;
  /** Position in the symbol list (`id` attribute); undefined for nested symbols. */
  id?: number;
  code: string;
  name: string;
  description?: string;
  hidden: boolean;
  helper: boolean;
  protected: boolean;
}

export interface OmapPointElement {
  symbol: OmapSymbol;
  object: OmapObject;
}

export interface OmapPointBody {
  kind: "point";
  rotatable: boolean;
  innerRadius: number;
  innerColour: number;
  outerWidth: number;
  outerColour: number;
  elements: OmapPointElement[];
}

export interface OmapBorder {
  colour: number;
  width: number;
  shift: number;
  dashed: boolean;
  dashLength: number;
  breakLength: number;
}

export interface OmapLineBody {
  kind: "line";
  colour: number;
  lineWidth: number;
  minimumLength: number;
  joinStyle: number;
  capStyle: number;
  pointedCapLength: number;
  startOffset: number;
  endOffset: number;
  dashed: boolean;
  segmentLength: number;
  endLength: number;
  showAtLeastOneSymbol: boolean;
  minimumMidSymbolCount: number;
  minimumMidSymbolCountWhenClosed: number;
  dashLength: number;
  breakLength: number;
  dashesInGroup: number;
  inGroupBreakLength: number;
  halfOuterDashes: boolean;
  midSymbolsPerSpot: number;
  midSymbolDistance: number;
  midSymbolPlacement: number;
  suppressDashSymbolAtEnds: boolean;
  scaleDashSymbol: boolean;
  startSymbol?: OmapSymbol;
  midSymbol?: OmapSymbol;
  endSymbol?: OmapSymbol;
  dashSymbol?: OmapSymbol;
  borders?: { left: OmapBorder; right: OmapBorder; different: boolean };
}

export interface OmapPattern {
  /** 1 line hatch, 2 point grid. */
  type: number;
  /** Radians. */
  angle: number;
  /** 0 clip, 1 completely inside, 2 centre inside, 3 partially inside. */
  noClipping: number;
  rotatable: boolean;
  lineSpacing: number;
  lineOffset: number;
  offsetAlongLine: number;
  colour?: number;
  lineWidth?: number;
  pointDistance?: number;
  symbol?: OmapSymbol;
}

export interface OmapAreaBody {
  kind: "area";
  innerColour: number;
  minArea: number;
  rotatable: boolean;
  patterns: OmapPattern[];
}

export interface OmapTextBody {
  kind: "text";
  iconText: string;
  rotatable: boolean;
  fontFamily: string;
  /** Em size in 0.001 mm. */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  colour: number;
  lineSpacing: number;
  paragraphSpacing: number;
  characterSpacing: number;
  kerning: boolean;
  framing?: { colour: number; mode: number; lineHalfWidth: number; shadowXOffset: number; shadowYOffset: number };
  lineBelow?: { colour: number; width: number; distance: number };
  tabs: number[];
}

export type OmapCombinedPart = { ref: number } | { symbol: OmapSymbol } | null;

export interface OmapCombinedBody {
  kind: "combined";
  parts: OmapCombinedPart[];
}

export type OmapSymbolBody = OmapPointBody | OmapLineBody | OmapAreaBody | OmapTextBody | OmapCombinedBody;
export type OmapSymbol = OmapSymbolBase & { body: OmapSymbolBody | null };

export interface OmapProjectedCrs {
  id: string;
  spec?: string;
  parameters: string[];
  refPoint?: { x: number; y: number };
}

export interface OmapGeoreferencing {
  scale: number;
  gridScaleFactor: number;
  auxiliaryScaleFactor: number;
  /** Degrees. */
  declination: number;
  /** Degrees. */
  grivation: number;
  /** Map reference point in mm (paper, y down). */
  refPoint: { x: number; y: number };
  projectedCrs?: OmapProjectedCrs;
  geographicRefPoint?: { lat: number; lon: number };
}

export interface OmapPart {
  name: string;
  objects: OmapObject[];
}

export interface OmapTemplate {
  type: string;
  name: string;
  path?: string;
  open: boolean;
}

export interface OmapPrint {
  scale?: number;
  resolution?: number;
  mode?: string;
  /** Paper mm, y down. */
  area?: { left: number; top: number; width: number; height: number };
}

export interface OmapWarning {
  code: string;
  count: number;
  message?: string;
}

export interface OmapFile {
  version: number;
  notes?: string;
  georeferencing: OmapGeoreferencing;
  /** Indexed by priority (0 = drawn on top). */
  colours: OmapColour[];
  /** Indexed by list position (`id`). */
  symbols: OmapSymbol[];
  symbolSetId?: string;
  parts: OmapPart[];
  templates: OmapTemplate[];
  print?: OmapPrint;
  warnings: OmapWarning[];
}

// ─── Attribute helpers ───────────────────────────────────────────────────────

const int = (a: XmlAttributes, k: string, d = 0): number => {
  const v = a[k];
  if (v === undefined) return d;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const num = (a: XmlAttributes, k: string, d = 0): number => {
  const v = a[k];
  if (v === undefined) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (a: XmlAttributes, k: string, d = false): boolean => {
  const v = a[k];
  return v === undefined ? d : v === "true";
};
const str = (a: XmlAttributes, k: string, d = ""): string => a[k] ?? d;

// ─── Reader ──────────────────────────────────────────────────────────────────

class Warnings {
  private map = new Map<string, OmapWarning>();
  add(code: string, message?: string): void {
    const key = message ? `${code}\u0000${message}` : code;
    const w = this.map.get(key);
    if (w) w.count++;
    else this.map.set(key, { code, count: 1, message });
  }
  list(): OmapWarning[] {
    return [...this.map.values()];
  }
}

/** Parse the `x y[ flags];…` coordinate text (and legacy `<coord>` children). */
export function parseOmapCoords(coordsEl: XmlElement): OmapCoord[] {
  const out: OmapCoord[] = [];
  const text = coordsEl.text;
  if (text.trim() !== "") {
    // Tokens are integers separated by whitespace; ';' ends a coordinate.
    const re = /(-?\d+)|(;)/g;
    let m: RegExpExecArray | null;
    let cur: number[] = [];
    while ((m = re.exec(text)) !== null) {
      if (m[2]) {
        if (cur.length < 2) throw new Error(`omap: malformed coordinate "${text.slice(Math.max(0, m.index - 20), m.index + 1).trim()}"`);
        out.push({ x: cur[0], y: cur[1], flags: cur[2] ?? 0 });
        cur = [];
      } else cur.push(parseInt(m[1], 10));
    }
    if (cur.length) {
      if (cur.length < 2) throw new Error("omap: trailing partial coordinate");
      out.push({ x: cur[0], y: cur[1], flags: cur[2] ?? 0 });
    }
  }
  for (const c of childrenNamed(coordsEl, "coord")) out.push({ x: int(c.attrs, "x"), y: int(c.attrs, "y"), flags: int(c.attrs, "flags") });
  const count = coordsEl.attrs.count;
  if (count !== undefined && parseInt(count, 10) !== out.length) {
    throw new Error(`omap: expected ${count} coordinates, found ${out.length}`);
  }
  return out;
}

export function objectFromElement(e: XmlElement): OmapObject {
  const a = e.attrs;
  const type = int(a, "type", -1);
  const obj: OmapObject = {
    type,
    symbol: a.symbol === undefined || a.symbol === "" ? -1 : int(a, "symbol", -1),
    rotation: num(a, "rotation", 0),
    coords: [],
  };
  if (type === OMAP_OBJECT_TYPE.text) {
    obj.hAlign = int(a, "h_align", 0);
    obj.vAlign = int(a, "v_align", 0);
  }
  for (const c of e.children) {
    switch (c.name) {
      case "coords":
        obj.coords = parseOmapCoords(c);
        break;
      case "tags": {
        const tags: Record<string, string> = {};
        for (const t of c.children) if ((t.name === "t" || t.name === "tag") && t.attrs.k !== undefined) tags[t.attrs.k] = t.text;
        if (Object.keys(tags).length) obj.tags = tags;
        break;
      }
      case "pattern": {
        obj.patternRotation = num(c.attrs, "rotation", 0);
        const o = childNamed(c, "coord");
        if (o) obj.patternOrigin = { x: int(o.attrs, "x"), y: int(o.attrs, "y") };
        break;
      }
      case "size":
        obj.boxSize = { width: int(c.attrs, "width"), height: int(c.attrs, "height") };
        break;
      case "text":
        obj.text = c.text;
        break;
      default:
        break;
    }
  }
  if (type === OMAP_OBJECT_TYPE.text && obj.coords.length > 1 && !obj.boxSize) {
    // Box size travels as the second coordinate for compatibility.
    obj.boxSize = { width: obj.coords[1].x, height: obj.coords[1].y };
  }
  return obj;
}

function borderFrom(e: XmlElement): OmapBorder {
  const a = e.attrs;
  const dashed = bool(a, "dashed");
  return {
    colour: int(a, "color", -1),
    width: int(a, "width"),
    shift: int(a, "shift"),
    dashed,
    dashLength: dashed ? int(a, "dash_length") : 0,
    breakLength: dashed ? int(a, "break_length") : 0,
  };
}

function nestedSymbol(e: XmlElement | undefined, w: Warnings): OmapSymbol | undefined {
  if (!e) return undefined;
  const s = childNamed(e, "symbol");
  return s ? symbolFromElement(s, w) : undefined;
}

export function symbolFromElement(e: XmlElement, w: Warnings = new Warnings()): OmapSymbol {
  const a = e.attrs;
  const base: OmapSymbolBase = {
    type: int(a, "type", 0),
    id: a.id === undefined ? undefined : int(a, "id", -1),
    code: str(a, "code"),
    name: str(a, "name"),
    hidden: bool(a, "is_hidden"),
    helper: bool(a, "is_helper_symbol"),
    protected: bool(a, "is_protected"),
  };
  const d = childNamed(e, "description");
  if (d && d.text !== "") base.description = d.text;

  let body: OmapSymbolBody | null = null;
  switch (base.type) {
    case OMAP_SYMBOL_TYPE.point: {
      const p = childNamed(e, "point_symbol");
      if (!p) break;
      const pa = p.attrs;
      const elements: OmapPointElement[] = [];
      for (const el of childrenNamed(p, "element")) {
        const s = childNamed(el, "symbol");
        const o = childNamed(el, "object");
        if (!s || !o) {
          w.add("READER_WARNING", "point symbol element without symbol or object");
          continue;
        }
        elements.push({ symbol: symbolFromElement(s, w), object: objectFromElement(o) });
      }
      body = {
        kind: "point",
        rotatable: bool(pa, "rotatable"),
        innerRadius: int(pa, "inner_radius"),
        innerColour: int(pa, "inner_color", -1),
        outerWidth: int(pa, "outer_width"),
        outerColour: int(pa, "outer_color", -1),
        elements,
      };
      break;
    }
    case OMAP_SYMBOL_TYPE.line: {
      const l = childNamed(e, "line_symbol");
      if (!l) break;
      const la = l.attrs;
      const bordersEl = childNamed(l, "borders");
      let borders: OmapLineBody["borders"];
      if (bordersEl) {
        const bs = childrenNamed(bordersEl, "border").map(borderFrom);
        if (bs.length) {
          const different = bool(bordersEl.attrs, "borders_different");
          borders = { left: bs[0], right: different && bs[1] ? bs[1] : bs[0], different };
        }
      }
      const dashed = bool(la, "dashed");
      body = {
        kind: "line",
        colour: int(la, "color", -1),
        lineWidth: int(la, "line_width"),
        minimumLength: int(la, "minimum_length"),
        joinStyle: int(la, "join_style"),
        capStyle: int(la, "cap_style"),
        pointedCapLength: int(la, "pointed_cap_length"),
        startOffset: int(la, "start_offset"),
        endOffset: int(la, "end_offset"),
        dashed,
        segmentLength: int(la, "segment_length"),
        endLength: int(la, "end_length"),
        showAtLeastOneSymbol: bool(la, "show_at_least_one_symbol"),
        minimumMidSymbolCount: int(la, "minimum_mid_symbol_count"),
        minimumMidSymbolCountWhenClosed: int(la, "minimum_mid_symbol_count_when_closed"),
        dashLength: int(la, "dash_length"),
        breakLength: int(la, "break_length"),
        dashesInGroup: int(la, "dashes_in_group", 1),
        inGroupBreakLength: int(la, "in_group_break_length"),
        halfOuterDashes: bool(la, "half_outer_dashes"),
        midSymbolsPerSpot: int(la, "mid_symbols_per_spot", 1),
        midSymbolDistance: int(la, "mid_symbol_distance"),
        midSymbolPlacement: int(la, "mid_symbol_placement", 0),
        suppressDashSymbolAtEnds: bool(la, "suppress_dash_symbol_at_ends"),
        scaleDashSymbol: bool(la, "scale_dash_symbol", true),
        startSymbol: nestedSymbol(childNamed(l, "start_symbol"), w),
        midSymbol: nestedSymbol(childNamed(l, "mid_symbol"), w),
        endSymbol: nestedSymbol(childNamed(l, "end_symbol"), w),
        dashSymbol: nestedSymbol(childNamed(l, "dash_symbol"), w),
        borders,
      };
      break;
    }
    case OMAP_SYMBOL_TYPE.area: {
      const ar = childNamed(e, "area_symbol");
      if (!ar) break;
      const aa = ar.attrs;
      const patterns: OmapPattern[] = childrenNamed(ar, "pattern").map((p) => {
        const pa = p.attrs;
        const type = int(pa, "type", 1);
        const pat: OmapPattern = {
          type,
          angle: num(pa, "angle"),
          noClipping: int(pa, "no_clipping") & 3,
          rotatable: bool(pa, "rotatable"),
          lineSpacing: int(pa, "line_spacing"),
          lineOffset: int(pa, "line_offset"),
          offsetAlongLine: int(pa, "offset_along_line"),
        };
        if (type === 1) {
          pat.colour = int(pa, "color", -1);
          pat.lineWidth = int(pa, "line_width");
        } else {
          pat.pointDistance = int(pa, "point_distance");
          const s = childNamed(p, "symbol");
          if (s) pat.symbol = symbolFromElement(s, w);
        }
        return pat;
      });
      body = {
        kind: "area",
        innerColour: int(aa, "inner_color", -1),
        minArea: int(aa, "min_area"),
        rotatable: bool(aa, "rotatable"),
        patterns,
      };
      break;
    }
    case OMAP_SYMBOL_TYPE.text: {
      const t = childNamed(e, "text_symbol");
      if (!t) break;
      const font = childNamed(t, "font")?.attrs ?? {};
      const text = childNamed(t, "text")?.attrs ?? {};
      const fr = childNamed(t, "framing");
      const lb = childNamed(t, "line_below");
      const tabs = childNamed(t, "tabs");
      body = {
        kind: "text",
        iconText: str(t.attrs, "icon_text"),
        rotatable: bool(t.attrs, "rotatable", true),
        fontFamily: str(font, "family"),
        fontSize: int(font, "size"),
        bold: bool(font, "bold"),
        italic: bool(font, "italic"),
        underline: bool(font, "underline"),
        colour: int(text, "color", -1),
        lineSpacing: num(text, "line_spacing", 1),
        paragraphSpacing: int(text, "paragraph_spacing"),
        characterSpacing: num(text, "character_spacing"),
        kerning: bool(text, "kerning", true),
        framing: fr
          ? {
              colour: int(fr.attrs, "color", -1),
              mode: int(fr.attrs, "mode"),
              lineHalfWidth: int(fr.attrs, "line_half_width"),
              shadowXOffset: int(fr.attrs, "shadow_x_offset"),
              shadowYOffset: int(fr.attrs, "shadow_y_offset"),
            }
          : undefined,
        lineBelow: lb ? { colour: int(lb.attrs, "color", -1), width: int(lb.attrs, "width"), distance: int(lb.attrs, "distance") } : undefined,
        tabs: tabs ? childrenNamed(tabs, "tab").map((x) => parseInt(x.text, 10) || 0) : [],
      };
      break;
    }
    case OMAP_SYMBOL_TYPE.combined: {
      const c = childNamed(e, "combined_symbol");
      if (!c) break;
      const parts: OmapCombinedPart[] = childrenNamed(c, "part").map((p) => {
        if (bool(p.attrs, "private")) {
          const s = childNamed(p, "symbol");
          return s ? { symbol: symbolFromElement(s, w) } : null;
        }
        if (p.attrs.symbol === undefined) return null;
        const ref = int(p.attrs, "symbol", -1);
        return ref < 0 ? null : { ref };
      });
      body = { kind: "combined", parts };
      break;
    }
    default:
      w.add("READER_WARNING", `unknown symbol type ${base.type}`);
  }
  return { ...base, body };
}

function colourFromElement(e: XmlElement): OmapColour {
  const a = e.attrs;
  const col: OmapColour = {
    priority: int(a, "priority", -1),
    name: str(a, "name"),
    c: num(a, "c"),
    m: num(a, "m"),
    y: num(a, "y"),
    k: num(a, "k"),
    opacity: num(a, "opacity", 1),
    knockout: false,
  };
  const sc = childNamed(e, "spotcolors");
  if (sc) {
    col.knockout = bool(sc.attrs, "knockout");
    const named = childNamed(sc, "namedcolor");
    if (named) col.spotName = named.text;
    const comps = childrenNamed(sc, "component").map((c) => ({ factor: num(c.attrs, "factor"), spotColour: int(c.attrs, "spotcolor", -1) }));
    if (comps.length) col.spotComponents = comps;
  }
  const cm = childNamed(e, "cmyk");
  if (cm?.attrs.method) col.cmykMethod = cm.attrs.method;
  const rgb = childNamed(e, "rgb");
  if (rgb) col.rgb = { method: rgb.attrs.method, r: num(rgb.attrs, "r"), g: num(rgb.attrs, "g"), b: num(rgb.attrs, "b") };
  return col;
}

function georeferencingFrom(e: XmlElement | undefined): OmapGeoreferencing {
  const a = e?.attrs ?? {};
  const g: OmapGeoreferencing = {
    scale: int(a, "scale", 0),
    gridScaleFactor: num(a, "grid_scale_factor", 1),
    auxiliaryScaleFactor: num(a, "auxiliary_scale_factor", 1),
    declination: num(a, "declination", 0),
    grivation: num(a, "grivation", 0),
    refPoint: { x: 0, y: 0 },
  };
  if (!e) return g;
  const rp = childNamed(e, "ref_point");
  if (rp) g.refPoint = { x: num(rp.attrs, "x"), y: num(rp.attrs, "y") };
  const pc = childNamed(e, "projected_crs");
  if (pc) {
    const crs: OmapProjectedCrs = { id: str(pc.attrs, "id"), parameters: childrenNamed(pc, "parameter").map((p) => p.text) };
    const spec = childNamed(pc, "spec");
    if (spec && spec.text !== "") crs.spec = spec.text;
    const prp = childNamed(pc, "ref_point");
    if (prp) crs.refPoint = { x: num(prp.attrs, "x"), y: num(prp.attrs, "y") };
    g.projectedCrs = crs;
  }
  const gc = childNamed(e, "geographic_crs");
  const deg = gc && childNamed(gc, "ref_point_deg");
  if (deg) g.geographicRefPoint = { lat: num(deg.attrs, "lat"), lon: num(deg.attrs, "lon") };
  return g;
}

/**
 * Parse a Mapper XML document. Objects are streamed out of the tree as they
 * close so the peak memory is one object, not the whole file as a DOM; the
 * `<icon>`, `<undo>`, `<redo>` and `<view>` subtrees are discarded on the fly.
 */
export function readOmap(text: string): OmapFile {
  const w = new Warnings();
  const parts: OmapPart[] = [];
  let currentPart: OmapPart | undefined;
  const root = parseXmlTree(text, (path, attrs) => {
    const leaf = path[path.length - 1];
    const parent = path[path.length - 2];
    if ((parent === "map" || parent === "barrier") && (leaf === "undo" || leaf === "redo" || leaf === "view" || leaf === "map_view")) return "discard";
    if (leaf === "icon") return "discard";
    if (leaf === "part" && path[path.length - 2] === "parts") {
      currentPart = { name: str(attrs, "name"), objects: [] };
      parts.push(currentPart);
      return undefined; // keep the element itself; its objects are pruned below
    }
    if (leaf === "object" && path[path.length - 2] === "objects") {
      const part = currentPart;
      return (e) => {
        const obj = objectFromElement(e);
        if (part) part.objects.push(obj);
      };
    }
    return undefined;
  });
  if (root.name !== "map") throw new Error(`omap: root element is <${root.name}>, expected <map>`);
  const version = int(root.attrs, "version", 0);
  if (root.attrs.xmlns && root.attrs.xmlns !== OMAP_NAMESPACE) w.add("READER_WARNING", `unexpected namespace ${root.attrs.xmlns}`);

  // Sections sit either directly under <map> or inside a <barrier> wrapper
  // (Mapper ≥ 0.6 wraps everything after <colors> in one).
  const section = (name: string): XmlElement | undefined => {
    const direct = childNamed(root, name);
    if (direct) return direct;
    for (const b of childrenNamed(root, "barrier")) {
      const e = childNamed(b, name);
      if (e) return e;
    }
    return undefined;
  };

  const colours: OmapColour[] = [];
  const coloursEl = section("colors");
  if (coloursEl) {
    for (const c of childrenNamed(coloursEl, "color")) colours.push(colourFromElement(c));
    colours.sort((p, q) => p.priority - q.priority);
    colours.forEach((c, i) => {
      if (c.priority !== i) w.add("READER_WARNING", `colour priorities are not contiguous (index ${i} has priority ${c.priority})`);
    });
  }

  const symbolsEl = section("symbols");
  const symbols: OmapSymbol[] = [];
  let symbolSetId: string | undefined;
  if (symbolsEl) {
    symbolSetId = symbolsEl.attrs.id || undefined;
    const list = childrenNamed(symbolsEl, "symbol");
    list.forEach((s, i) => {
      const sym = symbolFromElement(s, w);
      if (sym.id !== undefined && sym.id !== i) w.add("READER_WARNING", `symbol id ${sym.id} at list position ${i}`);
      sym.id = i;
      symbols.push(sym);
    });
  }

  const templates: OmapTemplate[] = [];
  const templatesEl = section("templates");
  if (templatesEl) {
    for (const t of childrenNamed(templatesEl, "template")) {
      templates.push({ type: str(t.attrs, "type"), name: str(t.attrs, "name"), path: t.attrs.path, open: bool(t.attrs, "open") });
    }
  }

  let print: OmapPrint | undefined;
  const printEl = section("print");
  if (printEl) {
    print = {
      scale: printEl.attrs.scale !== undefined ? int(printEl.attrs, "scale") : undefined,
      resolution: printEl.attrs.resolution !== undefined ? int(printEl.attrs, "resolution") : undefined,
      mode: printEl.attrs.mode,
    };
    const area = childNamed(printEl, "print_area");
    if (area) {
      print.area = { left: num(area.attrs, "left"), top: num(area.attrs, "top"), width: num(area.attrs, "width"), height: num(area.attrs, "height") };
    }
  }

  const notes = section("notes")?.text;
  return {
    version,
    notes: notes === undefined || notes === "" ? undefined : notes,
    georeferencing: georeferencingFrom(section("georeferencing")),
    colours,
    symbols,
    symbolSetId,
    parts,
    templates,
    print,
    warnings: w.list(),
  };
}

/** Quick check used by format sniffing: is this text a Mapper XML map? */
export function looksLikeOmap(head: string): boolean {
  return /<map\b[^>]*openorienteering/i.test(head);
}
