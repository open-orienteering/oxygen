/**
 * JSON projection of a pass stream — for fixtures, snapshot tests and
 * debugging. The typed-array form is canonical; this is a lossless,
 * human-diffable view of it with a Zod schema so fixture files are
 * validated on load.
 *
 * Also the stream comparator used by the pass-stream assertion tier
 * (docs/map-rendering.md §6): structural equality with a length
 * tolerance in µm, reported as a list of differences rather than a
 * boolean so test failures say what moved.
 */

import { z } from "zod";
import {
  type FontRef,
  type GlyphMesh,
  type Pass,
  type PassStream,
  type RenderPath,
  type Slice,
  sortPassStream,
} from "./pass-stream.js";

const pathJson = z.object({
  coords: z.array(z.number().int()),
  flags: z.array(z.number().int().min(0).max(255)).optional(),
  closed: z.boolean().optional(),
});
const sliceJson = z.object({
  seg0: z.number().int().min(0),
  t0: z.number().min(0).max(1),
  seg1: z.number().int().min(0),
  t1: z.number().min(0).max(1),
});
const capJson = z.enum(["butt", "round", "square", "pointed"]);
const joinJson = z.enum(["miter", "round", "bevel"]);

const passJson = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fill"), colour: z.number().int(), path: pathJson }),
  z.object({
    kind: z.literal("stroke"),
    colour: z.number().int(),
    path: pathJson,
    slices: z.array(sliceJson).optional(),
    widthUm: z.number().nonnegative(),
    cap: capJson.default("butt"),
    join: joinJson.default("miter"),
    taper: z.object({ startUm: z.number().optional(), endUm: z.number().optional() }).optional(),
  }),
  z.object({
    kind: z.literal("glyph"),
    colour: z.number().int(),
    glyphId: z.number().int(),
    partIdx: z.number().int().default(0),
    /** x, y, cos, sin, scale per instance. */
    instances: z.array(z.number()),
    clip: pathJson.optional(),
  }),
  z.object({
    kind: z.literal("hatch"),
    colour: z.number().int(),
    path: pathJson,
    widthUm: z.number().positive(),
    spacingUm: z.number().positive(),
    offsetUm: z.number().default(0),
    angleDeg: z.number().default(0),
  }),
  z.object({
    kind: z.literal("text"),
    colour: z.number().int(),
    fontId: z.number().int(),
    sizeUm: z.number().positive(),
    glyphs: z.array(z.number().int()),
    positions: z.array(z.number()),
    angles: z.array(z.number()).optional(),
    haloWidthUm: z.number().positive().optional(),
  }),
]);

const glyphMeshJson = z.object({
  glyphId: z.number().int(),
  partIdx: z.number().int().default(0),
  fills: z.array(pathJson).default([]),
  strokes: z
    .array(
      z.object({
        path: pathJson,
        widthUm: z.number().nonnegative(),
        cap: capJson.default("butt"),
        join: joinJson.default("miter"),
      }),
    )
    .default([]),
});

const fontRefJson = z.object({
  fontId: z.number().int(),
  family: z.enum(["liberation-sans", "liberation-sans-narrow", "liberation-serif", "liberation-mono"]),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
});

export const passStreamJsonSchema = z.object({
  /** Parallel to `passes`. */
  objectIdx: z.array(z.number().int().min(0)),
  symbolIdx: z.array(z.number().int().min(0)),
  passes: z.array(passJson),
  glyphTable: z.array(glyphMeshJson).default([]),
  fontTable: z.array(fontRefJson).default([]),
  /** Filter masks (§3.8); absent = none. */
  masks: z.array(z.object({ regions: z.array(pathJson).min(1) })).optional(),
  /** Parallel to `passes`: index into `masks`, −1 = unmasked. */
  maskIdx: z.array(z.number().int().min(-1)).optional(),
});

export type PassStreamJson = z.input<typeof passStreamJsonSchema>;

function pathFromJson(p: z.output<typeof pathJson>): RenderPath {
  const n = p.coords.length / 2;
  if (!Number.isInteger(n)) throw new Error("path coords must be x,y pairs");
  const flags = new Uint8Array(n);
  if (p.flags) {
    if (p.flags.length !== n) throw new Error("path flags length must equal point count");
    flags.set(p.flags);
  }
  return { coords: Int32Array.from(p.coords), flags, closed: p.closed ?? false };
}

function pathToJson(p: RenderPath): z.input<typeof pathJson> {
  const out: z.input<typeof pathJson> = { coords: Array.from(p.coords) };
  if (p.flags.some((f) => f !== 0)) out.flags = Array.from(p.flags);
  if (p.closed) out.closed = true;
  return out;
}

/** Parses and validates a JSON projection; the result is canonically sorted. */
export function passStreamFromJson(input: unknown): PassStream {
  const j = passStreamJsonSchema.parse(input);
  if (j.objectIdx.length !== j.passes.length || j.symbolIdx.length !== j.passes.length) {
    throw new Error("objectIdx/symbolIdx must be parallel to passes");
  }
  if (!!j.masks !== !!j.maskIdx) throw new Error("masks and maskIdx come together");
  if (j.maskIdx && (j.maskIdx.length !== j.passes.length || j.maskIdx.some((m) => m >= j.masks!.length))) {
    throw new Error("maskIdx must be parallel to passes and index masks");
  }
  const passes: Pass[] = j.passes.map((p): Pass => {
    switch (p.kind) {
      case "fill":
        return { kind: "fill", colour: p.colour, path: pathFromJson(p.path), rule: "evenodd" };
      case "stroke":
        return {
          kind: "stroke",
          colour: p.colour,
          path: pathFromJson(p.path),
          ...(p.slices ? { slices: p.slices } : {}),
          widthUm: p.widthUm,
          cap: p.cap,
          join: p.join,
          ...(p.taper ? { taper: p.taper } : {}),
        };
      case "glyph":
        if (p.instances.length % 5 !== 0) throw new Error("glyph instances must be 5 numbers each");
        return {
          kind: "glyph",
          colour: p.colour,
          glyphId: p.glyphId,
          partIdx: p.partIdx,
          instances: Float32Array.from(p.instances),
          ...(p.clip ? { clip: pathFromJson(p.clip) } : {}),
        };
      case "hatch":
        return {
          kind: "hatch",
          colour: p.colour,
          path: pathFromJson(p.path),
          widthUm: p.widthUm,
          spacingUm: p.spacingUm,
          offsetUm: p.offsetUm,
          angleDeg: p.angleDeg,
        };
      case "text":
        if (p.positions.length !== p.glyphs.length * 2) {
          throw new Error("text positions must be x,y per glyph");
        }
        if (p.angles && p.angles.length !== p.glyphs.length) throw new Error("text angles must be one per glyph");
        return {
          kind: "text",
          colour: p.colour,
          fontId: p.fontId,
          sizeUm: p.sizeUm,
          glyphs: Uint16Array.from(p.glyphs),
          positions: Float32Array.from(p.positions),
          ...(p.angles ? { angles: Float32Array.from(p.angles) } : {}),
          ...(p.haloWidthUm ? { haloWidthUm: p.haloWidthUm } : {}),
        };
    }
  });
  const glyphTable: GlyphMesh[] = j.glyphTable.map((g) => ({
    glyphId: g.glyphId,
    partIdx: g.partIdx,
    fills: g.fills.map(pathFromJson),
    strokes: g.strokes.map((s) => ({ path: pathFromJson(s.path), widthUm: s.widthUm, cap: s.cap, join: s.join })),
  }));
  const fontTable: FontRef[] = j.fontTable.map((f) => ({ ...f }));
  return sortPassStream({
    objectIdx: Uint32Array.from(j.objectIdx),
    symbolIdx: Uint32Array.from(j.symbolIdx),
    passes,
    glyphTable,
    fontTable,
    ...(j.masks && j.maskIdx
      ? { masks: j.masks.map((m) => ({ regions: m.regions.map(pathFromJson) })), maskIdx: Int32Array.from(j.maskIdx) }
      : {}),
  });
}

/** Rounds to `digits` decimals so float noise does not show up in snapshots. */
function q(v: number, digits = 3): number {
  const m = 10 ** digits;
  const r = Math.round(v * m) / m;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * JSON projection of a stream. Float arrays are quantised to 3 decimals;
 * this is what snapshot files contain, so it must be deterministic for
 * equal inputs (the stream is sorted first).
 */
export function passStreamToJson(stream: PassStream): PassStreamJson {
  if (!!stream.masks !== !!stream.maskIdx) throw new Error("masks and maskIdx come together");
  const s = sortPassStream(stream);
  return {
    objectIdx: Array.from(s.objectIdx),
    symbolIdx: Array.from(s.symbolIdx),
    passes: s.passes.map((p) => {
      switch (p.kind) {
        case "fill":
          return { kind: "fill", colour: p.colour, path: pathToJson(p.path) };
        case "stroke":
          return {
            kind: "stroke",
            colour: p.colour,
            path: pathToJson(p.path),
            ...(p.slices
              ? { slices: p.slices.map((sl) => ({ seg0: sl.seg0, t0: q(sl.t0, 6), seg1: sl.seg1, t1: q(sl.t1, 6) })) }
              : {}),
            widthUm: q(p.widthUm),
            cap: p.cap,
            join: p.join,
            ...(p.taper ? { taper: p.taper } : {}),
          };
        case "glyph":
          return {
            kind: "glyph",
            colour: p.colour,
            glyphId: p.glyphId,
            partIdx: p.partIdx,
            // x, y are µm (3 decimals); cos, sin and scale are unitless and keep 6.
            instances: Array.from(p.instances, (v, k) => q(v, k % 5 < 2 ? 3 : 6)),
            ...(p.clip ? { clip: pathToJson(p.clip) } : {}),
          };
        case "hatch":
          return {
            kind: "hatch",
            colour: p.colour,
            path: pathToJson(p.path),
            widthUm: q(p.widthUm),
            spacingUm: q(p.spacingUm),
            offsetUm: q(p.offsetUm),
            angleDeg: q(p.angleDeg),
          };
        case "text":
          return {
            kind: "text",
            colour: p.colour,
            fontId: p.fontId,
            sizeUm: q(p.sizeUm),
            glyphs: Array.from(p.glyphs),
            positions: Array.from(p.positions, (v) => q(v)),
            ...(p.angles ? { angles: Array.from(p.angles, (v) => q(v, 6)) } : {}),
            ...(p.haloWidthUm ? { haloWidthUm: q(p.haloWidthUm) } : {}),
          };
      }
    }),
    glyphTable: s.glyphTable.map((g) => ({
      glyphId: g.glyphId,
      partIdx: g.partIdx,
      fills: g.fills.map(pathToJson),
      strokes: g.strokes.map((st) => ({ path: pathToJson(st.path), widthUm: q(st.widthUm), cap: st.cap, join: st.join })),
    })),
    fontTable: s.fontTable.map((f) => ({ ...f })),
    ...(s.masks && s.maskIdx
      ? { masks: s.masks.map((m) => ({ regions: m.regions.map(pathToJson) })), maskIdx: Array.from(s.maskIdx) }
      : {}),
  };
}

export interface StreamDifference {
  /** Pass index in the canonical order, or -1 for stream-level differences. */
  pass: number;
  what: string;
}

export interface DiffOptions {
  /** Tolerance for lengths and coordinates, µm. Default 1. */
  lengthToleranceUm?: number;
  /** Tolerance for slice parameters, unitless. Default 1e-6. */
  tToleranceUm?: number;
}

/**
 * Compares two streams in canonical order. Returns an empty list when they
 * are equal within tolerance. Geometry is compared coordinate by
 * coordinate (the stage is expected to be deterministic, not merely
 * equivalent), slices and instance transforms within tolerance.
 */
export function diffPassStreams(a: PassStream, b: PassStream, opts: DiffOptions = {}): StreamDifference[] {
  const tol = opts.lengthToleranceUm ?? 1;
  const tTol = opts.tToleranceUm ?? 1e-6;
  const A = sortPassStream(a);
  const B = sortPassStream(b);
  const out: StreamDifference[] = [];
  if (A.passes.length !== B.passes.length) {
    out.push({ pass: -1, what: `pass count ${A.passes.length} vs ${B.passes.length}` });
  }
  const n = Math.min(A.passes.length, B.passes.length);
  const near = (x: number, y: number, t = tol) => Math.abs(x - y) <= t;
  const samePath = (p: RenderPath, r: RenderPath): string | null => {
    if (p.closed !== r.closed) return "closed";
    if (p.coords.length !== r.coords.length) return `point count ${p.coords.length / 2} vs ${r.coords.length / 2}`;
    for (let i = 0; i < p.coords.length; i++) {
      if (!near(p.coords[i], r.coords[i])) return `coord ${i}: ${p.coords[i]} vs ${r.coords[i]}`;
    }
    for (let i = 0; i < p.flags.length; i++) {
      if (p.flags[i] !== r.flags[i]) return `flag ${i}: ${p.flags[i]} vs ${r.flags[i]}`;
    }
    return null;
  };
  const sameSlices = (p: Slice[] | undefined, r: Slice[] | undefined): string | null => {
    if (!p && !r) return null;
    if (!p || !r) return "slices present vs absent";
    if (p.length !== r.length) return `slice count ${p.length} vs ${r.length}`;
    for (let i = 0; i < p.length; i++) {
      const x = p[i], y = r[i];
      if (x.seg0 !== y.seg0 || x.seg1 !== y.seg1 || !near(x.t0, y.t0, tTol) || !near(x.t1, y.t1, tTol)) {
        return `slice ${i}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`;
      }
    }
    return null;
  };
  for (let i = 0; i < n; i++) {
    const p = A.passes[i], r = B.passes[i];
    const where = (w: string) => out.push({ pass: i, what: w });
    if (A.objectIdx[i] !== B.objectIdx[i]) where(`objectIdx ${A.objectIdx[i]} vs ${B.objectIdx[i]}`);
    if (A.symbolIdx[i] !== B.symbolIdx[i]) where(`symbolIdx ${A.symbolIdx[i]} vs ${B.symbolIdx[i]}`);
    const ma = A.maskIdx?.[i] ?? -1, mb = B.maskIdx?.[i] ?? -1;
    if ((ma < 0) !== (mb < 0)) where(`mask ${ma < 0 ? "absent" : "present"} vs ${mb < 0 ? "absent" : "present"}`);
    else if (ma >= 0) {
      const ra = A.masks![ma].regions, rb = B.masks![mb].regions;
      if (ra.length !== rb.length) where(`mask regions ${ra.length} vs ${rb.length}`);
      else ra.forEach((pa, k) => { const d = samePath(pa, rb[k]); if (d) where(`mask region ${k} ${d}`); });
    }
    if (p.kind !== r.kind) { where(`kind ${p.kind} vs ${r.kind}`); continue; }
    if (p.colour !== r.colour) where(`colour ${p.colour} vs ${r.colour}`);
    switch (p.kind) {
      case "fill": {
        const d = samePath(p.path, (r as typeof p).path);
        if (d) where(`fill path ${d}`);
        break;
      }
      case "stroke": {
        const s = r as typeof p;
        const d = samePath(p.path, s.path);
        if (d) where(`stroke path ${d}`);
        if (!near(p.widthUm, s.widthUm)) where(`widthUm ${p.widthUm} vs ${s.widthUm}`);
        if (p.cap !== s.cap) where(`cap ${p.cap} vs ${s.cap}`);
        if (p.join !== s.join) where(`join ${p.join} vs ${s.join}`);
        if (!near(p.taper?.startUm ?? 0, s.taper?.startUm ?? 0) || !near(p.taper?.endUm ?? 0, s.taper?.endUm ?? 0)) where("taper");
        const sd = sameSlices(p.slices, s.slices);
        if (sd) where(sd);
        break;
      }
      case "glyph": {
        const g = r as typeof p;
        if (p.glyphId !== g.glyphId || p.partIdx !== g.partIdx) where(`glyph ${p.glyphId}/${p.partIdx} vs ${g.glyphId}/${g.partIdx}`);
        if (p.instances.length !== g.instances.length) {
          where(`instance count ${p.instances.length / 5} vs ${g.instances.length / 5}`);
          break;
        }
        for (let k = 0; k < p.instances.length; k++) {
          const isLength = k % 5 < 2;
          if (!near(p.instances[k], g.instances[k], isLength ? tol : 1e-4)) {
            where(`instance ${Math.floor(k / 5)} component ${k % 5}: ${p.instances[k]} vs ${g.instances[k]}`);
            break;
          }
        }
        if (!!p.clip !== !!g.clip) where("clip present vs absent");
        else if (p.clip && g.clip) {
          const d = samePath(p.clip, g.clip);
          if (d) where(`clip path ${d}`);
        }
        break;
      }
      case "hatch": {
        const h = r as typeof p;
        const d = samePath(p.path, h.path);
        if (d) where(`hatch path ${d}`);
        if (!near(p.widthUm, h.widthUm) || !near(p.spacingUm, h.spacingUm) || !near(p.offsetUm, h.offsetUm) || !near(p.angleDeg, h.angleDeg, 1e-4)) {
          where("hatch params differ");
        }
        break;
      }
      case "text": {
        const t = r as typeof p;
        if (p.fontId !== t.fontId) where(`fontId ${p.fontId} vs ${t.fontId}`);
        if (!near(p.sizeUm, t.sizeUm)) where(`sizeUm ${p.sizeUm} vs ${t.sizeUm}`);
        if (p.glyphs.length !== t.glyphs.length) { where(`glyph count ${p.glyphs.length} vs ${t.glyphs.length}`); break; }
        for (let k = 0; k < p.glyphs.length; k++) {
          if (p.glyphs[k] !== t.glyphs[k]) { where(`glyph ${k}: ${p.glyphs[k]} vs ${t.glyphs[k]}`); break; }
          if (!near(p.positions[2 * k], t.positions[2 * k]) || !near(p.positions[2 * k + 1], t.positions[2 * k + 1])) {
            where(`glyph ${k} position`); break;
          }
        }
        if (!!p.angles !== !!t.angles) where("angles present on one side only");
        else if (p.angles && t.angles) {
          for (let k = 0; k < p.angles.length; k++) {
            if (!near(p.angles[k], t.angles[k], 1e-4)) { where(`glyph ${k} angle`); break; }
          }
        }
        if ((p.haloWidthUm ?? 0) !== (t.haloWidthUm ?? 0)) where("haloWidthUm");
        break;
      }
    }
  }
  return out;
}
