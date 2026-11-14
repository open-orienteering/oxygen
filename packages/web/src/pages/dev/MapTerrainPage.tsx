/**
 * Dev-only terrain page (`/dev/map-terrain`, docs/map-rendering.md §5.6
 * "Dev page"): a synthetic height field, round-tripped through the
 * `OXHF` codec, drawn by `TerrainRenderer` with a checker (or flat grey or
 * white) drape. Publishes `window.__mapTerrain` for Playwright: the draw
 * stats, `project(xMm, yMm)` → canvas px of the surface point, `pick(px,
 * py)` and the last click's pick. Not routed in production builds.
 *
 * `?field=cone|slope|noise&n=<W>x<H>&texture=checker|grey|white&drape=half&pitch=&bearing=&e=&lod=auto|0…6&zoom=&w=&h=&bg=<hex>&bench=1`
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { decodeHeightField, encodeHeightField, type HeightField } from "@oxygen/shared/src/terrain/field/read.js";
import { viewMatrix } from "../../map-gl/view";
import { distanceForPxPerUm, projectToScreen, screenRay, type TerrainCamera } from "../../map-gl/terrain/camera";
import { pickTerrain, surfaceZ, type TerrainHit } from "../../map-gl/terrain/pick";
import { TerrainRenderer, type TerrainDrawStats } from "../../map-gl/terrain/program";
import { CHECKER, coneField, noiseField, slopeField } from "../../map-gl/terrain/synthetic";

const GREY = [0x80, 0x80, 0x80], WHITE = [0xff, 0xff, 0xff];

interface TerrainPageApi {
  stats: (TerrainDrawStats & { drawMs?: { p50: number; p95: number } }) | null;
  /** Canvas px (y down) of the surface point at paper (x, y) mm. */
  project: (xMm: number, yMm: number) => [number, number] | null;
  pick: (px: number, py: number) => TerrainHit | null;
  lastPick: TerrainHit | null;
}

declare global {
  interface Window {
    __mapTerrain?: TerrainPageApi;
  }
}

function buildField(kind: string, n: string | null): HeightField {
  if (kind === "slope") return slopeField();
  if (kind === "noise") {
    const [w, h] = (n ?? "300x200").split("x").map(Number);
    return noiseField(w, h || w);
  }
  return coneField();
}

/** The drape: RGBA over the field's paper extent, row 0 at the bottom (y up, as the clip space it is sampled through). */
function drapePixels(field: HeightField, kind: string, texW: number, texH: number): Uint8Array {
  const { x0, y0, cellMm, width, height } = field.header;
  const wMm = width * cellMm, hMm = height * cellMm;
  const px = new Uint8Array(texW * texH * 4);
  for (let r = 0; r < texH; r++)
    for (let c = 0; c < texW; c++) {
      let rgb: readonly number[] = kind === "white" ? WHITE : GREY;
      if (kind === "checker") {
        const x = x0 + ((c + 0.5) / texW) * wMm, y = y0 + ((r + 0.5) / texH) * hMm;
        rgb = (Math.floor(x / CHECKER.squareMm) + Math.floor(y / CHECKER.squareMm)) % 2 === 0 ? CHECKER.a : CHECKER.b;
      }
      px.set([rgb[0], rgb[1], rgb[2], 255], (r * texW + c) * 4);
    }
  return px;
}

const num = (v: string | null, d: number) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const hexRgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};

export function MapTerrainPage() {
  const [params] = useSearchParams();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState("");
  const [pick, setPick] = useState<TerrainHit | null>(null);
  const key = params.toString();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: TerrainRenderer | undefined;
    let texture: WebGLTexture | null = null;
    let gl: WebGL2RenderingContext | null = null;
    try {
      const w = num(params.get("w"), 800), h = num(params.get("h"), 600);
      const e = num(params.get("e"), 1);
      const lod = params.get("lod");
      const level = lod && lod !== "auto" ? num(lod, 0) : undefined;
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      gl = canvas.getContext("webgl2", { antialias: true, depth: true, alpha: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error("WebGL2 unavailable");
      // the stored form, as H6 / H7 will read it
      const field = decodeHeightField(encodeHeightField(buildField(params.get("field") ?? "cone", params.get("n"))));
      const { x0, y0, cellMm, width, height } = field.header;
      const wUm = width * cellMm * 1000, hUm = height * cellMm * 1000;
      const centre = { x: (x0 * 1000 + wUm / 2), y: (y0 * 1000 + hUm / 2) };
      const origin = { x: Math.round(centre.x), y: Math.round(centre.y) };
      renderer = new TerrainRenderer(gl);
      const mesh = renderer.setField(field, origin);

      const texW = 1024, texH = Math.max(1, Math.round((1024 * hUm) / wUm));
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, texW, texH, 0, gl.RGBA, gl.UNSIGNED_BYTE, drapePixels(field, params.get("texture") ?? "checker", texW, texH));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      // drape=half: the texture squeezed onto the field's west half, the rest outside the drape
      const half = params.get("drape") === "half";
      const drapeW = half ? wUm / 2 : wUm;
      const drapeMatrix = viewMatrix({ centreX: x0 * 1000 + drapeW / 2, centreY: centre.y, pxPerUm: texW / drapeW, widthPx: texW, heightPx: (texW / drapeW) * hUm }, origin.x, origin.y);

      const camera: TerrainCamera = {
        target: { x: centre.x - origin.x, y: centre.y - origin.y, z: 0 },
        distanceUm: 0,
        bearingDeg: num(params.get("bearing"), 0),
        pitchDeg: num(params.get("pitch"), 0),
        widthPx: w,
        heightPx: h,
      };
      camera.distanceUm = distanceForPxPerUm(camera, Math.min(w / wUm, h / hUm) * 0.9 * num(params.get("zoom"), 1));
      const frame = { camera, exaggeration: e, drapes: [{ texture: texture!, matrix: drapeMatrix }], background: hexRgb(params.get("bg") ?? "ffffff"), level };
      const target = { framebuffer: null, width: w, height: h };
      let stats: TerrainPageApi["stats"] = renderer.draw(frame, target);
      if (params.get("bench") === "1") {
        const times: number[] = [];
        const probe = new Uint8Array(4);
        for (let i = 0; i < 60; i++) {
          const t0 = performance.now();
          stats = renderer.draw(frame, target);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probe);
          times.push(performance.now() - t0);
        }
        times.sort((a, b) => a - b);
        stats = { ...stats!, drawMs: { p50: times[30], p95: times[56] } };
      }
      const r = renderer;
      window.__mapTerrain = {
        stats,
        project: (xMm, yMm) => {
          const x = xMm * 1000 - origin.x, y = yMm * 1000 - origin.y;
          const z = surfaceZ(mesh, x, y, e);
          return z === null || !stats ? null : projectToScreen(stats.matrix, w, h, x, y, z);
        },
        pick: (px, py) => (r.mesh ? pickTerrain(r.mesh, field, screenRay(camera, px, py), e) : null),
        lastPick: null,
      };
      setMessage(stats ? `${stats.chunks} chunks (${stats.culled} culled), ${stats.triangles} triangles, ${stats.draws} draws, levels ${stats.perLevel.join("/")}${stats.drawMs ? `, draw p50 ${stats.drawMs.p50.toFixed(2)} ms p95 ${stats.drawMs.p95.toFixed(2)} ms` : ""}` : "nothing drawn");
      setStatus("ready");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
    return () => {
      renderer?.dispose();
      if (gl && texture) gl.deleteTexture(texture);
      delete window.__mapTerrain;
    };
    // the page redraws when its query changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const onClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const api = window.__mapTerrain;
    if (!api) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const hit = api.pick(ev.clientX - rect.left, ev.clientY - rect.top);
    api.lastPick = hit;
    setPick(hit);
  };

  return (
    <div className="p-4 space-y-2">
      <h1 className="text-lg font-semibold">Terrain mesh (dev)</h1>
      <canvas ref={canvasRef} data-testid="map-terrain-canvas" data-ready={status === "ready" ? "true" : undefined} data-status={status} data-pick={pick ? `${pick.x.toFixed(3)},${pick.y.toFixed(3)}` : undefined} onClick={onClick} className="border border-gray-300" />
      <p data-testid="map-terrain-status" className="text-sm font-mono">
        {status}: {message}
      </p>
      {pick && (
        <p className="text-sm font-mono" data-testid="map-terrain-pick">
          pick ({pick.x.toFixed(2)}, {pick.y.toFixed(2)}) mm, {pick.heightM.toFixed(1)} m{pick.data ? "" : " (no data)"}
        </p>
      )}
    </div>
  );
}
