/**
 * WebGL2 backend, GPU side. Takes a `PreparedStream` and a view, draws it
 * in stream order (which is colour-stack order). Five small programs:
 *
 *   fan / fanInst      stencil-invert triangles (even-odd fills)
 *   cover              paints where the stencil is set: solid or stripes
 *   stroke / strokeInst  shader-extruded strokes with a minimum pixel width
 *
 * Spike S1 step 3: one VBO per prepared item, no arena, no buckets, no
 * LOD beyond the minimum stroke width. Enough to measure and to prove
 * parity with the reference raster; the production backend grows from
 * here (docs/map-rendering.md §5.2).
 */

import type { FanGeometry, Prepared, PreparedStream, StrokeGeometry } from "./prepare.js";

export interface View {
  /** Paper point at the canvas centre, µm. */
  centreX: number;
  centreY: number;
  /** Device pixels per µm. */
  pxPerUm: number;
  /** Canvas size in device pixels. */
  widthPx: number;
  heightPx: number;
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

const CLIP_BIT = 0x01;
const PARITY_BIT = 0x02;

const VS_BLIT = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FS_BLIT = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 o;
void main() { o = texture(u_tex, v_uv); }
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
  };
}

export class MapGlRenderer {
  readonly gl: WebGL2RenderingContext;
  private readonly programs: Record<"fan" | "fanInst" | "cover" | "stroke" | "strokeInst" | "blit", Program>;
  private uploaded: Uploaded[] = [];
  private offscreen?: { w: number; h: number; msaa: WebGLFramebuffer; resolve: WebGLFramebuffer; tex: WebGLTexture; rbs: WebGLRenderbuffer[] };
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
      blit: this.link(VS_BLIT, FS_BLIT, ["a_pos"], ["u_tex"]),
    };
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
    this.deleteOffscreen();
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
    }
    this.uploaded = [];
  }

  render(view: View, opts: RenderOptions): void {
    const gl = this.gl;
    const ss = opts.supersample ?? 1;
    if (ss > 1) {
      const fb = this.offscreenFramebuffer(view.widthPx * ss, view.heightPx * ss);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb.msaa);
      this.draw({ ...view, widthPx: view.widthPx * ss, heightPx: view.heightPx * ss, pxPerUm: view.pxPerUm * ss }, opts, ss);
      // Resolve the multisample buffer into a texture (same size), then
      // draw it onto the canvas with linear filtering: at exactly 2× that
      // is a 2×2 box filter. (A scaled blit into the canvas is not an
      // option — its default framebuffer is itself multisampled.)
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb.msaa);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb.resolve);
      gl.blitFramebuffer(0, 0, fb.w, fb.h, 0, 0, fb.w, fb.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, view.widthPx, view.heightPx);
      gl.disable(gl.STENCIL_TEST);
      gl.disable(gl.BLEND);
      const p = this.programs.blit;
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fb.tex);
      gl.uniform1i(p.uniforms.u_tex, 0);
      this.quad ??= this.buffer(Float32Array.from([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
      gl.enableVertexAttribArray(p.attribs.a_pos);
      gl.vertexAttribPointer(p.attribs.a_pos, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.draw(view, opts, 1);
  }

  private offscreenFramebuffer(w: number, h: number): NonNullable<MapGlRenderer["offscreen"]> {
    const gl = this.gl;
    if (this.offscreen && this.offscreen.w === w && this.offscreen.h === h) return this.offscreen;
    this.deleteOffscreen();
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
    this.offscreen = { w, h, msaa, resolve, tex, rbs: [colourMs, stencilMs] };
    return this.offscreen;
  }

  private deleteOffscreen(): void {
    if (!this.offscreen) return;
    const gl = this.gl;
    gl.deleteFramebuffer(this.offscreen.msaa);
    gl.deleteFramebuffer(this.offscreen.resolve);
    gl.deleteTexture(this.offscreen.tex);
    for (const r of this.offscreen.rbs) gl.deleteRenderbuffer(r);
    this.offscreen = undefined;
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
    gl.disable(gl.STENCIL_TEST);
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
    gl.stencilFunc(gl.EQUAL, CLIP_BIT, CLIP_BIT);
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
    gl.stencilFunc(gl.EQUAL, want, want);
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
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
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
    if (clipped) gl.stencilFunc(gl.EQUAL, CLIP_BIT, CLIP_BIT);
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
