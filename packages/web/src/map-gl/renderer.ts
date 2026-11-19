/**
 * WebGL2 backend, GPU side (docs/map-rendering.md §5.2). Two paths over one
 * context:
 *
 *   arena path (B2)   `setDocument` / `uploadPart` / `setVisibleSet` / `renderDocument`:
 *                     vertex arenas per kind, visible-set index and instance buffers
 *                     per (colour, kind), mesh-atlas instancing, stencil clip groups,
 *                     MSDF text quads (B3, `setTextAtlas`), hairline floor and
 *                     screen-only LOD; one draw per (colour, kind)
 *   per-pass path     `setStream` / `render`: one draw per prepared pass, stencil
 *                     even-odd fills, optional 2× supersampling — the golden path
 *                     (§6.2) and the reference the arena path is compared with
 *
 * The renderer is dumb: `engine.ts` decides what is resident and visible.
 */

import { MITRE_LIMIT, type FanGeometry, type Prepared, type PreparedStream, type StrokeGeometry } from "./prepare.js";
import { GpuArena } from "./arena.js";
import { ATLAS_WIDTH, INSTANCE_FLOATS, type MeshAtlas } from "./mesh-atlas.js";
import { viewMatrix, type RenderTarget } from "./view.js";
import { DRAPE_TILE, drapeTiles } from "./terrain/footprint.js";
import { TerrainRenderer, type TerrainDrawStats, type TerrainFrame } from "./terrain/program.js";
import { TerrainLines, type LineDrawStats, type TerrainLine } from "./terrain/lines.js";
import { buildTextGlyphs, GLYPH_TABLE_TEXELS, GLYPH_TABLE_WIDTH, type TextAtlasPage } from "./text-atlas.js";
import {
  FILL_VERTEX_BYTES, HATCH_VERTEX_BYTES, STROKE_VERTEX_BYTES,
  type AlphaLayer, type ClipGroup, type ImageDraw, type DrawLayer, type PreparedPart, type ResidentPart, type VisibleSet,
} from "./buckets.js";

export interface View {
  /** Paper point at the canvas centre, µm. */
  centreX: number;
  centreY: number;
  /** Device pixels per µm. */
  pxPerUm: number;
  /** Canvas size in device pixels. */
  widthPx: number;
  heightPx: number;
  /** Display rotation, degrees counter-clockwise (arena path only; B4's north offset). Default 0. */
  rotationDeg?: number;
}

/** Options of the arena path (`renderDocument`); the screen-only rules of 04 §6.11. */
/** A texture of a window of its graphic (`[x, y, width, height]`, fractions, top-left origin; §5.2 "Images"). */
export interface WindowedTexture {
  source: TexImageSource;
  window: [number, number, number, number];
}

export interface DocumentRenderOptions {
  colour: (idx: number) => [number, number, number];
  background?: [number, number, number];
  /** Hairline floor: thinner strokes are drawn this wide with alpha × (true width / floor). Default 1 px. */
  minStrokePx?: number;
  /** Glyph instances smaller than this on screen (diameter) are skipped. Default 2 px. */
  minGlyphPx?: number;
  /** Hatch stripes closer than this on screen become a tint of coverage width / spacing. Default 1.5 px. */
  hatchTintPx?: number;
  /** Text whose em is smaller than this on screen is skipped (04 §6.11). Default 4 px. */
  minTextPx?: number;
  /**
   * Model → clip matrix (column-major) overriding the orthographic map view, e.g. a perspective
   * camera; positions are relative to the document origin. Cell selection and the screen-only rules
   * still use the `View` (its `pxPerUm`).
   */
  viewMatrix?: Float32Array;
  /** Profiling (dev page `kinds=`): draw only these kinds. */
  kinds?: ReadonlySet<"fill" | "hatch" | "stroke" | "glyph" | "clip" | "text" | "image">;
  /**
   * An image's texture (J6, §5.2 "Images"): `undefined` while it loads (drawn as an outline),
   * `null` when it cannot be had (an outline with `outlineMissingImages`, else nothing). Without
   * it every image is an outline. A texture of part of the graphic (an SVG's window) comes with
   * that `window`, and the crop is drawn relative to it. `pxPerUm` is the target's density.
   */
  graphic?: (image: ImageDraw, pxPerUm: number) => TexImageSource | WindowedTexture | null | undefined;
  /** Draw a failed image's outline too (the editor); the viewer and kiosk draw nothing. */
  outlineMissingImages?: boolean;
  /**
   * Layout mode's page (docs/course-layout.md §1): colours below `fromColour` are the map layer,
   * drawn only inside the frame (`ringUm`, paper µm); the page layer above them is not clipped.
   * The clip is the frame's screen bounding box (a scissor): exact while the page is upright on
   * screen, which Layout mode keeps.
   */
  pageClip?: { fromColour: number; ringUm: readonly (readonly [number, number])[] };
}

/**
 * The scissor box (device pixels, GL bottom-left origin) of a paper-µm ring under the model → clip
 * matrix `m` (positions relative to the origin): the ring's screen bounding box, clamped to the target.
 */
export function scissorOfRing(m: ArrayLike<number>, ring: readonly (readonly [number, number])[], originX: number, originY: number, width: number, height: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    const px = x - originX, py = y - originY;
    const cx = m[0] * px + m[4] * py + m[12], cy = m[1] * px + m[5] * py + m[13], w = m[3] * px + m[7] * py + m[15];
    const sx = ((cx / w + 1) / 2) * width, sy = ((cy / w + 1) / 2) * height;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  const l = Math.max(0, Math.min(width, Math.round(x0))), r = Math.max(0, Math.min(width, Math.round(x1)));
  const b = Math.max(0, Math.min(height, Math.round(y0))), t = Math.max(0, Math.min(height, Math.round(y1)));
  return [l, b, r - l, t - b];
}

export interface RenderOptions {
  colour: (idx: number) => [number, number, number];
  background?: [number, number, number];
  /** Strokes thinner than this on screen are widened to it. Default 0.75 px. */
  minStrokePx?: number;
  /**
   * Render at this multiple of the canvas size into an offscreen MSAA
   * framebuffer and box-filter down. 1 = draw straight to the canvas
   * (4× MSAA, what the context gives). 2 = 16 effective samples per
   * pixel: edge coverage close to an analytic rasteriser, four times the
   * fragment work. The golden fixture page uses 2.
   */
  supersample?: 1 | 2;
}

const VS_COMMON = `#version 300 es
precision highp float;
uniform vec2 u_centre;
uniform vec2 u_scale; // clip units per µm, x and y
vec4 project(vec2 p) { return vec4((p - u_centre) * u_scale, 0.0, 1.0); }
`;

const VS_FAN = VS_COMMON + `
in vec2 a_pos;
void main() { gl_Position = project(a_pos); }
`;

const VS_FAN_INST = VS_COMMON + `
in vec2 a_pos;
in vec4 a_inst; // x, y, cos, sin
in float a_scale;
void main() {
  vec2 p = a_pos * a_scale;
  vec2 r = vec2(p.x * a_inst.z - p.y * a_inst.w, p.x * a_inst.w + p.y * a_inst.z);
  gl_Position = project(a_inst.xy + r);
}
`;

const VS_COVER = VS_COMMON + `
in vec2 a_pos;
out vec2 v_paper;
void main() { v_paper = a_pos; gl_Position = project(a_pos); }
`;

const VS_STROKE = VS_COMMON + `
in vec2 a_pos;
in vec2 a_off;
uniform float u_halfWidth;   // µm
uniform float u_minHalfPx;   // device px
uniform float u_pxPerUm;
void main() {
  float hw = max(u_halfWidth, u_minHalfPx / u_pxPerUm);
  gl_Position = project(a_pos + a_off * hw);
}
`;

const VS_STROKE_INST = VS_COMMON + `
in vec2 a_pos;
in vec2 a_off;
in vec4 a_inst;
in float a_scale;
uniform float u_halfWidth;   // glyph units
uniform float u_minHalfPx;
uniform float u_pxPerUm;
void main() {
  float hw = max(u_halfWidth, u_minHalfPx / (u_pxPerUm * a_scale));
  vec2 p = (a_pos + a_off * hw) * a_scale;
  vec2 r = vec2(p.x * a_inst.z - p.y * a_inst.w, p.x * a_inst.w + p.y * a_inst.z);
  gl_Position = project(a_inst.xy + r);
}
`;

const FS_SOLID = `#version 300 es
precision highp float;
uniform vec3 u_colour;
out vec4 o;
void main() { o = vec4(u_colour, 1.0); }
`;

const FS_COVER = `#version 300 es
precision highp float;
uniform vec3 u_colour;
uniform int u_mode;           // 0 solid, 1 stripes
uniform vec2 u_normal;        // stripe normal (unit)
uniform float u_spacing;
uniform float u_offset;
uniform float u_halfWidth;
uniform float u_pxPerUm;
in vec2 v_paper;
out vec4 o;
void main() {
  if (u_mode == 0) { o = vec4(u_colour, 1.0); return; }
  float d = dot(v_paper, u_normal) - u_offset;
  float m = d - u_spacing * floor(d / u_spacing + 0.5); // signed distance to nearest stripe centre
  // Coverage approximation: a one-pixel ramp centred on the stripe edge.
  float a = clamp((u_halfWidth - abs(m)) * u_pxPerUm + 0.5, 0.0, 1.0);
  o = vec4(u_colour, a);
}
`;

// ---- arena path (B2): shaders -----------------------------------------------

/**
 * The arena fragment shaders' output (J3, §5.2 "Alpha layers"): `u_clear` = 1 − opacity and
 * `u_multiply` are 0 on opaque draws (a uniform's default), so an opaque draw writes
 * `(colour, a)` as before. An alpha layer folds its opacity into the coverage; Multiply writes
 * `mix(1, colour, k)` for the `DST_COLOR, ZERO` blend. In an alpha layer a fragment below
 * `u_minCover` (the interior phase) or with no coverage is discarded, so it does not take the
 * pixel's stencil mark.
 */
const FS_A_OUT = `
uniform float u_clear;
uniform float u_multiply;
uniform float u_minCover;
out vec4 o;
void outA(vec3 c, float a) {
  if ((u_clear > 0.0 || u_multiply > 0.5) && (a <= 0.0 || a < u_minCover)) discard;
  float k = a * (1.0 - u_clear);
  o = u_multiply > 0.5 ? vec4(mix(vec3(1.0), c, k), 1.0) : vec4(c, k);
}
`;

/**
 * Images (J6, §5.2 "Images"): the unit square (two triangles by vertex id; with u_outline its
 * four corners as a line loop) through the pass's affine, origin-relative. The texture is
 * straight alpha (decoded unpremultiplied): its alpha × opacity is the coverage, blended as
 * the alpha layers blend (Multiply: mix(1, colour, k) under DST_COLOR, ZERO).
 */
const VS_A_IMAGE = `#version 300 es
precision highp float;
uniform mat4 u_view;
uniform vec4 u_ab_cd;
uniform vec2 u_ef;
uniform vec4 u_crop;
uniform float u_outline;
out vec2 v_uv;
void main() {
  int i = gl_VertexID;
  vec2 q = u_outline > 0.5 ? vec2(i == 1 || i == 2 ? 1.0 : 0.0, i >= 2 ? 1.0 : 0.0)
    : vec2(i == 1 || i == 2 || i == 4 ? 1.0 : 0.0, i == 2 || i == 4 || i == 5 ? 1.0 : 0.0);
  vec2 p = u_ef + q.x * u_ab_cd.xy + q.y * u_ab_cd.zw;
  v_uv = vec2(u_crop.x + q.x * u_crop.z, u_crop.y + (1.0 - q.y) * u_crop.w);
  gl_Position = u_view * vec4(p, 0.0, 1.0);
}
`;

const FS_A_IMAGE = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform float u_multiply;
uniform float u_outline;
in vec2 v_uv;
out vec4 o;
void main() {
  if (u_outline > 0.5) { o = vec4(0.5, 0.5, 0.5, 0.6); return; }
  vec4 t = texture(u_tex, v_uv);
  float k = t.a * u_opacity;
  if (k <= 0.0) discard;
  o = u_multiply > 0.5 ? vec4(mix(vec3(1.0), t.rgb, k), 1.0) : vec4(t.rgb, k);
}
`;

const FS_A_SOLID = `#version 300 es
precision highp float;
uniform vec3 u_colour;
${FS_A_OUT}
void main() { outA(u_colour, 1.0); }
`;

const FS_A_ALPHA = `#version 300 es
precision highp float;
uniform vec3 u_colour;
in float v_alpha;
${FS_A_OUT}
void main() { outA(u_colour, v_alpha); }
`;

/** Positions are relative to the document origin; `u_view` is the model → clip matrix (view.ts, built in f64). */
const VS_ARENA = `#version 300 es
precision highp float;
uniform mat4 u_view;
uniform float u_pxPerUm;     // screen density for the screen-only rules (floor, skips, tint)
uniform float u_minPx;       // hairline floor, device px
vec4 projectA(vec2 p) { return u_view * vec4(p, 0.0, 1.0); }
`;

const VS_A_FILL = VS_ARENA + `
in vec2 a_pos;
void main() { gl_Position = projectA(a_pos); }
`;

const VS_A_HATCH = VS_ARENA + `
in vec2 a_pos;
in vec2 a_n;
in vec3 a_h;                 // spacing, offset (origin-relative), half width
out float v_d;
flat out float v_sp;
flat out float v_hw;
void main() {
  v_d = dot(a_pos, a_n) - a_h.y;
  v_sp = a_h.x;
  v_hw = a_h.z;
  gl_Position = projectA(a_pos);
}
`;

const FS_A_HATCH = `#version 300 es
precision highp float;
uniform vec3 u_colour;
uniform float u_pxPerUm;
uniform float u_tintPx;      // below this stripe spacing on screen, draw the coverage tint
in float v_d;
flat in float v_sp;
flat in float v_hw;
${FS_A_OUT}
void main() {
  if (v_sp * u_pxPerUm < u_tintPx) { outA(u_colour, clamp(2.0 * v_hw / v_sp, 0.0, 1.0)); return; }
  float m = v_d - v_sp * floor(v_d / v_sp + 0.5);
  outA(u_colour, clamp((v_hw - abs(m)) * u_pxPerUm + 0.5, 0.0, 1.0));
}
`;

/** Strokes: offset × half width; under the floor the ribbon is u_minPx wide and alpha carries the true width (04 §6.2). */
const VS_A_STROKE = VS_ARENA + `
in vec2 a_pos;
in vec2 a_off;               // SHORT normalised, × MITRE_LIMIT
in float a_hw;               // ½ µm
out float v_alpha;
void main() {
  float hw = a_hw * 0.5;
  float px = 2.0 * hw * u_pxPerUm;
  float hwe = hw;
  v_alpha = 1.0;
  if (px < u_minPx) { hwe = 0.5 * u_minPx / u_pxPerUm; v_alpha = px / u_minPx; }
  gl_Position = projectA(a_pos + a_off * ${MITRE_LIMIT.toFixed(1)} * hwe);
}
`;

/** Atlas instancing: vertex gl_VertexID of the instance's mesh, pulled from the atlas texture. */
const VS_A_INST = VS_ARENA + `
uniform highp sampler2D u_atlas;
uniform float u_minGlyphPx;
in vec4 a_i0;                // x, y, cos, sin
in vec4 a_i1;                // scale, base, count, radius
out float v_alpha;
void main() {
  int vid = gl_VertexID;
  float scale = a_i1.x;
  if (vid >= int(a_i1.z) || 2.0 * a_i1.w * scale * u_pxPerUm < u_minGlyphPx) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_alpha = 0.0;
    return;
  }
  int t = 2 * (int(a_i1.y) + vid);
  vec4 a = texelFetch(u_atlas, ivec2(t % ${ATLAS_WIDTH}, t / ${ATLAS_WIDTH}), 0);
  float hw = texelFetch(u_atlas, ivec2((t + 1) % ${ATLAS_WIDTH}, (t + 1) / ${ATLAS_WIDTH}), 0).x;
  vec2 p = a.xy;
  v_alpha = 1.0;
  if (hw > 0.0) {
    float px = 2.0 * hw * scale * u_pxPerUm;
    float hwe = hw;
    if (px < u_minPx) { hwe = 0.5 * u_minPx / (u_pxPerUm * scale); v_alpha = px / u_minPx; }
    p += a.zw * hwe;
  }
  p *= scale;
  vec2 r = vec2(p.x * a_i0.z - p.y * a_i0.w, p.x * a_i0.w + p.y * a_i0.z);
  gl_Position = projectA(a_i0.xy + r);
}
`;

/**
 * MSDF text (B3): one quad per glyph instance, corners from gl_VertexID; plane bounds (em) and
 * atlas uv from the glyph table (`text-atlas.ts` `buildTextGlyphs`). Text whose em is under
 * u_minTextPx on screen collapses.
 */
const VS_A_TEXT = VS_ARENA + `
uniform highp sampler2D u_glyphs;
uniform float u_minTextPx;
in vec4 a_i0;                // x, y, cos, sin
in vec4 a_i1;                // em size µm, glyph-table entry, halo half width (em), 0
out vec2 v_uv;
flat out float v_pxPerEm;
flat out float v_range;
flat out float v_halo;
void main() {
  float size = a_i1.x;
  v_pxPerEm = size * u_pxPerUm;
  if (v_pxPerEm < u_minTextPx) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  int e = int(a_i1.y) * ${GLYPH_TABLE_TEXELS};
  vec4 plane = texelFetch(u_glyphs, ivec2(e % ${GLYPH_TABLE_WIDTH}, e / ${GLYPH_TABLE_WIDTH}), 0);
  vec4 uv = texelFetch(u_glyphs, ivec2((e + 1) % ${GLYPH_TABLE_WIDTH}, (e + 1) / ${GLYPH_TABLE_WIDTH}), 0);
  v_range = texelFetch(u_glyphs, ivec2((e + 2) % ${GLYPH_TABLE_WIDTH}, (e + 2) / ${GLYPH_TABLE_WIDTH}), 0).y;
  v_halo = a_i1.z;
  int vid = gl_VertexID;     // two triangles: (0,0) (1,0) (0,1) · (0,1) (1,0) (1,1)
  vec2 c = vec2(vid == 1 || vid == 4 || vid == 5 ? 1.0 : 0.0, vid == 2 || vid == 3 || vid == 5 ? 1.0 : 0.0);
  vec2 p = mix(plane.xy, plane.zw, c) * size;
  v_uv = vec2(mix(uv.x, uv.z, c.x), mix(uv.w, uv.y, c.y)); // atlas v grows downward: bottom = v1
  vec2 r = vec2(p.x * a_i0.z - p.y * a_i0.w, p.x * a_i0.w + p.y * a_i0.z);
  gl_Position = projectA(a_i0.xy + r);
}
`;

/**
 * MTSDF decode: a fill pass covers where median(r, g, b) > ½ (sharp corners); a halo pass the band
 * |true distance| < halo (alpha channel) — the outline stroked round/round at twice the halo width,
 * as the reference raster draws it. Distances are em × v_range (channel value − ½); the edge ramp
 * is one screen pixel.
 */
const FS_A_TEXT = `#version 300 es
precision highp float;
uniform vec3 u_colour;
uniform sampler2D u_page;
in vec2 v_uv;
flat in float v_pxPerEm;
flat in float v_range;
flat in float v_halo;
${FS_A_OUT}
void main() {
  vec4 t = texture(u_page, v_uv);
  float a;
  if (v_halo > 0.0) {
    float d = (t.a - 0.5) * v_range;
    a = clamp((v_halo - abs(d)) * v_pxPerEm + 0.5, 0.0, 1.0);
  } else {
    float m = max(min(t.r, t.g), min(max(t.r, t.g), t.b));
    a = clamp((m - 0.5) * v_range * v_pxPerEm + 0.5, 0.0, 1.0);
  }
  if (a <= 0.0) discard;
  outA(u_colour, a);
}
`;

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Where `compositeInset` draws: a square of the canvas, top-left corner and side in device px. */
export interface InsetBox {
  x: number;
  y: number;
  size: number;
}

type Offscreen = { w: number; h: number; msaa: WebGLFramebuffer; resolve: WebGLFramebuffer; tex: WebGLTexture; rbs: WebGLRenderbuffer[] };

/** A drape layer's texture (docs/map-rendering.md §5.6 "Rendering the drape"): RGBA8 with a full mip chain. */
type DrapeTexture = { w: number; h: number; tex: WebGLTexture; fb: WebGLFramebuffer; levels: number };

export interface DrapeRenderStats {
  /** Draw calls over all tiles. */
  drawCalls: number;
  tiles: number;
  /** JS time of the tiles, the resolves and the mip chain, ms. */
  cpuMs: number;
}

/** GPU bytes of a drape layer's texture: RGBA8 and its mip chain. */
export function drapeTextureBytes(w: number, h: number): number {
  let n = 0;
  for (let lw = w, lh = h; ; lw = Math.max(1, lw >> 1), lh = Math.max(1, lh >> 1)) {
    n += lw * lh * 4;
    if (lw === 1 && lh === 1) break;
  }
  return n;
}

export interface FrameStats {
  drawCalls: number;
  /** Images in view drawn as an outline because their texture is not loaded (J6); absent when none. */
  imagesPending?: number;
  /** JS time of the frame, ms. */
  cpuMs: number;
  gpuMs?: number;
}

const CLIP_BIT = 0x01;
const PARITY_BIT = 0x02;
/** Filter masks (map-rendering §3.8): set inside the union of a mask's regions; masked draws need it clear. */
const REGION_BIT = 0x04;
/** Alpha layers (J3, §5.2 "Alpha layers"): set by a layer's first fragment per sample, so later ones fail; cleared after the layer. */
const ALPHA_BIT = 0x08;

const VS_BLIT = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FS_BLIT = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_circle;
in vec2 v_uv;
out vec4 o;
void main() {
  if (u_circle > 0.5 && length(v_uv - 0.5) > 0.5) discard;
  o = texture(u_tex, v_uv);
}
`;

interface Program {
  prog: WebGLProgram;
  attribs: Record<string, number>;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

interface Uploaded {
  item: Prepared;
  buffers: {
    fan?: WebGLBuffer; fanCount: number;
    cover?: WebGLBuffer;
    strokes: { buf: WebGLBuffer; count: number; halfWidth: number }[];
    inst?: WebGLBuffer; instCount: number;
    clipFan?: WebGLBuffer; clipFanCount: number; clipCover?: WebGLBuffer;
    /** Filter-mask regions: one stencil fan and cover per region. */
    regions?: { fan: WebGLBuffer; fanCount: number; cover: WebGLBuffer }[];
  };
}

interface ArenaState {
  originX: number;
  originY: number;
  arenas: { fill: GpuArena; hatch: GpuArena; stroke: GpuArena };
  atlas: { tex: WebGLTexture; bytes: number };
  parts: Map<string, ResidentPart>;
  vs: VisibleSet | undefined;
  vsBuffers: { fill: WebGLBuffer; hatch: WebGLBuffer; stroke: WebGLBuffer; glyph: WebGLBuffer; text: WebGLBuffer; clipPos: WebGLBuffer; clipIdx: WebGLBuffer; clipInst: WebGLBuffer; maskPos: WebGLBuffer; maskIdx: WebGLBuffer };
  vsBytes: number;
  vaos: { fill: WebGLVertexArrayObject; hatch: WebGLVertexArrayObject; stroke: WebGLVertexArrayObject; inst: WebGLVertexArrayObject; text: WebGLVertexArrayObject; clip: WebGLVertexArrayObject; mask: WebGLVertexArrayObject };
  vaoGeneration: number;
  programs: { fill: Program; hatch: Program; stroke: Program; inst: Program; text: Program };
}

/** A text atlas page and its decoded image (RGBA, not premultiplied), as `setTextAtlas` takes it. */
export interface TextAtlasImage {
  page: TextAtlasPage;
  image: TexImageSource;
}

/** The text atlas on the GPU: one texture per page, the glyph table. Session-scoped: survives `setDocument`. */
interface TextAtlasState {
  /** Page identities in order (what `setTextAtlas` compares to skip a re-upload). */
  pages: TextAtlasPage[];
  textures: WebGLTexture[];
  table: WebGLTexture;
  bytes: number;
}

/** Vertices one instanced draw pulls for a size class (a whole number of triangles). */
function classVertices(cls: number): number {
  return Math.ceil(2 ** cls / 3) * 3;
}

/** The lines a 3D frame draws over the mesh (§5.6 "Lines"): CSS widths × `pxRatio`. */
export interface TerrainLinesPass {
  lines: readonly TerrainLine[];
  pxRatio: number;
}

export class MapGlRenderer {
  readonly gl: WebGL2RenderingContext;
  private readonly programs: Record<"fan" | "fanInst" | "cover" | "stroke" | "strokeInst" | "blit", Program>;
  private readonly timer: { ext: TimerExt; pending: { q: WebGLQuery; frame: number }[] } | undefined;
  private frameCounter = 0;
  /** Last resolved GPU frame time, ms (needs EXT_disjoint_timer_query_webgl2). */
  lastGpuMs: number | undefined;
  private uploaded: Uploaded[] = [];
  /** Offscreen MSAA + stencil targets: the supersample path's, the loupe's (`insetTarget`) and the drape tiles' (`renderDrape`). */
  private offscreen: Partial<Record<"supersample" | "inset" | "drape", Offscreen>> = {};
  /** The drape layers' textures, by layer slot (§5.6 "Rendering the drape"). */
  private drapes: (DrapeTexture | undefined)[] = [];
  private terrainRenderer?: TerrainRenderer;
  private terrainLinesProgram?: TerrainLines;
  private quad?: WebGLBuffer;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, attrs: WebGLContextAttributes = {}) {
    const gl = canvas.getContext("webgl2", { stencil: true, antialias: true, alpha: false, premultipliedAlpha: false, ...attrs });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl as WebGL2RenderingContext;
    this.programs = {
      fan: this.link(VS_FAN, FS_SOLID, ["a_pos"], ["u_centre", "u_scale", "u_colour"]),
      fanInst: this.link(VS_FAN_INST, FS_SOLID, ["a_pos", "a_inst", "a_scale"], ["u_centre", "u_scale", "u_colour"]),
      cover: this.link(VS_COVER, FS_COVER, ["a_pos"], ["u_centre", "u_scale", "u_colour", "u_mode", "u_normal", "u_spacing", "u_offset", "u_halfWidth", "u_pxPerUm"]),
      stroke: this.link(VS_STROKE, FS_SOLID, ["a_pos", "a_off"], ["u_centre", "u_scale", "u_colour", "u_halfWidth", "u_minHalfPx", "u_pxPerUm"]),
      strokeInst: this.link(VS_STROKE_INST, FS_SOLID, ["a_pos", "a_off", "a_inst", "a_scale"], ["u_centre", "u_scale", "u_colour", "u_halfWidth", "u_minHalfPx", "u_pxPerUm"]),
      blit: this.link(VS_BLIT, FS_BLIT, ["a_pos"], ["u_tex", "u_circle"]),
    };
    const ext = this.gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerExt | null;
    if (ext) this.timer = { ext, pending: [] };
  }

  get hasGpuTimer(): boolean {
    return !!this.timer;
  }

  /** MSAA samples of the default framebuffer (04 §6.9: shown in the debug overlay). */
  get samples(): number {
    return this.gl.getParameter(this.gl.SAMPLES) as number;
  }

  private link(vs: string, fs: string, attribs: string[], uniforms: string[]): Program {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(prog)}`);
    const a: Record<string, number> = {};
    for (const n of attribs) a[n] = gl.getAttribLocation(prog, n);
    const u: Record<string, WebGLUniformLocation | null> = {};
    for (const n of uniforms) u[n] = gl.getUniformLocation(prog, n);
    return { prog, attribs: a, uniforms: u };
  }

  private buffer(data: Float32Array): WebGLBuffer {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  /** Replaces the resident geometry. */
  setStream(prepared: PreparedStream): void {
    this.deleteBuffers();
    this.uploaded = prepared.items.map((item) => ({ item, buffers: this.upload(item) }));
  }

  private upload(item: Prepared): Uploaded["buffers"] {
    const b = this.uploadItem(item);
    if (!item.mask) return b;
    return { ...b, regions: item.mask.filter((g) => g.fan.length).map((g) => ({ fan: this.buffer(g.fan), fanCount: g.fan.length / 2, cover: this.buffer(g.cover) })) };
  }

  private uploadItem(item: Prepared): Uploaded["buffers"] {
    const fanOf = (g: FanGeometry | undefined) =>
      g && g.fan.length ? { fan: this.buffer(g.fan), fanCount: g.fan.length / 2, cover: this.buffer(g.cover) } : { fanCount: 0 };
    const strokesOf = (ss: StrokeGeometry[]) =>
      ss.filter((s) => s.verts.length).map((s) => ({ buf: this.buffer(s.verts), count: s.verts.length / 4, halfWidth: s.halfWidth }));
    switch (item.kind) {
      case "fill":
      case "hatch":
        return { ...fanOf(item.geometry), strokes: [], instCount: 0, clipFanCount: 0 };
      case "stroke":
        return { fanCount: 0, strokes: strokesOf([item.geometry]), instCount: 0, clipFanCount: 0 };
      case "instanced": {
        const clip = fanOf(item.clip);
        return {
          ...fanOf(item.fill),
          strokes: strokesOf(item.strokes),
          inst: this.buffer(item.instances),
          instCount: item.instances.length / 5,
          clipFan: clip.fan,
          clipFanCount: clip.fanCount,
          clipCover: clip.cover,
        };
      }
    }
  }

  /** Frees every GL resource; the renderer is unusable afterwards. */
  dispose(): void {
    for (const t of this.graphicTextures.values()) this.gl.deleteTexture(t.tex);
    this.graphicTextures.clear();
    if (this.imageVao) this.gl.deleteVertexArray(this.imageVao);
    this.imageVao = undefined;
    this.disposeDocument();
    this.disposeTextAtlas();
    this.deleteOffscreen("supersample");
    this.deleteOffscreen("inset");
    this.releaseDrapes();
    this.terrainRenderer?.dispose();
    this.terrainRenderer = undefined;
    this.terrainLinesProgram?.dispose();
    this.terrainLinesProgram = undefined;
    this.deleteBuffers();
    if (this.quad) this.gl.deleteBuffer(this.quad);
    this.quad = undefined;
  }

  private deleteBuffers(): void {
    const gl = this.gl;
    for (const u of this.uploaded) {
      const b = u.buffers;
      for (const x of [b.fan, b.cover, b.inst, b.clipFan, b.clipCover]) if (x) gl.deleteBuffer(x);
      for (const s of b.strokes) gl.deleteBuffer(s.buf);
      for (const r of b.regions ?? []) { gl.deleteBuffer(r.fan); gl.deleteBuffer(r.cover); }
    }
    this.uploaded = [];
  }

  render(view: View, opts: RenderOptions): void {
    const gl = this.gl;
    const ss = opts.supersample ?? 1;
    if (ss > 1) {
      const fb = this.offscreenFramebuffer("supersample", view.widthPx * ss, view.heightPx * ss);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb.msaa);
      this.draw({ ...view, widthPx: view.widthPx * ss, heightPx: view.heightPx * ss, pxPerUm: view.pxPerUm * ss }, opts, ss);
      // Resolve the multisample buffer into a texture (same size), then
      // draw it onto the canvas with linear filtering: at exactly 2× that
      // is a 2×2 box filter. (A scaled blit into the canvas is not an
      // option — its default framebuffer is itself multisampled.)
      this.resolveOffscreen(fb);
      this.drawTexture(fb.tex, [0, 0, view.widthPx, view.heightPx], false);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.draw(view, opts, 1);
  }

  /**
   * The loupe's target (docs/map-rendering.md §5.5 "Loupe"): a `size`² offscreen framebuffer with
   * 4× MSAA colour and `DEPTH24_STENCIL8` (the supersample path's recipe), kept until the size
   * changes or `releaseInset`. Pass it to `renderDocument`, then `compositeInset`.
   */
  insetTarget(size: number): RenderTarget {
    const fb = this.offscreenFramebuffer("inset", size, size);
    return { framebuffer: fb.msaa, width: size, height: size };
  }

  /**
   * Resolves the inset target and draws it into the circle inscribed in `box` of the canvas
   * (fragments outside it discarded); the rest of the canvas is left as it is.
   */
  compositeInset(box: InsetBox): void {
    const fb = this.offscreen.inset;
    if (!fb) return;
    this.resolveOffscreen(fb);
    // `box` is top-left in device px; GL's viewport origin is the bottom-left.
    this.drawTexture(fb.tex, [box.x, this.gl.drawingBufferHeight - box.y - box.size, box.size, box.size], true);
  }

  /** Frees the inset target (the loupe went away); the next `insetTarget` makes a new one. */
  releaseInset(): void {
    this.deleteOffscreen("inset");
  }

  // ---- terrain (§5.6, H6) ------------------------------------------------------

  /** The terrain program on this renderer's context, made on first use. */
  get terrain(): TerrainRenderer {
    this.terrainRenderer ??= new TerrainRenderer(this.gl);
    return this.terrainRenderer;
  }

  /** The largest texture side this context allows. */
  get maxTextureSize(): number {
    return this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number;
  }

  /**
   * Renders the visible set with the orthographic `view` into drape layer `slot`'s texture
   * (`view.widthPx × view.heightPx` texels; made or remade at that size): tile by tile
   * (`drapeTiles`) through one `DRAPE_TILE`² MSAA + stencil target, each tile resolved and then
   * copied into its rectangle (a multisampled blit cannot move pixels), then the mip chain.
   */
  renderDrape(slot: number, view: View, opts: DocumentRenderOptions): DrapeRenderStats {
    const gl = this.gl;
    const t0 = performance.now();
    const d = this.drapeTexture(slot, view.widthPx, view.heightPx);
    const side = Math.min(DRAPE_TILE, Math.max(view.widthPx, view.heightPx));
    const scratch = this.offscreenFramebuffer("drape", side, side);
    let drawCalls = 0;
    const tiles = drapeTiles(view, side);
    for (const t of tiles) {
      const { widthPx: w, heightPx: h } = t.view;
      drawCalls += this.renderDocument(t.view, opts, { framebuffer: scratch.msaa, width: w, height: h }).drawCalls;
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, scratch.msaa);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, scratch.resolve);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, scratch.resolve);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, d.fb);
      gl.blitFramebuffer(0, 0, w, h, t.x, t.y, t.x + w, t.y + h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, d.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { drawCalls, tiles: tiles.length, cpuMs: performance.now() - t0 };
  }

  /** Drape layer `slot`'s texture, if rendered. */
  drape(slot: number): WebGLTexture | undefined {
    return this.drapes[slot]?.tex;
  }

  /** Frees drape layers from `slot` on (all by default), and the tile target with the last of them. */
  releaseDrapes(from = 0): void {
    const gl = this.gl;
    for (let i = from; i < this.drapes.length; i++) {
      const d = this.drapes[i];
      if (!d) continue;
      gl.deleteFramebuffer(d.fb);
      gl.deleteTexture(d.tex);
    }
    this.drapes.length = Math.min(this.drapes.length, from);
    if (!this.drapes.some(Boolean)) this.deleteOffscreen("drape");
  }

  /** GPU bytes of the drape layers' textures (the budget's count; the tile target is not in it). */
  get drapeBytes(): number {
    return this.drapes.reduce((n, d) => n + (d ? drapeTextureBytes(d.w, d.h) : 0), 0);
  }

  /** GPU bytes of the tile target: 4× MSAA colour + depth/stencil and the resolve texture. */
  get drapeScratchBytes(): number {
    const s = this.offscreen.drape;
    return s ? s.w * s.h * (4 * 8 + 4) : 0;
  }

  /**
   * Draws the terrain (§5.6 "Drawing") into `target` (default the canvas), then `lines` over it
   * (§5.6 "Lines", H8), under the GPU timer when there is one.
   */
  drawTerrain(frame: TerrainFrame, target?: RenderTarget, lines?: TerrainLinesPass): (TerrainDrawStats & FrameStats & { lines?: LineDrawStats }) | null {
    const gl = this.gl;
    const t0 = performance.now();
    this.resolveTimers();
    const q = this.timer ? gl.createQuery() : null;
    if (q && this.timer) gl.beginQuery(this.timer.ext.TIME_ELAPSED_EXT, q);
    const t = target ?? { framebuffer: null, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
    const stats = this.terrain.draw(frame, t);
    const mesh = this.terrain.mesh;
    let lineStats: LineDrawStats | undefined;
    if (stats && mesh && lines && lines.lines.length > 0) {
      this.terrainLinesProgram ??= new TerrainLines(gl);
      lineStats = this.terrainLinesProgram.draw(lines.lines, mesh, { matrix: stats.matrix, eye: stats.eye, focalPx: stats.focalPx, exaggeration: frame.exaggeration, pxRatio: lines.pxRatio }, t);
    }
    if (q && this.timer) {
      gl.endQuery(this.timer.ext.TIME_ELAPSED_EXT);
      this.timer.pending.push({ q, frame: this.frameCounter });
    }
    this.frameCounter++;
    if (!stats) return null;
    const out: TerrainDrawStats & FrameStats & { lines?: LineDrawStats } = { ...stats, drawCalls: stats.draws, cpuMs: performance.now() - t0 };
    if (lineStats) out.lines = lineStats;
    if (this.lastGpuMs !== undefined) out.gpuMs = this.lastGpuMs;
    return out;
  }

  private drapeTexture(slot: number, w: number, h: number): DrapeTexture {
    const cur = this.drapes[slot];
    if (cur && cur.w === w && cur.h === h) return cur;
    const gl = this.gl;
    if (cur) {
      gl.deleteFramebuffer(cur.fb);
      gl.deleteTexture(cur.tex);
    }
    const levels = Math.floor(Math.log2(Math.max(w, h))) + 1;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Far ground is seen at a grazing angle: anisotropic filtering keeps its lines from blurring away.
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number));
    gl.bindTexture(gl.TEXTURE_2D, null);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const d: DrapeTexture = { w, h, tex, fb, levels };
    this.drapes[slot] = d;
    return d;
  }

  private resolveOffscreen(fb: Offscreen): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb.msaa);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb.resolve);
    gl.blitFramebuffer(0, 0, fb.w, fb.h, 0, 0, fb.w, fb.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  /** Draws `tex` over the canvas viewport `[x, y, w, h]` (GL origin), optionally as its inscribed circle. */
  private drawTexture(tex: WebGLTexture, [x, y, w, h]: [number, number, number, number], circle: boolean): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(x, y, w, h);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    const p = this.programs.blit;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.uniforms.u_tex, 0);
    gl.uniform1f(p.uniforms.u_circle, circle ? 1 : 0);
    this.quad ??= this.buffer(Float32Array.from([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(p.attribs.a_pos);
    gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private offscreenFramebuffer(slot: "supersample" | "inset" | "drape", w: number, h: number): Offscreen {
    const gl = this.gl;
    const cur = this.offscreen[slot];
    if (cur && cur.w === w && cur.h === h) return cur;
    this.deleteOffscreen(slot);
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
    const rb = (format: number, multisampled: boolean) => {
      const r = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, r);
      if (multisampled) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, format, w, h);
      else gl.renderbufferStorage(gl.RENDERBUFFER, format, w, h);
      return r;
    };
    const colourMs = rb(gl.RGBA8, true);
    const stencilMs = rb(gl.DEPTH24_STENCIL8, true);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const msaa = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colourMs);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencilMs);
    const resolve = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, resolve);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const fb: Offscreen = { w, h, msaa, resolve, tex, rbs: [colourMs, stencilMs] };
    this.offscreen[slot] = fb;
    return fb;
  }

  private deleteOffscreen(slot: "supersample" | "inset" | "drape"): void {
    const fb = this.offscreen[slot];
    if (!fb) return;
    const gl = this.gl;
    gl.deleteFramebuffer(fb.msaa);
    gl.deleteFramebuffer(fb.resolve);
    gl.deleteTexture(fb.tex);
    for (const r of fb.rbs) gl.deleteRenderbuffer(r);
    delete this.offscreen[slot];
  }

  private draw(view: View, opts: RenderOptions, ss: number): void {
    const gl = this.gl;
    gl.viewport(0, 0, view.widthPx, view.heightPx);
    const bg = opts.background ?? [1, 1, 1];
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.STENCIL_TEST);

    const scale: [number, number] = [(2 * view.pxPerUm) / view.widthPx, (2 * view.pxPerUm) / view.heightPx];
    const minHalfPx = ((opts.minStrokePx ?? 0.75) * ss) / 2;
    const common = (p: Program) => {
      gl.useProgram(p.prog);
      gl.uniform2f(p.uniforms.u_centre, view.centreX, view.centreY);
      gl.uniform2f(p.uniforms.u_scale, scale[0], scale[1]);
      if (p.uniforms.u_pxPerUm) gl.uniform1f(p.uniforms.u_pxPerUm, view.pxPerUm);
      if (p.uniforms.u_minHalfPx) gl.uniform1f(p.uniforms.u_minHalfPx, minHalfPx);
    };

    for (const { item, buffers: b } of this.uploaded) {
      const rgb = opts.colour(item.colour);
      if (b.regions?.length) this.markRegions(b.regions, common);
      this.drawItem(item, b, rgb, view, common);
      if (b.regions?.length) this.clearRegions(b.regions, common);
    }
    gl.disable(gl.STENCIL_TEST);
  }

  /** Bits a masked draw requires clear: `REGION_BIT` between `markRegions` and `clearRegions`, else none. */
  private regionTest = 0;

  /** Sets `REGION_BIT` inside the union of the regions: each region's even-odd parity in the parity bit, then moved over. */
  private markRegions(regions: NonNullable<Uploaded["buffers"]["regions"]>, common: (p: Program) => void): void {
    const gl = this.gl;
    for (const r of regions) {
      this.stencilMark(r.fan, r.fanCount, common, PARITY_BIT);
      const p = this.programs.fan;
      common(p);
      gl.colorMask(false, false, false, false);
      gl.stencilMask(PARITY_BIT | REGION_BIT);
      gl.stencilFunc(gl.EQUAL, REGION_BIT | PARITY_BIT, PARITY_BIT);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      // Where the parity bit is set, REPLACE writes the reference under the write mask: the region bit (and the parity bit, already set).
      this.fanDraw(r.cover, p);
      // Then the parity bit is cleared over the cover for the next region and the item's own fills.
      gl.stencilMask(PARITY_BIT);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
      this.fanDraw(r.cover, p);
      gl.colorMask(true, true, true, true);
    }
    this.regionTest = REGION_BIT;
  }

  private clearRegions(regions: NonNullable<Uploaded["buffers"]["regions"]>, common: (p: Program) => void): void {
    const gl = this.gl;
    const p = this.programs.fan;
    common(p);
    gl.colorMask(false, false, false, false);
    gl.stencilMask(REGION_BIT);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    for (const r of regions) this.fanDraw(r.cover, p);
    gl.colorMask(true, true, true, true);
    this.regionTest = 0;
  }

  private fanDraw(buf: WebGLBuffer, p: Program): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(p.attribs.a_pos);
    gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawItem(item: Prepared, b: Uploaded["buffers"], rgb: [number, number, number], view: View, common: (p: Program) => void): void {
    switch (item.kind) {
      case "fill":
        if (!b.fan) break;
        this.stencilMark(b.fan, b.fanCount, common);
        this.coverSolid(b.cover!, rgb, common);
        break;
      case "hatch":
        if (!b.fan) break;
        this.stencilMark(b.fan, b.fanCount, common);
        this.coverStripes(b.cover!, rgb, item, view, common);
        break;
      case "stroke":
        for (const s of b.strokes) this.drawStroke(s, rgb, common);
        break;
      case "instanced": {
        if (!b.inst || b.instCount === 0) break;
        // Stencil bit 0 holds the clip mask (pattern areas), bit 1 the
        // per-instance even-odd parity, so a clipped instanced fill can
        // run the parity trick inside the mask.
        const clipped = !!b.clipFan;
        if (clipped) this.stencilMark(b.clipFan!, b.clipFanCount, common, CLIP_BIT);
        if (b.fan) {
          this.stencilMarkInst(b, common);
          this.coverSolidInst(b, rgb, clipped, common);
        }
        for (const s of b.strokes) this.drawStrokeInst(b, s, rgb, clipped, common);
        if (clipped) this.stencilClear(b.clipCover!, common);
        break;
      }
    }
  }

  /** Reads back finished GPU timer queries (results lag a frame or two). */
  private resolveTimers(): void {
    if (!this.timer) return;
    const gl = this.gl;
    const { ext, pending } = this.timer;
    while (pending.length) {
      const { q } = pending[0];
      const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      if (!available && !disjoint) break;
      if (available && !disjoint) this.lastGpuMs = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      gl.deleteQuery(q);
      pending.shift();
    }
  }

  // ---- arena path (B2) -----------------------------------------------------

  private arena?: ArenaState;

  /**
   * Starts a document on the arena path: positions arriving in parts are
   * relative to (`originX`, `originY`); `atlas` holds every glyph mesh
   * (text comes from `setTextAtlas`). Drops any previous document.
   */
  setDocument(originX: number, originY: number, atlas: MeshAtlas): void {
    this.disposeDocument();
    const gl = this.gl;
    const tex = this.atlasTexture(atlas);
    const p = this.arenaPrograms();
    this.arena = {
      originX, originY,
      arenas: { fill: new GpuArena(gl, FILL_VERTEX_BYTES), hatch: new GpuArena(gl, HATCH_VERTEX_BYTES, 1 << 12), stroke: new GpuArena(gl, STROKE_VERTEX_BYTES) },
      atlas: { tex, bytes: atlas.data.byteLength },
      parts: new Map(),
      vs: undefined,
      vsBuffers: {
        fill: gl.createBuffer()!, hatch: gl.createBuffer()!, stroke: gl.createBuffer()!, glyph: gl.createBuffer()!, text: gl.createBuffer()!,
        clipPos: gl.createBuffer()!, clipIdx: gl.createBuffer()!, clipInst: gl.createBuffer()!,
        maskPos: gl.createBuffer()!, maskIdx: gl.createBuffer()!,
      },
      vsBytes: 0,
      vaos: { fill: gl.createVertexArray()!, hatch: gl.createVertexArray()!, stroke: gl.createVertexArray()!, inst: gl.createVertexArray()!, text: gl.createVertexArray()!, clip: gl.createVertexArray()!, mask: gl.createVertexArray()! },
      vaoGeneration: -1,
      programs: p,
    };
  }

  private atlasTexture(atlas: MeshAtlas): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const rows = atlas.data.length / 4 / ATLAS_WIDTH;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ATLAS_WIDTH, rows, 0, gl.RGBA, gl.FLOAT, atlas.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /**
   * Replaces the mesh atlas of the current document with a grown one (the course layer's glyphs,
   * §5.2 "Dynamic bucket"). Growth is append-only, so every resident instance's `base` / `count`
   * stays valid.
   */
  setAtlas(atlas: MeshAtlas): void {
    const a = this.requireArena();
    this.gl.deleteTexture(a.atlas.tex);
    a.atlas = { tex: this.atlasTexture(atlas), bytes: atlas.data.byteLength };
  }

  private arenaPrograms(): ArenaState["programs"] {
    const common = ["u_view", "u_pxPerUm", "u_minPx", "u_colour", "u_clear", "u_multiply", "u_minCover"];
    this.arenaProgramCache ??= {
      fill: this.link(VS_A_FILL, FS_A_SOLID, ["a_pos"], common),
      hatch: this.link(VS_A_HATCH, FS_A_HATCH, ["a_pos", "a_n", "a_h"], [...common, "u_tintPx"]),
      stroke: this.link(VS_A_STROKE, FS_A_ALPHA, ["a_pos", "a_off", "a_hw"], common),
      inst: this.link(VS_A_INST, FS_A_ALPHA, ["a_i0", "a_i1"], [...common, "u_atlas", "u_minGlyphPx"]),
      text: this.link(VS_A_TEXT, FS_A_TEXT, ["a_i0", "a_i1"], [...common, "u_glyphs", "u_page", "u_minTextPx"]),
    };
    return this.arenaProgramCache;
  }

  private arenaProgramCache?: ArenaState["programs"];

  private text?: TextAtlasState;

  /**
   * Uploads the text atlas pages (§5.2 "Text atlas") in the order the worker resolves text against:
   * a text instance's draw group is its index here. A no-op when the same pages are already loaded.
   */
  setTextAtlas(pages: TextAtlasImage[]): void {
    const cur = this.text;
    if (cur && cur.pages.length === pages.length && cur.pages.every((p, i) => p === pages[i].page)) return;
    this.disposeTextAtlas();
    if (!pages.length) return;
    const gl = this.gl;
    const params = (filter: number) => {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    };
    // The distance field is data, not colour: no premultiplication, no colour-space conversion.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    let bytes = 0;
    const textures = pages.map(({ page, image }) => {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
      params(gl.LINEAR);
      bytes += page.width * page.height * 4;
      return tex;
    });
    const { table: data } = buildTextGlyphs(pages.map((p) => p.page));
    const table = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, table);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, GLYPH_TABLE_WIDTH, data.length / 4 / GLYPH_TABLE_WIDTH, 0, gl.RGBA, gl.FLOAT, data);
    params(gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.BROWSER_DEFAULT_WEBGL);
    this.text = { pages: pages.map((p) => p.page), textures, table, bytes: bytes + data.byteLength };
  }

  /** GPU bytes of the text atlas (pages + glyph table); 0 before `setTextAtlas`. */
  get textAtlasBytes(): number {
    return this.text?.bytes ?? 0;
  }

  private disposeTextAtlas(): void {
    const t = this.text;
    if (!t) return;
    for (const tex of t.textures) this.gl.deleteTexture(tex);
    this.gl.deleteTexture(t.table);
    this.text = undefined;
  }

  /** Uploads a prepared part into the arenas; returns where its vertices went (for `buildVisibleSet`). */
  uploadPart(key: string, part: PreparedPart): ResidentPart {
    const a = this.requireArena();
    this.releasePart(key);
    const base = {
      fill: part.fill ? a.arenas.fill.put(part.fill.verts) : 0,
      hatch: part.hatch ? a.arenas.hatch.put(part.hatch.verts) : 0,
      stroke: part.stroke ? a.arenas.stroke.put(part.stroke.verts) : 0,
    };
    const resident: ResidentPart = { part, base };
    a.parts.set(key, resident);
    return resident;
  }

  /** Frees a part's arena ranges and clip buffers (no-op if not resident). */
  releasePart(key: string): void {
    const a = this.arena;
    const r = a?.parts.get(key);
    if (!a || !r) return;
    const p = r.part;
    if (p.fill) a.arenas.fill.release(r.base.fill, p.fill.vertexCount);
    if (p.hatch) a.arenas.hatch.release(r.base.hatch, p.hatch.vertexCount);
    if (p.stroke) a.arenas.stroke.release(r.base.stroke, p.stroke.vertexCount);
    a.parts.delete(key);
  }

  hasPart(key: string): boolean {
    return !!this.arena?.parts.has(key);
  }

  /** Uploads the visible-set index and instance buffers (04 §6.8 point 2). */
  setVisibleSet(vs: VisibleSet): void {
    const a = this.requireArena();
    const gl = this.gl;
    const put = (target: number, buf: WebGLBuffer, data: ArrayBufferView) => {
      gl.bindBuffer(target, buf);
      gl.bufferData(target, data, gl.DYNAMIC_DRAW);
      return data.byteLength;
    };
    // ELEMENT_ARRAY_BUFFER binds into the current VAO; unbind first so no VAO captures these.
    gl.bindVertexArray(null);
    a.vsBytes =
      put(gl.ELEMENT_ARRAY_BUFFER, a.vsBuffers.fill, vs.fill.indices) +
      put(gl.ELEMENT_ARRAY_BUFFER, a.vsBuffers.hatch, vs.hatch.indices) +
      put(gl.ELEMENT_ARRAY_BUFFER, a.vsBuffers.stroke, vs.stroke.indices) +
      put(gl.ARRAY_BUFFER, a.vsBuffers.glyph, vs.glyph.instances) +
      put(gl.ARRAY_BUFFER, a.vsBuffers.text, vs.text.instances) +
      put(gl.ELEMENT_ARRAY_BUFFER, a.vsBuffers.clipIdx, vs.clips.indices) +
      put(gl.ARRAY_BUFFER, a.vsBuffers.clipPos, vs.clips.positions) +
      put(gl.ARRAY_BUFFER, a.vsBuffers.clipInst, vs.clips.instances) +
      put(gl.ELEMENT_ARRAY_BUFFER, a.vsBuffers.maskIdx, vs.filter?.indices ?? new Uint32Array(0)) +
      put(gl.ARRAY_BUFFER, a.vsBuffers.maskPos, vs.filter?.positions ?? new Float32Array(0));
    a.vs = vs;
    a.vaoGeneration = -1;
  }

  /** GPU bytes of the document path: arena capacity (and live), mesh atlas, text atlas, visible-set buffers (incl. clip groups). */
  get documentBytes(): { arenas: number; arenasUsed: number; atlas: number; text: number; visibleSet: number; total: number } {
    const a = this.arena;
    const text = this.textAtlasBytes;
    if (!a) return { arenas: 0, arenasUsed: 0, atlas: 0, text, visibleSet: 0, total: text };
    const ar = a.arenas;
    const arenas = ar.fill.capacityBytes + ar.hatch.capacityBytes + ar.stroke.capacityBytes;
    const arenasUsed = ar.fill.usedBytes + ar.hatch.usedBytes + ar.stroke.usedBytes;
    return { arenas, arenasUsed, atlas: a.atlas.bytes, text, visibleSet: a.vsBytes, total: arenas + a.atlas.bytes + text + a.vsBytes };
  }

  private requireArena(): ArenaState {
    if (!this.arena) throw new Error("setDocument first");
    return this.arena;
  }

  private bindArenaVaos(a: ArenaState): void {
    const gen = a.arenas.fill.generation * 1e6 + a.arenas.hatch.generation * 1e3 + a.arenas.stroke.generation;
    if (a.vaoGeneration === gen) return;
    const gl = this.gl;
    const P = a.programs;
    gl.bindVertexArray(a.vaos.fill);
    gl.bindBuffer(gl.ARRAY_BUFFER, a.arenas.fill.buffer);
    gl.enableVertexAttribArray(P.fill.attribs.a_pos);
    gl.vertexAttribPointer(P.fill.attribs.a_pos, 2, gl.FLOAT, false, FILL_VERTEX_BYTES, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, a.vsBuffers.fill);

    gl.bindVertexArray(a.vaos.hatch);
    gl.bindBuffer(gl.ARRAY_BUFFER, a.arenas.hatch.buffer);
    const h = P.hatch.attribs;
    gl.enableVertexAttribArray(h.a_pos);
    gl.vertexAttribPointer(h.a_pos, 2, gl.FLOAT, false, HATCH_VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(h.a_n);
    gl.vertexAttribPointer(h.a_n, 2, gl.FLOAT, false, HATCH_VERTEX_BYTES, 8);
    gl.enableVertexAttribArray(h.a_h);
    gl.vertexAttribPointer(h.a_h, 3, gl.FLOAT, false, HATCH_VERTEX_BYTES, 16);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, a.vsBuffers.hatch);

    gl.bindVertexArray(a.vaos.stroke);
    gl.bindBuffer(gl.ARRAY_BUFFER, a.arenas.stroke.buffer);
    const s = P.stroke.attribs;
    gl.enableVertexAttribArray(s.a_pos);
    gl.vertexAttribPointer(s.a_pos, 2, gl.FLOAT, false, STROKE_VERTEX_BYTES, 0);
    gl.enableVertexAttribArray(s.a_off);
    gl.vertexAttribPointer(s.a_off, 2, gl.SHORT, true, STROKE_VERTEX_BYTES, 8);
    gl.enableVertexAttribArray(s.a_hw);
    gl.vertexAttribPointer(s.a_hw, 1, gl.UNSIGNED_SHORT, false, STROKE_VERTEX_BYTES, 12);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, a.vsBuffers.stroke);

    gl.bindVertexArray(a.vaos.inst);
    const i = P.inst.attribs;
    gl.enableVertexAttribArray(i.a_i0);
    gl.vertexAttribDivisor(i.a_i0, 1);
    gl.enableVertexAttribArray(i.a_i1);
    gl.vertexAttribDivisor(i.a_i1, 1);

    gl.bindVertexArray(a.vaos.text);
    const tx = P.text.attribs;
    gl.enableVertexAttribArray(tx.a_i0);
    gl.vertexAttribDivisor(tx.a_i0, 1);
    gl.enableVertexAttribArray(tx.a_i1);
    gl.vertexAttribDivisor(tx.a_i1, 1);

    gl.bindVertexArray(a.vaos.clip);
    gl.bindBuffer(gl.ARRAY_BUFFER, a.vsBuffers.clipPos);
    gl.enableVertexAttribArray(P.fill.attribs.a_pos);
    gl.vertexAttribPointer(P.fill.attribs.a_pos, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, a.vsBuffers.clipIdx);

    gl.bindVertexArray(a.vaos.mask);
    gl.bindBuffer(gl.ARRAY_BUFFER, a.vsBuffers.maskPos);
    gl.enableVertexAttribArray(P.fill.attribs.a_pos);
    gl.vertexAttribPointer(P.fill.attribs.a_pos, 2, gl.FLOAT, false, 8, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, a.vsBuffers.maskIdx);
    gl.bindVertexArray(null);
    a.vaoGeneration = gen;
  }

  /**
   * Draws the visible set: per colour in stack order, fill → hatch → stroke → glyph (+ clips) → text
   * (MSDF quads from the text atlas; none without `setTextAtlas`).
   * `target` is where: a framebuffer and its size (default the canvas at the view's size). A
   * framebuffer target needs a stencil attachment for pattern clips.
   */
  renderDocument(view: View, opts: DocumentRenderOptions, target?: RenderTarget): FrameStats {
    const gl = this.gl;
    const a = this.requireArena();
    const t0 = performance.now();
    this.resolveTimers();
    const q = this.timer ? gl.createQuery() : null;
    if (q && this.timer) gl.beginQuery(this.timer.ext.TIME_ELAPSED_EXT, q);

    const t = target ?? { framebuffer: null, width: view.widthPx, height: view.heightPx };
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
    gl.viewport(0, 0, t.width, t.height);
    const bg = opts.background ?? [1, 1, 1];
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clearStencil(0);
    gl.stencilMask(0xff);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.STENCIL_TEST);

    let draws = 0;
    let imagesPending = 0;
    const vs = a.vs;
    if (vs) {
      this.bindArenaVaos(a);
      const P = a.programs;
      const m = opts.viewMatrix ?? viewMatrix(view, a.originX, a.originY);
      const minPx = opts.minStrokePx ?? 1;
      for (const p of [P.fill, P.hatch, P.stroke, P.inst, P.text]) {
        gl.useProgram(p.prog);
        gl.uniformMatrix4fv(p.uniforms.u_view, false, m);
        gl.uniform1f(p.uniforms.u_pxPerUm, view.pxPerUm);
        gl.uniform1f(p.uniforms.u_minPx, minPx);
      }
      gl.useProgram(P.hatch.prog);
      gl.uniform1f(P.hatch.uniforms.u_tintPx, opts.hatchTintPx ?? 1.5);
      gl.useProgram(P.inst.prog);
      gl.uniform1f(P.inst.uniforms.u_minGlyphPx, opts.minGlyphPx ?? 2);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, a.atlas.tex);
      gl.uniform1i(P.inst.uniforms.u_atlas, 0);
      const text = this.text;
      if (text) {
        gl.useProgram(P.text.prog);
        gl.uniform1f(P.text.uniforms.u_minTextPx, opts.minTextPx ?? 4);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, text.table);
        gl.uniform1i(P.text.uniforms.u_glyphs, 1);
        gl.uniform1i(P.text.uniforms.u_page, 2);
        gl.activeTexture(gl.TEXTURE0);
      }

      const cur = { fill: 0, hatch: 0, stroke: 0, glyph: 0, text: 0, clip: 0 };
      // Draw lists and `vs.layers` share the order (colour, then unmasked, then masks ascending).
      const before = (d: { colour: number; mask?: number }, l: DrawLayer) => d.colour < l.colour || (d.colour === l.colour && (d.mask ?? -1) < l.mask);
      const at = (d: { colour: number; mask?: number }, l: DrawLayer) => d.colour === l.colour && (d.mask ?? -1) === l.mask;
      /** Masked draws test the region bit (clear = outside every region); unmasked ones draw without the stencil. */
      const regionTest = (l: DrawLayer) => {
        if (l.mask < 0) { gl.disable(gl.STENCIL_TEST); return; }
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0);
        gl.stencilFunc(gl.EQUAL, 0, REGION_BIT);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      };
      const indexed = (kind: "fill" | "hatch" | "stroke", l: DrawLayer, rgb: [number, number, number]) => {
        const list = vs[kind].draws;
        while (cur[kind] < list.length && before(list[cur[kind]], l)) cur[kind]++;
        if (cur[kind] >= list.length || !at(list[cur[kind]], l)) return;
        const d = list[cur[kind]++];
        regionTest(l);
        const p = P[kind];
        gl.useProgram(p.prog);
        gl.uniform3f(p.uniforms.u_colour, rgb[0], rgb[1], rgb[2]);
        gl.bindVertexArray(a.vaos[kind]);
        gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, d.offset * 4);
        draws++;
      };
      /** Text: one quad (6 vertices) per instance, one draw per atlas page in this colour. */
      const textDraws = (l: DrawLayer, rgb: [number, number, number]) => {
        const list = vs.text.draws;
        while (cur.text < list.length && before(list[cur.text], l)) cur.text++;
        let bound = false;
        while (cur.text < list.length && at(list[cur.text], l)) {
          const d = list[cur.text++];
          const page = text?.textures[d.cls];
          if (!page) continue;
          if (!bound) {
            regionTest(l);
            gl.useProgram(P.text.prog);
            gl.uniform3f(P.text.uniforms.u_colour, rgb[0], rgb[1], rgb[2]);
            gl.bindVertexArray(a.vaos.text);
            gl.bindBuffer(gl.ARRAY_BUFFER, a.vsBuffers.text);
            bound = true;
          }
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, page);
          gl.activeTexture(gl.TEXTURE0);
          this.instancePointers(P.text, d.first * INSTANCE_FLOATS * 4);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, d.count);
          draws++;
        }
      };
      const instanced = (kind: "glyph", l: DrawLayer, rgb: [number, number, number]) => {
        const list = vs[kind].draws;
        while (cur[kind] < list.length && before(list[cur[kind]], l)) cur[kind]++;
        let bound = false;
        while (cur[kind] < list.length && at(list[cur[kind]], l)) {
          const d = list[cur[kind]++];
          if (!bound) {
            regionTest(l);
            gl.useProgram(P.inst.prog);
            gl.uniform3f(P.inst.uniforms.u_colour, rgb[0], rgb[1], rgb[2]);
            gl.bindVertexArray(a.vaos.inst);
            gl.bindBuffer(gl.ARRAY_BUFFER, a.vsBuffers[kind]);
            bound = true;
          }
          this.instancePointers(P.inst, d.first * INSTANCE_FLOATS * 4);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, classVertices(d.cls), d.count);
          draws++;
        }
      };
      const on = (k: "fill" | "hatch" | "stroke" | "glyph" | "clip" | "text" | "image") => !opts.kinds || opts.kinds.has(k);
      const pc = opts.pageClip;
      if (pc) {
        const [x, y, w, h] = scissorOfRing(m, pc.ringUm, a.originX, a.originY, t.width, t.height);
        gl.scissor(x, y, w, h);
      }
      for (const l of vs.layers) {
        const rgb = opts.colour(l.colour);
        if (pc) {
          if (l.colour < pc.fromColour) gl.enable(gl.SCISSOR_TEST);
          else gl.disable(gl.SCISSOR_TEST);
        }
        const masked = l.mask >= 0 && vs.filter;
        if (masked) draws += this.markMask(a, vs.filter!.masks[l.mask], true);
        if (l.alpha !== undefined) {
          const al = vs.alpha![l.alpha];
          if (al.kind === "image") {
            if (on("image")) {
              const d = this.drawImageLayer(m, al, opts, view.pxPerUm);
              draws += d.draws;
              imagesPending += d.pending;
            }
          } else if (on(al.kind)) draws += this.drawAlphaLayer(a, al, rgb, text?.textures);
          if (masked) draws += this.markMask(a, vs.filter!.masks[l.mask], false);
          continue;
        }
        if (on("fill")) indexed("fill", l, rgb);
        if (on("hatch")) indexed("hatch", l, rgb);
        if (on("stroke")) indexed("stroke", l, rgb);
        if (on("glyph")) instanced("glyph", l, rgb);
        const groups = vs.clips.groups;
        while (cur.clip < groups.length && before(groups[cur.clip], l)) cur.clip++;
        while (cur.clip < groups.length && at(groups[cur.clip], l)) {
          const g = groups[cur.clip++];
          if (on("clip")) draws += this.drawClip(a, g, rgb, l.mask >= 0 ? REGION_BIT : 0);
        }
        if (on("text")) textDraws(l, rgb);
        if (masked) draws += this.markMask(a, vs.filter!.masks[l.mask], false);
      }
      gl.bindVertexArray(null);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.SCISSOR_TEST);
    }
    if (q && this.timer) {
      gl.endQuery(this.timer.ext.TIME_ELAPSED_EXT);
      this.timer.pending.push({ q, frame: this.frameCounter });
    }
    this.frameCounter++;
    const stats: FrameStats = { drawCalls: draws, cpuMs: performance.now() - t0 };
    if (imagesPending) stats.imagesPending = imagesPending;
    if (this.lastGpuMs !== undefined) stats.gpuMs = this.lastGpuMs;
    return stats;
  }

  private imageProgram?: Program;
  private imageVao?: WebGLVertexArrayObject;
  private graphicTextures = new Map<TexImageSource, { tex: WebGLTexture; bytes: number }>();

  /** GPU bytes of the image textures (with their mip chains, 4/3), J6. */
  get graphicBytes(): number {
    let n = 0;
    for (const t of this.graphicTextures.values()) n += t.bytes;
    return n;
  }

  /** Deletes the texture made from `source` (the loader replaced or dropped it), J6. */
  releaseGraphic(source: TexImageSource): void {
    const t = this.graphicTextures.get(source);
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.graphicTextures.delete(source);
  }

  private graphicTexture(source: TexImageSource): WebGLTexture {
    const hit = this.graphicTextures.get(source);
    if (hit) return hit.tex;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Straight alpha, as decoded (`premultiplyAlpha: "none"`): the shader folds the alpha in.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    // Enlarged: nearest, as the PDF and the oracle sample (§3.10), so the canvas shows the print's pixels;
    // reduced: trilinear, so a large graphic zoomed out does not alias.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    const { width, height } = source as { width: number; height: number };
    this.graphicTextures.set(source, { tex, bytes: Math.round((width * height * 4 * 4) / 3) });
    return tex;
  }

  /**
   * One image (J6, §5.2 "Images"): its texture through the quad, under the pass's opacity and
   * blend; under a mask only where the region bit is clear. A quad covers each pixel once, so no
   * stencil test-and-set is needed. Without its texture: the quad's outline (1 px, 60 % grey)
   * while loading, or after a failure with `outlineMissingImages`.
   */
  private drawImageLayer(m: Float32Array, al: AlphaLayer, opts: DocumentRenderOptions, pxPerUm: number): { draws: number; pending: number } {
    const gl = this.gl;
    const img = al.image!;
    const got = opts.graphic ? opts.graphic(img, pxPerUm) : undefined;
    const windowed = got && typeof got === "object" && "window" in got ? got : undefined;
    const source = windowed ? windowed.source : (got as TexImageSource | null | undefined);
    // The crop relative to the texture's window (the whole graphic when it has none).
    const [wx, wy, ww, wh] = windowed?.window ?? [0, 0, 1, 1];
    const crop = [(img.crop[0] - wx) / ww, (img.crop[1] - wy) / wh, img.crop[2] / ww, img.crop[3] / wh];
    if (source === null && !opts.outlineMissingImages) return { draws: 0, pending: 0 };
    this.imageProgram ??= this.link(VS_A_IMAGE, FS_A_IMAGE, [], ["u_view", "u_ab_cd", "u_ef", "u_crop", "u_outline", "u_tex", "u_opacity", "u_multiply"]);
    this.imageVao ??= gl.createVertexArray()!;
    const P = this.imageProgram;
    gl.useProgram(P.prog);
    gl.bindVertexArray(this.imageVao);
    gl.uniformMatrix4fv(P.uniforms.u_view, false, m);
    const q = img.quad;
    gl.uniform4f(P.uniforms.u_ab_cd, q[0], q[1], q[2], q[3]);
    gl.uniform2f(P.uniforms.u_ef, q[4], q[5]);
    gl.uniform4f(P.uniforms.u_crop, crop[0], crop[1], crop[2], crop[3]);
    if (al.mask >= 0) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilMask(0);
      gl.stencilFunc(gl.EQUAL, 0, REGION_BIT);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    }
    let pending = 0;
    if (source) {
      const tex = this.graphicTexture(source);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(P.uniforms.u_tex, 3);
      gl.uniform1f(P.uniforms.u_outline, 0);
      gl.uniform1f(P.uniforms.u_opacity, al.opacity);
      gl.uniform1f(P.uniforms.u_multiply, al.multiply ? 1 : 0);
      if (al.multiply) gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ZERO, gl.ONE);
      else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    } else {
      pending = source === undefined ? 1 : 0;
      gl.uniform1f(P.uniforms.u_outline, 1);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.drawArrays(gl.LINE_LOOP, 0, 4);
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (al.mask >= 0) {
      gl.stencilMask(0xff);
      gl.disable(gl.STENCIL_TEST);
    }
    return { draws: 1, pending };
  }

  private instancePointers(p: Program, offset: number): void {
    const gl = this.gl;
    gl.vertexAttribPointer(p.attribs.a_i0, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, offset);
    gl.vertexAttribPointer(p.attribs.a_i1, 4, gl.FLOAT, false, INSTANCE_FLOATS * 4, offset + 16);
  }

  /**
   * A filter mask's regions into the region bit (`set`), or the bit cleared over them: their
   * triangles drawn with REPLACE / ZERO, no colour. One draw.
   */
  private markMask(a: ArenaState, m: { offset: number; count: number }, set: boolean): number {
    const gl = this.gl;
    if (!m.count) return 0;
    gl.useProgram(a.programs.fill.prog);
    gl.bindVertexArray(a.vaos.mask);
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilMask(REGION_BIT);
    gl.stencilFunc(gl.ALWAYS, REGION_BIT, 0xff);
    const op = set ? gl.REPLACE : gl.ZERO;
    gl.stencilOp(op, op, op);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, m.offset * 4);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.STENCIL_TEST);
    return 1;
  }

  /**
   * One alpha layer (J3, §5.2 "Alpha layers"): the pass drawn with its opacity (and Multiply)
   * in stencil test-and-set — a sample's first fragment sets `ALPHA_BIT`, later ones fail — so
   * the pass paints each sample once; then the bit cleared by the same geometry with colour off.
   * Every kind but a fill draws twice before the clear: full-coverage fragments first, then the
   * fringe, so a quad's or ribbon's faint edge cannot take a sample a neighbour covers fully. A
   * clipped glyph pass marks and clears its area (`CLIP_BIT`) around it. Under a mask the region
   * bit must be clear, as for an opaque draw.
   */
  private drawAlphaLayer(a: ArenaState, al: AlphaLayer, rgb: [number, number, number], pages: WebGLTexture[] | undefined): number {
    const gl = this.gl;
    const P = a.programs;
    const regionBit = al.mask >= 0 ? REGION_BIT : 0;
    const clip = al.kind === "clip";
    const prog = al.kind === "fill" || al.kind === "hatch" || al.kind === "stroke" ? P[al.kind] : al.kind === "text" ? P.text : P.inst;
    let draws = 0;
    const geometry = () => {
      if (al.kind === "fill" || al.kind === "hatch" || al.kind === "stroke") {
        gl.bindVertexArray(a.vaos[al.kind]);
        gl.drawElements(gl.TRIANGLES, al.count, gl.UNSIGNED_INT, al.offset * 4);
        draws++;
        return;
      }
      if (al.kind === "text") {
        gl.bindVertexArray(a.vaos.text);
        gl.bindBuffer(gl.ARRAY_BUFFER, a.vsBuffers.text);
        for (const r of al.runs) {
          const page = pages?.[r.cls];
          if (!page) continue;
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, page);
          gl.activeTexture(gl.TEXTURE0);
          this.instancePointers(P.text, r.first * INSTANCE_FLOATS * 4);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, r.count);
          draws++;
        }
        return;
      }
      gl.bindVertexArray(a.vaos.inst);
      gl.bindBuffer(gl.ARRAY_BUFFER, clip ? a.vsBuffers.clipInst : a.vsBuffers.glyph);
      for (const r of al.runs) {
        this.instancePointers(P.inst, r.first * INSTANCE_FLOATS * 4);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, classVertices(r.cls), r.count);
        draws++;
      }
    };
    const area = (op: number) => {
      gl.useProgram(P.fill.prog);
      gl.bindVertexArray(a.vaos.clip);
      gl.colorMask(false, false, false, false);
      gl.stencilMask(CLIP_BIT);
      gl.stencilFunc(gl.ALWAYS, CLIP_BIT, 0xff);
      gl.stencilOp(op, op, op);
      gl.drawElements(gl.TRIANGLES, al.count, gl.UNSIGNED_INT, al.offset * 4);
      gl.colorMask(true, true, true, true);
      draws++;
    };
    gl.enable(gl.STENCIL_TEST);
    if (clip) area(gl.REPLACE);
    gl.useProgram(prog.prog);
    gl.uniform3f(prog.uniforms.u_colour, rgb[0], rgb[1], rgb[2]);
    gl.uniform1f(prog.uniforms.u_clear, 1 - al.opacity);
    gl.uniform1f(prog.uniforms.u_multiply, al.multiply ? 1 : 0);
    // Destination alpha is kept in both modes (review J3), so a framebuffer read as RGBA stays opaque.
    if (al.multiply) gl.blendFuncSeparate(gl.DST_COLOR, gl.ZERO, gl.ZERO, gl.ONE);
    else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
    gl.stencilMask(ALPHA_BIT);
    gl.stencilFunc(gl.EQUAL, clip ? CLIP_BIT : 0, ALPHA_BIT | regionBit | (clip ? CLIP_BIT : 0));
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    for (const minCover of al.kind === "fill" ? [0] : [0.999, 0]) {
      gl.uniform1f(prog.uniforms.u_minCover, minCover);
      geometry();
    }
    // The clear: the same fragments (zero coverage still discarded), colour off, the bit zeroed.
    gl.uniform1f(prog.uniforms.u_minCover, 0);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    geometry();
    gl.colorMask(true, true, true, true);
    gl.uniform1f(prog.uniforms.u_clear, 0);
    gl.uniform1f(prog.uniforms.u_multiply, 0);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (clip) area(gl.ZERO);
    gl.disable(gl.STENCIL_TEST);
    return draws;
  }

  /** A clip group: its areas into stencil bit 0, its instances where the bit is set (and `regionTest` clear), the areas cleared. Three draws. */
  private drawClip(a: ArenaState, g: ClipGroup, rgb: [number, number, number], regionTest = 0): number {
    const gl = this.gl;
    if (!g.count) return 0;
    const P = a.programs;
    const area = (op: number) => {
      gl.useProgram(P.fill.prog);
      gl.bindVertexArray(a.vaos.clip);
      gl.colorMask(false, false, false, false);
      gl.stencilMask(CLIP_BIT);
      gl.stencilFunc(gl.ALWAYS, CLIP_BIT, 0xff);
      gl.stencilOp(op, op, op);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, g.offset * 4);
      gl.colorMask(true, true, true, true);
    };
    gl.enable(gl.STENCIL_TEST);
    area(gl.REPLACE);
    gl.useProgram(P.inst.prog);
    gl.uniform3f(P.inst.uniforms.u_colour, rgb[0], rgb[1], rgb[2]);
    gl.bindVertexArray(a.vaos.inst);
    gl.bindBuffer(gl.ARRAY_BUFFER, a.vsBuffers.clipInst);
    this.instancePointers(P.inst, g.first * INSTANCE_FLOATS * 4);
    gl.stencilFunc(gl.EQUAL, CLIP_BIT, CLIP_BIT | regionTest);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, classVertices(g.cls), g.instances);
    area(gl.ZERO);
    gl.disable(gl.STENCIL_TEST);
    return 3;
  }

  private disposeDocument(): void {
    const a = this.arena;
    if (!a) return;
    const gl = this.gl;
    for (const key of [...a.parts.keys()]) this.releasePart(key);
    a.arenas.fill.dispose();
    a.arenas.hatch.dispose();
    a.arenas.stroke.dispose();
    gl.deleteTexture(a.atlas.tex);
    for (const b of Object.values(a.vsBuffers)) gl.deleteBuffer(b);
    for (const v of Object.values(a.vaos)) gl.deleteVertexArray(v);
    this.arena = undefined;
  }

  // ---- stencil even-odd ----------------------------------------------------

  private stencilMark(fan: WebGLBuffer, count: number, common: (p: Program) => void, bit = CLIP_BIT): void {
    const gl = this.gl;
    const p = this.programs.fan;
    common(p);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.INVERT, gl.INVERT, gl.INVERT);
    gl.stencilMask(bit);
    gl.bindBuffer(gl.ARRAY_BUFFER, fan);
    gl.enableVertexAttribArray(p.attribs.a_pos);
    gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, count);
    gl.colorMask(true, true, true, true);
  }

  private coverSolid(cover: WebGLBuffer, rgb: [number, number, number], common: (p: Program) => void): void {
    const gl = this.gl;
    const p = this.programs.cover;
    common(p);
    gl.uniform3f(p.uniforms.u_colour, rgb[0], rgb[1], rgb[2]);
    gl.uniform1i(p.uniforms.u_mode, 0);
    this.coverDraw(cover, p);
  }

  private coverStripes(cover: WebGLBuffer, rgb: [number, number, number], h: Extract<Prepared, { kind: "hatch" }>, view: View, common: (p: Program) => void): void {
    const gl = this.gl;
    const p = this.programs.cover;
    common(p);
    gl.uniform3f(p.uniforms.u_colour, rgb[0], rgb[1], rgb[2]);
    gl.uniform1i(p.uniforms.u_mode, 1);
    const a = (h.angleDeg * Math.PI) / 180;
    gl.uniform2f(p.uniforms.u_normal, -Math.sin(a), Math.cos(a));
    gl.uniform1f(p.uniforms.u_spacing, h.spacingUm);
    gl.uniform1f(p.uniforms.u_offset, h.offsetUm);
    gl.uniform1f(p.uniforms.u_halfWidth, h.widthUm / 2);
    gl.uniform1f(p.uniforms.u_pxPerUm, view.pxPerUm);
    this.coverDraw(cover, p);
  }

  /** Paints the cover where the clip bit is set and resets it there. */
  private coverDraw(cover: WebGLBuffer, p: Program): void {
    const gl = this.gl;
    gl.stencilMask(CLIP_BIT);
    gl.stencilFunc(gl.EQUAL, CLIP_BIT, CLIP_BIT | this.regionTest);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    gl.bindBuffer(gl.ARRAY_BUFFER, cover);
    gl.enableVertexAttribArray(p.attribs.a_pos);
    gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private stencilClear(cover: WebGLBuffer, common: (p: Program) => void): void {
    const gl = this.gl;
    const p = this.programs.fan;
    common(p);
    gl.colorMask(false, false, false, false);
    gl.stencilMask(0xff);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    gl.bindBuffer(gl.ARRAY_BUFFER, cover);
    gl.enableVertexAttribArray(p.attribs.a_pos);
    gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.colorMask(true, true, true, true);
  }

  // ---- instanced ---------------------------------------------------------

  private bindInstance(p: Program, inst: WebGLBuffer): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.enableVertexAttribArray(p.attribs.a_inst);
    gl.vertexAttribPointer(p.attribs.a_inst, 4, gl.FLOAT, false, 20, 0);
    gl.vertexAttribDivisor(p.attribs.a_inst, 1);
    gl.enableVertexAttribArray(p.attribs.a_scale);
    gl.vertexAttribPointer(p.attribs.a_scale, 1, gl.FLOAT, false, 20, 16);
    gl.vertexAttribDivisor(p.attribs.a_scale, 1);
  }

  private unbindInstance(p: Program): void {
    const gl = this.gl;
    gl.vertexAttribDivisor(p.attribs.a_inst, 0);
    gl.vertexAttribDivisor(p.attribs.a_scale, 0);
    gl.disableVertexAttribArray(p.attribs.a_inst);
    gl.disableVertexAttribArray(p.attribs.a_scale);
  }

  private stencilMarkInst(b: Uploaded["buffers"], common: (p: Program) => void): void {
    const gl = this.gl;
    const p = this.programs.fanInst;
    common(p);
    gl.colorMask(false, false, false, false);
    gl.stencilMask(PARITY_BIT);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.INVERT, gl.INVERT, gl.INVERT);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.fan!);
    gl.enableVertexAttribArray(p.attribs.a_pos);
    gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 0, 0);
    this.bindInstance(p, b.inst!);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, b.fanCount, b.instCount);
    this.unbindInstance(p);
    gl.colorMask(true, true, true, true);
  }

  /** Paints instance covers where the parity bit is set (and the clip bit, when clipped); clears the parity bit everywhere it touches. */
  private coverSolidInst(b: Uploaded["buffers"], rgb: [number, number, number], clipped: boolean, common: (p: Program) => void): void {
    const gl = this.gl;
    const p = this.programs.fanInst;
    common(p);
    gl.uniform3f(p.uniforms.u_colour, rgb[0], rgb[1], rgb[2]);
    gl.stencilMask(PARITY_BIT);
    const want = clipped ? PARITY_BIT | CLIP_BIT : PARITY_BIT;
    gl.stencilFunc(gl.EQUAL, want, want | this.regionTest);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.cover!);
    gl.enableVertexAttribArray(p.attribs.a_pos);
    gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 0, 0);
    this.bindInstance(p, b.inst!);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, b.instCount);
    this.unbindInstance(p);
  }

  // ---- strokes -----------------------------------------------------------

  private drawStroke(s: { buf: WebGLBuffer; count: number; halfWidth: number }, rgb: [number, number, number], common: (p: Program) => void): void {
    const gl = this.gl;
    const p = this.programs.stroke;
    common(p);
    gl.uniform3f(p.uniforms.u_colour, rgb[0], rgb[1], rgb[2]);
    gl.uniform1f(p.uniforms.u_halfWidth, s.halfWidth);
    if (this.regionTest) gl.stencilFunc(gl.EQUAL, 0, this.regionTest);
    else gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);
    gl.enableVertexAttribArray(p.attribs.a_pos);
    gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(p.attribs.a_off);
    gl.vertexAttribPointer(p.attribs.a_off, 2, gl.FLOAT, false, 16, 8);
    gl.drawArrays(gl.TRIANGLES, 0, s.count);
  }

  private drawStrokeInst(b: Uploaded["buffers"], s: { buf: WebGLBuffer; count: number; halfWidth: number }, rgb: [number, number, number], clipped: boolean, common: (p: Program) => void): void {
    const gl = this.gl;
    const p = this.programs.strokeInst;
    common(p);
    gl.uniform3f(p.uniforms.u_colour, rgb[0], rgb[1], rgb[2]);
    gl.uniform1f(p.uniforms.u_halfWidth, s.halfWidth);
    if (clipped) gl.stencilFunc(gl.EQUAL, CLIP_BIT, CLIP_BIT | this.regionTest);
    else if (this.regionTest) gl.stencilFunc(gl.EQUAL, 0, this.regionTest);
    else gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.buf);
    gl.enableVertexAttribArray(p.attribs.a_pos);
    gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(p.attribs.a_off);
    gl.vertexAttribPointer(p.attribs.a_off, 2, gl.FLOAT, false, 16, 8);
    this.bindInstance(p, b.inst!);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, s.count, b.instCount);
    this.unbindInstance(p);
  }
}

/** Hex colour → 0..1 RGB. */
export function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
}
