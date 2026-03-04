import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { getCompetitionClient, ensureMapFilesTable, incrementCounter } from "../db.js";
import { CourseSummary, CourseDetail, RunnerStatus } from "@oxygen/shared";
import { parseIOFCourseData, parseIOFCourseDataWithGeometry, type ParsedCourseData, type GeoJSONFeatureCollection, type ParsedCourse } from "../iof-course-parser.js";
import { parseOCDCourseData } from "../ocd-course-parser.js";

/**
 * Extract a numeric suffix from a control ID string (e.g. "STA1" → 1, "FIN2" → 2).
 * Returns 1 as default if no numeric suffix is found.
 */
function getControlSuffix(id: string): number {
  const match = id.match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) || 1 : 1;
}

/**
 * MeOS-style IDs for start/finish controls.
 * Start N → 211100 + N, Finish N → 311100 + N
 */
function meosStartId(n: number): number {
  return 211100 + n;
}
function meosFinishId(n: number): number {
  return 311100 + n;
}

/**
 * MeOS-style names for start/finish controls.
 * Start N → "Start N", Finish N → "Mål N"
 */
function meosStartName(n: number): string {
  return n > 1 ? `Start ${n}` : "Start 1";
}
function meosFinishName(n: number): string {
  return n > 1 ? `Mål ${n}` : "Mål 1";
}

// ─── Course geometry table ───────────────────────────────────────────────────

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

/**
 * Upsert GeoJSON geometry for a set of courses.
 * Source priority: 'ocd' > 'xml' — an OCD geometry is never overwritten by XML.
 */
async function saveCourseGeometry(
  client: Awaited<ReturnType<typeof getCompetitionClient>>,
  courseGeometry: Record<string, GeoJSONFeatureCollection>,
  source: "xml" | "ocd",
) {
  await ensureCourseGeometryTable(client);

  // Load existing geometries to check their source
  const existing = await client.$queryRawUnsafe<{ CourseName: string; Source: string }[]>(
    "SELECT CourseName, Source FROM oxygen_course_geometry",
  );
  const existingSource = new Map(existing.map(r => [r.CourseName, r.Source]));

  for (const [courseName, geometry] of Object.entries(courseGeometry)) {
    const currentSource = existingSource.get(courseName);

    // Skip write if existing geometry is OCD and new source is only XML
    if (source === "xml" && currentSource === "ocd") continue;

    const geomJson = JSON.stringify(geometry);
    if (currentSource !== undefined) {
      await client.$executeRawUnsafe(
        "UPDATE oxygen_course_geometry SET Source=?, Geometry=? WHERE CourseName=?",
        source, geomJson, courseName,
      );
    } else {
      await client.$executeRawUnsafe(
        "INSERT INTO oxygen_course_geometry (CourseName, Source, Geometry) VALUES (?, ?, ?)",
        courseName, source, geomJson,
      );
    }
  }
}

// ─── Input parsing helper ────────────────────────────────────────────────────

/** The combined zod input shape for both XML and OCD import mutations. */
const courseFileInput = z.object({
  xmlContent: z.string().optional(),
  ocdBase64: z.string().optional(),
  classMapping: z.record(z.string(), z.array(z.number().int())).optional(),
});

/** Parse the incoming file data (XML string or OCD base64) using the right parser. */
function parseCourseFileInput(
  input: { xmlContent?: string; ocdBase64?: string },
): ParsedCourseData {
  if (input.ocdBase64) {
    const buf = Buffer.from(input.ocdBase64, "base64");
    return parseOCDCourseData(buf);
  }
  if (input.xmlContent) {
    return parseIOFCourseDataWithGeometry(input.xmlContent);
  }
  throw new Error("No course data provided: supply either xmlContent or ocdBase64");
}

export const courseRouter = router({
  /**
   * List all courses.
   */
  list: publicProcedure
    .input(
      z
        .object({
          search: z.string().optional(),
        })
        .optional(),
    )
    .query(async ({ input }): Promise<CourseSummary[]> => {
      const client = await getCompetitionClient();

      const courses = await client.oCourse.findMany({
        where: { Removed: false },
        orderBy: { Id: "asc" },
      });

      let filtered = courses;
      if (input?.search) {
        const term = input.search.toLowerCase();
        filtered = filtered.filter(
          (c) =>
            c.Name.toLowerCase().includes(term) ||
            c.Controls.toLowerCase().includes(term) ||
            String(c.Id).includes(term),
        );
      }

      return filtered.map(
        (c): CourseSummary => ({
          id: c.Id,
          name: c.Name,
          controls: c.Controls,
          controlCount: c.Controls.split(";").filter(Boolean).length,
          length: c.Length,
          climb: c.Climb,
          numberOfMaps: c.NumberMaps,
          firstAsStart: c.FirstAsStart === 1,
          lastAsFinish: c.LastAsFinish === 1,
        }),
      );
    }),

  /**
   * Get a single course with detailed class usage info.
   */
  detail: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .query(async ({ input }): Promise<CourseDetail | null> => {
      const client = await getCompetitionClient();

      const course = await client.oCourse.findFirst({
        where: { Id: input.id, Removed: false },
      });
      if (!course) return null;

      // Find classes using this course
      const classes = await client.oClass.findMany({
        where: { Removed: false, Course: course.Id },
        select: { Id: true, Name: true },
      });

      // Count runners per class
      const runners = await client.oRunner.findMany({
        where: { Removed: false },
        select: { Class: true },
      });
      const runnersByClass = new Map<number, number>();
      for (const r of runners) {
        runnersByClass.set(r.Class, (runnersByClass.get(r.Class) ?? 0) + 1);
      }

      const controlCodes = course.Controls.split(";")
        .filter(Boolean)
        .map((s) => parseInt(s, 10));

      return {
        id: course.Id,
        name: course.Name,
        controls: course.Controls,
        controlCount: controlCodes.length,
        length: course.Length,
        climb: course.Climb,
        numberOfMaps: course.NumberMaps,
        firstAsStart: course.FirstAsStart === 1,
        lastAsFinish: course.LastAsFinish === 1,
        controlCodes,
        classes: classes.map((cls) => ({
          classId: cls.Id,
          className: cls.Name,
          runnerCount: runnersByClass.get(cls.Id) ?? 0,
        })),
      };
    }),

  /**
   * Create a new course.
   */
  create: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        controls: z.string().optional().default(""),
        length: z.number().int().optional().default(0),
        numberOfMaps: z.number().int().optional().default(1),
        firstAsStart: z.boolean().optional().default(false),
        lastAsFinish: z.boolean().optional().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      const course = await client.oCourse.create({
        data: {
          Name: input.name,
          Controls: input.controls,
          Length: input.length,
          NumberMaps: input.numberOfMaps,
          FirstAsStart: input.firstAsStart ? 1 : 0,
          LastAsFinish: input.lastAsFinish ? 1 : 0,
        },
      });

      await incrementCounter("oCourse", course.Id);
      return {
        id: course.Id,
        name: course.Name,
      };
    }),

  /**
   * Update an existing course.
   */
  update: publicProcedure
    .input(
      z.object({
        id: z.number().int(),
        name: z.string().optional(),
        controls: z.string().optional(),
        length: z.number().int().optional(),
        numberOfMaps: z.number().int().optional(),
        firstAsStart: z.boolean().optional(),
        lastAsFinish: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.Name = input.name;
      if (input.controls !== undefined) data.Controls = input.controls;
      if (input.length !== undefined) data.Length = input.length;
      if (input.numberOfMaps !== undefined) data.NumberMaps = input.numberOfMaps;
      if (input.firstAsStart !== undefined)
        data.FirstAsStart = input.firstAsStart ? 1 : 0;
      if (input.lastAsFinish !== undefined)
        data.LastAsFinish = input.lastAsFinish ? 1 : 0;

      const course = await client.oCourse.update({
        where: { Id: input.id },
        data,
      });

      await incrementCounter("oCourse", course.Id);
      return {
        id: course.Id,
        name: course.Name,
      };
    }),

  /**
   * Soft-delete a course.
   */
  delete: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();

      await client.oCourse.update({
        where: { Id: input.id },
        data: { Removed: true },
      });

      return { success: true };
    }),

  /**
   * Preview an IOF 3.0 CourseData XML import.
   * Parses the XML, auto-matches class names, and returns what would be imported.
   */
  previewImport: publicProcedure
    .input(courseFileInput)
    .mutation(async ({ input }) => {
      const parsed = parseCourseFileInput(input);
      const client = await getCompetitionClient();

      // Fetch existing classes for auto-matching
      const dbClasses = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true, Course: true },
      });

      // Fetch existing controls
      const dbControls = await client.oControl.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true, Numbers: true },
      });
      const existingControlNames = new Set(
        dbControls.map((c) => c.Name.toLowerCase()),
      );

      // Auto-match class names from XML to DB classes
      const classMap: Record<string, { dbClassId: number; dbClassName: string; matched: boolean }[]> = {};

      for (const assignment of parsed.classAssignments) {
        const xmlClassName = assignment.className;
        const courseName = assignment.courseName;

        // Find best matching DB class
        let bestMatch: { id: number; name: string } | null = null;

        // Exact match (case-insensitive)
        const exact = dbClasses.find(
          (c) => c.Name.toLowerCase() === xmlClassName.toLowerCase(),
        );
        if (exact) {
          bestMatch = { id: exact!.Id, name: exact!.Name };
        } else {
          // Fuzzy: check if DB class name contains the XML name or vice versa
          const fuzzy = dbClasses.find(
            (c) =>
              c.Name.toLowerCase().includes(xmlClassName.toLowerCase()) ||
              xmlClassName.toLowerCase().includes(c.Name.toLowerCase()),
          );
          if (fuzzy) {
            bestMatch = { id: fuzzy!.Id, name: fuzzy!.Name };
          }
        }

        if (!classMap[courseName]) classMap[courseName] = [];
        classMap[courseName].push({
          dbClassId: bestMatch?.id ?? 0,
          dbClassName: bestMatch?.name ?? "",
          matched: !!bestMatch,
        });
      }

      // Build course preview
      const coursePreview = parsed.courses.map((course: ParsedCourse) => {
        const controlCount = course.controls.filter(
          (c) => c.type === "Control",
        ).length;
        const assignments = parsed.classAssignments
          .filter((a) => a.courseName === course.name)
          .map((a) => a.className);
        const matchedClasses = classMap[course.name] ?? [];

        return {
          name: course.name,
          length: course.length,
          climb: course.climb,
          controlCount,
          xmlClassNames: assignments,
          classMatches: matchedClasses,
        };
      });

      // Count new vs existing controls
      const newControls = parsed.controls.filter(
        (c) =>
          c.type === "Control" &&
          !existingControlNames.has(c.id.toLowerCase()),
      ).length;
      const existingControls = parsed.controls.filter(
        (c) =>
          c.type === "Control" &&
          existingControlNames.has(c.id.toLowerCase()),
      ).length;

      return {
        courses: coursePreview,
        totalControls: parsed.controls.filter((c) => c.type === "Control").length,
        newControls,
        existingControls,
        startControls: parsed.controls.filter((c) => c.type === "Start").length,
        finishControls: parsed.controls.filter((c) => c.type === "Finish").length,
        mapScale: parsed.mapScale,
        dbClasses: dbClasses.map((c) => ({ id: c.Id, name: c.Name })),
      };
    }),

  /**
   * Import IOF 3.0 CourseData XML into the competition database.
   * Creates/updates controls, courses, and optionally assigns courses to classes.
   */
  importCourses: publicProcedure
    .input(courseFileInput)
    .mutation(async ({ input }) => {
      const parsed = parseCourseFileInput(input);
      const { courseGeometry: geometry, geometrySource: source } = parsed;
      const client = await getCompetitionClient();

      let controlsCreated = 0;
      let controlsUpdated = 0;
      let coursesCreated = 0;
      let coursesUpdated = 0;
      let classesAssigned = 0;

      // ── 1. Upsert controls ──────────────────────────────────

      // Build a map from control string ID → DB control ID
      const controlIdMap = new Map<string, number>();

      // Load existing controls
      const existingControls = await client.oControl.findMany({
        select: { Id: true, Name: true, Numbers: true, Removed: true },
      });
      const controlByName = new Map<string, typeof existingControls[0]>();
      for (const c of existingControls) {
        controlByName.set(c.Name.toLowerCase(), c);
        // Also index by each number code
        for (const code of c.Numbers.split(";").filter(Boolean)) {
          controlByName.set(code.toLowerCase(), c);
        }
      }

      for (const pc of parsed.controls) {
        const existing = controlByName.get(pc.id.toLowerCase());

        // Determine status based on type
        const status = pc.type === "Start" ? 4 : pc.type === "Finish" ? 5 : 0;

        // Convert lat/lng to integer (MeOS convention: 6 decimal places → multiply by 1e6)
        const latcrd = Math.round(pc.lat * 1e6);
        const longcrd = Math.round(pc.lng * 1e6);
        // Store map position (MeOS convention: 1 decimal place → multiply by 10)
        const xpos = Math.round(pc.mapX * 10);
        const ypos = Math.round(pc.mapY * 10);

        // MeOS naming conventions:
        // - Regular controls: Name = "" (empty), Numbers = control code (e.g. "31")
        // - Start controls: Name = "Start N", Numbers = "", Id = 211100 + N
        // - Finish controls: Name = "Mål N", Numbers = "", Id = 311100 + N
        const suffix = getControlSuffix(pc.id);
        let controlName: string;
        let controlNumbers: string;
        let controlDbId: number | undefined;

        if (pc.type === "Start") {
          controlName = meosStartName(suffix);
          controlNumbers = "";
          controlDbId = meosStartId(suffix);
        } else if (pc.type === "Finish") {
          controlName = meosFinishName(suffix);
          controlNumbers = "";
          controlDbId = meosFinishId(suffix);
        } else {
          // Regular control: Name empty, Numbers = code
          controlName = "";
          controlNumbers = pc.id;
          const numericId = parseInt(pc.id, 10);
          controlDbId = !isNaN(numericId) && numericId > 0 ? numericId : undefined;
        }

        // Also check for existing by MeOS-encoded ID (for start/finish)
        const existingById = controlDbId
          ? existingControls.find((c) => c.Id === controlDbId)
          : undefined;
        const matchedExisting = existing ?? existingById;

        if (matchedExisting && !matchedExisting.Removed) {
          // Update existing control with coordinates
          await client.oControl.update({
            where: { Id: matchedExisting.Id },
            data: { Name: controlName, Numbers: controlNumbers, latcrd, longcrd, xpos, ypos, Status: status },
          });
          controlIdMap.set(pc.id, matchedExisting.Id);
          controlsUpdated++;
        } else if (matchedExisting && matchedExisting.Removed) {
          // Re-activate deleted control
          await client.oControl.update({
            where: { Id: matchedExisting.Id },
            data: {
              Name: controlName,
              Numbers: controlNumbers,
              Status: status,
              latcrd,
              longcrd,
              xpos,
              ypos,
              Removed: false,
            },
          });
          controlIdMap.set(pc.id, matchedExisting.Id);
          controlsCreated++;
        } else {
          // Create new control
          try {
            const created = controlDbId
              ? await client.oControl.create({
                data: {
                  Id: controlDbId,
                  Name: controlName,
                  Numbers: controlNumbers,
                  Status: status,
                  latcrd,
                  longcrd,
                  xpos,
                  ypos,
                },
              })
              : await client.oControl.create({
                data: {
                  Name: controlName,
                  Numbers: controlNumbers,
                  Status: status,
                  latcrd,
                  longcrd,
                  xpos,
                  ypos,
                },
              });
            controlIdMap.set(pc.id, created.Id);
            controlsCreated++;
          } catch {
            // ID conflict — try without specifying ID
            const created = await client.oControl.create({
              data: {
                Name: controlName,
                Numbers: controlNumbers,
                Status: status,
                latcrd,
                longcrd,
                xpos,
                ypos,
              },
            });
            controlIdMap.set(pc.id, created.Id);
            controlsCreated++;
          }
        }
      }

      // ── 2. Create/update courses ────────────────────────────

      // Load existing courses
      const existingCourses = await client.oCourse.findMany({
        where: { Removed: false },
        select: { Id: true, Name: true },
      });
      const courseByName = new Map(
        existingCourses.map((c) => [c.Name.toLowerCase(), c]),
      );
      const courseIdMap = new Map<string, number>();

      for (const pc of parsed.courses) {
        // Build control sequence as semicolon-separated DB IDs (regular controls only,
        // matching MeOS behavior — start/finish are not stored in Controls)
        const controlIds = pc.controls
          .filter((cc) => cc.type === "Control")
          .map((cc) => controlIdMap.get(cc.controlId) ?? cc.controlId)
          .join(";");
        const controlsStr = controlIds ? controlIds + ";" : "";

        // Extract start name from the IOF course and convert to MeOS-style name.
        // MeOS uses "Start 1", "Start 2" etc. to link courses to their start station.
        const startControl = pc.controls.find((cc) => cc.type === "Start");
        const startName = startControl
          ? meosStartName(getControlSuffix(startControl.controlId))
          : "";

        const existing = courseByName.get(pc.name.toLowerCase());

        if (existing) {
          await client.oCourse.update({
            where: { Id: existing.Id },
            data: {
              Controls: controlsStr,
              Length: Math.round(pc.length),
              Climb: Math.round(pc.climb),
              FirstAsStart: 0,
              LastAsFinish: 0,
              StartName: startName,
            },
          });
          courseIdMap.set(pc.name, existing.Id);
          coursesUpdated++;
        } else {
          const created = await client.oCourse.create({
            data: {
              Name: pc.name,
              Controls: controlsStr,
              Length: Math.round(pc.length),
              Climb: Math.round(pc.climb),
              FirstAsStart: 0,
              LastAsFinish: 0,
              StartName: startName,
            },
          });
          courseIdMap.set(pc.name, created.Id);
          coursesCreated++;
        }
      }

      // ── 3. Assign courses to classes ────────────────────────

      if (input.classMapping) {
        for (const [courseName, classIds] of Object.entries(input.classMapping)) {
          const courseId = courseIdMap.get(courseName);
          if (!courseId) continue;

          for (const classId of classIds) {
            if (classId <= 0) continue;
            try {
              await client.oClass.update({
                where: { Id: classId },
                data: { Course: courseId },
              });
              classesAssigned++;
            } catch {
              // Class might not exist
            }
          }
        }
      }

      // ── 4. Save GeoJSON geometry ────────────────────────────
      await saveCourseGeometry(client, geometry, source);

      return {
        controlsCreated,
        controlsUpdated,
        coursesCreated,
        coursesUpdated,
        classesAssigned,
      };
    }),

  /**
   * Upload an OCD (OCAD) map file for this competition.
   * Accepts base64-encoded file data.
   */
  uploadMap: publicProcedure
    .input(
      z.object({
        fileName: z.string(),
        fileDataBase64: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const client = await getCompetitionClient();
      await ensureMapFilesTable(client);

      const buffer = Buffer.from(input.fileDataBase64, "base64");

      // Delete any existing map files (only keep one per competition)
      await client.$executeRawUnsafe("DELETE FROM oxygen_map_files");

      await client.$executeRawUnsafe(
        "INSERT INTO oxygen_map_files (FileName, FileData) VALUES (?, ?)",
        input.fileName,
        buffer,
      );

      return { success: true, fileName: input.fileName, size: buffer.length };
    }),

  /**
   * Check if a map file exists for this competition.
   */
  mapFileInfo: publicProcedure.query(async () => {
    const client = await getCompetitionClient();
    await ensureMapFilesTable(client);

    const rows = await client.$queryRawUnsafe<
      { Id: number; FileName: string; UploadedAt: Date; Size: number }[]
    >(
      "SELECT Id, FileName, UploadedAt, LENGTH(FileData) as Size FROM oxygen_map_files ORDER BY Id DESC LIMIT 1",
    );

    if (rows.length === 0) return null;
    return {
      id: Number(rows[0].Id),
      fileName: rows[0].FileName,
      uploadedAt: rows[0].UploadedAt.toISOString(),
      size: Number(rows[0].Size),
    };
  }),

  /**
   * Download the OCD map file (base64-encoded).
   */
  downloadMap: publicProcedure.query(async () => {
    const client = await getCompetitionClient();
    await ensureMapFilesTable(client);

    const rows = await client.$queryRawUnsafe<
      { FileData: Buffer; FileName: string }[]
    >(
      "SELECT FileData, FileName FROM oxygen_map_files ORDER BY Id DESC LIMIT 1",
    );

    if (rows.length === 0) return null;
    return {
      fileName: rows[0].FileName,
      fileDataBase64: Buffer.from(rows[0].FileData).toString("base64"),
    };
  }),

  /**
   * Get all controls with their coordinates (for map overlay).
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

    return controls
      .filter((c) => c.latcrd !== 0 || c.longcrd !== 0 || c.xpos !== 0 || c.ypos !== 0)
      .map((c) => ({
        id: c.Id,
        name: c.Name,
        code: c.Numbers.split(";")[0] || c.Name,
        status: c.Status,
        lat: c.latcrd / 1e6,
        lng: c.longcrd / 1e6,
        // Map position in mm (MeOS stores as value * 10, 1 decimal place)
        mapX: c.xpos / 10,
        mapY: c.ypos / 10,
      }));
  }),

  /**
   * Get completion status for each control — how many runners have passed it.
   * Optionally filter by a specific course.
   */
  controlCompletionStatus: publicProcedure
    .input(
      z
        .object({
          courseId: z.number().int().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const client = await getCompetitionClient();

      // 1. Get all controls (for code → id mapping)
      const controls = await client.oControl.findMany({
        where: { Removed: false },
        select: { Id: true, Numbers: true, Status: true },
      });

      // Build code→controlId map (use first code from Numbers)
      const codeToControlId = new Map<number, number>();
      for (const c of controls) {
        const code = parseInt(c.Numbers.split(";")[0], 10);
        if (!isNaN(code) && code > 10) codeToControlId.set(code, c.Id);
      }

      // 2. Get courses to determine which controls belong to which course
      const courses = await client.oCourse.findMany({
        where: { Removed: false },
        select: { Id: true, Controls: true },
      });

      // Build controlId → set of courseIds
      const controlToCourses = new Map<number, Set<number>>();
      for (const course of courses) {
        for (const ctrlIdStr of course.Controls.split(";").filter(Boolean)) {
          const ctrlId = parseInt(ctrlIdStr, 10);
          if (!isNaN(ctrlId)) {
            if (!controlToCourses.has(ctrlId)) controlToCourses.set(ctrlId, new Set());
            controlToCourses.get(ctrlId)!.add(course.Id);
          }
        }
      }

      const runners = await client.oRunner.findMany({
        where: {
          Removed: false,
          Status: {
            notIn: [
              RunnerStatus.NoTiming,
              RunnerStatus.DNS,
              RunnerStatus.Cancel,
              RunnerStatus.NotCompeting,
              RunnerStatus.OutOfCompetition,
            ],
          },
        },
        select: {
          Id: true,
          CardNo: true,
          Class: true,
          Course: true,
          Status: true,
          StartTime: true,
          Card: true,
          FinishTime: true,
        },
      });


      // Get class → courseId mapping
      const classes = await client.oClass.findMany({
        where: { Removed: false },
        select: { Id: true, Course: true },
      });
      const classToCourse = new Map<number, number>();
      for (const cl of classes) {
        if (cl.Course > 0) classToCourse.set(cl.Id, cl.Course);
      }


      // 4. Count passes per control code from oPunch (radio/manual)
      const passedByCode = new Map<number, Set<number>>();

      const punchDetails = await client.$queryRawUnsafe<
        { Type: number; CardNo: number }[]
      >(
        "SELECT DISTINCT Type, CardNo FROM oPunch WHERE Removed = 0 AND Type > 10",
      );
      for (const p of punchDetails) {
        if (!passedByCode.has(p.Type)) passedByCode.set(p.Type, new Set());
        passedByCode.get(p.Type)!.add(p.CardNo);
      }

      // 5. Also count from oCard.Punches (card readouts)
      const cards = await client.oCard.findMany({
        where: { Punches: { not: "" } },
        select: { CardNo: true, Punches: true },
      });

      for (const card of cards) {
        if (card.CardNo <= 0) continue;
        const parts = card.Punches.split(";").filter(Boolean);
        for (const part of parts) {
          const dashIdx = part.indexOf("-");
          if (dashIdx === -1) continue;
          const type = parseInt(part.substring(0, dashIdx), 10);
          if (isNaN(type) || type <= 10) continue;
          if (!passedByCode.has(type)) passedByCode.set(type, new Set());
          passedByCode.get(type)!.add(card.CardNo);
        }
      }

      const hasPunchData = passedByCode.size > 0;

      const cardToRunnerIds = new Map<number, number[]>();
      const runnersPerCourse = new Map<number, number>();
      const inForestRunnersPerCourse = new Map<number, number>();
      const relevantRunnerIds = new Set<number>();
      const okRunnersPerCourse = new Map<number, Set<number>>();

      for (const r of runners) {
        // Runner's direct course assignment (MeOS stores this if different from class)
        // If 0, it falls back to class course
        const courseId = (r.Course > 0) ? r.Course : classToCourse.get(r.Class);
        if (!courseId) continue;
        if (input?.courseId && courseId !== input.courseId) continue;

        runnersPerCourse.set(courseId, (runnersPerCourse.get(courseId) ?? 0) + 1);
        relevantRunnerIds.add(r.Id);

        const isFinished = r.Status > 0 || r.FinishTime > 0;
        if (!isFinished) {
          inForestRunnersPerCourse.set(courseId, (inForestRunnersPerCourse.get(courseId) ?? 0) + 1);
        }

        if (r.CardNo > 0) {
          if (!cardToRunnerIds.has(r.CardNo)) cardToRunnerIds.set(r.CardNo, []);
          cardToRunnerIds.get(r.CardNo)!.push(r.Id);
        }

        if (r.Status === 1) { // OK
          if (!okRunnersPerCourse.has(courseId)) okRunnersPerCourse.set(courseId, new Set());
          okRunnersPerCourse.get(courseId)!.add(r.Id);
        }
      }

      // 7. Build result: for each control, compute passed / total
      const result: {
        controlId: number;
        code: number;
        passed: number;
        total: number;
      }[] = [];

      for (const [code, controlId] of codeToControlId) {
        const courseIdsForThisControl = controlToCourses.get(controlId);

        // Collect all Runner IDs that passed this control
        const passedRunnerIds = new Set<number>();

        // From oPunch / oCard
        const punched = passedByCode.get(code);
        if (punched) {
          for (const cn of punched) {
            const rIds = cardToRunnerIds.get(cn);
            if (rIds) {
              for (const rid of rIds) {
                if (relevantRunnerIds.has(rid)) passedRunnerIds.add(rid);
              }
            }
          }
        }

        // Backfill OK runners (those who passed all controls on their course)
        if (courseIdsForThisControl) {
          for (const cid of courseIdsForThisControl) {
            const okIds = okRunnersPerCourse.get(cid);
            if (okIds) {
              for (const rid of okIds) passedRunnerIds.add(rid);
            }
          }
        }

        const passed = passedRunnerIds.size;
        let total = passed;

        // Total = those who passed + those still in forest who might still pass
        if (courseIdsForThisControl) {
          if (input?.courseId) {
            total += inForestRunnersPerCourse.get(input.courseId) ?? 0;
          } else {
            for (const cid of courseIdsForThisControl) {
              total += inForestRunnersPerCourse.get(cid) ?? 0;
            }
          }
        }

        result.push({ controlId, code, passed, total });
      }

      return result;
    }),

  /**
   * Get the GeoJSON routing geometry for a specific course.
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
      try {
        return JSON.parse(row[0].Geometry) as GeoJSONFeatureCollection;
      } catch {
        return null;
      }
    }),
});
