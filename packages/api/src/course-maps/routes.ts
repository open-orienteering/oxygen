import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  courseMapObjectSchema,
  courseMapOverridesSchema,
  mapWindowForFrame,
  type ResolvedMapGraphic,
} from "@oxygen/shared";
import { z } from "zod";
import { prisma } from "../db.js";
import { assertRestAccess } from "../restGuard.js";
import { composeMapPageSvg, renderBaseMapWindow } from "./map-page-svg.js";
import { graphicToResolved } from "./graphics.js";
import { getBaseMapInfo, loadBaseMapSvg } from "./map-source.js";
import { resolveMapLayout } from "./resolve-layout.js";
import { LruCache } from "./lru-cache.js";
import { RsvgConverter, mergePdfPages } from "./svg-to-pdf.js";

type Db = ReturnType<typeof prisma>;

type MapRow = Awaited<ReturnType<typeof findMapRows>>[number];

const mapObjectsSchema = z.array(courseMapObjectSchema);

/** High-DPI previews are allowed, but the raster stays bounded per side. */
const MAX_DPI = 600;
const MAX_RENDER_PX = 4096;
const MAX_WINDOW_PNG_CACHE_ENTRIES = 16;
const MAX_WINDOW_PNG_CACHE_BYTES = 64 * 1024 * 1024;

interface WindowPngCacheEntry {
  body: Buffer;
  etag: string;
}

const windowPngCache = new LruCache<WindowPngCacheEntry>(
  MAX_WINDOW_PNG_CACHE_ENTRIES,
  MAX_WINDOW_PNG_CACHE_BYTES,
  (entry) => entry.body.byteLength,
);

export function clearCourseMapWindowCache(): void {
  windowPngCache.clear();
}

function parsePositive(
  value: string | undefined,
  name: string,
  max = Number.POSITIVE_INFINITY,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be between 0 and ${max}`);
  }
  return parsed;
}

function parseSeqs(raw: string | undefined): number[] | null {
  if (!raw) return null;
  const seqs = raw.split(",").map((value) => Number(value.trim()));
  if (seqs.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error("Map and course ids must be positive integers");
  }
  return [...new Set(seqs)];
}

function safeFilename(value: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "maps";
}

async function findMapRows(
  db: Db,
  eventId: bigint,
  query: { maps?: string; courses?: string; allControls?: string },
) {
  const mapSeqs = parseSeqs(query.maps);
  const courseSeqs = parseSeqs(query.courses);
  const includeAllControls = query.allControls === "1";
  if (mapSeqs && courseSeqs) {
    throw new Error("Use either maps or courses, not both");
  }
  const rows = await db.courseMap.findMany({
    where: {
      eventId,
      ...(mapSeqs ? { seq: { in: mapSeqs } } : {}),
      ...(courseSeqs ? { course: { seq: { in: courseSeqs } } } : {}),
      ...(!mapSeqs && !courseSeqs && !includeAllControls
        ? {}
        : includeAllControls && !mapSeqs && !courseSeqs
          ? { kind: "all_controls" }
          : {}),
    },
    include: {
      template: true,
      course: {
        include: {
          classes: { select: { name: true } },
          courseControls: {
            orderBy: { position: "asc" },
            include: { control: true },
          },
        },
      },
    },
    orderBy: [
      { course: { seq: "asc" } },
      { sortOrder: "asc" },
      { seq: "asc" },
    ],
    take: 201,
  });
  if (rows.length > 200) {
    throw new Error("A single export is limited to 200 map pages");
  }
  if (
    mapSeqs &&
    new Set(rows.map((row) => row.seq)).size !== mapSeqs.length
  ) {
    throw new Error("One or more requested maps were not found");
  }
  const requested = mapSeqs?.length ?? courseSeqs?.length;
  if (requested && rows.length === 0) throw new Error("No requested maps found");
  return rows;
}

type AllControlRow = {
  id: string;
  seq: number;
  codes: string;
  status: string;
  xpos: number;
  ypos: number;
  description: unknown;
};

/**
 * Data-URI / inline-SVG resolver for every graphic referenced by the maps
 * being exported. Loaded once per request; unknown ids resolve to null and
 * the object is simply skipped.
 */
async function buildGraphicResolver(
  db: Db,
  eventId: bigint,
  rows: MapRow[],
): Promise<(graphicId: number) => ResolvedMapGraphic | null> {
  const ids = new Set<bigint>();
  for (const row of rows) {
    for (const source of [row.objects, row.template?.objects]) {
      const objects = mapObjectsSchema.safeParse(source ?? []);
      if (!objects.success) continue;
      for (const object of objects.data) {
        if (object.kind === "image") ids.add(BigInt(object.graphicId));
      }
    }
  }
  if (ids.size === 0) return () => null;
  const graphics = await db.graphic.findMany({
    where: {
      id: { in: [...ids] },
      OR: [{ eventId }, { eventId: null }],
    },
    select: { id: true, mime: true, data: true },
  });
  const resolved = new Map<number, ResolvedMapGraphic | null>();
  for (const graphic of graphics) {
    resolved.set(
      Number(graphic.id),
      graphicToResolved(graphic.mime, Buffer.from(graphic.data)),
    );
  }
  return (graphicId) => resolved.get(graphicId) ?? null;
}

async function renderPage(
  db: Db,
  event: { id: bigint; name: string; date: Date },
  row: MapRow,
  allControls: AllControlRow[],
  resolveGraphic: (graphicId: number) => ResolvedMapGraphic | null,
): Promise<string> {
  if (!row.template) throw new Error(`Map "${row.name}" has no template`);
  const mapInfo = await getBaseMapInfo(db, event.id);
  const layout = resolveMapLayout({
    kind: row.kind,
    template: row.template,
    overrides: courseMapOverridesSchema.parse(row.overrides),
    objects: mapObjectsSchema.parse(row.objects),
    course: row.course
      ? {
          name: row.course.name,
          lengthM: row.course.lengthM,
          climbM: row.course.climbM,
          geometry: row.course.geometry,
          classes: row.course.classes,
          controls: row.course.courseControls.map(({ control }) => control),
        }
      : null,
    allControls,
    windowCenter:
      row.windowCenter && typeof row.windowCenter === "object"
        ? z.object({ x: z.number(), y: z.number() }).parse(row.windowCenter)
        : null,
    mapScale: mapInfo.scale,
    meridianTiltDeg: mapInfo.meridianTiltDeg,
    event: { name: event.name, date: event.date },
    mapName: row.name,
  });
  const { layers } = await loadBaseMapSvg(db, event.id, layout.window);
  return composeMapPageSvg({
    document: layout.document,
    window: layout.window,
    baseMap: layers.full,
    inkMap: layers.ink,
    controls: layout.controls,
    legs: layout.legs,
    descriptionRows: layout.descriptionRows,
    title: row.course?.name ?? row.name,
    allControls: row.kind === "all_controls",
    textValues: layout.textValues,
    resolveGraphic,
    overprintScale: layout.overprintScale,
  });
}

export function registerCourseMapRoutes(
  server: FastifyInstance,
  options: { converter?: Pick<RsvgConverter, "convert"> } = {},
): void {
  server.get<{
    Params: { nameId: string };
    Querystring: {
      maps?: string;
      courses?: string;
      allControls?: string;
    };
  }>("/api/maps/:nameId/maps.pdf", async (req, reply) => {
    const { nameId } = req.params;
    if (!(await assertRestAccess(req, reply, { nameId, cap: "courses.view" }))) {
      return;
    }
    try {
      const db = prisma();
      const event = await db.event.findUnique({ where: { nameId } });
      if (!event || event.removed) {
        return reply.code(404).send({ error: "Event not found" });
      }
      const rows = await findMapRows(db, event.id, req.query);
      if (rows.length === 0) {
        return reply.code(404).send({ error: "No maps found" });
      }
      const allControls = await db.control.findMany({
        where: { eventId: event.id, removed: false },
        select: {
          id: true,
          seq: true,
          codes: true,
          status: true,
          xpos: true,
          ypos: true,
          description: true,
        },
      });
      const resolveGraphic = await buildGraphicResolver(db, event.id, rows);
      const converter = options.converter ?? new RsvgConverter();
      const pages: Buffer[] = [];
      for (const row of rows) {
        pages.push(
          await converter.convert(
            await renderPage(db, event, row, allControls, resolveGraphic),
          ),
        );
      }
      const body =
        pages.length === 1
          ? pages[0]
          : await mergePdfPages(pages, {
              title: `${event.name} maps`,
              author: event.organizerName || undefined,
            });
      const filename =
        rows.length === 1
          ? `${safeFilename(event.nameId)}_${safeFilename(rows[0].name)}.pdf`
          : `${safeFilename(event.nameId)}_maps.pdf`;
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .header("Cache-Control", "no-store")
        .send(body);
    } catch (error) {
      req.log.error(error);
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Could not render maps",
      });
    }
  });

  server.get<{
    Params: { nameId: string };
    Querystring: {
      cx?: string;
      cy?: string;
      wMm?: string;
      hMm?: string;
      printScale?: string;
      dpi?: string;
      rot?: string;
      layer?: string;
    };
  }>("/api/maps/:nameId/window.png", async (req, reply) => {
    const { nameId } = req.params;
    if (!(await assertRestAccess(req, reply, { nameId, cap: "courses.view" }))) {
      return;
    }
    try {
      const db = prisma();
      const event = await db.event.findUnique({ where: { nameId } });
      if (!event || event.removed) {
        return reply.code(404).send({ error: "Event not found" });
      }
      const cx = Number(req.query.cx);
      const cy = Number(req.query.cy);
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        throw new Error("cx and cy must be finite map coordinates");
      }
      const widthMm = parsePositive(req.query.wMm, "wMm", 1_000);
      const heightMm = parsePositive(req.query.hMm, "hMm", 1_000);
      const printScale = parsePositive(
        req.query.printScale,
        "printScale",
        100_000,
      );
      const dpi = parsePositive(req.query.dpi ?? "120", "dpi", MAX_DPI);
      const rotation = Number(req.query.rot ?? "0");
      if (!Number.isFinite(rotation) || Math.abs(rotation) > 180) {
        throw new Error("rot must be a rotation between -180 and 180 degrees");
      }
      const layerRaw = (req.query.layer ?? "full").toLowerCase();
      if (layerRaw !== "full" && layerRaw !== "ink") {
        throw new Error('layer must be "full" or "ink"');
      }
      const layer = layerRaw as "full" | "ink";
      const widthPx = Math.max(1, Math.round((widthMm / 25.4) * dpi));
      const heightPx = Math.max(1, Math.round((heightMm / 25.4) * dpi));
      if (widthPx > MAX_RENDER_PX || heightPx > MAX_RENDER_PX) {
        throw new Error(
          `Requested render is ${widthPx}x${heightPx} px; each side must stay within ${MAX_RENDER_PX} px`,
        );
      }
      const mapInfo = await getBaseMapInfo(db, event.id);
      const cacheKey = [
        event.id.toString(),
        mapInfo.version,
        cx.toFixed(4),
        cy.toFixed(4),
        widthMm.toFixed(4),
        heightMm.toFixed(4),
        printScale.toFixed(2),
        dpi.toFixed(2),
        rotation.toFixed(2),
        layer,
      ].join(":");
      const cached = windowPngCache.get(cacheKey);
      if (cached) {
        if (req.headers["if-none-match"] === cached.etag) {
          return reply
            .code(304)
            .header("ETag", cached.etag)
            .header("X-Cache", "hit")
            .send();
        }
        return reply
          .header("Content-Type", "image/png")
          .header("Cache-Control", "private, max-age=3600")
          .header("ETag", cached.etag)
          .header("X-Cache", "hit")
          .send(cached.body);
      }
      const frame = { x: 0, y: 0, width: widthMm, height: heightMm };
      const window = mapWindowForFrame(
        frame,
        { x: cx, y: cy },
        mapInfo.scale,
        printScale,
        rotation,
      );
      const { layers } = await loadBaseMapSvg(db, event.id, window);
      const source =
        layer === "ink"
          ? layers.ink
          : layers.full;
      if (!source) {
        // Empty ink layer: 1×1 transparent PNG.
        const { default: sharp } = await import("sharp");
        const body = await sharp({
          create: {
            width: 1,
            height: 1,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        })
          .png()
          .toBuffer();
        const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
        windowPngCache.set(cacheKey, { body, etag });
        return reply
          .header("Content-Type", "image/png")
          .header("Cache-Control", "private, max-age=3600")
          .header("ETag", etag)
          .header("X-Cache", "miss")
          .send(body);
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}">${renderBaseMapWindow(source, window, frame, {
        forceTransparentFill: layer === "ink",
        dataLayer: layer === "ink" ? "map-ink" : "map-full",
      })}</svg>`;
      const { renderAsync } = await import("@resvg/resvg-js");
      const rendered = await renderAsync(svg, {
        fitTo: { mode: "width", value: widthPx },
        ...(layer === "ink" ? {} : { background: "white" }),
      });
      const body = Buffer.from(rendered.asPng());
      const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
      windowPngCache.set(cacheKey, { body, etag });
      return reply
        .header("Content-Type", "image/png")
        .header("Cache-Control", "private, max-age=3600")
        .header("ETag", etag)
        .header("X-Cache", "miss")
        .send(body);
    } catch (error) {
      return reply.code(400).send({
        error:
          error instanceof Error ? error.message : "Could not render map window",
      });
    }
  });

  server.get<{
    Params: { nameId: string; id: string };
  }>("/api/maps/:nameId/graphics/:id", async (req, reply) => {
    const { nameId } = req.params;
    if (!(await assertRestAccess(req, reply, { nameId, cap: "courses.view" }))) {
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: "Invalid graphic id" });
    }
    const db = prisma();
    const event = await db.event.findUnique({ where: { nameId } });
    if (!event || event.removed) {
      return reply.code(404).send({ error: "Event not found" });
    }
    const graphic = await db.graphic.findFirst({
      where: {
        id: BigInt(id),
        OR: [{ eventId: event.id }, { eventId: null }],
      },
      select: { mime: true, data: true, updatedAt: true },
    });
    if (!graphic) {
      return reply.code(404).send({ error: "Graphic not found" });
    }
    return reply
      .header("Content-Type", graphic.mime)
      .header("Cache-Control", "private, max-age=3600")
      .send(Buffer.from(graphic.data));
  });
}
