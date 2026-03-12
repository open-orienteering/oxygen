/**
 * External API router — endpoints consumed by mobile clients (Lox).
 *
 * These are separate from the internal tRPC routes that serve the Oxygen web UI.
 * This separation makes it easy to apply different auth/rate-limiting later.
 */

import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  getCompetitionClient,
  ensureMapFilesTable,
  ensureRenderedMapsTable,
  ensureTracksTable,
} from "../db.js";
import { ocadBoundsToWgs84, computeMapNorthOffset, mapMmToWgs84, type OcadCrs } from "../map-projection.js";
import type { GeoJSONFeatureCollection } from "../iof-course-parser.js";

// ─── Lazy-loaded heavy dependencies ──────────────────────────

let _readOcad: ((buf: Buffer, opts?: Record<string, unknown>) => Promise<OcadFile>) | null = null;
let _ocadToSvg: ((file: OcadFile, opts: Record<string, unknown>) => SVGElement) | null = null;
let _Resvg: (typeof import("@resvg/resvg-js"))["Resvg"] | null = null;
let _JSDOM: (typeof import("jsdom"))["JSDOM"] | null = null;

interface OcadFile {
  getCrs(): OcadCrs;
  getBounds(): number[];
  objects: unknown[];
  symbols: unknown[];
  colors: unknown[];
  parameterStrings: Record<string, unknown[]>;
}

async function loadOcadLib() {
  if (!_readOcad) {
    // ocad2geojson is CJS
    const mod = await import("ocad2geojson");
    _readOcad = (mod as Record<string, unknown>).readOcad as typeof _readOcad;
    _ocadToSvg = (mod as Record<string, unknown>).ocadToSvg as typeof _ocadToSvg;
  }
  return { readOcad: _readOcad!, ocadToSvg: _ocadToSvg! };
}

async function loadResvg() {
  if (!_Resvg) {
    const mod = await import("@resvg/resvg-js");
    _Resvg = mod.Resvg;
  }
  return _Resvg;
}

async function loadJsdom() {
  if (!_JSDOM) {
    const mod = await import("jsdom");
    _JSDOM = mod.JSDOM;
  }
  return _JSDOM;
}

// ─── Helpers ─────────────────────────────────────────────────

async function getOcdFileBuffer(): Promise<Buffer | null> {
  const client = await getCompetitionClient();
  await ensureMapFilesTable(client);

  const rows = await client.$queryRawUnsafe<{ FileData: Buffer }[]>(
    "SELECT FileData FROM oxygen_map_files ORDER BY Id DESC LIMIT 1",
  );
  if (rows.length === 0) return null;
  return Buffer.from(rows[0].FileData);
}

async function parseOcdFile() {
  const buffer = await getOcdFileBuffer();
  if (!buffer) throw new Error("No map file uploaded");

  const { readOcad, ocadToSvg } = await loadOcadLib();
  const ocadFile = await readOcad(buffer, { quietWarnings: true });
  const crs = ocadFile.getCrs();

  return { ocadFile, crs, ocadToSvg };
}

async function ensureCourseGeometryTable(client: Awaited<ReturnType<typeof getCompetitionClient>>) {
  await client.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS oxygen_course_geometry (
      Id INT AUTO_INCREMENT PRIMARY KEY,
      CourseName VARCHAR(255) NOT NULL UNIQUE,
      Source VARCHAR(10) NOT NULL,
      Geometry LONGTEXT NOT NULL
    )
  `);
}

// ─── Router ──────────────────────────────────────────────────

export const externalRouter = router({
  /**
   * Lightweight endpoint to check what maps and courses are available.
   */
  mapInfo: publicProcedure.query(async () => {
    const client = await getCompetitionClient();
    await ensureMapFilesTable(client);

    // Check if a map file exists
    const mapRows = await client.$queryRawUnsafe<
      { Id: number; FileName: string; UploadedAt: Date }[]
    >(
      "SELECT Id, FileName, UploadedAt FROM oxygen_map_files ORDER BY Id DESC LIMIT 1",
    );

    const hasMap = mapRows.length > 0;
    let mapScale: number | null = null;
    let bounds: { north: number; south: number; east: number; west: number } | null = null;
    let mapNorthOffset: number | null = null;

    if (hasMap) {
      try {
        const { ocadFile, crs } = await parseOcdFile();
        mapScale = crs.scale;
        const ocadBounds = ocadFile.getBounds();
        bounds = ocadBoundsToWgs84(ocadBounds, crs);
        mapNorthOffset = computeMapNorthOffset(ocadBounds, crs);
      } catch (err) {
        console.warn("[external.mapInfo] Failed to compute bounds:", err);
      }
    }

    // Get courses with class name mapping
    const courses = await client.oCourse.findMany({
      where: { Removed: false },
      select: { Id: true, Name: true, Length: true, Controls: true },
    });

    const classes = await client.oClass.findMany({
      where: { Removed: false },
      select: { Name: true, Course: true },
    });

    // Build map from course Id → list of class names
    const courseClassNames = new Map<number, string[]>();
    for (const cls of classes) {
      if (!cls.Course || !cls.Name) continue;
      const existing = courseClassNames.get(cls.Course) ?? [];
      existing.push(cls.Name);
      courseClassNames.set(cls.Course, existing);
    }

    return {
      hasMap,
      mapFileName: hasMap ? mapRows[0].FileName : null,
      mapScale,
      bounds,
      mapNorthOffset,
      courses: courses.map((c) => ({
        name: c.Name,
        classes: courseClassNames.get(c.Id) ?? [],
        controlCount: c.Controls
          ? c.Controls.split(";").filter((s) => s.trim()).length
          : 0,
        length: c.Length,
      })),
    };
  }),

  /**
   * Render the OCAD map to a georeferenced PNG image.
   * Cached in the database to avoid re-rendering on each request.
   */
  renderMapImage: publicProcedure
    .input(z.object({ maxWidth: z.number().default(4096) }).optional().default({ maxWidth: 4096 }))
    .query(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureRenderedMapsTable(client);

      // Check cache
      const cached = await client.$queryRawUnsafe<
        { ImageData: Buffer; Bounds: string; MapScale: number; Width: number; Height: number }[]
      >(
        "SELECT ImageData, Bounds, MapScale, Width, Height FROM oxygen_rendered_maps WHERE MaxWidth = ? ORDER BY RenderedAt DESC LIMIT 1",
        input.maxWidth,
      );

      if (cached.length > 0) {
        return {
          imageBase64: Buffer.from(cached[0].ImageData).toString("base64"),
          bounds: JSON.parse(cached[0].Bounds),
          mapScale: cached[0].MapScale,
          widthPx: cached[0].Width,
          heightPx: cached[0].Height,
        };
      }

      // Render from scratch
      const { ocadFile, crs, ocadToSvg } = await parseOcdFile();
      const JSDOM = await loadJsdom();
      const Resvg = await loadResvg();

      // Create a JSDOM document for ocadToSvg
      const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>");
      const document = dom.window.document;

      const svgElement = ocadToSvg(ocadFile, {
        document,
        generateSymbolElements: true,
        exportHidden: false,
      });

      const svgString = svgElement.outerHTML;

      const bounds = ocadBoundsToWgs84(ocadFile.getBounds(), crs);
      if (!bounds) throw new Error("Failed to convert map bounds to WGS84 — unsupported CRS");

      // Parse viewBox for aspect ratio calculation
      const vbAttr = svgElement.getAttribute("viewBox");
      if (!vbAttr) throw new Error("SVG has no viewBox attribute");
      const vbParts = vbAttr.split(/[\s,]+/).map(Number);
      const viewBox = { w: vbParts[2], h: vbParts[3] };

      // Rasterize SVG to PNG
      // Calculate dimensions maintaining aspect ratio
      const aspectRatio = viewBox.h / viewBox.w;
      const width = Math.min(input.maxWidth, Math.ceil(viewBox.w / 10)); // reasonable default
      const height = Math.ceil(width * aspectRatio);

      const resvg = new Resvg(svgString, {
        fitTo: { mode: "width" as const, value: width },
        background: "white",
      });
      const rendered = resvg.render();
      const pngBuffer = rendered.asPng();

      // Cache the result
      const boundsJson = JSON.stringify(bounds);
      await client.$executeRawUnsafe(
        `INSERT INTO oxygen_rendered_maps (MaxWidth, ImageData, Bounds, MapScale, Width, Height)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.maxWidth,
        pngBuffer,
        boundsJson,
        crs.scale,
        rendered.width,
        rendered.height,
      );

      return {
        imageBase64: Buffer.from(pngBuffer).toString("base64"),
        bounds,
        mapScale: crs.scale,
        widthPx: rendered.width,
        heightPx: rendered.height,
      };
    }),

  /**
   * Get course geometry (controls, legs, etc.) with WGS84 coordinates.
   */
  courseGeometry: publicProcedure
    .input(z.object({ courseName: z.string() }))
    .query(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureCourseGeometryTable(client);

      const row = await client.$queryRawUnsafe<{ Geometry: string }[]>(
        "SELECT Geometry FROM oxygen_course_geometry WHERE CourseName=?",
        input.courseName,
      );
      if (!row || row.length === 0) return null;

      let geometry: GeoJSONFeatureCollection;
      try {
        geometry = JSON.parse(row[0].Geometry);
      } catch {
        return null;
      }

      // Get the CRS from the OCD file to convert coordinates
      let crs: OcadCrs;
      try {
        const parsed = await parseOcdFile();
        crs = parsed.crs;
      } catch {
        // No OCD file — can't convert. Return original geometry.
        return geometry;
      }

      // Convert all coordinates from map-mm to WGS84 [lng, lat]
      return convertFeatureCollectionToWgs84(geometry, crs);
    }),

  /**
   * Get all controls with WGS84 positions (for "All controls" view).
   */
  controlCoordinates: publicProcedure.query(async () => {
    const client = await getCompetitionClient();

    const controls = await client.oControl.findMany({
      where: { Removed: false },
      select: {
        Id: true,
        Name: true,
        Numbers: true,
        Status: true,
        latcrd: true,
        longcrd: true,
        xpos: true,
        ypos: true,
      },
    });

    // If controls have lat/lng from DB, use those directly
    // Otherwise try converting from map position via OCD CRS
    let crs: OcadCrs | null = null;
    const needsConversion = controls.some(
      (c) => (c.latcrd === 0 && c.longcrd === 0) && (c.xpos !== 0 || c.ypos !== 0),
    );

    if (needsConversion) {
      try {
        const parsed = await parseOcdFile();
        crs = parsed.crs;
      } catch {
        // No OCD file — can't convert
      }
    }

    return controls
      .filter((c) => c.latcrd !== 0 || c.longcrd !== 0 || c.xpos !== 0 || c.ypos !== 0)
      .map((c) => {
        let lat = c.latcrd / 1e6;
        let lng = c.longcrd / 1e6;

        // If no lat/lng stored, convert from map position
        if (lat === 0 && lng === 0 && crs && (c.xpos !== 0 || c.ypos !== 0)) {
          const mapXMm = c.xpos / 10;
          const mapYMm = c.ypos / 10;
          const wgs84 = mapMmToWgs84(mapXMm, mapYMm, crs);
          if (wgs84) {
            lat = wgs84.lat;
            lng = wgs84.lng;
          }
        }

        return {
          id: c.Id,
          name: c.Name,
          code: c.Numbers.split(";")[0] || c.Name,
          status: c.Status,
          lat,
          lng,
        };
      })
      .filter((c) => c.lat !== 0 || c.lng !== 0);
  }),

  /**
   * Upload a GPS track as a GeoJSON Feature (LineString).
   * Upserts on (DeviceId, StartTime) so re-uploading is safe.
   */
  uploadTrack: publicProcedure
    .input(
      z.object({
        deviceId: z.string().min(1).max(255),
        trackName: z.string().max(255).default(""),
        startTime: z.number(),
        endTime: z.number().nullable().optional(),
        distance: z.number().default(0),
        geometry: z.object({
          type: z.literal("Feature"),
          geometry: z.object({
            type: z.literal("LineString"),
            coordinates: z.array(z.array(z.number())),
          }),
          properties: z
            .object({
              coordTimes: z.array(z.string()).optional(),
              speeds: z.array(z.number()).optional(),
            })
            .passthrough(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureTracksTable(client);

      const geometryJson = JSON.stringify(input.geometry);
      const pointCount = input.geometry.geometry.coordinates.length;

      await client.$executeRawUnsafe(
        `INSERT INTO oxygen_tracks (DeviceId, TrackName, StartTime, EndTime, Distance, PointCount, Geometry)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           TrackName = VALUES(TrackName),
           EndTime = VALUES(EndTime),
           Distance = VALUES(Distance),
           PointCount = VALUES(PointCount),
           Geometry = VALUES(Geometry)`,
        input.deviceId,
        input.trackName,
        input.startTime,
        input.endTime ?? null,
        input.distance,
        pointCount,
        geometryJson,
      );

      return { success: true, pointCount };
    }),

  /**
   * Append points to an existing track (for future live push).
   */
  appendTrackPoints: publicProcedure
    .input(
      z.object({
        deviceId: z.string().min(1).max(255),
        startTime: z.number(),
        coordinates: z.array(z.array(z.number())),
        coordTimes: z.array(z.string()).optional(),
        speeds: z.array(z.number()).optional(),
        endTime: z.number().nullable().optional(),
        distance: z.number().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureTracksTable(client);

      const rows = await client.$queryRawUnsafe<
        { Id: number; Geometry: string }[]
      >(
        "SELECT Id, Geometry FROM oxygen_tracks WHERE DeviceId = ? AND StartTime = ?",
        input.deviceId,
        input.startTime,
      );

      if (rows.length === 0) {
        throw new Error("Track not found. Upload the initial track first.");
      }

      const existing = JSON.parse(rows[0].Geometry);
      existing.geometry.coordinates.push(...input.coordinates);
      if (input.coordTimes && existing.properties.coordTimes) {
        existing.properties.coordTimes.push(...input.coordTimes);
      }
      if (input.speeds && existing.properties.speeds) {
        existing.properties.speeds.push(...input.speeds);
      }

      const newPointCount = existing.geometry.coordinates.length;
      const geometryJson = JSON.stringify(existing);

      await client.$executeRawUnsafe(
        `UPDATE oxygen_tracks SET Geometry = ?, PointCount = ?, EndTime = COALESCE(?, EndTime), Distance = COALESCE(?, Distance) WHERE Id = ?`,
        geometryJson,
        newPointCount,
        input.endTime ?? null,
        input.distance ?? null,
        rows[0].Id,
      );

      return { success: true, pointCount: newPointCount };
    }),

  /**
   * List uploaded tracks (metadata only, no geometry blob).
   */
  listTracks: publicProcedure
    .input(
      z
        .object({
          deviceId: z.string().optional(),
          limit: z.number().min(1).max(100).default(50),
        })
        .optional()
        .default({ limit: 50 }),
    )
    .query(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureTracksTable(client);

      type RawTrack = {
        Id: number;
        DeviceId: string;
        TrackName: string;
        StartTime: bigint;
        EndTime: bigint | null;
        Distance: number;
        PointCount: number;
      };

      const toJson = (row: RawTrack) => ({
        id: row.Id,
        deviceId: row.DeviceId,
        trackName: row.TrackName,
        startTime: Number(row.StartTime),
        endTime: row.EndTime != null ? Number(row.EndTime) : null,
        distance: row.Distance,
        pointCount: row.PointCount,
      });

      if (input.deviceId) {
        const rows = await client.$queryRawUnsafe<RawTrack[]>(
          "SELECT Id, DeviceId, TrackName, StartTime, EndTime, Distance, PointCount FROM oxygen_tracks WHERE DeviceId = ? ORDER BY StartTime DESC LIMIT ?",
          input.deviceId,
          input.limit,
        );
        return rows.map(toJson);
      }
      const rows = await client.$queryRawUnsafe<RawTrack[]>(
        "SELECT Id, DeviceId, TrackName, StartTime, EndTime, Distance, PointCount FROM oxygen_tracks ORDER BY StartTime DESC LIMIT ?",
        input.limit,
      );
      return rows.map(toJson);
    }),
});

// ─── GeoJSON coordinate conversion ──────────────────────────

function convertFeatureCollectionToWgs84(
  fc: GeoJSONFeatureCollection,
  crs: OcadCrs,
): GeoJSONFeatureCollection {
  return {
    ...fc,
    features: fc.features.map((f) => ({
      ...f,
      geometry: convertGeometryToWgs84(f.geometry, crs) as typeof f.geometry,
    })),
  };
}

function convertGeometryToWgs84(
  geom: { type: string; coordinates: unknown },
  crs: OcadCrs,
): { type: string; coordinates: unknown } {
  switch (geom.type) {
    case "Point": {
      const coords = geom.coordinates as number[];
      const wgs84 = mapMmToWgs84(coords[0], coords[1], crs);
      return {
        type: "Point",
        coordinates: wgs84 ? [wgs84.lng, wgs84.lat] : coords,
      };
    }
    case "LineString": {
      const coords = geom.coordinates as number[][];
      return {
        type: "LineString",
        coordinates: coords.map((c) => {
          const wgs84 = mapMmToWgs84(c[0], c[1], crs);
          return wgs84 ? [wgs84.lng, wgs84.lat] : c;
        }),
      };
    }
    case "Polygon": {
      const rings = geom.coordinates as number[][][];
      return {
        type: "Polygon",
        coordinates: rings.map((ring) =>
          ring.map((c) => {
            const wgs84 = mapMmToWgs84(c[0], c[1], crs);
            return wgs84 ? [wgs84.lng, wgs84.lat] : c;
          }),
        ),
      };
    }
    default:
      return geom;
  }
}
