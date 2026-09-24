import { JSDOM } from "jsdom";
import { windowBoundingBox, type MapWindow } from "@oxygen/shared";
import { parseViewBox } from "../map-window.js";
import { probeMeridianLines } from "../map-north.js";
import {
  applyIofColorStack,
  filterNorthLineObjects,
  inkToColor,
  type StackOcadFile,
} from "../map-color-stack.js";
import { ensureEventMapRenderKey } from "../map-render-cache.js";
import type { BaseMapSvg } from "./map-page-svg.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { LruCache } from "./lru-cache.js";
import type { ColorProfile, ColorStackOverrides } from "@oxygen/shared";

type MapFileReader = Pick<PrismaClient, "mapFile">;

interface RawObject {
  sym?: number;
  coordinates?: Array<ArrayLike<number>>;
}

interface ParsedOcad extends StackOcadFile {
  objects: RawObject[];
  getBounds(): number[];
  getCrs(): { scale?: number };
}

export interface BaseMapLayers {
  /** Full opaque composite (all colours). */
  full: BaseMapSvg;
  /** Transparent ink layer (above lower purple), or null when empty. */
  ink: BaseMapSvg | null;
}

interface CachedMap {
  id: bigint;
  renderKey: string;
  file: ParsedOcad;
  scale: number | null;
  /**
   * In-paper tilt of the drawn magnetic-north lines (ISOM 601.x), degrees
   * clockwise from paper +Y; 0 when the file has no meridian cluster.
   * This — not `map_files.north_offset` — is the print rotation source:
   * `north_offset` additionally contains the paper-to-true-north bearing,
   * which only applies to the tile pipeline's mercator-warped rasters.
   * The print pipeline renders raw paper space, where the meridians lean
   * by exactly this tilt.
   */
  meridianTiltDeg: number;
  /** Ink-layer `toColor` after IOF stack rewrite, or null when empty. */
  inkTo: number | null;
  northLinesBelow: boolean;
}

const cache = new Map<string, CachedMap>();
const MAX_CACHE = 3;
const svgCache = new LruCache<{ layers: BaseMapLayers; scale: number }>(8);
const SVG_NS = "http://www.w3.org/2000/svg";
const DEFAULT_PATTERN_INFLATION = 8;

function roundedWindowKey(window: MapWindow): string {
  return [
    window.minX,
    window.minY,
    window.width,
    window.height,
    window.rotationDeg ?? 0,
  ]
    .map((value) => value.toFixed(4))
    .join(":");
}

/**
 * librsvg drops user-space patterns whose tile is smaller than roughly one
 * output device pixel. OCAD patterns are intentionally tiny (often 10×30
 * native units), so enlarge the repeating tile while preserving its visual
 * period with clipped copies of the original tile.
 */
export function inflateUserSpacePatterns(
  svg: string,
  factor = DEFAULT_PATTERN_INFLATION,
): string {
  if (!Number.isInteger(factor) || factor < 2) return svg;
  const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  const doc = dom.window.document;
  for (const pattern of doc.querySelectorAll(
    'pattern[patternUnits="userSpaceOnUse"]',
  )) {
    const width = Number(pattern.getAttribute("width"));
    const height = Number(pattern.getAttribute("height"));
    if (!(width > 0) || !(height > 0)) continue;
    const children = [...pattern.childNodes].map((child) =>
      child.cloneNode(true),
    );
    if (children.length === 0) continue;

    pattern.setAttribute("width", String(width * factor));
    pattern.setAttribute("height", String(height * factor));
    pattern.replaceChildren();

    for (let row = 0; row < factor; row += 1) {
      for (let column = 0; column < factor; column += 1) {
        const tile = doc.createElementNS(SVG_NS, "svg");
        tile.setAttribute("data-pattern-tile", `${column}-${row}`);
        tile.setAttribute("x", String(column * width));
        tile.setAttribute("y", String(row * height));
        tile.setAttribute("width", String(width));
        tile.setAttribute("height", String(height));
        tile.setAttribute("viewBox", `0 0 ${width} ${height}`);
        tile.setAttribute("overflow", "hidden");
        for (const child of children) tile.appendChild(child.cloneNode(true));
        pattern.appendChild(tile);
      }
    }
  }
  return doc.documentElement.outerHTML;
}

async function parsedMap(db: MapFileReader, eventId: bigint): Promise<CachedMap> {
  const stackMeta = await ensureEventMapRenderKey(db, eventId);
  if (!stackMeta) throw new Error("No base map uploaded");

  const existing = cache.get(stackMeta.renderKey);
  if (existing && existing.id === stackMeta.mapFileId) {
    cache.delete(stackMeta.renderKey);
    cache.set(stackMeta.renderKey, existing);
    return existing;
  }

  const row = await db.mapFile.findFirst({
    where: { eventId },
    orderBy: { uploadedAt: "desc" },
    select: { id: true, fileData: true, scale: true },
  });
  if (!row) throw new Error("No base map uploaded");

  const ocadModule = await import("ocad2geojson");
  const readOcad = (ocadModule as Record<string, unknown>).readOcad as (
    buffer: Buffer,
    options?: Record<string, unknown>,
  ) => Promise<ParsedOcad>;
  const file = await readOcad(Buffer.from(row.fileData), {
    quietWarnings: true,
  });
  const stack = applyIofColorStack(file, {
    profile: stackMeta.colorProfile as ColorProfile,
    overrides: stackMeta.colorOverrides as ColorStackOverrides,
    scale: stackMeta.scale,
  });
  if (stack.warnings.length > 0) {
    console.warn(
      `[map-color-stack] event ${eventId}: ${stack.warnings.join("; ")}`,
    );
  }
  const value: CachedMap = {
    id: row.id,
    renderKey: stackMeta.renderKey,
    file,
    scale: row.scale ?? file.getCrs().scale ?? null,
    meridianTiltDeg:
      probeMeridianLines(
        file.objects as Parameters<typeof probeMeridianLines>[0],
      )?.medianTiltDeg ?? 0,
    inkTo: inkToColor(stack),
    northLinesBelow: stackMeta.northLinesBelow,
  };
  cache.set(stackMeta.renderKey, value);
  while (cache.size > MAX_CACHE) {
    cache.delete(cache.keys().next().value!);
  }
  return value;
}

function objectBounds(object: RawObject): [number, number, number, number] | null {
  const coordinates = object.coordinates;
  if (!coordinates?.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const coordinate of coordinates) {
    const x = Number(coordinate[0]);
    const y = Number(coordinate[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

function objectsInWindow(
  objects: RawObject[],
  rawWindow: MapWindow,
  paddingMm: number,
): RawObject[] {
  // A rotated window is rendered from the axis-aligned bounding box of the
  // rotated rect, so filter against that box.
  const window = windowBoundingBox(rawWindow);
  const minX = (window.minX - paddingMm) * 100;
  const minY = (window.minY - paddingMm) * 100;
  const maxX = (window.minX + window.width + paddingMm) * 100;
  const maxY = (window.minY + window.height + paddingMm) * 100;
  return objects.filter((object) => {
    const bounds = objectBounds(object);
    if (!bounds) return true;
    return (
      bounds[0] <= maxX &&
      bounds[2] >= minX &&
      bounds[1] <= maxY &&
      bounds[3] >= minY
    );
  });
}

export async function loadBaseMapSvg(
  db: MapFileReader,
  eventId: bigint,
  window: MapWindow,
): Promise<{ layers: BaseMapLayers; scale: number }> {
  const source = await parsedMap(db, eventId);
  if (!source.scale || source.scale <= 0) {
    throw new Error("Base map has no usable scale");
  }
  const cacheKey = [
    source.renderKey,
    roundedWindowKey(window),
  ].join(":");
  const cached = svgCache.get(cacheKey);
  if (cached) return cached;
  const ocadModule = await import("ocad2geojson");
  const ocadToSvg = (ocadModule as Record<string, unknown>).ocadToSvg as (
    file: ParsedOcad,
    options: Record<string, unknown>,
  ) => { outerHTML: string };
  const document = new JSDOM(
    "<!DOCTYPE html><html><body></body></html>",
  ).window.document;
  const objects = objectsInWindow(source.file.objects, window, 20);
  const ocadBounds = source.file.getBounds();

  const fullSvg = inflateUserSpacePatterns(
    ocadToSvg(source.file, {
      document,
      generateSymbolElements: true,
      exportHidden: false,
      objects,
    }).outerHTML,
  );
  const fullViewBox = parseViewBox(fullSvg);
  if (!fullViewBox) throw new Error("Base map SVG has no viewBox");

  let ink: BaseMapSvg | null = null;
  if (source.inkTo != null) {
    const inkObjects = source.northLinesBelow
      ? filterNorthLineObjects(objects) ?? []
      : objects;
    const inkSvg = inflateUserSpacePatterns(
      ocadToSvg(source.file, {
        document,
        generateSymbolElements: true,
        exportHidden: false,
        objects: inkObjects,
        toColor: source.inkTo,
        // Transparent fill so the ink layer does not paint a white sheet.
        fill: "transparent",
      }).outerHTML,
    );
    const inkViewBox = parseViewBox(inkSvg);
    if (!inkViewBox) throw new Error("Ink layer SVG has no viewBox");
    ink = { svg: inkSvg, rootViewBox: inkViewBox, ocadBounds };
  }

  const result = {
    layers: {
      full: { svg: fullSvg, rootViewBox: fullViewBox, ocadBounds },
      ink,
    },
    scale: source.scale,
  };
  svgCache.set(cacheKey, result);
  return result;
}

export async function getBaseMapScale(
  db: MapFileReader,
  eventId: bigint,
): Promise<number> {
  const source = await parsedMap(db, eventId);
  if (!source.scale || source.scale <= 0) {
    throw new Error("Base map has no usable scale");
  }
  return source.scale;
}

export async function getBaseMapInfo(
  db: MapFileReader,
  eventId: bigint,
): Promise<{ scale: number; meridianTiltDeg: number; version: string }> {
  const source = await parsedMap(db, eventId);
  if (!source.scale || source.scale <= 0) {
    throw new Error("Base map has no usable scale");
  }
  return {
    scale: source.scale,
    meridianTiltDeg: source.meridianTiltDeg,
    version: source.renderKey,
  };
}

/** Like `getBaseMapInfo`, but null when no base map is uploaded. */
export async function getBaseMapInfoOrNull(
  db: MapFileReader,
  eventId: bigint,
): Promise<{ scale: number; meridianTiltDeg: number; version: string } | null> {
  try {
    return await getBaseMapInfo(db, eventId);
  } catch {
    return null;
  }
}

export function clearCourseMapSourceCache(): void {
  cache.clear();
  svgCache.clear();
}
