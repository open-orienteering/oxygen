#!/usr/bin/env node
// WebGL2 backend on real maps through /dev/map-gl-doc (docs/map-rendering.md §5.2 "Measurements").
// Headed Chromium on the machine's GPU (or --headless SwiftShader); optional CDP CPU throttling and a
// phone viewport as the phone proxy. Maps are read by absolute path through the page's file input —
// never copied into the repo.
//
//   node scripts/measure-gl.mjs --base=http://127.0.0.1:5291 --corpus=/abs/dir [--maps=sprint,crop-b]
//     [--modes=pilot,envelope] [--query=worker=0&gate=0] [--throttle=4]
//     [--viewport=412x915] [--dpr=2.625] [--headless] [--out=results.json]
//
// The S1 columns of docs/map-rendering.md §5.2 were measured with this script before B2 removed the S1
// batch path (it took `path=s1` then); it now measures the arena path only.
// The Vite server must be one started from this checkout on a free port (never the user's :5173):
//   WEB_PORT=5291 API_PROXY_PORT=9 pnpm --filter @oxygen/web exec vite
import { chromium } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const base = opt("base", "http://127.0.0.1:5291");
const corpus = opt("corpus");
if (!corpus) throw new Error("--corpus=<dir with the .ocd files> is required");
const maps = opt("maps", "sprint,crop-b,crop-a,club-2026,club-full").split(",");
const modes = opt("modes", "pilot,envelope").split(",");
const extra = opt("query", "");
const throttle = Number(opt("throttle", "1"));
const headless = args.includes("--headless");
const [vw, vh] = opt("viewport", "1280x800").split("x").map(Number);
const dpr = Number(opt("dpr", "1"));
const out = opt("out");

const browser = await chromium.launch({ headless, args: headless ? ["--use-angle=swiftshader"] : ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: dpr });
const results = [];
const mb = (n) => (n / 1048576).toFixed(1);
for (const map of maps) {
  {
    const path = "arena";
    for (const mode of modes) {
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      if (throttle > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
      await page.goto(`${base}/dev/map-gl-doc?mode=${mode}&bench=1${extra ? `&${extra}` : ""}`);
      await page.getByTestId("map-gl-doc-file").setInputFiles(resolve(corpus, `${map}.ocd`));
      await page.waitForFunction(() => window.__mapGlDoc && (window.__mapGlDoc.bench || window.__mapGlDoc.error), null, { timeout: 600_000 });
      const r = await page.evaluate(() => { const d = window.__mapGlDoc; return { load: d.load, bench: d.bench, error: d.error }; });
      const gpu = await page.evaluate(() => {
        const gl = document.createElement("canvas").getContext("webgl2");
        const d = gl.getExtension("WEBGL_debug_renderer_info");
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      });
      await page.close();
      results.push({ map, mode, path, query: extra, throttle, headless, viewport: `${vw}x${vh}@${dpr}`, gpu, ...r });
      if (r.error) {
        console.log(`${map} ${mode} ${path}: ERROR ${r.error}`);
        continue;
      }
      const l = r.load, b = r.bench, p = b.paper1x;
      const a = l.arena;
      console.log(
        `${map.padEnd(10)} ${mode.padEnd(8)} ${path.padEnd(5)} x${throttle} | passes ${String(l.passes).padStart(6)} | read ${l.ms.read} sym ${l.ms.symbolise} prep ${l.ms.prepare} load ${l.ms.load} first ${l.ms.firstFrame} complete ${l.ms.complete} total ${l.ms.total} (−read ${Math.round(l.ms.total - l.ms.read)}) ms` +
          ` | GPU ${mb(l.gpuBytes)} MB${a ? ` (base ${mb(a.bytes.base)} large ${mb(a.bytes.large)} atlas ${mb(a.bytes.atlas)}) prep p95 ${a.prepareMs.p95} max ${a.prepareMs.max}` : ""}` +
          ` | fit: draws max ${b.maxDrawCalls} cpu ${b.cpuMs.avg}/${b.cpuMs.p95}${b.gpuMs ? ` gpu ${b.gpuMs.avg}/${b.gpuMs.p95}` : ""}${b.maxResidentBytes !== undefined ? ` res ${mb(b.maxResidentBytes)}` : ""}` +
          (p ? ` | 1x: draws max ${p.maxDrawCalls} cpu ${p.cpuMs.avg}/${p.cpuMs.p95}${p.gpuMs ? ` gpu ${p.gpuMs.avg}/${p.gpuMs.p95}` : ""}${p.maxResidentBytes !== undefined ? ` res ${mb(p.maxResidentBytes)} incomplete ${p.incompleteFrames}` : ""}` : ""),
      );
    }
  }
}
if (args.includes("--detail")) for (const r of results) console.log(r.map, r.mode, r.path, JSON.stringify({ ms: r.load?.ms, worker: r.load?.arena?.ms, prep: r.load?.arena?.prepareMs, gpu: r.load?.arena?.gpu, engine: { ...r.load?.arena?.engine, prepareMs: undefined }, main: r.load?.mainThread, canvas: r.load?.canvasPx, cells: r.load?.arena?.detailCells, grid: r.load?.arena?.grid, first: r.load?.firstFrame, complete: r.load?.completeFrame }));
if (out) {
  writeFileSync(out, JSON.stringify(results, null, 1));
  console.log("wrote", out);
}
await browser.close();
