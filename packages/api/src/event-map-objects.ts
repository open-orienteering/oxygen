/**
 * The pinned map document's terrain objects, cut features and check
 * obstacles (docs/map-storage.md §4.6), read from the effective document:
 * the pin with the event's patch applied (docs/map-patches.md §2.4; G14),
 * so a hidden object is no candidate, cut feature or obstacle and an added
 * one is.
 *
 * The description autodetect needs to ask "what map features are within a
 * few millimetres of this point?". This module slims the document's
 * objects for that search, memoised per document hash and patch version
 * (both change on every edit, so never stale).
 *
 * Only objects whose symbol has an entry in `ISOM_DESCRIPTION_MAP` are
 * kept, which drops contours, course overprint and text objects — the
 * bulk of a club map — so the retained set stays small. The symbol code is
 * the applied match's canonical code, else the source code, and hidden
 * symbols and objects the patch hides are skipped: the rule the cut
 * features and check obstacles
 * follow (docs/course-layer.md §3.4, §9.3).
 *
 * Coordinates are OCAD-style 1/100 mm paper units whatever the document's
 * native unit, and `sym` an OCAD-style symbol number (`204.1` → 204001),
 * so `description-autodetect.ts` reads the same shape it always has.
 * Bezier segments are flattened into short polyline runs: junction /
 * crossing / corner detection compares geometry at a few tenths of a
 * millimetre, and a curved path whose control handles sit a millimetre
 * off the drawn line would otherwise never register as meeting the path
 * it ends on.
 */

import { course, isomDescriptionFor, mapDocument, render } from "@oxygen/shared";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { LruCache } from "./course-maps/lru-cache.js";
import { decodedDocument, eventDocumentHash } from "./map-store/event-document.js";
import { eventPatchOnPin, eventPatchVersion } from "./map-store/patches.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** Point (1), line (2) or area (3) object. Text/rect types are dropped. */
export type SlimObjectType = 1 | 2 | 3;

export interface SlimMapObject {
  /** OCAD-style symbol number, e.g. 204000 for ISOM 204 (boulder). */
  sym: number;
  objType: SlimObjectType;
  /** 1/100 mm paper coordinates. Areas keep their outer ring only. */
  coordinates: Array<[number, number]>;
  /** [minX, minY, maxX, maxY] in the same units. */
  bbox: [number, number, number, number];
}

/** Units of `SlimMapObject` coordinates per paper mm. */
const SLIM_UNITS_PER_MM = 100;

/** Straight segments per cubic Bezier when flattening. */
const BEZIER_STEPS = 8;

/**
 * Derivations kept per document. An entry is a few MB for a real club
 * map and editing happens in one event at a time, so a tiny bound is
 * plenty.
 */
const MAX_CACHED_DOCUMENTS = 3;

/** `"204.1"` → 204001, `"204"` → 204000; null for codes that are not numeric (`graphic`). */
export function ocadSymbolNumber(code: string): number | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(code);
  if (!m) return null;
  return Number(m[1]) * 1000 + (m[2] ? Number(m[2]) : 0);
}

/** The code a symbol is drawn as: the applied match's canonical code, else the source code. */
function effectiveCode(symbol: mapDocument.DocumentSymbol): string {
  const match = symbol.match;
  if (mapDocument.isAppliedMatch(match)) return match.canonicalId.slice(match.canonicalId.indexOf(":") + 1);
  return symbol.code;
}

/**
 * Flatten object `i`'s coordinates. A cubic segment is stored as
 * `P0, C1 (bezierFirst), C2 (bezierSecond), P3`; everything else is a
 * plain vertex. Stops at the first hole point of an area.
 */
function flattenObject(doc: mapDocument.MapDocument, i: number, objType: SlimObjectType, scale: number): Array<[number, number]> {
  const { coords, flags, coordStart } = doc;
  const end = coordStart[i + 1];
  const out: Array<[number, number]> = [];
  const point = (j: number): [number, number] => [coords[j * 2] * scale, coords[j * 2 + 1] * scale];
  let j = coordStart[i];
  while (j < end) {
    // Areas may carry holes after the outer ring; the search only needs
    // the outline, and ignoring holes at most makes a control inside a
    // hole look "on" the feature — acceptable for a suggestion.
    if (out.length > 0 && objType === 3 && flags[j] & render.COORD_FLAG.hole) break;

    if (
      out.length > 0 &&
      flags[j] & render.COORD_FLAG.bezierFirst &&
      j + 2 < end &&
      flags[j + 1] & render.COORD_FLAG.bezierSecond
    ) {
      const p0 = out[out.length - 1];
      const c1 = point(j);
      const c2 = point(j + 1);
      const p3 = point(j + 2);
      for (let s = 1; s <= BEZIER_STEPS; s++) {
        const t = s / BEZIER_STEPS;
        const mt = 1 - t;
        const a = mt * mt * mt;
        const b = 3 * mt * mt * t;
        const cc = 3 * mt * t * t;
        const d = t * t * t;
        out.push([
          a * p0[0] + b * c1[0] + cc * c2[0] + d * p3[0],
          a * p0[1] + b * c1[1] + cc * c2[1] + d * p3[1],
        ]);
      }
      j += 3;
      continue;
    }

    out.push(point(j));
    j++;
  }
  return out;
}

/** The searchable point / line / area objects of a decoded (effective) document. */
export function slimObjectsOfDocument(doc: mapDocument.EffectiveDocument): SlimMapObject[] {
  const syms = doc.header.symbols.map((s): number | null => {
    if (s.hidden) return null;
    const sym = ocadSymbolNumber(effectiveCode(s));
    return sym !== null && isomDescriptionFor(sym) ? sym : null;
  });
  const scale = SLIM_UNITS_PER_MM / doc.header.unitsPerMm;
  const out: SlimMapObject[] = [];
  for (let i = 0; i < doc.attrs.symbolIdx.length; i++) {
    const objType = doc.attrs.type[i];
    if ((objType !== 1 && objType !== 2 && objType !== 3) || doc.hidden?.[i]) continue;
    const sym = syms[doc.attrs.symbolIdx[i]];
    if (sym === null || sym === undefined) continue;
    const coordinates = flattenObject(doc, i, objType, scale);
    if (coordinates.length === 0) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of coordinates) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    out.push({ sym, objType, coordinates, bbox: [minX, minY, maxX, maxY] });
  }
  return out;
}

/** The memo key: the hash alone without a delivered patch, else hash and patch version. */
const derivationKey = (hash: string, version: string) => (version === "0" ? hash : `${hash}:${version}`);

/**
 * Memoise one derivation of the effective document (the pin with the
 * event's patch, docs/map-patches.md §2.4) per hash + patch version. A
 * hit costs the pin and the version column; a miss reads the patch and
 * applies it to the decoded pin (`applyPatch` is linear; a disabled or
 * op-less patch returns the pin itself).
 */
function perDocument<T>(derive: (doc: mapDocument.EffectiveDocument) => T, what: string) {
  const memo = new LruCache<T>(MAX_CACHED_DOCUMENTS);
  return async (db: Db, eventId: bigint): Promise<T | null> => {
    const hash = await eventDocumentHash(db, eventId);
    if (!hash) return null;
    const lookedUp = derivationKey(hash, await eventPatchVersion(db, eventId, hash));
    const cached = memo.get(lookedUp);
    if (cached !== undefined) return cached;
    const [doc, delivered] = await Promise.all([decodedDocument(db, hash), eventPatchOnPin(db, eventId, hash)]);
    if (!doc) return null;
    try {
      const { document, issues } = mapDocument.applyPatch(doc, delivered.patch);
      if (issues.length) console.warn(`[event-map-objects] document ${hash}: ${issues.length} patch op(s) skipped:`, issues.map((x) => `${x.opId}: ${x.code}`).join(", "));
      const value = derive(document);
      // Under the version actually read: a write between the two reads is answered at the next call.
      memo.set(derivationKey(hash, delivered.version), value);
      // A row keyed to the pin that does not parse is delivered as no patch (version "0") while its version
      // column is not 0: remember the unpatched answer under the key looked up too, or it never hits.
      if (!delivered.patch) memo.set(lookedUp, value);
      return value;
    } catch (err) {
      console.warn(`[event-map-objects] document ${hash}: no ${what}:`, err);
      return null;
    }
  };
}

/**
 * Searchable terrain objects of the event's pinned map document, or null
 * when the event has no pin (no map, or the import has not finished) or
 * the document is unreadable.
 */
export const loadEventMapObjects = perDocument(slimObjectsOfDocument, "objects");

/**
 * The features the course overprint is cut around (docs/course-layer.md
 * §3.4, §4.2): the pinned document's, for every event with a pin. Null
 * without one — the course then has no automatic cuts.
 */
export const loadEventCutFeatures = perDocument(course.cutFeaturesOfDocument, "cut features");

/**
 * The pinned document's library and leg obstacles for `course.checks`
 * (docs/course-layer.md §9); null without a pin or when the document is
 * unreadable.
 */
export const loadEventCheckDocument = perDocument(course.checkObstaclesOfDocument, "check obstacles");
