/**
 * The new editor's writes (docs/course-editor.md §3, §7): every course,
 * control and course-object write sends the newest token this client has seen
 * (`VersionBook`), each result advances it — one write per row in flight, the
 * next queued behind it (`serial`), so it reads its predecessor's token — and a version `CONFLICT` is
 * decided by the G1 client rules (`conflict.ts`):
 *
 * - `rebase` → the same write is re-sent once with the server's token;
 * - `moved` / `refresh` → an `EditorConflict` is thrown for the page to
 *   show (and the caller's cache invalidation reloads the rows).
 *
 * Over a minimal client interface so the rules are unit-tested without
 * tRPC; the page passes `utils.client`.
 */

import type { course, CourseDescriptionInstructions, gpsTrack, mapDocument } from "@oxygen/shared";
import { VersionBook, publicIdAfterCodes, versionConflictOfError, type VersionedKind } from "../version-book";
import { conflictDecision, MOVE_FIELDS, type ConflictDecision } from "./conflict";

type Pt = { x: number; y: number };

export interface ControlUpdateInput {
  id: number;
  codes?: string;
  xpos?: number;
  ypos?: number;
  autoDescribe?: boolean;
  description?: unknown;
  baseVersion?: string;
}

/** A course object's writable fields (`courseObject.update`, docs/course-layer.md §8.4). */
export interface ObjectUpdateInput {
  id: number;
  geometry?: course.CourseObject["geometry"];
  props?: course.CourseObject["props"];
  scope?: course.CourseObject["scope"];
  /** J10: the control it follows and where it was (`null` detaches; absent keeps). */
  attach?: course.CourseObjectAttach<number> | null;
}

export type ObjectCreateInput = Pick<course.CourseObject, "kind" | "geometry" | "props" | "scope"> & { attach?: course.CourseObjectAttach<number> | null };

/** What a `mapPatch.` write answers (docs/map-patches.md §3.2): the row's version and the delivered patch. */
export interface PatchWriteResult {
  version: string;
  patch: mapDocument.MapPatch | null;
}

/** A stored GPS track's metadata (`mapTrack.list`, docs/map-gps-tracks.md §1.2). */
export interface TrackMeta {
  id: string;
  name: string | null;
  sourceName: string;
  pointCount: number;
  /** Epoch ms of the first recorded time, or null. */
  recordedAt: number | null;
  trim: gpsTrack.TrackRange;
  derivedFrom: string[];
  singlePass: gpsTrack.TrackRange[] | null;
  convertedOp: string | null;
  createdBy: string | null;
  createdAt: string;
  version: string;
}

/** One track of a `mapTrack.import` call (§1.2): parsed on the device; `id` to re-import under a known id (undo). */
export interface TrackImportItem {
  id?: string;
  name: string | null;
  sourceName: string;
  points: gpsTrack.TrackPoints;
  derivedFrom?: string[];
  singlePass?: gpsTrack.TrackRange[];
}

/** What the editor needs of the tRPC client (structural: `utils.client` fits). */
export interface EditorClient {
  course: {
    setStructure: { mutate(input: { courseId: number; structure: course.WireCourseStructure; baseVersion?: string }): Promise<{ version: string }> };
    setControlLabelOffset: { mutate(input: { id: number; controlId: number; offset: { dx: number; dy: number } | null }): Promise<{ version: string }> };
    /** Only `descriptionInstructions` is written through it here (§4); the structure goes through `setStructure`. */
    update: {
      mutate(input: { id: number; descriptionInstructions: CourseDescriptionInstructions | null; baseVersion?: string }): Promise<{ version: string }>;
    };
  };
  control: {
    // `description` is the tRPC input's own type; the editor passes it through untouched.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fit for the router's input type
    update: { mutate(input: any): Promise<{ version: string }> };
    delete: { mutate(input: { id: number }): Promise<{ courses: { id: number; version: string }[] }> };
    check: { mutate(input: { controlId: number; checked: boolean }): Promise<{ version: string }> };
  };
  courseObject?: {
    // The kinds' props are a discriminated union the router validates; the editor builds them per kind.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fit for the router's input type
    create: { mutate(input: any): Promise<course.CourseObject> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    update: { mutate(input: any): Promise<course.CourseObject> };
    delete: { mutate(input: { id: number; baseVersion?: string }): Promise<unknown> };
  };
  /** Map mode's corrections (docs/course-editor.md §13; docs/map-patches.md §3.2). */
  mapPatch?: {
    applyChange: { mutate(input: { documentHash: string } & mapDocument.PatchChange): Promise<PatchWriteResult> };
    setEnabled: { mutate(input: { enabled: boolean }): Promise<PatchWriteResult> };
    attachUnresolved: {
      mutate(input: { documentHash: string; key: string; sourceIndex?: number; symbol?: mapDocument.PatchSymbolRef }): Promise<PatchWriteResult>;
    };
  };
  /** Map mode's GPS tracks (docs/map-gps-tracks.md §1.2, §5.1). */
  mapTrack?: {
    import: { mutate(input: { tracks: TrackImportItem[] }): Promise<{ tracks: TrackMeta[] }> };
    update: { mutate(input: { id: string; name?: string | null; trim?: gpsTrack.TrackRange }): Promise<TrackMeta> };
    split: { mutate(input: { id: string; index: number; ids?: [string, string] }): Promise<{ tracks: [TrackMeta, TrackMeta] }> };
    remove: { mutate(input: { ids: string[] }): Promise<{ removed: number }> };
    markConverted: { mutate(input: { marks: { id: string; opId: string | null }[] }): Promise<{ tracks: TrackMeta[] }> };
  };
}

/** A conflict the user has to see: both moved the control, or the row must be refreshed and the edit redone. */
export class EditorConflict extends Error {
  readonly decision: Exclude<ConflictDecision, { kind: "rebase" }>;
  readonly kind: VersionedKind;
  readonly id: number;

  constructor(decision: Exclude<ConflictDecision, { kind: "rebase" }>, kind: VersionedKind, id: number) {
    super(decision.kind === "moved" ? "moved elsewhere" : "changed elsewhere");
    this.decision = decision;
    this.kind = kind;
    this.id = id;
  }
}

export class EditorWrites {
  private readonly client: EditorClient;
  readonly versions: VersionBook;
  /** Course tokens this client's own writes returned: a course token outside it moved elsewhere (D11, `presence.ts`). */
  readonly ownCourseVersions = new Set<string>();

  /** Per row (`kind:id`): the write in flight and the ones queued behind it, settled or not (`serial`). */
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(client: EditorClient, versions: VersionBook = new VersionBook()) {
    this.client = client;
    this.versions = versions;
  }

  /**
   * Runs `op` once every earlier write of the same row has settled: one write per row in flight, so the next reads
   * the token its predecessor's result seeded (docs/course-editor.md §3 "Tokens"). Without it a second write sent
   * while the first was in flight — Ctrl+Z twice, an undo faster than its reply — carried the same `baseVersion`
   * and was refused as stale (docs/bugfix-editor-overlapping-course-writes.md). A refused predecessor does not stop
   * the queue: the next write reads the token the refusal seeded.
   */
  private serial<T>(kind: VersionedKind, id: number, op: () => Promise<T>): Promise<T> {
    const key = `${kind}:${id}`;
    const next = (this.tails.get(key) ?? Promise.resolve()).then(op, op);
    const tail = next.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }

  /** Sends `send(token)`; on a version conflict decides, re-sends once on `rebase`, throws `EditorConflict` otherwise. */
  private async withToken<T>(
    kind: VersionedKind,
    id: number,
    write: { fields: readonly string[]; base?: Pt },
    send: (baseVersion: string | undefined) => Promise<T>,
    baseVersion?: string,
  ): Promise<T> {
    try {
      return await send(baseVersion ?? this.versions.get(kind, id));
    } catch (e) {
      const conflict = versionConflictOfError(e);
      if (!conflict) throw e;
      this.versions.seed(conflict.kind, conflict.id, conflict.version);
      const decision = conflictDecision(conflict, write);
      if (decision.kind !== "rebase") throw new EditorConflict(decision, conflict.kind, conflict.id);
      return send(decision.version);
    }
  }

  setStructure(courseId: number, structure: course.WireCourseStructure): Promise<{ version: string }> {
    return this.serial("course", courseId, async () => {
      const res = await this.withToken("course", courseId, { fields: ["structure"] }, (baseVersion) =>
        this.client.course.setStructure.mutate({ courseId, structure, baseVersion }),
      );
      this.versions.seed("course", courseId, res.version);
      this.ownCourseVersions.add(res.version);
      return res;
    });
  }

  /**
   * The course's description instructions (finish variant, specials; §4) through `course.update` with the
   * course's token. A stale token is a course conflict: `refresh`, never merged (as `setStructure`).
   */
  setInstructions(courseId: number, descriptionInstructions: CourseDescriptionInstructions | null): Promise<{ version: string }> {
    return this.serial("course", courseId, async () => {
      const res = await this.withToken("course", courseId, { fields: ["descriptionInstructions"] }, (baseVersion) =>
        this.client.course.update.mutate({ id: courseId, descriptionInstructions, baseVersion }),
      );
      this.versions.seed("course", courseId, res.version);
      this.ownCourseVersions.add(res.version);
      return res;
    });
  }

  /**
   * `control.update`. A move (`xpos` / `ypos` and nothing else the user
   * chose) passes `from`, the position it moved from, for the field-move rule.
   * A queued write (D9c, Field mode's outbox, §9 "Offline") passes the token it was queued with as
   * `opts.baseVersion`: the book's newer one, seeded by a refetch after reconnect, would hide a move made
   * elsewhere meanwhile.
   */
  updateControl(input: Omit<ControlUpdateInput, "baseVersion">, from?: Pt, opts?: { baseVersion?: string }): Promise<{ version: string }> {
    const fields = Object.keys(input).filter((k) => k !== "id" && k !== "autoDescribe");
    const isMove = from !== undefined && MOVE_FIELDS.every((f) => fields.includes(f));
    const write = isMove ? { fields: MOVE_FIELDS, base: from } : { fields };
    return this.serial("control", input.id, async () => {
      const res = await this.withToken("control", input.id, write, (baseVersion) =>
        this.client.control.update.mutate({ ...input, baseVersion }),
      opts?.baseVersion);
      this.versions.seed("control", publicIdAfterCodes(input.id, input.codes), res.version);
      return res;
    });
  }

  /** `course.setControlLabelOffset` (no token in; the course's out): it advances the course's token, so it queues as one. */
  setLabelOffset(courseId: number, controlId: number, offset: { dx: number; dy: number } | null): Promise<{ version: string }> {
    return this.serial("course", courseId, async () => {
      const res = await this.client.course.setControlLabelOffset.mutate({ id: courseId, controlId, offset });
      this.versions.seed("course", courseId, res.version);
      this.ownCourseVersions.add(res.version);
      return res;
    });
  }

  /** `control.check` (Field mode, §9; `courses.review`): no token in — a check-off never conflicts — the control's out. */
  async checkControl(id: number, checked: boolean): Promise<{ version: string }> {
    const res = await this.client.control.check.mutate({ controlId: id, checked });
    this.versions.seed("control", id, res.version);
    return res;
  }

  /** `control.delete`: the cascade advances the tokens of the courses that lost it. */
  async deleteControl(id: number): Promise<{ courses: { id: number; version: string }[] }> {
    const res = await this.client.control.delete.mutate({ id });
    this.versions.seedAll("course", res.courses);
    for (const c of res.courses) this.ownCourseVersions.add(c.version);
    return res;
  }

  private objects() {
    if (!this.client.courseObject) throw new Error("course objects are not available");
    return this.client.courseObject;
  }

  /** `courseObject.create` (no token in; the object's out). */
  async createObject(input: ObjectCreateInput): Promise<course.CourseObject> {
    const res = await this.objects().create.mutate(input);
    this.versions.seed("object", res.id, res.version);
    return res;
  }

  /**
   * Several creates as one gesture (J12: a paste onto selected controls), in order so their `seq` follow it. A failure
   * deletes the ones already made (best effort) and rethrows, so the batch is all or nothing for its undo entry.
   */
  async createObjects(inputs: readonly ObjectCreateInput[]): Promise<course.CourseObject[]> {
    const made: course.CourseObject[] = [];
    try {
      for (const input of inputs) made.push(await this.createObject(input));
    } catch (e) {
      for (const o of made.reverse()) await this.deleteObject(o.id).catch(() => undefined);
      throw e;
    }
    return made;
  }

  /** `courseObject.update` with the object's token; a conflict is always a refresh (§8.4: no base to diff). */
  updateObject(input: ObjectUpdateInput): Promise<course.CourseObject> {
    const fields = Object.keys(input).filter((k) => k !== "id");
    return this.serial("object", input.id, async () => {
      const res = await this.withToken("object", input.id, { fields }, (baseVersion) => this.objects().update.mutate({ ...input, baseVersion }));
      this.versions.seed("object", res.id, res.version);
      return res;
    });
  }

  /** `courseObject.delete` with the object's token. */
  deleteObject(id: number): Promise<void> {
    return this.serial("object", id, async () => {
      await this.withToken("object", id, { fields: ["delete"] }, (baseVersion) => this.objects().delete.mutate({ id, baseVersion }));
    });
  }

  private patches(): NonNullable<EditorClient["mapPatch"]> {
    if (!this.client.mapPatch) throw new Error("mapPatch writes are not available");
    return this.client.mapPatch;
  }

  /**
   * Map mode's one write per gesture (§13): `mapPatch.applyChange` keyed onto `documentHash`. No token — the merge
   * is per op id, last-writer-wins (docs/map-patches.md §3.2) — so no conflict rule either; a refusal propagates.
   */
  applyPatchChange(documentHash: string, change: mapDocument.PatchChange): Promise<PatchWriteResult> {
    return this.patches().applyChange.mutate({ documentHash, ...change });
  }

  /**
   * *Attach* of an unresolved correction (§13 "Unresolved"; docs/map-patches.md §4.3): `mapPatch.attachUnresolved`
   * onto the selected object (`sourceIndex`) or with a picked symbol (G12b). No token; a refusal propagates.
   */
  attachUnresolvedPatch(documentHash: string, key: string, at: { sourceIndex?: number; symbol?: mapDocument.PatchSymbolRef }): Promise<PatchWriteResult> {
    return this.patches().attachUnresolved.mutate({ documentHash, key, ...at });
  }

  /** *Apply corrections* (§13; docs/map-patches.md §1.4): `mapPatch.setEnabled`, no token. */
  setPatchEnabled(enabled: boolean): Promise<PatchWriteResult> {
    return this.patches().setEnabled.mutate({ enabled });
  }

  private tracks(): NonNullable<EditorClient["mapTrack"]> {
    if (!this.client.mapTrack) throw new Error("mapTrack writes are not available");
    return this.client.mapTrack;
  }

  /**
   * GPS tracks (docs/map-gps-tracks.md §5.1): cloud-owned rows with no token — `points` never change under one id,
   * name, trim and `convertedOp` are last-writer-wins (§1.2) — so no conflict rule; a refusal (`TRACK_*`) propagates.
   */
  importTracks(tracks: TrackImportItem[]): Promise<{ tracks: TrackMeta[] }> {
    return this.tracks().import.mutate({ tracks });
  }

  updateTrack(input: { id: string; name?: string | null; trim?: gpsTrack.TrackRange }): Promise<TrackMeta> {
    return this.tracks().update.mutate(input);
  }

  /** `mapTrack.split` (§1.2 "Split"): the row replaced by two; `ids` client-minted, ascending, left first (G27). */
  splitTrack(input: { id: string; index: number; ids: [string, string] }): Promise<{ tracks: [TrackMeta, TrackMeta] }> {
    return this.tracks().split.mutate(input);
  }

  removeTracks(ids: string[]): Promise<{ removed: number }> {
    return this.tracks().remove.mutate({ ids });
  }

  markTracksConverted(marks: { id: string; opId: string | null }[]): Promise<{ tracks: TrackMeta[] }> {
    return this.tracks().markConverted.mutate({ marks });
  }
}
