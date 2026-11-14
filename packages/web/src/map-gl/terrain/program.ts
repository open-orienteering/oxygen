/**
 * The terrain program (docs/map-rendering.md §5.6 "Drawing"): draws a
 * height field's chunked mesh under the perspective camera, textured with
 * a drape and lit from the normal map.
 *
 * - Heights go up as they are, the int16 grid as an `R16I` texture the
 *   vertex shader reads with `texelFetch` (`map-terrain.md` §5.1), so
 *   every chunk shares one vertex grid; no-data cells hold their filled
 *   height (`meshHeights`).
 * - Normals are `heightNormals(field, 1)` as `RGB8_SNORM`, linear; the
 *   fragment shader applies the exaggeration (`shade.ts`).
 * - The drape is any texture with the model → clip matrix it was rendered
 *   with: `uv = (drapeMatrix · (x, y, 0, 1)).xy / w · ½ + ½`. Outside
 *   [0, 1] the background is drawn. H6 passes the map rendered into a
 *   framebuffer texture; the dev page passes a checker.
 * - It runs on the caller's context and leaves the state the arena path
 *   expects: depth test off, no program, vertex array, framebuffer or
 *   texture of its own bound, `TEXTURE0` active, unpack alignment 4.
 */

import { heightNormals, type HeightField } from "@oxygen/shared/src/terrain/field/read.js";
import type { RenderTarget } from "../view.js";
import { cameraFrame, type TerrainCamera } from "./camera.js";
import { LEVELS, buildTerrainMesh, chunkGeometry, meshBox, selectChunks, type SelectionStats, type TerrainMesh } from "./mesh.js";
import { SHADE_GLSL } from "./shade.js";

export interface TerrainFrame {
  camera: TerrainCamera;
  /** Vertical exaggeration; no default (§5.6 decision 2). */
  exaggeration: number;
  /** The drape texture (RGBA, filtering set by the caller). */
  texture: WebGLTexture;
  /** The model → clip matrix `texture` was rendered with. */
  drapeMatrix: Float32Array;
  /** Drawn where the drape does not reach and cleared behind the terrain, 0…1 RGB. */
  background: [number, number, number];
  /** Screen size of a quad edge for the level of detail (`DEFAULT_LOD_PX`). */
  lodPx?: number;
  /** Draw every chunk at this level. */
  level?: number;
}

export interface TerrainDrawStats extends SelectionStats {
  /** Draw calls issued: one instanced draw per level in use. */
  draws: number;
  /** The camera's model → clip matrix. */
  matrix: Float32Array;
}

const VS = `#version 300 es
precision highp float;
precision highp int;
in vec3 a_vertex;
in vec3 a_chunk;
uniform highp isampler2D u_heights;
uniform mat4 u_view;
uniform vec2 u_grid0;
uniform float u_cellUm;
uniform float u_zUnit;
uniform float u_zMin;
uniform ivec2 u_size;
out vec2 v_xy;
void main() {
  ivec2 g = min(ivec2(a_chunk.xy) + ivec2(a_vertex.xy), u_size - 1);
  float h = a_vertex.z > 0.5 ? a_chunk.z : float(texelFetch(u_heights, g, 0).r);
  vec3 p = vec3(u_grid0 + vec2(g) * u_cellUm, (h - u_zMin) * u_zUnit);
  v_xy = p.xy;
  gl_Position = u_view * vec4(p, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D u_normals;
uniform sampler2D u_drape;
uniform mat4 u_drapeMatrix;
uniform vec2 u_grid0;
uniform float u_cellUm;
uniform vec2 u_sizeF;
uniform float u_exaggeration;
uniform vec3 u_background;
in vec2 v_xy;
out vec4 o_colour;
${SHADE_GLSL}
void main() {
  vec2 nuv = ((v_xy - u_grid0) / u_cellUm + 0.5) / u_sizeF;
  float s = shade(texture(u_normals, nuv).xyz, u_exaggeration);
  vec4 c = u_drapeMatrix * vec4(v_xy, 0.0, 1.0);
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  bool outside = uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
  vec3 colour = outside ? u_background : texture(u_drape, uv).rgb;
  o_colour = vec4(min(vec3(1.0), colour * s), 1.0);
}`;

const UNIFORMS = ["u_heights", "u_view", "u_grid0", "u_cellUm", "u_zUnit", "u_zMin", "u_size", "u_normals", "u_drape", "u_drapeMatrix", "u_sizeF", "u_exaggeration", "u_background"] as const;

export class TerrainRenderer {
  private readonly prog: WebGLProgram;
  private readonly u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vertexBuffer: WebGLBuffer;
  private readonly indexBuffer: WebGLBuffer;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly aChunk: number;
  private heights: WebGLTexture | null = null;
  private normals: WebGLTexture | null = null;
  private terrain: TerrainMesh | null = null;
  private field: HeightField | null = null;
  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`terrain shader: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const prog = gl.createProgram()!;
    const vs = compile(gl.VERTEX_SHADER, VS), fs = compile(gl.FRAGMENT_SHADER, FS);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`terrain program: ${gl.getProgramInfoLog(prog)}`);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.prog = prog;
    this.u = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)])) as TerrainRenderer["u"];

    const geo = chunkGeometry();
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vertexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, geo.vertices, gl.STATIC_DRAW);
    const aVertex = gl.getAttribLocation(prog, "a_vertex");
    gl.enableVertexAttribArray(aVertex);
    gl.vertexAttribPointer(aVertex, 3, gl.UNSIGNED_BYTE, false, 3, 0);
    this.indexBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.indices, gl.STATIC_DRAW);
    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    this.aChunk = gl.getAttribLocation(prog, "a_chunk");
    gl.enableVertexAttribArray(this.aChunk);
    gl.vertexAttribPointer(this.aChunk, 3, gl.FLOAT, false, 12, 0);
    gl.vertexAttribDivisor(this.aChunk, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** The mesh of the field last set (for the pick and the camera's bounds). */
  get mesh(): TerrainMesh | null {
    return this.terrain;
  }

  /** Uploads a field's heights and normals; model space is relative to `originUm` (paper µm). */
  setField(field: HeightField, originUm: { x: number; y: number }): TerrainMesh {
    const gl = this.gl;
    const mesh = buildTerrainMesh(field, originUm);
    const { width: W, height: H } = field.header;
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (W > max || H > max) throw new Error(`height field ${W} × ${H} exceeds the texture limit ${max}`);
    this.deleteTextures();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.heights = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.heights);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16I, W, H, 0, gl.RED_INTEGER, gl.SHORT, mesh.heights);
    this.params(gl.NEAREST);
    this.normals = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.normals);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8_SNORM, W, H, 0, gl.RGB, gl.BYTE, heightNormals(field, 1));
    this.params(gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.terrain = mesh;
    this.field = field;
    return mesh;
  }

  /** Draws one frame into `target` (clearing it); nothing when no field is set. */
  draw(frame: TerrainFrame, target: RenderTarget): TerrainDrawStats | null {
    const gl = this.gl, mesh = this.terrain, field = this.field;
    if (!mesh || !field || !this.heights || !this.normals) return null;
    const e = frame.exaggeration;
    const cam = cameraFrame(frame.camera, meshBox(mesh, e));
    const sel = selectChunks(mesh, cam, { exaggeration: e, lodPx: frame.lodPx, level: frame.level });
    const matrix = new Float32Array(cam.matrix);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    const [r, g, b] = frame.background;
    gl.clearColor(r, g, b, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.prog);
    const u = this.u;
    gl.uniformMatrix4fv(u.u_view, false, matrix);
    gl.uniformMatrix4fv(u.u_drapeMatrix, false, frame.drapeMatrix);
    gl.uniform2f(u.u_grid0, mesh.x0Um, mesh.y0Um);
    gl.uniform1f(u.u_cellUm, mesh.cellUm);
    gl.uniform1f(u.u_zUnit, mesh.unitUm * e);
    gl.uniform1f(u.u_zMin, mesh.zMin);
    gl.uniform2i(u.u_size, mesh.width, mesh.height);
    gl.uniform2f(u.u_sizeF, mesh.width, mesh.height);
    gl.uniform1f(u.u_exaggeration, e);
    gl.uniform3f(u.u_background, r, g, b);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heights);
    gl.uniform1i(u.u_heights, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.normals);
    gl.uniform1i(u.u_normals, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, frame.texture);
    gl.uniform1i(u.u_drape, 2);

    const total = sel.instances.reduce((s, a) => s + a.length, 0);
    const all = new Float32Array(total);
    const offsets: number[] = [];
    let at = 0;
    for (const inst of sel.instances) {
      offsets.push(at);
      all.set(inst, at);
      at += inst.length;
    }
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, all, gl.DYNAMIC_DRAW);
    const geo = chunkGeometry();
    let draws = 0;
    for (let l = 0; l < LEVELS; l++) {
      const n = sel.instances[l].length / 3;
      if (n === 0) continue;
      gl.vertexAttribPointer(this.aChunk, 3, gl.FLOAT, false, 12, offsets[l] * 4);
      gl.drawElementsInstanced(gl.TRIANGLES, geo.levels[l].count, gl.UNSIGNED_SHORT, geo.levels[l].first * 2, n);
      draws++;
    }

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    for (const unit of [gl.TEXTURE2, gl.TEXTURE1, gl.TEXTURE0]) {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.useProgram(null);
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { ...sel.stats, draws, matrix };
  }

  dispose(): void {
    const gl = this.gl;
    this.deleteTextures();
    gl.deleteBuffer(this.vertexBuffer);
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
    this.terrain = this.field = null;
  }

  private params(filter: number): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private deleteTextures(): void {
    if (this.heights) this.gl.deleteTexture(this.heights);
    if (this.normals) this.gl.deleteTexture(this.normals);
    this.heights = this.normals = null;
  }
}

