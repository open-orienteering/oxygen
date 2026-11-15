/**
 * The terrain dev page's document mode (`/dev/map-terrain?doc=course`, docs/map-rendering.md §5.6
 * "Dev page"): the course fixture document (`map-gl/fixtures/course-document.ts`) loaded into a
 * real `MapGlEngine` with its course layer, a synthetic field under it, and the engine's 3D frame —
 * the map and the course rendered into the drape layers, then the mesh. Redraws on the engine's
 * `onChange` (arrivals, the settle timer).
 */

import { MapGlRenderer, hexToRgb } from "../../map-gl/renderer";
import { MapGlEngine, inlineTransport, workerTransport, type EngineStats, type TerrainFrameStats } from "../../map-gl/engine";
import { documentBytes, request } from "../../map-gl/fixtures/course-document";
import { docField } from "../../map-gl/terrain/synthetic";
import { distanceForPxPerUm, projectToScreen, screenRay, type TerrainCamera } from "../../map-gl/terrain/camera";
import { pickTerrain, surfaceZ, type TerrainHit } from "../../map-gl/terrain/pick";
import type { TerrainLine } from "../../map-gl/terrain/lines";
import { loadMapFonts, loadTextAtlas } from "../../lib/map-fonts";
import { documentColours } from "../../lib/vector-map";

export interface DocCamera {
  /** Paper mm the camera looks at. */
  xMm: number;
  yMm: number;
  pitch: number;
  bearing: number;
  /** 1 = the sheet fitted at pitch 0. */
  zoom: number;
}

export interface DocTerrainApi {
  /** The last frame's stats. */
  frame: TerrainFrameStats | null;
  engineStats: () => EngineStats;
  /** Canvas px (y down) of the surface point at paper (x, y) mm under the last frame's camera. */
  project: (xMm: number, yMm: number) => [number, number] | null;
  pick: (px: number, py: number) => TerrainHit | null;
  /** Moves the camera and draws a frame (the drape follows once it has settled). */
  setCamera: (c: Partial<DocCamera>) => void;
  /**
   * Draws the same view in 2D (the hand-over view: pitch 0's `pxPerUm`, rotation = bearing) and
   * compares it with the 3D frame pixel by pixel; then draws the 3D frame again.
   */
  compare2d: () => { maxDiff: number; over: number; pixels: number };
  /** RGB 0–255 of the course's colour (the stack's purple). */
  courseRgb: [number, number, number];
  /** RGB 0–255 of the `line=` lines' colour. */
  lineRgb: [number, number, number];
}

/** The sheet the fixture's field covers, paper mm. */
const SHEET = { w: 80, h: 60 };

export async function startDocTerrain(canvas: HTMLCanvasElement, params: URLSearchParams, w: number, h: number): Promise<{ api: DocTerrainApi; dispose: () => void }> {
  const e = Number(params.get("e") ?? 1);
  const lod = params.get("lod");
  const level = lod && lod !== "auto" ? Number(lod) : undefined;
  const budgetMb = params.get("budget");
  const bgHex = params.get("bg") ?? "ffffff";
  const background = hexToRgb(`#${bgHex.replace("#", "")}`);

  const renderer = new MapGlRenderer(canvas, { preserveDrawingBuffer: true, depth: true });
  const engine = new MapGlEngine(renderer, params.get("worker") === "1" ? workerTransport() : inlineTransport(), budgetMb ? { budgetBytes: Number(budgetMb) * 1024 * 1024 } : {});
  const [fonts, textAtlas] = await Promise.all([loadMapFonts(), loadTextAtlas(["latin"])]);
  const summary = await engine.load({
    source: { kind: "document", bytes: documentBytes(), options: { unmatched: "proxy" } },
    fonts: fonts.map((f) => ({ family: f.family, bytes: f.bytes.slice(0) })),
    textAtlas,
    courseLayer: true,
  });
  if (summary.courseLayer?.supported !== true) throw new Error("the fixture's course layer is not supported");
  const courseIn = new Promise<void>((resolve) => {
    engine.onCourse = () => resolve();
  });
  engine.setCourse(request());
  await courseIn;
  // `line=x,y;x,y|x,y;…` (paper mm): lines on the terrain (§5.6 "Lines", H8), opaque, 8 px, `lineColour`.
  const lineRgb = hexToRgb(`#${(params.get("lineColour") ?? "e6194b").replace("#", "")}`);
  const lines: TerrainLine[] | undefined = params.get("line")?.split("|").map((l) => ({
    points: l.split(";").map((p) => {
      const [x, y] = p.split(",").map(Number);
      return { x, y };
    }),
    colour: lineRgb,
    opacity: 1,
    widthPx: 8,
  }));
  const field = docField(params.get("field") === "flat" ? "flat" : "cone");
  const mesh = (await engine.setTerrain(field))!;
  const origin = { x: summary.originX, y: summary.originY };

  let colour = documentColours(engine.colours);
  const opts = () => ({ colour, background });
  const cam: DocCamera = { xMm: Number(params.get("x") ?? SHEET.w / 2), yMm: Number(params.get("y") ?? SHEET.h / 2), pitch: Number(params.get("pitch") ?? 0), bearing: Number(params.get("bearing") ?? 0), zoom: Number(params.get("zoom") ?? 1) };
  const camera = (): TerrainCamera => {
    const c: TerrainCamera = { target: { x: cam.xMm * 1000 - origin.x, y: cam.yMm * 1000 - origin.y, z: 0 }, distanceUm: 0, bearingDeg: cam.bearing, pitchDeg: cam.pitch, widthPx: w, heightPx: h };
    c.distanceUm = distanceForPxPerUm(c, Math.min(w / (SHEET.w * 1000), h / (SHEET.h * 1000)) * 0.9 * cam.zoom);
    return c;
  };

  const api: DocTerrainApi = {
    frame: null,
    engineStats: () => engine.stats(),
    project: (xMm, yMm) => {
      const x = xMm * 1000 - origin.x, y = yMm * 1000 - origin.y;
      const z = surfaceZ(mesh, x, y, e);
      const m = api.frame?.mesh?.matrix;
      return z === null || !m ? null : projectToScreen(m, w, h, x, y, z);
    },
    pick: (px, py) => pickTerrain(mesh, field, screenRay(camera(), px, py), e),
    setCamera: (c) => {
      Object.assign(cam, c);
      draw();
    },
    compare2d: () => {
      const gl = renderer.gl;
      const a = new Uint8Array(w * h * 4), b = new Uint8Array(w * h * 4);
      draw();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, a);
      const c = camera();
      engine.setView({ centreX: c.target.x + origin.x, centreY: c.target.y + origin.y, pxPerUm: (h / 2 / Math.tan((35 * Math.PI) / 360)) / c.distanceUm, widthPx: w, heightPx: h, rotationDeg: cam.bearing });
      engine.render(opts());
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
      let maxDiff = 0, over = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        maxDiff = Math.max(maxDiff, d);
        if (d > 2) over++;
      }
      draw();
      return { maxDiff, over, pixels: w * h };
    },
    courseRgb: [0, 0, 0],
    lineRgb: lineRgb.map((v) => Math.round(v * 255)) as [number, number, number],
  };
  const purple = engine.colours.findIndex((c) => c.id === "iof2024:purple-upper");
  if (purple >= 0) api.courseRgb = colour(purple).map((v) => Math.round(v * 255)) as [number, number, number];

  // A redraw on the next animation frame, or a timer where frames do not run (a hidden tab).
  let pending: { raf: number; timer: ReturnType<typeof setTimeout> } | null = null;
  function draw() {
    colour = documentColours(engine.colours);
    api.frame = engine.renderTerrain({ camera: camera(), exaggeration: e, level, lines }, opts());
  }
  const flush = () => {
    if (!pending) return;
    cancelAnimationFrame(pending.raf);
    clearTimeout(pending.timer);
    pending = null;
    draw();
  };
  engine.onChange = () => {
    if (!pending) pending = { raf: requestAnimationFrame(flush), timer: setTimeout(flush, 50) };
  };
  draw();
  await engine.whenComplete();
  draw();
  return {
    api,
    dispose: () => {
      if (pending) {
        cancelAnimationFrame(pending.raf);
        clearTimeout(pending.timer);
      }
      engine.dispose();
      renderer.dispose();
    },
  };
}

/** For the page's status line. */
export function describeDocFrame(f: TerrainFrameStats | null, st: EngineStats): string {
  const t = st.terrain;
  if (!f?.mesh || !t) return "nothing drawn";
  const layers = t.layers.map((l) => `${l.role} ${l.widthPx}×${l.heightPx} @${(l.ratio * 100).toFixed(0)} %`).join(", ");
  const lines = f.mesh.lines ? `, ${f.mesh.lines.lines} lines (${f.mesh.lines.segments} segments, ${f.mesh.lines.draws} draws)` : "";
  return `${f.mesh.chunks} chunks, ${f.mesh.triangles} triangles, ${f.mesh.draws} draws${lines}; drape ${layers} (${t.drapeRenders} renders, last ${t.lastDrapeMs.toFixed(1)} ms, ${t.lastDrapeDraws} draws); field ${(t.fieldBytes / 1048576).toFixed(1)} MB, drape ${(t.drapeBytes / 1048576).toFixed(1)} MB`;
}
