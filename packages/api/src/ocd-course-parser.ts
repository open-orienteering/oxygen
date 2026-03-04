/**
 * OCAD (.ocd) course and control data parser.
 *
 * Extracts courses, controls (with map positions), and per-course leg routing
 * geometry from the binary OCAD file format (versions 10–2024).
 *
 * Key symbols in OCAD course setting files:
 *   701000  Start triangle
 *   702000  Control circle
 *   703000  Control number (text label with control code + description)
 *   704000  Course-specific leg cut-out polygon
 *   704001  Per-control leg cut-out polygon
 *   705000  Pre-clipped leg line segment
 *   706000  Finish double circle
 *   707000  Marked route / restricted line
 *   709000  Restricted line
 *   711000  Forbidden route
 */

import type {
    ParsedControl,
    ParsedCourseControl,
    ParsedCourse,
    ParsedCourseData,
    ClassAssignment,
    SlitGap,
    GeoJSONFeature,
    GeoJSONFeatureCollection,
    GeoJSONPoint,
    GeoJSONLineString,
    GeoJSONMultiLineString,
    GeoJSONPolygon
} from "./iof-course-parser.js";

// ─── Internal types ──────────────────────────────────────────────────────────

interface LegOverride {
    course: string;
    from: string;
    to: string;
}

interface DoglegMarker {
    course: string;
    code: string;
}

/** A pre-clipped leg line segment from symbol 705000. */
interface LegSegment {
    courseId: string;
    from: string;
    to: string;
    coordinates: [number, number][];
}

/** IOF control description parsed from 702000 object text. */
interface ControlDescription {
    d?: string;  // Column D: control feature (e.g., "2.001" = Terrace)
    c?: string;  // Column C: which of similar features (e.g., "0.208" = Middle)
    g?: string;  // Column G: location of flag (e.g., "11.143" = NE side)
    s?: string;  // Column E/F: appearance/dimensions (e.g., "1,5" = 1.5m)
    f?: string;  // Column F: combination/second feature
}

const SYM_START = 701000;
const SYM_CONTROL = 702000;
const SYM_CONTROL_NUM = 703000;
const SYM_LEG_CUT = 704000;
const SYM_LEG_CUT_CTRL = 704001;
const SYM_LEG_CLIPPED = 705000;
const SYM_FINISH = 706000;
const SYM_DESC_BOX = 760000;

const OTYPE_POINT = 1;
const OTYPE_LINE = 2;
const OTYPE_AREA = 3;

const OBJ_HEADER_SIZE = 56;

export type ParsedOCDCourseData = ParsedCourseData;

// ─── Coordinate utilities ────────────────────────────────────────────────────

function ocadCoordToMm(raw: number): number {
    return (raw >> 8) / 100;
}

/**
 * Convert an OCAD angle (1/10 degree, CCW from East) to compass bearing
 * (degrees CW from North).
 */
function ocadAngleToCompass(tenthsDeg: number): number {
    return ((90 - tenthsDeg / 10) + 360) % 360;
}


// ─── Object index parsing ────────────────────────────────────────────────────

export interface OCDObjectEntry {
    filePos: number;
    len: number;
    sym: number;
    objType: number;
    llx: number;
    lly: number;
    urx: number;
    ury: number;
}

export function readObjectIndex(buf: Buffer, objIndexOffset: number, version: number): OCDObjectEntry[] {
    const ENTRY_SIZE = version > 10 ? 40 : 32;
    const entries: OCDObjectEntry[] = [];
    let blockOff = objIndexOffset;
    const visited = new Set<number>();

    while (blockOff > 0 && blockOff < buf.length && !visited.has(blockOff)) {
        visited.add(blockOff);
        const nextBlock = buf.readUInt32LE(blockOff);

        for (let i = 0; i < 256; i++) {
            const eOff = blockOff + 4 + i * ENTRY_SIZE;
            if (eOff + ENTRY_SIZE > buf.length) break;

            const filePos = buf.readUInt32LE(eOff + 16);
            const len = buf.readUInt32LE(eOff + 20);
            const sym = buf.readInt32LE(eOff + 24);
            const objType = buf.readUInt8(eOff + 28);

            if (filePos === 0 || len === 0 || sym === 0) continue;
            if (filePos >= buf.length) continue;

            entries.push({
                filePos, len, sym, objType,
                llx: buf.readInt32LE(eOff + 0),
                lly: buf.readInt32LE(eOff + 4),
                urx: buf.readInt32LE(eOff + 8),
                ury: buf.readInt32LE(eOff + 12),
            });
        }
        blockOff = nextBlock;
    }
    return entries;
}

function readNItems(buf: Buffer, objPos: number): number {
    if (objPos + 48 > buf.length) return 0;
    return buf.readUInt32LE(objPos + 44);
}

function readNText(buf: Buffer, objPos: number): number {
    if (objPos + 50 > buf.length) return 0;
    return buf.readUInt16LE(objPos + 48);
}

function readCoords(buf: Buffer, objPos: number, nItem: number): { xMm: number; yMm: number }[] {
    const result: { xMm: number; yMm: number }[] = [];
    const coordStart = objPos + OBJ_HEADER_SIZE;
    for (let i = 0; i < nItem; i++) {
        const off = coordStart + i * 8;
        if (off + 8 > buf.length) break;
        const rawX = buf.readInt32LE(off);
        const rawY = buf.readInt32LE(off + 4);
        if (rawX & 0x03) continue; // skip bezier control points
        result.push({ xMm: ocadCoordToMm(rawX), yMm: ocadCoordToMm(rawY) });
    }
    return result;
}

/** Read coords, splitting into segments at hole markers. */
function readCoordSegments(buf: Buffer, objPos: number, nItem: number): { xMm: number; yMm: number }[][] {
    const segments: { xMm: number; yMm: number }[][] = [];
    let current: { xMm: number; yMm: number }[] = [];
    const coordStart = objPos + OBJ_HEADER_SIZE;
    for (let i = 0; i < nItem; i++) {
        const off = coordStart + i * 8;
        if (off + 8 > buf.length) break;
        const rawX = buf.readInt32LE(off);
        const rawY = buf.readInt32LE(off + 4);
        if (rawX & 0x03) continue; // skip bezier control points
        if (rawY & 0x01) { // holeStart: end current segment, start new one
            if (current.length > 1) segments.push(current);
            current = [];
            continue;
        }
        current.push({ xMm: ocadCoordToMm(rawX), yMm: ocadCoordToMm(rawY) });
    }
    if (current.length > 1) segments.push(current);
    return segments;
}

function readObjectText(buf: Buffer, objPos: number, nItem: number, nText: number): string {
    const start = objPos + OBJ_HEADER_SIZE + nItem * 8;
    const maxLen = nText > 0 ? nText * 8 : 1024;
    const end = Math.min(start + maxLen, buf.length);
    let str = "";
    for (let off = start; off + 1 < end; off += 2) {
        const ch = buf.readUInt16LE(off);
        if (ch === 0) break;
        str += String.fromCharCode(ch);
    }
    return str;
}

// ─── Text record parsing ─────────────────────────────────────────────────────

interface TextRecords {
    courses: Map<string, { controls: string[]; startId: string; finishId: string; mapId: string; extraDistance: number; climb: number }>;
    classes: { className: string; courseName: string; runners: number }[];
    legOverrides: LegOverride[];
    doglegMarkers: DoglegMarker[];
}

function parseTextRecords(buf: Buffer, version: number): TextRecords {
    const courses = new Map<string, { controls: string[]; startId: string; finishId: string; mapId: string; extraDistance: number; climb: number }>();
    const classes: { className: string; courseName: string; runners: number }[] = [];
    const legOverrides: LegOverride[] = [];
    const doglegMarkers: DoglegMarker[] = [];

    const stringParamIndexOff = version > 10 ? buf.readUInt32LE(32) : buf.readUInt32LE(20);
    let blockOff = stringParamIndexOff;
    const seenBlocks = new Set<number>();
    while (blockOff > 0 && blockOff < buf.length && !seenBlocks.has(blockOff)) {
        seenBlocks.add(blockOff);
        const nextBlock = buf.readUInt32LE(blockOff);
        for (let i = 0; i < 256; i++) {
            const eOff = blockOff + 4 + i * 16;
            if (eOff + 16 > buf.length) break;
            const filePos = buf.readInt32LE(eOff);
            const len = buf.readInt32LE(eOff + 4);
            const strType = buf.readInt32LE(eOff + 8);
            if (filePos > 0 && filePos < buf.length && len > 0) {
                const txt = buf.slice(filePos, filePos + len).toString('utf8').replace(/\0+$/, '');
                parseRecord(txt, courses, classes, legOverrides, doglegMarkers, strType);
            }
        }
        blockOff = nextBlock;
    }
    return { courses, classes, legOverrides, doglegMarkers };
}

function parseRecord(txt: string, courses: Map<string, any>, classes: any[], legOverrides: any[], doglegMarkers: any[], strType?: number): void {
    const parts = txt.split("\t");
    if (parts.length < 2) return;
    const head = parts[0].trim();

    const hasS = parts.some(p => p.startsWith("s") && p.length > 1);
    const hasF = parts.some(p => p.startsWith("f") && p.length > 1);

    if (head.length > 0 && !head.startsWith("<") && hasS && hasF) {
        const controls = []; let startId = "", finishId = "", mapId = "", extraDistance = 0, climb = 0;
        for (const p of parts.slice(1)) {
            if (p.startsWith("s")) startId = p.slice(1);
            else if (p.startsWith("f")) finishId = p.slice(1);
            else if (p.startsWith("c")) controls.push(p.slice(1));
            else if (p.startsWith("m")) mapId = p.slice(1);
            else if (p.startsWith("E")) extraDistance = parseFloat(p.slice(1)) || 0;
            else if (p.startsWith("C")) climb = parseFloat(p.slice(1)) || 0;
        }
        courses.set(head, { controls, startId, finishId, mapId, extraDistance, climb });
    } else if (strType === 3 || (strType === undefined && parts.some(p => p.startsWith("c") || p.startsWith("r")))) {
        let courseName = ""; let runners = 0;
        for (const p of parts.slice(1)) {
            if (p.startsWith("c")) courseName = p.slice(1);
            else if (p.startsWith("r")) runners = parseInt(p.slice(1), 10) || 0;
        }
        if (courseName && head) classes.push({ className: head, courseName, runners });
    } else if (head === "<All>" || /^[A-Z0-9]{1,10}$/.test(head)) {
        const paramMap: Record<string, string> = {};
        for (const p of parts.slice(1)) if (p.length >= 2) paramMap[p[0]] = p.slice(1);
        if ("d" in paramMap) doglegMarkers.push({ course: head, code: paramMap["d"] });
        if ("f" in paramMap && "t" in paramMap) legOverrides.push({ course: head, from: paramMap["f"], to: paramMap["t"] });
    }
}

// ─── Main parser ─────────────────────────────────────────────────────────────

export function parseOCDCourseData(fileData: Buffer): ParsedOCDCourseData {
    if (fileData.length < 16) throw new Error("File too small");
    const version = fileData.readUInt16LE(4);
    const objIndexOffset = fileData.readUInt32LE(12);
    const textRecs = parseTextRecords(fileData, version);
    const objEntries = objIndexOffset > 0 ? readObjectIndex(fileData, objIndexOffset, version) : [];

    const controlLabels: { code: string; xMm: number; yMm: number; sym: number }[] = [];
    // Unnamed 702000 circle positions (when no text/code is available).
    const unnamedCircles: { xMm: number; yMm: number }[] = [];
    const mapFeatures: GeoJSONFeature[] = [];
    const controlObjs = new Map<string, { xMm: number; yMm: number }>();

    // Marked route features (707000) keyed by T-code (start/finish map group).
    const markedRoutesByMap = new Map<string, GeoJSONFeature[]>();

    // Slit gaps extracted from 703000 objects' extra coordinate pairs.
    // Key: control code, Value: array of slit gaps read from the file.
    const controlSlits = new Map<string, SlitGap[]>();

    // Pre-clipped leg segments from symbol 705000, grouped by course ID
    const legSegments: LegSegment[] = [];

    // IOF control descriptions parsed from 702000 text (keyed by control code)
    const controlDescriptions = new Map<string, ControlDescription>();

    // Description sheet box positions from 760000 objects
    const descriptionBoxes: [number, number][][] = [];

    for (const entry of objEntries) {
        const pos = entry.filePos;
        if (pos + OBJ_HEADER_SIZE > fileData.length) continue;
        const ni = readNItems(fileData, pos);
        const nt = readNText(fileData, pos);

        if (entry.sym < 700000 || entry.sym >= 800000) continue;

        const txt = readObjectText(fileData, pos, ni, nt);

        if (entry.sym === SYM_START || entry.sym === SYM_CONTROL || entry.sym === SYM_CONTROL_NUM || entry.sym === SYM_FINISH) {
            const rawX = fileData.readInt32LE(pos + 56);
            const rawY = fileData.readInt32LE(pos + 60);
            const point = { xMm: ocadCoordToMm(rawX), yMm: ocadCoordToMm(rawY) };

            let resolvedCode: string | null = null;
            let hasControlCodeText = false;
            const m = txt.match(/(?:^|\t)a([A-Za-z0-9_\-\.]{1,15})/);
            if (m) { resolvedCode = m[1]; hasControlCodeText = true; }
            if (!resolvedCode) {
                const oMatch = txt.match(/(?:^|\t)o([A-Za-z0-9_\-\.]{1,15})/);
                if (oMatch) resolvedCode = oMatch[1];
            }
            if (!resolvedCode) {
                const parts = txt.split(/\s+/);
                for (const p of parts) {
                    if (p && !p.includes("Y") && !p.includes(".") && p.length >= 1 && p.length <= 10 && /^[A-Z0-9]+$/.test(p)) {
                        resolvedCode = p;
                        break;
                    }
                }
            }

            if (resolvedCode) {
                controlLabels.push({ code: resolvedCode, ...point, sym: entry.sym });

                // Objects with a<code> text (control descriptions) store circle
                // slit data in extra coordinate pairs. Each pair's raw X/Y are
                // start/end angles in OCAD convention (1/10 deg, CCW from East).
                // This applies to both 702000 and 703000 objects depending on the
                // OCAD version. Objects without a<code> (display-number-only
                // 703000 labels) use extra coords for text bounding boxes instead.
                if (hasControlCodeText && ni > 1) {
                    const slits: SlitGap[] = [];
                    for (let ci = 1; ci < ni; ci++) {
                        const off = pos + 56 + ci * 8;
                        if (off + 8 > fileData.length) break;
                        const rawSX = fileData.readInt32LE(off);
                        const rawSY = fileData.readInt32LE(off + 4);
                        slits.push({
                            start: ocadAngleToCompass(rawSY),
                            end: ocadAngleToCompass(rawSX),
                        });
                    }
                    if (slits.length > 0) {
                        controlSlits.set(resolvedCode, slits);
                    }
                }

                if (hasControlCodeText && !controlDescriptions.has(resolvedCode)) {
                    const desc: ControlDescription = {};
                    for (const part of txt.split("\t")) {
                        if (part.startsWith("d")) desc.d = part.slice(1);
                        else if (part.startsWith("g")) desc.g = part.slice(1);
                        else if (part.startsWith("c") && part.includes(".")) desc.c = part.slice(1);
                        else if (part.startsWith("s") && /^s\d/.test(part)) desc.s = part.slice(1);
                        else if (part.startsWith("f") && part.includes(".")) desc.f = part.slice(1);
                    }
                    if (desc.d) controlDescriptions.set(resolvedCode, desc);
                }
            } else if (entry.sym === SYM_CONTROL) {
                unnamedCircles.push(point);
            }

        } else if (entry.sym === SYM_LEG_CLIPPED) {
            // Pre-clipped leg line segments: text format is "<courseId>\tf<from>\tt<to>"
            const coords = readCoords(fileData, pos, ni);
            if (coords.length >= 2) {
                const tabParts = txt.split("\t");
                const courseId = tabParts[0] || "";
                let from = "", to = "";
                for (const p of tabParts.slice(1)) {
                    if (p.startsWith("f")) from = p.slice(1);
                    else if (p.startsWith("t")) to = p.slice(1);
                }
                if (courseId && from && to) {
                    legSegments.push({
                        courseId,
                        from,
                        to,
                        coordinates: coords.map(c => [c.xMm, c.yMm] as [number, number]),
                    });
                }
            }

        } else if (entry.sym === SYM_LEG_CUT || entry.sym === SYM_LEG_CUT_CTRL) {
            const coords = readCoords(fileData, pos, ni);

            // In OCAD 2018+, 704000 2-point line objects with "f<from>\tt<to>"
            // text are pre-clipped leg segments (same role as 705000).
            if (entry.objType === OTYPE_LINE && coords.length === 2) {
                const tabParts = txt.split("\t");
                let courseId = "", from = "", to = "";
                courseId = tabParts[0] || "";
                for (const p of tabParts.slice(1)) {
                    if (p.startsWith("f")) from = p.slice(1);
                    else if (p.startsWith("t")) to = p.slice(1);
                }
                if (courseId && from && to) {
                    legSegments.push({
                        courseId,
                        from,
                        to,
                        coordinates: coords.map(c => [c.xMm, c.yMm] as [number, number]),
                    });
                }
            } else {
                const poly = coords.map(c => [c.xMm, c.yMm] as [number, number]);
                if (poly.length > 2) {
                    if (poly[0][0] !== poly[poly.length - 1][0] || poly[0][1] !== poly[poly.length - 1][1]) {
                        poly.push([...poly[0]]);
                    }
                    const tabParts = txt.split(/\t/);
                    const cls = tabParts[0].split(/[, ]+/).filter(c => c.length > 0);
                    mapFeatures.push({
                        type: "Feature",
                        geometry: { type: "Polygon", coordinates: [poly] },
                        properties: {
                            symbolType: "leg_cut",
                            sym: entry.sym,
                            classes: cls.length > 0 ? cls : ["<All>"],
                        }
                    });
                }
            }

        } else if (entry.sym === 707000) {
            // Marked route: belongs to a specific start/finish map (T-code).
            // Split at hole markers so gaps (e.g., at the start banner T-bar) render correctly.
            if (entry.objType === OTYPE_LINE) {
                const segments = readCoordSegments(fileData, pos, ni);
                const tabParts = txt.split("\t");
                const tCode = tabParts[0].replace(/^\d+/, "");
                if (!markedRoutesByMap.has(tCode)) markedRoutesByMap.set(tCode, []);
                for (const seg of segments) {
                    markedRoutesByMap.get(tCode)!.push({
                        type: "Feature",
                        geometry: { type: "LineString", coordinates: seg.map(c => [c.xMm, c.yMm]) },
                        properties: { symbolType: "marked_route", sym: entry.sym }
                    });
                }
            }

        } else if (entry.sym === 709000 || entry.sym === 711000) {
            const coords = readCoords(fileData, pos, ni);
            if (coords.length > 1) {
                if (entry.objType === OTYPE_LINE) {
                    mapFeatures.push({
                        type: "Feature",
                        geometry: { type: "LineString", coordinates: coords.map(c => [c.xMm, c.yMm]) },
                        properties: { symbolType: entry.sym === 711000 ? "forbidden_route" : "restricted_line", sym: entry.sym }
                    });
                } else if (entry.objType === 3) {
                    const poly = coords.map(c => [c.xMm, c.yMm] as [number, number]);
                    if (poly.length > 2) {
                        if (poly[0][0] !== poly[poly.length - 1][0] || poly[0][1] !== poly[poly.length - 1][1]) {
                            poly.push([...poly[0]]);
                        }
                        mapFeatures.push({
                            type: "Feature",
                            geometry: { type: "Polygon", coordinates: [poly] },
                            properties: { symbolType: "restricted_area", sym: entry.sym }
                        });
                    }
                }
            }

        } else if (entry.sym === SYM_DESC_BOX && entry.objType === OTYPE_AREA) {
            const coords = readCoords(fileData, pos, ni);
            if (coords.length >= 3) {
                const poly = coords.map(c => [c.xMm, c.yMm] as [number, number]);
                if (poly[0][0] !== poly[poly.length - 1][0] || poly[0][1] !== poly[poly.length - 1][1]) {
                    poly.push([...poly[0]]);
                }
                descriptionBoxes.push(poly);
            }
        }
    }

    // Build control position lookup.
    // 1. Register Start/Finish symbols directly from their point objects
    //    (701000 / 706000) so they get the actual symbol position.
    // 2. For 703000 number labels, match ONLY against 702000 control circles
    //    to avoid pulling regular controls to the Start/Finish position.
    const startFinishSyms = controlLabels.filter(l => l.sym === SYM_START || l.sym === SYM_FINISH);
    const circleSyms = controlLabels.filter(l => l.sym === SYM_CONTROL);
    const numberLabels = controlLabels.filter(l => l.sym === SYM_CONTROL_NUM);

    for (const sf of startFinishSyms) {
        if (!controlObjs.has(sf.code)) {
            controlObjs.set(sf.code, { xMm: sf.xMm, yMm: sf.yMm });
        }
    }

    for (const cs of circleSyms) {
        if (!controlObjs.has(cs.code)) {
            controlObjs.set(cs.code, { xMm: cs.xMm, yMm: cs.yMm });
        }
    }

    for (const nl of numberLabels) {
        if (controlObjs.has(nl.code)) continue;
        let bestDist = Infinity;
        let bestPt: { xMm: number; yMm: number } | null = null;
        for (const ps of circleSyms) {
            const d = Math.sqrt((ps.xMm - nl.xMm) ** 2 + (ps.yMm - nl.yMm) ** 2);
            if (d < bestDist) { bestDist = d; bestPt = ps; }
        }
        if (bestPt && bestDist < 20) {
            controlObjs.set(nl.code, { xMm: bestPt.xMm, yMm: bestPt.yMm });
        } else {
            controlObjs.set(nl.code, { xMm: nl.xMm, yMm: nl.yMm });
        }
    }

    let mapScale = 7500;
    const sMatch = fileData.toString("utf8", 0, 50000).match(/\bm(\d+)\b/);
    if (sMatch) { const s = parseInt(sMatch[1], 10); if (s >= 1000) mapScale = s; }

    // ─── Build per-course leg segment lookup ─────────────────────────────────
    // Key: "<courseId>:<from>-><to>", Value: array of coordinate arrays
    const legSegmentsByCourse = new Map<string, Map<string, [number, number][][]>>();
    const allCoursesLegs = new Map<string, [number, number][][]>();

    for (const seg of legSegments) {
        const legKey = `${seg.from}->${seg.to}`;
        if (seg.courseId === "<AllCourses>") {
            if (!allCoursesLegs.has(legKey)) allCoursesLegs.set(legKey, []);
            allCoursesLegs.get(legKey)!.push(seg.coordinates);
        } else {
            if (!legSegmentsByCourse.has(seg.courseId)) legSegmentsByCourse.set(seg.courseId, new Map());
            const courseLegs = legSegmentsByCourse.get(seg.courseId)!;
            if (!courseLegs.has(legKey)) courseLegs.set(legKey, []);
            courseLegs.get(legKey)!.push(seg.coordinates);
        }
    }

    const hasPreclippedLegs = legSegments.length > 0;

    // ─── Build courses and geometry ──────────────────────────────────────────

    const allCodes = new Set<string>();
    for (const [, c] of textRecs.courses) {
        if (c.startId) allCodes.add(c.startId);
        if (c.finishId) allCodes.add(c.finishId);
        for (const code of c.controls) allCodes.add(code);
    }

    // Fallback: if regular control codes are unresolved (703000 text has only
    // display numbers, not control codes), map them via 702000 circle positions.
    // We pair each course's Nth control code with the 703000 display-number-N
    // label, then snap to the nearest 702000 circle.
    const unresolvedCodes = [...allCodes].filter(c =>
        !controlObjs.has(c) && !c.startsWith("S") && !c.startsWith("M") && !c.startsWith("F") && c !== "Start" && c !== "Finish"
    );
    if (unresolvedCodes.length > 0) {
        const namedCircles = controlLabels.filter(l => l.sym === SYM_CONTROL);
        const allCirclePositions = [
            ...namedCircles.map(c => ({ xMm: c.xMm, yMm: c.yMm })),
            ...unnamedCircles,
        ];
        const displayLabels = controlLabels.filter(l => l.sym === SYM_CONTROL_NUM);

        // Track which circle positions are claimed by which code so that
        // different control codes never share the same 702000 circle.
        const positionOwner = new Map<string, string>();
        const posKey = (p: { xMm: number; yMm: number }) =>
            `${Math.round(p.xMm * 10)},${Math.round(p.yMm * 10)}`;

        for (const [, cDef] of textRecs.courses) {
            for (let ci = 0; ci < cDef.controls.length; ci++) {
                const code = cDef.controls[ci];
                if (controlObjs.has(code)) continue;
                const displayNum = String(ci + 1);
                const matchingLabels = displayLabels.filter(l => l.code === displayNum);
                for (const label of matchingLabels) {
                    let bestCircle: { xMm: number; yMm: number } | null = null;
                    let bestDist = Infinity;
                    for (const cp of allCirclePositions) {
                        const key = posKey(cp);
                        const owner = positionOwner.get(key);
                        if (owner && owner !== code) continue;
                        const d = Math.sqrt((cp.xMm - label.xMm) ** 2 + (cp.yMm - label.yMm) ** 2);
                        if (d < bestDist) { bestDist = d; bestCircle = cp; }
                    }
                    if (bestCircle && bestDist < 20) {
                        controlObjs.set(code, { xMm: bestCircle.xMm, yMm: bestCircle.yMm });
                        positionOwner.set(posKey(bestCircle), code);
                        break;
                    }
                }
                if (!controlObjs.has(code)) {
                    const label = matchingLabels[0];
                    if (label) controlObjs.set(code, { xMm: label.xMm, yMm: label.yMm });
                }
            }
        }
    }

    const controls: ParsedControl[] = [];
    for (const code of allCodes) {
        const p = controlObjs.get(code);
        const type = (code.startsWith("S") || code === "Start") ? "Start"
            : (code.startsWith("M") || code === "Finish" || code.startsWith("F")) ? "Finish"
            : "Control";
        controls.push({
            id: code,
            type,
            lat: 0, lng: 0,
            mapX: p?.xMm ?? 0, mapY: p?.yMm ?? 0,
        });
    }

    const courseGeometry: Record<string, GeoJSONFeatureCollection> = {};
    const doglegSet = new Set<string>();
    for (const dl of textRecs.doglegMarkers) doglegSet.add(`${dl.course}:${dl.code}`);

    const courses: ParsedCourse[] = [];
    for (const [courseName, cDef] of textRecs.courses) {
        const features: GeoJSONFeature[] = [];
        const cCtrls: ParsedCourseControl[] = [];
        let totalDistMm = 0;
        const all = [cDef.startId || "STA1", ...cDef.controls, cDef.finishId || "FIN1"];

        const courseSpecificLegs = legSegmentsByCourse.get(courseName);

        for (let i = 0; i < all.length; i++) {
            const code = all[i];
            const ctrlPos = controlObjs.get(code);
            if (!ctrlPos) continue;
            let type: "Start" | "Finish" | "Control" = "Control";
            if (i === 0) type = "Start";
            else if (i === all.length - 1) type = "Finish";

            // Use slit data read from the 703000 object. The file stores the
            // exact slit angles placed by the course setter to reveal map detail.
            // Controls without file-based slit data render as full circles.
            const slits: SlitGap[] = controlSlits.get(code) ?? [];

            const desc = controlDescriptions.get(code);
            features.push({
                type: "Feature",
                geometry: { type: "Point", coordinates: [ctrlPos.xMm, ctrlPos.yMm] },
                properties: {
                    symbolType: type.toLowerCase(),
                    code, id: code,
                    cuts: slits.length > 0 ? slits : undefined,
                    isDogleg: type === "Control" && (doglegSet.has(`${courseName}:${code}`) || doglegSet.has(`<All>:${code}`)),
                    ...(desc ? { description: desc } : {}),
                }
            });

            // Leg line
            if (i < all.length - 1) {
                const nextCode = all[i + 1];
                const nextPos = controlObjs.get(nextCode);
                if (nextPos) {
                    const d = Math.sqrt((nextPos.xMm - ctrlPos.xMm) ** 2 + (nextPos.yMm - ctrlPos.yMm) ** 2);
                    totalDistMm += d;
                    cCtrls.push({ controlId: code, type, legLength: Math.round(d * mapScale / 1000) });

                    const legKey = `${code}->${nextCode}`;

                    // Prefer pre-clipped segments from 705000
                    const courseSegs = courseSpecificLegs?.get(legKey);
                    const allSegs = allCoursesLegs.get(legKey);
                    const segments = courseSegs || allSegs;

                    if (segments && segments.length > 0) {
                        for (const segCoords of segments) {
                            features.push({
                                type: "Feature",
                                geometry: { type: "LineString", coordinates: segCoords },
                                properties: { symbolType: "leg", from: code, to: nextCode, preclipped: true }
                            });
                        }
                    } else {
                        // Fallback: straight center-to-center line
                        features.push({
                            type: "Feature",
                            geometry: { type: "LineString", coordinates: [[ctrlPos.xMm, ctrlPos.yMm], [nextPos.xMm, nextPos.yMm]] },
                            properties: { symbolType: "leg", from: code, to: nextCode }
                        });
                    }
                }
            } else {
                cCtrls.push({ controlId: code, type, legLength: 0 });
            }
        }

        // Add map features (restricted areas/lines, leg cuts for fallback masking)
        const appMapFeatures = mapFeatures.filter(f => {
            if (f.properties?.symbolType === "leg_cut") {
                if (hasPreclippedLegs) return false; // not needed when legs are pre-clipped
                const cls = f.properties.classes as string[];
                return cls.includes("<All>") || cls.includes(courseName)
                    || textRecs.classes.some(ca => ca.courseName === courseName && cls.includes(ca.className));
            }
            return true;
        });
        features.push(...appMapFeatures);

        // Add marked route features matching this course's start/finish map
        if (cDef.mapId) {
            const routes = markedRoutesByMap.get(cDef.mapId);
            if (routes) features.push(...routes);
        }

        // Add description sheet boxes from 760000 objects
        for (const box of descriptionBoxes) {
            features.push({
                type: "Feature",
                geometry: { type: "Polygon", coordinates: [box] },
                properties: { symbolType: "description_box" }
            });
        }

        courseGeometry[courseName] = { type: "FeatureCollection", features };
        courses.push({
            name: courseName,
            length: Math.round(totalDistMm * mapScale / 10000) * 10 + cDef.extraDistance,
            climb: cDef.climb,
            controls: cCtrls,
        });
    }

    return {
        controls,
        courses,
        classAssignments: textRecs.classes.map(c => ({ className: c.className, courseName: c.courseName })),
        mapScale,
        courseGeometry,
        mapFeatures,
        geometrySource: "ocd",
    };
}
