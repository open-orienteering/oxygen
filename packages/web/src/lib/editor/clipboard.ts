/**
 * The editor's app clipboard (J12; docs/course-editor.md §7 "Duplicate,
 * copy, cut, paste", docs/course-layout.md §2 "Keys"): one object, a course
 * object in Course mode or a page object in Layout mode, held in memory and
 * in `localStorage` so it crosses sheets, templates, events and tabs. Not
 * the system clipboard. Pure apart from the storage it is handed.
 */

import { course, courseMapObjectSchema, type CourseMapObject } from "@oxygen/shared";
import { centrePatch, objectCentre } from "./attach";

type Pt = { x: number; y: number };
type CourseObject = course.CourseObject;

export const CLIPBOARD_KEY = "oxygen.editor.clipboard";

/** A course object as copied: the shown object's body, its scope and the courses that scope resolved to. */
export interface CourseEntry {
  v: 1;
  type: "course";
  /** The event it was copied in (its name id): another event's scope ids mean nothing here. */
  event: string;
  object: Pick<CourseObject, "kind" | "geometry" | "props" | "scope" | "inCourses"> & { attach?: CourseObject["attach"] };
}

/** A page object as copied (Layout mode). */
export interface PageEntry {
  v: 1;
  type: "page";
  event: string;
  object: CourseMapObject;
}

export type ClipboardEntry = CourseEntry | PageEntry;

/** Where the entry lives: `localStorage` when it can be used, else memory only. */
export interface ClipboardStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

let memory: ClipboardEntry | null = null;
/** The last write did not reach storage (full or blocked): the memory copy wins until one does (storage may hold an older entry). */
let unsaved = false;

function storage(): ClipboardStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Put `entry` on the clipboard (memory always; storage when it works). */
export function writeClipboard(entry: ClipboardEntry, store: ClipboardStore | null = storage()): void {
  memory = entry;
  try {
    store?.setItem(CLIPBOARD_KEY, JSON.stringify(entry));
    unsaved = false;
  } catch {
    // A full or blocked storage keeps the memory copy: this tab still pastes it, not the older stored entry.
    unsaved = true;
  }
}

/** The clipboard's entry, read at paste time so another tab's copy counts; an unreadable one is empty. */
export function readClipboard(store: ClipboardStore | null = storage()): ClipboardEntry | null {
  if (unsaved) return memory;
  let raw: string | null = null;
  try {
    raw = store?.getItem(CLIPBOARD_KEY) ?? null;
  } catch {
    raw = null;
  }
  if (raw === null) return memory;
  try {
    return entryOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A stored entry checked as far as a paste reads it; anything else (another version, a hand-edited one) is empty. */
function entryOf(parsed: unknown): ClipboardEntry | null {
  if (!isObj(parsed) || parsed.v !== 1 || typeof parsed.event !== "string" || !isObj(parsed.object)) return null;
  if (parsed.type === "page") {
    const r = courseMapObjectSchema.safeParse(parsed.object);
    return r.success ? { v: 1, type: "page", event: parsed.event, object: r.data } : null;
  }
  if (parsed.type !== "course") return null;
  const o = parsed.object;
  const pts = Array.isArray(o.geometry) && o.geometry.length > 0 && o.geometry.every((p) => isObj(p) && Number.isFinite(p.x) && Number.isFinite(p.y));
  const scope = isObj(o.scope) && (o.scope.all === true || (Array.isArray(o.scope.courses) && Array.isArray(o.scope.classes)));
  const attach = o.attach === undefined || (isObj(o.attach) && typeof o.attach.controlId === "number" && isObj(o.attach.at) && Number.isFinite(o.attach.at.x) && Number.isFinite(o.attach.at.y));
  if (typeof o.kind !== "string" || !pts || !isObj(o.props) || !scope || !attach || (o.inCourses !== null && !Array.isArray(o.inCourses))) return null;
  return parsed as unknown as CourseEntry;
}

/** Forget the memory copy (tests). */
export function clearClipboardMemory(): void {
  memory = null;
  unsaved = false;
}

/** The entry for a shown course object. */
export function courseEntry(shown: CourseObject, event: string): CourseEntry {
  return {
    v: 1, type: "course", event,
    object: { kind: shown.kind, geometry: shown.geometry, props: shown.props, scope: shown.scope, inCourses: shown.inCourses, ...(shown.attach ? { attach: shown.attach } : {}) },
  };
}

/** What a course paste creates (before its scope). */
export interface CourseBody { kind: CourseObject["kind"]; geometry: CourseObject["geometry"]; props: CourseObject["props"]; attach?: CourseObject["attach"] }

/** The duplicate's step: 3 mm down-right on paper (y-up), at the map's scale. */
export const DUPLICATE_MM = 3;

/** `Ctrl+D`: 3 mm down-right of the shown object; an attached one stays attached to the same control (its `at` kept). */
export function duplicateBody(shown: Pick<CourseObject, "kind" | "geometry" | "props" | "attach">): CourseBody {
  return {
    kind: shown.kind, props: shown.props,
    geometry: course.translateGeometry(shown.geometry, DUPLICATE_MM, -DUPLICATE_MM),
    ...(shown.attach ? { attach: shown.attach } : {}),
  };
}

/** A paste at a point: the object's centre (`objectCentre`) on `pt`, free (a pointer paste never attaches). */
export function pasteAt(o: CourseEntry["object"], pt: Pt): CourseBody {
  const c = objectCentre(o);
  return { kind: o.kind, props: o.props, geometry: course.translateGeometry(o.geometry, pt.x - c.x, pt.y - c.y) };
}

/**
 * A paste onto a selected control (user answer 10): attached to it — at the copied offset when the original was
 * attached (the geometry moved by the control's position minus the original `at`), else centred on it.
 */
export function pasteOnSite(o: CourseEntry["object"], site: { id: number; x: number; y: number }): CourseBody {
  if (o.attach) {
    return {
      kind: o.kind, props: o.props,
      geometry: course.translateGeometry(o.geometry, site.x - o.attach.at.x, site.y - o.attach.at.y),
      attach: { controlId: site.id, at: { x: site.x, y: site.y } },
    };
  }
  const p = centrePatch({ ...o, id: 0 } as CourseObject, site);
  return { kind: o.kind, props: o.props, geometry: p.geometry, attach: p.attach ?? undefined };
}

/**
 * The pasted scope (user answer 9): the original's when it was copied in this event and would be drawn in this view
 * (`all`, or a course it resolves to is drawn); else the current course, or `all` without one.
 */
export function pasteScope(
  entry: CourseEntry, here: { event: string; drawnCourseIds: readonly number[]; currentCourseId: number | null },
): CourseObject["scope"] {
  const o = entry.object;
  if (entry.event === here.event) {
    if ("all" in o.scope) return o.scope;
    if ((o.inCourses ?? []).some((id) => here.drawnCourseIds.includes(id))) return o.scope;
  }
  return here.currentCourseId !== null ? { courses: [here.currentCourseId], classes: [] } : { all: true };
}

export type Refusal = "clipboardWrongType" | "clipboardGraphicMissing" | "clipboardRegionForeign" | "clipboardUnattachable";

/**
 * Why an entry may not paste here, or null: the other mode's kind; an image whose graphic is neither this event's nor
 * the club's (`graphicIds`, `graphics.list`); a filter region picking symbols or colours of another event's map; a
 * kind that cannot attach pasted onto controls.
 */
export function refusal(
  entry: ClipboardEntry, here: { event: string; mode: "course" | "page"; graphicIds: ReadonlySet<number> | null; onControls?: boolean },
): Refusal | null {
  if (entry.type !== here.mode) return "clipboardWrongType";
  if (entry.type === "page") {
    if (entry.object.kind === "image" && here.graphicIds && !here.graphicIds.has(entry.object.graphicId)) return "clipboardGraphicMissing";
    return null;
  }
  const o = entry.object;
  if (o.kind === "image" && here.graphicIds && !here.graphicIds.has((o.props as { graphicId: number }).graphicId)) return "clipboardGraphicMissing";
  if (o.kind === "filter_region" && entry.event !== here.event && (o.props as { symbols?: unknown }).symbols !== "all") return "clipboardRegionForeign";
  if (here.onControls && course.UNATTACHABLE_KINDS.includes(o.kind)) return "clipboardUnattachable";
  return null;
}
