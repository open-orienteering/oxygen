/**
 * Lines on the terrain (docs/map-rendering.md §5.6 "Lines", H8): GPS
 * tracks as polylines in paper mm, lifted onto the drawn surface and drawn
 * after the mesh in the same frame, depth-tested against it.
 *
 * - `liftPolyline` (pure): paper mm → model µm, densified to the mesh's
 *   cell, each vertex at the drawn surface's height in int16 units above
 *   `zMin` (the exaggeration is the shader's, as the mesh's).
 * - `lineInstances` (pure): one `(p0, p1)` instance per segment.
 * - `TerrainLines`: screen-space capsules, lifted `LINE_LIFT_UM` plus their
 *   half width on screen (`lineVertex`) and moved `LINE_DEPTH_BIAS` of
 *   their distance towards the eye, depth test
 *   `LEQUAL` without depth writes, each line's opacity applied once
 *   through the stencil.
 */

import type { RenderTarget } from "../view.js";
import type { Vec3 } from "./mat4.js";
import type { TerrainMesh } from "./mesh.js";
import { surfaceHeight } from "./pick.js";

/** Model µm a line is drawn above the surface (2 m at 1:10 000), whatever the exaggeration. */
export const LINE_LIFT_UM = 200;
/** Share of its distance a line vertex moves towards the eye: coarse levels of detail lie above level 0. */
export const LINE_DEPTH_BIAS = 0.003;
/**
 * The screen rise's cap, in line widths of the distance's px-equivalents: looking straight down a
 * vertical rise does not move the line on screen, and the rise is then this much towards the eye.
 */
export const LINE_RISE_CAP = 4;
/** Segments one set of lines may have; over it, the densifying step doubles. */
export const MAX_LINE_SEGMENTS = 200_000;

export interface TerrainLine {
  /** Paper mm. */
  points: readonly { x: number; y: number }[];
  /** 0…1 RGB. */
  colour: readonly [number, number, number];
  /** 0…1, applied once over the whole line. */
  opacity: number;
  /** CSS px; the frame's `pxRatio` makes it device px. */
  widthPx: number;
}

/** Model µm → the surface's height in int16 units (absolute, as the mesh's), or null where there is none. */
export type LineSurface = (xUm: number, yUm: number) => number | null;

export interface LiftOptions {
  /** Default: the mesh's drawn surface (`surfaceHeight`). */
  surface?: LineSurface;
  /** Longest step in plan, model µm. Default: the mesh's cell. */
  stepUm?: number;
}

/**
 * A polyline in paper mm as runs of `(x, y, h − zMin)` vertices (model µm, height units): densified
 * so no step is longer than `stepUm` in plan, the original points kept, broken where the surface
 * has no height (off the mesh). Runs of fewer than two vertices are dropped.
 */
export function liftPolyline(points: readonly { x: number; y: number }[], mesh: TerrainMesh, opts: LiftOptions = {}): Float32Array[] {
  const surface = opts.surface ?? ((x: number, y: number) => surfaceHeight(mesh, x, y));
  const step = opts.stepUm ?? mesh.cellUm;
  const ox = mesh.originUm.x, oy = mesh.originUm.y, z0 = mesh.zMin;
  const runs: Float32Array[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length >= 6) runs.push(Float32Array.from(cur));
    cur = [];
  };
  const push = (x: number, y: number) => {
    const h = surface(x, y);
    if (h === null) flush();
    else cur.push(x, y, h - z0);
  };
  let px = 0, py = 0;
  points.forEach((p, i) => {
    const x = p.x * 1000 - ox, y = p.y * 1000 - oy;
    if (i === 0) push(x, y);
    else {
      const d = Math.hypot(x - px, y - py);
      if (d === 0) return;
      const n = Math.max(1, Math.ceil(d / step - 1e-9));
      for (let k = 1; k <= n; k++) push(k === n ? x : px + ((x - px) * k) / n, k === n ? y : py + ((y - py) * k) / n);
    }
    px = x;
    py = y;
  });
  flush();
  return runs;
}

export interface LineInstances {
  /** `(p0.x, p0.y, p0.h, p1.x, p1.y, p1.h)` per segment. */
  data: Float32Array;
  /** Each line's instances, in order. */
  ranges: { first: number; count: number }[];
  segments: number;
}

/** The instance buffer of a set of lines: densified to the mesh's cell, the step doubled until the set fits `MAX_LINE_SEGMENTS`. */
export function lineInstances(lines: readonly TerrainLine[], mesh: TerrainMesh, surface?: LineSurface): LineInstances {
  for (let step = mesh.cellUm; ; step *= 2) {
    const lifted = lines.map((l) => liftPolyline(l.points, mesh, { surface, stepUm: step }));
    const segments = lifted.reduce((s, runs) => s + runs.reduce((t, r) => t + r.length / 3 - 1, 0), 0);
    if (segments > MAX_LINE_SEGMENTS && step < 1e9) continue;
    const data = new Float32Array(segments * 6);
    const ranges: LineInstances["ranges"] = [];
    let at = 0;
    for (const runs of lifted) {
      const first = at;
      for (const r of runs)
        for (let i = 0; i + 5 < r.length; i += 3) {
          data.set(r.subarray(i, i + 6), at * 6);
          at++;
        }
      ranges.push({ first, count: at - first });
    }
    return { data, ranges, segments };
  }
}

/** The vertex shader's frame (and `lineVertex`'s). */
export interface LineVertexFrame {
  /** Model → clip. */
  matrix: ArrayLike<number>;
  /** Model µm. */
  eye: Vec3;
  /** Model µm per height unit: `unitUm · exaggeration`. */
  zUnit: number;
  /** Device px. */
  widthPx: number;
  heightPx: number;
  focalPx: number;
  /** Half the line's width, device px. */
  halfPx: number;
}

/** Model µm of the vertical step the screen-space rise is measured over. */
const RISE_PROBE_UM = 100;

/**
 * The vertex shader's position in TypeScript (the tests' twin of `VS`): `(x, y, h)` in model µm and
 * height units → the ground point raised `LINE_LIFT_UM` plus as much as lifts it `halfPx + ½` on
 * screen (at most `LINE_RISE_CAP` × that width in the distance's px-equivalents, where a vertical rise
 * barely moves on screen: looking straight down), then moved `LINE_DEPTH_BIAS` of the way to the eye.
 */
export function lineVertex(p: readonly [number, number, number], f: LineVertexFrame): [number, number, number] {
  const g: [number, number, number] = [p[0], p[1], p[2] * f.zUnit];
  let lift = LINE_LIFT_UM;
  const a = transform4(f.matrix, g[0], g[1], g[2]), b = transform4(f.matrix, g[0], g[1], g[2] + RISE_PROBE_UM);
  if (a[3] > 0 && b[3] > 0) {
    const rise = Math.hypot((b[0] / b[3] - a[0] / a[3]) * 0.5 * f.widthPx, (b[1] / b[3] - a[1] / a[3]) * 0.5 * f.heightPx) / RISE_PROBE_UM;
    const flat = f.focalPx / a[3];
    lift += (f.halfPx + 0.5) / Math.max(rise, flat / LINE_RISE_CAP);
  }
  const k = 1 - LINE_DEPTH_BIAS;
  return [f.eye[0] + (g[0] - f.eye[0]) * k, f.eye[1] + (g[1] - f.eye[1]) * k, f.eye[2] + (g[2] + lift - f.eye[2]) * k];
}

/** Column-major 4 × 4 times (x, y, z, 1). */
function transform4(m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

const VS = `#version 300 es
precision highp float;
in vec2 a_corner;
in vec3 a_p0;
in vec3 a_p1;
uniform mat4 u_view;
uniform vec3 u_eye;
uniform float u_zUnit;
uniform float u_halfPx;
uniform float u_focalPx;
uniform vec2 u_viewport;
flat out vec2 v_a;
flat out vec2 v_b;
// lineVertex in lines.ts
vec4 clipOf(vec3 p) {
  vec3 g = vec3(p.xy, p.z * u_zUnit);
  vec4 a = u_view * vec4(g, 1.0), b = u_view * vec4(g + vec3(0.0, 0.0, ${RISE_PROBE_UM.toFixed(1)}), 1.0);
  float lift = ${LINE_LIFT_UM.toFixed(1)};
  if (a.w > 0.0 && b.w > 0.0) {
    float rise = length((b.xy / b.w - a.xy / a.w) * 0.5 * u_viewport) / ${RISE_PROBE_UM.toFixed(1)};
    lift += (u_halfPx + 0.5) / max(rise, u_focalPx / a.w / ${LINE_RISE_CAP.toFixed(1)});
  }
  vec3 m = u_eye + (g + vec3(0.0, 0.0, lift) - u_eye) * ${(1 - LINE_DEPTH_BIAS).toFixed(6)};
  return u_view * vec4(m, 1.0);
}
void main() {
  vec4 c0 = clipOf(a_p0), c1 = clipOf(a_p1);
  if (c0.w <= 0.0 || c1.w <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    v_a = v_b = vec2(-1e9);
    return;
  }
  vec2 s0 = (c0.xy / c0.w * 0.5 + 0.5) * u_viewport;
  vec2 s1 = (c1.xy / c1.w * 0.5 + 0.5) * u_viewport;
  v_a = s0;
  v_b = s1;
  vec2 d = s1 - s0;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = u_halfPx + 1.0;
  bool start = a_corner.x < 0.5;
  vec4 c = start ? c0 : c1;
  vec2 s = (start ? s0 - dir * r : s1 + dir * r) + nrm * a_corner.y * r;
  gl_Position = vec4((s / u_viewport * 2.0 - 1.0) * c.w, c.z, c.w);
}`;

const FS = `#version 300 es
precision highp float;
uniform vec4 u_colour;
uniform float u_halfPx;
uniform int u_pass;
flat in vec2 v_a;
flat in vec2 v_b;
out vec4 o_colour;
void main() {
  vec2 p = gl_FragCoord.xy, ab = v_b - v_a;
  float l2 = dot(ab, ab);
  float t = l2 > 1e-9 ? clamp(dot(p - v_a, ab) / l2, 0.0, 1.0) : 0.0;
  float cov = clamp(u_halfPx + 0.5 - length(p - v_a - ab * t), 0.0, 1.0);
  // pass 0 the full-coverage interior, pass 1 the antialiased edge
  if (u_pass == 0 ? cov < 1.0 : (cov <= 0.0 || cov >= 1.0)) discard;
  o_colour = vec4(u_colour.rgb, u_colour.a * cov);
}`;

const UNIFORMS = ["u_view", "u_eye", "u_zUnit", "u_halfPx", "u_focalPx", "u_viewport", "u_colour", "u_pass"] as const;

export interface TerrainLinesFrame {
  /** The mesh draw's model → clip matrix. */
  matrix: Float32Array;
  /** Its eye, model µm. */
  eye: Vec3;
  /** Its focal length, device px. */
  focalPx: number;
  exaggeration: number;
  /** Device px per CSS px. */
  pxRatio: number;
}

export interface LineDrawStats {
  /** Lines with at least one segment drawn. */
  lines: number;
  draws: number;
  segments: number;
}

/** The lines program on the caller's context (§5.6 "Lines"). */
export class TerrainLines {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly cornerBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly aP0: number;
  private readonly aP1: number;
  private built: { lines: readonly TerrainLine[]; mesh: TerrainMesh; inst: LineInstances } | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`terrain lines shader: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const prog = gl.createProgram()!;
    const vs = compile(gl.VERTEX_SHADER, VS), fs = compile(gl.FRAGMENT_SHADER, FS);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`terrain lines program: ${gl.getProgramInfoLog(prog)}`);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.prog = prog;
    this.u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)])) as TerrainLines["u"];

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.cornerBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const aCorner = gl.getAttribLocation(prog, "a_corner");
    gl.enableVertexAttribArray(aCorner);
    gl.vertexAttribPointer(aCorner, 2, gl.FLOAT, false, 8, 0);
    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    this.aP0 = gl.getAttribLocation(prog, "a_p0");
    this.aP1 = gl.getAttribLocation(prog, "a_p1");
    for (const a of [this.aP0, this.aP1]) {
      gl.enableVertexAttribArray(a);
      gl.vertexAttribDivisor(a, 1);
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /**
   * Draws `lines` into `target` over the mesh just drawn there (its depth still in the target).
   * Rebuilds the instances only when `lines` or `mesh` changed.
   */
  draw(lines: readonly TerrainLine[], mesh: TerrainMesh, frame: TerrainLinesFrame, target: RenderTarget): LineDrawStats {
    const gl = this.gl;
    if (lines.length === 0) return { lines: 0, draws: 0, segments: 0 };
    if (!this.built || this.built.lines !== lines || this.built.mesh !== mesh) {
      const inst = lineInstances(lines, mesh);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, inst.data, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      this.built = { lines, mesh, inst };
    }
    const { inst } = this.built;
    if (inst.segments === 0) return { lines: 0, draws: 0, segments: 0 };

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);

    gl.useProgram(this.prog);
    const u = this.u;
    gl.uniformMatrix4fv(u.u_view, false, frame.matrix);
    gl.uniform3f(u.u_eye, frame.eye[0], frame.eye[1], frame.eye[2]);
    gl.uniform1f(u.u_zUnit, mesh.unitUm * frame.exaggeration);
    gl.uniform1f(u.u_focalPx, frame.focalPx);
    gl.uniform2f(u.u_viewport, target.width, target.height);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    let draws = 0, ref = 0;
    lines.forEach((line, i) => {
      const r = inst.ranges[i];
      if (!r || r.count === 0) return;
      if (ref === 255) {
        gl.clear(gl.STENCIL_BUFFER_BIT);
        ref = 0;
      }
      ref++;
      gl.vertexAttribPointer(this.aP0, 3, gl.FLOAT, false, 24, r.first * 24);
      gl.vertexAttribPointer(this.aP1, 3, gl.FLOAT, false, 24, r.first * 24 + 12);
      gl.uniform4f(u.u_colour, line.colour[0], line.colour[1], line.colour[2], line.opacity);
      gl.uniform1f(u.u_halfPx, (line.widthPx * frame.pxRatio) / 2);
      gl.stencilFunc(gl.NOTEQUAL, ref, 0xff);
      for (const pass of [0, 1]) {
        // the edge pass marks too: a fringe pixel two capsules share (every join) is blended once
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.uniform1i(u.u_pass, pass);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, r.count);
        draws++;
      }
    });

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.useProgram(null);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.disable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { lines: draws / 2, draws, segments: inst.segments };
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteBuffer(this.cornerBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
    this.built = null;
  }
}
