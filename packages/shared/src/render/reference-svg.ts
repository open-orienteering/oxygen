/**
 * Reference serialisation: pass stream → SVG. This is the oracle of the
 * golden-image tier (docs/map-rendering.md §6): it has no symbolisation
 * logic of its own — every pass is drawn exactly as the stream says, in
 * stream order, at paper size. Rasterisation (resvg) happens outside the
 * shared package.
 *
 * Coordinates stay in µm inside one root group that scales to millimetres
 * and flips y (paper is y-up, SVG is y-down), so numbers in the file are
 * the numbers in the stream.
 */

import {
  type FontRef,
  type GlyphMesh,
  type Pass,
  type PassStream,
  type RenderPath,
  type StrokeCap,
  type StrokeJoin,
  sortPassStream,
} from "./pass-stream.js";
import {
  type Bounds,
  type Segment,
  hatchLines,
  pathBounds,
  pathRings,
  ringSegments,
  sliceSegments,
  unionBounds,
} from "./path.js";
import { strokeOutline } from "./geometry.js";

export interface GlyphOutline {
  /** Outline in font units, y-up, origin at the baseline. */
  path: RenderPath;
  unitsPerEm: number;
}

export interface ReferenceSvgOptions {
  /** Colour-stack index → CSS colour. */
  colour: (idx: number) => string;
  /** Paper area to show, µm. Default: stream bounds plus `marginUm`. */
  bounds?: Bounds;
  marginUm?: number;
  /** Raster size hint: output pixels per millimetre. Default 10 (254 dpi). */
  pxPerMm?: number;
  /** Page colour under everything. Default white. */
  background?: string;
  /**
   * Glyph outlines for text passes. Without it, text is drawn as em boxes
   * (debug output, never a golden oracle).
   */
  glyphOutline?: (font: FontRef, glyphId: number) => GlyphOutline | undefined;
}

const n = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
};

function segmentsToD(segs: Segment[], close: boolean): string {
  if (segs.length === 0) return "";
  const parts: string[] = [`M${n(segs[0].x0)} ${n(segs[0].y0)}`];
  for (const s of segs) {
    parts.push(
      s.kind === "line"
        ? `L${n(s.x1)} ${n(s.y1)}`
        : `C${n(s.cx0)} ${n(s.cy0)} ${n(s.cx1)} ${n(s.cy1)} ${n(s.x1)} ${n(s.y1)}`,
    );
  }
  if (close) parts.push("Z");
  return parts.join("");
}

/** SVG path data for a whole path (all rings), closing rings when `closed`. */
export function pathToSvgD(path: RenderPath, forceClosed = false): string {
  const closed = path.closed || forceClosed;
  // `Z` closes the ring; emitting the closing segment explicitly too would
  // add a zero-length segment and a spurious join.
  return pathRings(path)
    .map((r) => segmentsToD(ringSegments(path, r, false), closed))
    .join("");
}

const capAttr = (c: StrokeCap) => (c === "pointed" ? "butt" : c);
const joinAttr = (j: StrokeJoin) => j;

function strokeAttrs(widthUm: number, cap: StrokeCap, join: StrokeJoin, colour: string): string {
  return `fill="none" stroke="${colour}" stroke-width="${n(widthUm)}" stroke-linecap="${capAttr(cap)}" stroke-linejoin="${joinAttr(join)}"`;
}

function glyphMeshSvg(mesh: GlyphMesh, colour: string): string {
  const fills = mesh.fills.map((p) => `<path d="${pathToSvgD(p, true)}" fill="${colour}" fill-rule="evenodd"/>`);
  const strokes = mesh.strokes.map(
    (s) => `<path d="${pathToSvgD(s.path)}" ${strokeAttrs(s.widthUm, s.cap, s.join, colour)}/>`,
  );
  return fills.concat(strokes).join("");
}

/** Bounds of everything a stream draws (control-point bounds; a superset). */
export function passStreamBounds(stream: PassStream): Bounds | undefined {
  let b: Bounds | undefined;
  const meshes = new Map<string, GlyphMesh>();
  for (const m of stream.glyphTable) meshes.set(`${m.glyphId}/${m.partIdx}`, m);
  for (const p of stream.passes) {
    switch (p.kind) {
      case "fill":
      case "stroke":
      case "hatch":
        b = unionBounds(b, pathBounds(p.path));
        break;
      case "glyph": {
        const mesh = meshes.get(`${p.glyphId}/${p.partIdx}`);
        let r = 0;
        if (mesh) {
          for (const f of mesh.fills) {
            const fb = pathBounds(f);
            r = Math.max(r, Math.abs(fb.minX), Math.abs(fb.maxX), Math.abs(fb.minY), Math.abs(fb.maxY));
          }
          for (const s of mesh.strokes) {
            const sb = pathBounds(s.path);
            r = Math.max(r, Math.abs(sb.minX), Math.abs(sb.maxX), Math.abs(sb.minY), Math.abs(sb.maxY)) + s.widthUm / 2;
          }
        }
        for (let i = 0; i < p.instances.length; i += 5) {
          const x = p.instances[i], y = p.instances[i + 1], s = p.instances[i + 4];
          const rr = r * s;
          b = unionBounds(b, { minX: x - rr, minY: y - rr, maxX: x + rr, maxY: y + rr });
        }
        break;
      }
      case "text":
        for (let i = 0; i < p.positions.length; i += 2) {
          const x = p.positions[i], y = p.positions[i + 1];
          b = unionBounds(b, { minX: x, minY: y - 0.25 * p.sizeUm, maxX: x + p.sizeUm, maxY: y + p.sizeUm });
        }
        break;
    }
  }
  return b;
}

/**
 * Serialises a stream to an SVG document. Passes are emitted in canonical
 * order, which is the painter's order of the colour stack.
 */
export function passStreamToSvg(stream: PassStream, opts: ReferenceSvgOptions): string {
  const s = sortPassStream(stream);
  const margin = opts.marginUm ?? 1000;
  const raw = opts.bounds ?? passStreamBounds(s) ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const b: Bounds = opts.bounds
    ? raw
    : { minX: raw.minX - margin, minY: raw.minY - margin, maxX: raw.maxX + margin, maxY: raw.maxY + margin };
  const wMm = (b.maxX - b.minX) / 1000;
  const hMm = (b.maxY - b.minY) / 1000;
  const pxPerMm = opts.pxPerMm ?? 10;
  const widthPx = Math.max(1, Math.round(wMm * pxPerMm));
  const heightPx = Math.max(1, Math.round(hMm * pxPerMm));

  const meshes = new Map<string, GlyphMesh>();
  for (const m of s.glyphTable) meshes.set(`${m.glyphId}/${m.partIdx}`, m);
  const fonts = new Map<number, FontRef>();
  for (const f of s.fontTable) fonts.set(f.fontId, f);

  // A clipped group whose clip lies wholly outside the frame draws
  // nothing; it is left out because resvg (2.6.2) aborts the process on
  // some of them (docs/map-rendering.md §5.1). Pixels are unchanged.
  const clippedAway = (c: Bounds) => c.maxX < b.minX || c.minX > b.maxX || c.maxY < b.minY || c.minY > b.maxY;

  const defs: string[] = [];
  const body: string[] = [];
  let idCounter = 0;
  const nextId = (prefix: string) => `${prefix}${idCounter++}`;
  const definedGlyphs = new Set<string>();

  // Filter masks (§3.8): one clip path per region of a mask — the frame with the region as an even-odd hole —
  // nested, so a masked pass shows only outside every region.
  const frameRing = `M${n(b.minX)} ${n(b.minY)}L${n(b.maxX)} ${n(b.minY)}L${n(b.maxX)} ${n(b.maxY)}L${n(b.minX)} ${n(b.maxY)}Z`;
  const maskClips = new Map<number, string[]>();
  const maskClipIds = (m: number): string[] => {
    let ids = maskClips.get(m);
    if (!ids) {
      ids = s.masks![m].regions.map((r) => {
        const cid = nextId("mask");
        defs.push(`<clipPath id="${cid}"><path d="${frameRing}${pathToSvgD(r, true)}" clip-rule="evenodd" fill-rule="evenodd"/></clipPath>`);
        return cid;
      });
      maskClips.set(m, ids);
    }
    return ids;
  };

  s.passes.forEach((p: Pass, passIndex: number) => {
    const mask = s.maskIdx?.[passIndex] ?? -1;
    const first = body.length;
    drawPass(p, passIndex);
    if (mask >= 0 && body.length > first) {
      const inner = body.splice(first).join("");
      const ids = maskClipIds(mask);
      body.push(ids.reduceRight((acc, cid, k) => `<g${k === 0 ? ` data-mask="${mask}"` : ""} clip-path="url(#${cid})">${acc}</g>`, inner));
    }
  });

  function drawPass(p: Pass, passIndex: number): void {
    const colour = opts.colour(p.colour);
    const tag = `data-pass="${passIndex}" data-kind="${p.kind}" data-colour="${p.colour}"`;
    switch (p.kind) {
      case "fill":
        body.push(`<path ${tag} d="${pathToSvgD(p.path, true)}" fill="${colour}" fill-rule="evenodd"/>`);
        break;
      case "stroke": {
        if (p.cap === "pointed" && ((p.taper?.startUm ?? 0) > 0 || (p.taper?.endUm ?? 0) > 0)) {
          // No SVG stroke tapers: the shared outline, as the PDF backend draws it.
          const outline = strokeOutline(p.path, { widthUm: p.widthUm, join: p.join, taper: p.taper, slices: p.slices });
          body.push(`<path ${tag} d="${pathToSvgD(outline, true)}" fill="${colour}" fill-rule="nonzero"/>`);
          break;
        }
        const attrs = strokeAttrs(p.widthUm, p.cap, p.join, colour);
        if (!p.slices) {
          body.push(`<path ${tag} d="${pathToSvgD(p.path)}" ${attrs}/>`);
        } else {
          const ds = p.slices
            .map((sl) => segmentsToD(sliceSegments(p.path, sl), false))
            .filter((d) => d.length > 0);
          body.push(`<path ${tag} data-slices="${p.slices.length}" d="${ds.join("")}" ${attrs}/>`);
        }
        break;
      }
      case "glyph": {
        const key = `${p.glyphId}/${p.partIdx}`;
        const mesh = meshes.get(key);
        const gid = `glyph-${p.glyphId}-${p.partIdx}-c${p.colour}`;
        if (!definedGlyphs.has(gid)) {
          definedGlyphs.add(gid);
          defs.push(`<g id="${gid}">${mesh ? glyphMeshSvg(mesh, colour) : ""}</g>`);
        }
        const uses: string[] = [];
        for (let i = 0; i < p.instances.length; i += 5) {
          const [x, y, c, sn, sc] = [p.instances[i], p.instances[i + 1], p.instances[i + 2], p.instances[i + 3], p.instances[i + 4]];
          uses.push(
            `<use href="#${gid}" transform="matrix(${n(c * sc)} ${n(sn * sc)} ${n(-sn * sc)} ${n(c * sc)} ${n(x)} ${n(y)})"/>`,
          );
        }
        if (p.clip) {
          if (clippedAway(pathBounds(p.clip))) break;
          const cid = nextId("clip");
          defs.push(`<clipPath id="${cid}"><path d="${pathToSvgD(p.clip, true)}" fill-rule="evenodd"/></clipPath>`);
          body.push(`<g ${tag} clip-path="url(#${cid})">${uses.join("")}</g>`);
        } else {
          body.push(`<g ${tag}>${uses.join("")}</g>`);
        }
        break;
      }
      case "hatch": {
        if (clippedAway(pathBounds(p.path))) break;
        const cid = nextId("clip");
        defs.push(`<clipPath id="${cid}"><path d="${pathToSvgD(p.path, true)}" fill-rule="evenodd"/></clipPath>`);
        const lines = hatchLines(pathBounds(p.path), { spacingUm: p.spacingUm, offsetUm: p.offsetUm, angleDeg: p.angleDeg });
        const d = lines.map((l) => `M${n(l.x0)} ${n(l.y0)}L${n(l.x1)} ${n(l.y1)}`).join("");
        body.push(
          `<g ${tag} clip-path="url(#${cid})"><path d="${d}" ${strokeAttrs(p.widthUm, "butt", "miter", colour)}/></g>`,
        );
        break;
      }
      case "text": {
        const font = fonts.get(p.fontId);
        const parts: string[] = [];
        for (let i = 0; i < p.glyphs.length; i++) {
          const x = p.positions[2 * i], y = p.positions[2 * i + 1];
          const a = p.angles ? (p.angles[i] * Math.PI) / 180 : 0;
          const cos = Math.cos(a), sin = Math.sin(a);
          const outline = font && opts.glyphOutline ? opts.glyphOutline(font, p.glyphs[i]) : undefined;
          if (outline) {
            const k = p.sizeUm / outline.unitsPerEm;
            const paint = p.haloWidthUm
              ? strokeAttrs((2 * p.haloWidthUm) / k, "round", "round", colour)
              : `fill="${colour}" fill-rule="evenodd"`;
            parts.push(
              `<path d="${pathToSvgD(outline.path, true)}" transform="matrix(${n(k * cos)} ${n(k * sin)} ${n(-k * sin)} ${n(k * cos)} ${n(x)} ${n(y)})" ${paint}/>`,
            );
          } else {
            // Debug fallback: an em box per glyph. Never used as an oracle.
            const w = 0.55 * p.sizeUm, asc = 0.72 * p.sizeUm, desc = 0.2 * p.sizeUm;
            const rot = a ? ` transform="rotate(${n((a * 180) / Math.PI)} ${n(x)} ${n(y)})"` : "";
            parts.push(
              p.haloWidthUm
                ? `<rect x="${n(x)}" y="${n(y - desc)}" width="${n(w)}" height="${n(asc + desc)}"${rot} ${strokeAttrs(2 * p.haloWidthUm, "round", "round", colour)}/>`
                : `<rect x="${n(x)}" y="${n(y - desc)}" width="${n(w)}" height="${n(asc + desc)}"${rot} fill="${colour}"/>`,
            );
          }
        }
        body.push(`<g ${tag} data-font="${p.fontId}" data-size="${n(p.sizeUm)}">${parts.join("")}</g>`);
        break;
      }
    }
  }

  const viewBox = `${n(b.minX)} ${n(-b.maxY)} ${n(b.maxX - b.minX)} ${n(b.maxY - b.minY)}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${widthPx}" height="${heightPx}" viewBox="${viewBox}">`,
    `<rect x="${n(b.minX)}" y="${n(-b.maxY)}" width="${n(b.maxX - b.minX)}" height="${n(b.maxY - b.minY)}" fill="${opts.background ?? "#ffffff"}"/>`,
    defs.length ? `<defs>${defs.join("")}</defs>` : "",
    `<g transform="scale(1 -1)">${body.join("")}</g>`,
    `</svg>`,
  ].join("");
}
