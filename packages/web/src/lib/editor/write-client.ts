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
      mutate(input: { id: number; descriptionInstructions?: CourseDescriptionInstructions | null; winnerPaceSPerKm?: number | null; baseVersion?: string }): Promise<{ version: string }>;
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

/** A row a write of this client produced a token for (D6 undo guard, docs/course-editor.md §3 "Undo after another editor's change"). */
export interface WrittenRow {
  kind: VersionedKind;
  id: number;
  /** The token the write produced. */
  version: string;
}

/**
 * An undo or redo refused under D6 (docs/course-editor.md §3): the row it would write back was changed by someone
 * else since this client's own write, so nothing (of it) was written. The page drops the row's entries and says who.
 */
export class UndoSkipped extends Error {
  readonly kind: VersionedKind;
  readonly id: number;
  /** Which step was refused (the page sets it; the notice says "undo" or "redo"). */
  step: "undo" | "redo" = "undo";

  constructor(kind: VersionedKind, id: number) {
    super("undo skipped: changed elsewhere");
    this.kind = kind;
    this.id = id;
  }
}

const rowKey = (kind: string, id: number) => `${kind}:${id}`;

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

  /**
   * This client's own chain per row (D6): `kind:id:base` → the token the write sent on `base` produced. A token
   * reached from an entry's token through these links only was written by nobody else since (`chainEnd`, `stillMine`).
   */
  private readonly ownNext = new Map<string, string>();

  /**
   * Links a control undo made across another write (the field rule, `updateControl`): `kind:id:base` → the fields
   * that write changed. The link sits in `ownNext` too, so an older undo of the control follows it; crossing it, the
   * undo is skipped when it is about one of these fields and leaves them out otherwise.
   */
  private readonly bridges = new Map<string, readonly string[]>();

  /** Open `collect` calls: every own write's row and result token goes to each (an undo entry's rows, D6). */
  private readonly collectors = new Set<WrittenRow[]>();

  /** While an undo / redo runs (`guarded`): the token each of its rows had after this client's write, by `kind:id`. */
  private guard: Map<string, string> | null = null;

  constructor(client: EditorClient, versions: VersionBook = new VersionBook()) {
    this.client = client;
    this.versions = versions;
  }

  /**
   * Runs `op` once every earlier write of the same row has settled: one write per row in flight, so the next reads
   * the token its predecessor's result seeded (docs/course-editor.md §3 "Tokens"). Without it a second write sent
   * while the first was in flight — Ctrl+Z twice, an undo faster than its reply — carried the same `baseVersion`
   * and was refused as stale (docs/bugfixes/editor-overlapping-course-writes.md). A refused predecessor does not stop
   * the queue: the next write reads the token the refusal seeded.
   */
  serialRow<T>(kind: VersionedKind | "patch", id: number, op: () => Promise<T>): Promise<T> {
    const key = rowKey(kind, id);
    const next = (this.tails.get(key) ?? Promise.resolve()).then(op, op);
    const tail = next.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }

  /**
   * Records a write's result as this client's own: the token seeds the book, links from the token it was sent on
   * (`base`; for a write that sends none, the book's token at send) and goes to every open `collect`.
   */
  noteOwn(kind: VersionedKind, id: number, base: string | undefined, result: string): void {
    if (base !== undefined && base !== result) this.ownNext.set(`${rowKey(kind, id)}:${base}`, result);
    this.versions.seed(kind, id, result);
    for (const c of this.collectors) c.push({ kind, id, version: result });
  }

  /**
   * Rows another procedure of this client wrote and answered the tokens of (Layout's template and setter writes, a
   * kind change's re-mirrored courses): their chains link from the book's token as the reply arrives.
   */
  adoptOwn(kind: VersionedKind, rows: readonly { id?: number; seq?: number; version: string }[]): void {
    for (const r of rows) {
      const id = r.id ?? r.seq;
      if (id === undefined) continue;
      if (kind === "course") this.noteOwnCourse(id, this.versions.get(kind, id), r.version);
      else this.noteOwn(kind, id, this.versions.get(kind, id), r.version);
    }
  }

  /** The end of this client's own chain from `since`: the newest token its own writes reached from it. */
  chainEnd(kind: VersionedKind, id: number, since: string): string {
    let v = since;
    for (let i = 0; i < 10_000; i++) {
      const next = this.ownNext.get(`${rowKey(kind, id)}:${v}`);
      if (next === undefined) break;
      v = next;
    }
    return v;
  }

  /** The fields bridged (`bridges`) on this client's own chain from `since`. */
  private bridgedOn(kind: VersionedKind, id: number, since: string): Set<string> {
    const out = new Set<string>();
    let v = since;
    for (let i = 0; i < 10_000; i++) {
      const key = `${rowKey(kind, id)}:${v}`;
      for (const f of this.bridges.get(key) ?? []) out.add(f);
      const next = this.ownNext.get(key);
      if (next === undefined) break;
      v = next;
    }
    return out;
  }

  /**
   * D6: the row is still where this client's own writes left it since `since` — the book's token is `since` or one
   * its own chain reached. A row the book has no token for counts as mine (the server's token check still guards).
   */
  stillMine(kind: VersionedKind, id: number, since: string): boolean {
    const now = this.versions.get(kind, id);
    return now === undefined || now === this.chainEnd(kind, id, since);
  }

  /**
   * Runs `fn` and returns the rows its own writes produced tokens for (the last token per row), for the undo entry
   * the gesture records. Writes of another gesture running at the same time are collected too: a row collected that
   * way only guards the entry on a row this client also wrote (docs/course-editor.md §3, Pending).
   */
  async collect<T>(fn: () => Promise<T>): Promise<{ value: T; rows: WrittenRow[] }> {
    const bag: WrittenRow[] = [];
    this.collectors.add(bag);
    try {
      const value = await fn();
      return { value, rows: lastPerRow(bag) };
    } finally {
      this.collectors.delete(bag);
    }
  }

  /**
   * An undo or redo under D6 (docs/course-editor.md §3 "Undo after another editor's change"). Before anything is
   * written, every row of the entry but a control must still be at its own chain (`stillMine`), else `UndoSkipped`
   * and nothing is written. While `fn` runs, each write of one of the rows is sent on the row's own-chain token,
   * never on a newer one the book holds, and a version conflict is `UndoSkipped`, never a rebase — but a control
   * move undo whose control was changed elsewhere in anything but its position still goes through (`updateControl`).
   * @returns the entry's rows as they are now: each one's token after this write, for the redo (or the next undo).
   */
  async guarded(rows: readonly WrittenRow[], fn: () => Promise<unknown>): Promise<WrittenRow[]> {
    for (const r of rows) {
      if (r.kind !== "control" && !this.stillMine(r.kind, r.id, r.version)) throw new UndoSkipped(r.kind, r.id);
    }
    this.guard = new Map(rows.map((r) => [rowKey(r.kind, r.id), r.version]));
    try {
      const { rows: wrote } = await this.collect(fn);
      return lastPerRow([...rows, ...wrote]);
    } finally {
      this.guard = null;
    }
  }

  /** The token a write of the row is sent on: the caller's, else an undo's own-chain one (`guarded`), else the book's. */
  private baseFor(kind: VersionedKind, id: number, explicit: string | undefined): string | undefined {
    if (explicit !== undefined) return explicit;
    const since = this.guard?.get(rowKey(kind, id));
    if (since !== undefined) return this.chainEnd(kind, id, since);
    return this.versions.get(kind, id);
  }

  /**
   * Sends `send(token)`; on a version conflict decides, re-sends once on `rebase`, throws `EditorConflict` otherwise.
   * Inside `guarded` a conflict on one of the entry's rows is `UndoSkipped` (D6), unless `onGuardConflict` returns a
   * write to send instead (the control move rule). @returns the reply and the token it was sent on.
   */
  private async withToken<T>(
    kind: VersionedKind,
    id: number,
    write: { fields: readonly string[]; base?: Pt },
    send: (baseVersion: string | undefined) => Promise<T>,
    baseVersion?: string,
    onGuardConflict?: (conflict: NonNullable<ReturnType<typeof versionConflictOfError>>) => (() => Promise<T>) | null,
  ): Promise<{ value: T; base: string | undefined }> {
    const guardedRow = baseVersion === undefined && this.guard?.has(rowKey(kind, id)) === true;
    const base = this.baseFor(kind, id, baseVersion);
    try {
      return { value: await send(base), base };
    } catch (e) {
      const conflict = versionConflictOfError(e);
      if (!conflict) throw e;
      this.versions.seed(conflict.kind, conflict.id, conflict.version);
      if (guardedRow) {
        const instead = onGuardConflict?.(conflict);
        if (!instead) throw new UndoSkipped(kind, id);
        try {
          return { value: await instead(), base: conflict.version };
        } catch (again) {
          // Changed once more inside this round trip: skipped like any other refused undo (D6).
          const second = versionConflictOfError(again);
          if (!second) throw again;
          this.versions.seed(second.kind, second.id, second.version);
          throw new UndoSkipped(kind, id);
        }
      }
      const decision = conflictDecision(conflict, write);
      if (decision.kind !== "rebase") throw new EditorConflict(decision, conflict.kind, conflict.id);
      return { value: await send(decision.version), base: decision.version };
    }
  }

  /**
   * `course.setStructure`. `opts.since`: the course token the structure was built from (CRS-049): the write is sent
   * on the end of this client's own chain from it, so a newer token `course.list` seeded from someone else's write
   * is refused by the server instead of overwritten.
   */
  setStructure(courseId: number, structure: course.WireCourseStructure, opts?: { since?: string }): Promise<{ version: string }> {
    return this.serialRow("course", courseId, async () => {
      const since = opts?.since !== undefined ? this.chainEnd("course", courseId, opts.since) : undefined;
      const { value: res, base } = await this.withToken("course", courseId, { fields: ["structure"] }, (baseVersion) =>
        this.client.course.setStructure.mutate({ courseId, structure, baseVersion }),
      since);
      this.noteOwnCourse(courseId, base, res.version);
      return res;
    });
  }

  private noteOwnCourse(courseId: number, base: string | undefined, version: string): void {
    this.noteOwn("course", courseId, base, version);
    this.ownCourseVersions.add(version);
  }

  /**
   * The course's description instructions (finish variant, specials; §4) through `course.update` with the
   * course's token. A stale token is a course conflict: `refresh`, never merged (as `setStructure`).
   */
  setInstructions(courseId: number, descriptionInstructions: CourseDescriptionInstructions | null): Promise<{ version: string }> {
    return this.serialRow("course", courseId, async () => {
      const { value: res, base } = await this.withToken("course", courseId, { fields: ["descriptionInstructions"] }, (baseVersion) =>
        this.client.course.update.mutate({ id: courseId, descriptionInstructions, baseVersion }),
      );
      this.noteOwnCourse(courseId, base, res.version);
      return res;
    });
  }

  /** The course's expected winner pace, seconds per km (docs/course-elevation.md §7.8), through `course.update` with the course's token. */
  setWinnerPace(courseId: number, winnerPaceSPerKm: number | null): Promise<{ version: string }> {
    return this.serialRow("course", courseId, async () => {
      const { value: res, base } = await this.withToken("course", courseId, { fields: ["winnerPaceSPerKm"] }, (baseVersion) =>
        this.client.course.update.mutate({ id: courseId, winnerPaceSPerKm, baseVersion }),
      );
      this.noteOwnCourse(courseId, base, res.version);
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
    // D6's control rule (docs/course-editor.md §3): a control's undo is decided field by field. It is skipped when
    // the other side changed a field the undo is about — a move undo's position, any other undo's fields — or the
    // change is unknown; otherwise it goes through on the server's token, leaving out the fields the other side
    // changed (a move undo keeps their description). A change of a field the undo does not write (radio, a restore,
    // a check-off, this client's own included) never blocks it.
    const about: readonly string[] = isMove || ("xpos" in input && "ypos" in input) ? MOVE_FIELDS : fields;
    return this.serialRow("control", input.id, async () => {
      const guardSince = opts?.baseVersion === undefined ? this.guard?.get(rowKey("control", input.id)) : undefined;
      // An undo that crosses an earlier field-level pass (`bridges`): about a field the other side changed there, it
      // is skipped; otherwise it leaves those fields out, as the pass did.
      const crossed = guardSince !== undefined ? this.bridgedOn("control", input.id, guardSince) : new Set<string>();
      if ([...crossed].some((f) => about.includes(f))) throw new UndoSkipped("control", input.id);
      // Leaving the description out leaves its auto-description out too (it would fill one the other side cleared).
      const leaveOut = (out: ReadonlySet<string>) => (k: string) => !out.has(k) && !(k === "autoDescribe" && out.has("description"));
      const sendInput = crossed.size ? Object.fromEntries(Object.entries(input).filter(([k]) => leaveOut(crossed)(k))) as typeof input : input;
      const sentOn = this.baseFor("control", input.id, opts?.baseVersion);
      let bridged = null as string[] | null;
      const fieldRule = (conflict: { version: string; differing: string[] | null }) => {
        const differing = conflict.differing;
        if (!differing || differing.some((f) => about.includes(f))) return null;
        bridged = [...differing, ...crossed];
        const kept = Object.fromEntries(Object.entries(sendInput).filter(([k]) => leaveOut(new Set(differing))(k)));
        return () => this.client.control.update.mutate({ ...kept, id: input.id, baseVersion: conflict.version }) as Promise<{ version: string }>;
      };
      const { value: res, base } = await this.withToken("control", input.id, write, (baseVersion) =>
        this.client.control.update.mutate({ ...sendInput, baseVersion }),
      opts?.baseVersion, fieldRule);
      // A code change re-keys the row: its chain starts again under the new public id.
      const publicId = publicIdAfterCodes(input.id, input.codes);
      this.noteOwn("control", publicId, publicId === input.id ? base : undefined, res.version);
      // Fields an undo left out stay left out for the entry's later steps (redo, the next undo), sent from this token.
      if (guardSince !== undefined && publicId === input.id) {
        const carry = new Set([...crossed, ...((bridged as string[] | null) ?? [])]);
        if (carry.size) this.bridges.set(`${rowKey("control", input.id)}:${res.version}`, [...carry]);
      }
      // A field-level pass links the undo's own chain across the other write, naming the fields it changed there.
      if (bridged && publicId === input.id && sentOn !== undefined && sentOn !== res.version) {
        const key = `${rowKey("control", input.id)}:${sentOn}`;
        this.ownNext.set(key, res.version);
        this.bridges.set(key, bridged);
      }
      // A kind change re-mirrors the courses that visit it and answers their tokens: own writes (D6).
      const courses = (res as { courses?: { id: number; version: string }[] }).courses;
      if (courses?.length) this.adoptOwn("course", courses);
      return res;
    });
  }

  /** `course.setControlLabelOffset` (no token in; the course's out): it advances the course's token, so it queues as one. */
  setLabelOffset(courseId: number, controlId: number, offset: { dx: number; dy: number } | null): Promise<{ version: string }> {
    return this.serialRow("course", courseId, async () => {
      // No token in: the chain links from the book's token at send (a change elsewhere inside this one round trip is
      // bridged, docs/course-editor.md §3 Pending). Inside an undo the D6 pre-check of `guarded` is its only guard.
      const base = this.versions.get("course", courseId);
      const res = await this.client.course.setControlLabelOffset.mutate({ id: courseId, controlId, offset });
      this.noteOwnCourse(courseId, base, res.version);
      return res;
    });
  }

  /**
   * A Layout-mode write of a sheet or a template (docs/course-layout.md §2), `send(token)` its procedure: one per row
   * in flight (CRS-053: a second gesture inside one round trip sends the first's token, not the one read before it),
   * on the row's token — an undo's own-chain one under D6. Whole snapshots are never merged: a stale token is a
   * `refresh` (inside an undo, `UndoSkipped`). The result's token is this client's own. `since`: the token the
   * written snapshot was built on; the write goes on the end of this client's own chain from it, so a gesture built
   * on an earlier gesture that was refused is refused too, not sent on the newer token the refusal brought.
   */
  writeRow<T extends { version: string }>(kind: "sheet" | "template", id: number, send: (baseVersion: string | undefined) => Promise<T>, since?: string): Promise<T> {
    return this.serialRow(kind, id, async () => {
      const guardedRow = this.guard?.has(rowKey(kind, id)) === true;
      const base = !guardedRow && since !== undefined ? this.chainEnd(kind, id, since) : this.baseFor(kind, id, undefined);
      let res: T;
      try {
        res = await send(base);
      } catch (e) {
        const conflict = versionConflictOfError(e);
        if (!conflict) throw e;
        this.versions.seed(kind, id, conflict.version);
        if (guardedRow) throw new UndoSkipped(kind, id);
        throw new EditorConflict({ kind: "refresh", differing: null }, kind, id);
      }
      this.noteOwn(kind, id, base, res.version);
      return res;
    });
  }

  /** A sheet or template write with no token in (a recalculation): queued with the row's writes, its result own. */
  writeRowUnversioned<T extends { version: string }>(kind: "sheet" | "template", id: number, send: () => Promise<T>): Promise<T> {
    return this.serialRow(kind, id, async () => {
      const base = this.versions.get(kind, id);
      const res = await send();
      this.noteOwn(kind, id, base, res.version);
      return res;
    });
  }

  /** `control.check` (Field mode, §9; `courses.review`): no token in — a check-off never conflicts — the control's out. */
  checkControl(id: number, checked: boolean): Promise<{ version: string }> {
    // Queued with the control's other writes, so its chain link starts from its predecessor's result.
    return this.serialRow("control", id, async () => {
      const base = this.versions.get("control", id);
      const res = await this.client.control.check.mutate({ controlId: id, checked });
      this.noteOwn("control", id, base, res.version);
      return res;
    });
  }

  /** `control.delete`: the cascade advances the tokens of the courses that lost it. */
  async deleteControl(id: number): Promise<{ courses: { id: number; version: string }[] }> {
    const res = await this.client.control.delete.mutate({ id });
    // No tokens in: each course's chain links from the book's token as the reply arrives.
    for (const c of res.courses) this.noteOwnCourse(c.id, this.versions.get("course", c.id), c.version);
    return res;
  }

  private objects() {
    if (!this.client.courseObject) throw new Error("course objects are not available");
    return this.client.courseObject;
  }

  /** `courseObject.create` (no token in; the object's out). */
  async createObject(input: ObjectCreateInput): Promise<course.CourseObject> {
    const res = await this.objects().create.mutate(input);
    this.noteOwn("object", res.id, undefined, res.version);
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
    return this.serialRow("object", input.id, async () => {
      const { value: res, base } = await this.withToken("object", input.id, { fields }, (baseVersion) => this.objects().update.mutate({ ...input, baseVersion }));
      this.noteOwn("object", res.id, base, res.version);
      return res;
    });
  }

  /**
   * Several updates as one gesture (J16: a group move), in order. A failure writes the `undo` of the ones already
   * updated back (best effort) and rethrows, so the batch is all or nothing for its undo entry.
   */
  async updateObjects(changes: readonly { input: ObjectUpdateInput; undo: ObjectUpdateInput }[]): Promise<course.CourseObject[]> {
    const done: ObjectUpdateInput[] = [];
    const out: course.CourseObject[] = [];
    try {
      for (const c of changes) {
        out.push(await this.updateObject(c.input));
        done.push(c.undo);
      }
    } catch (e) {
      for (const u of done.reverse()) await this.updateObject(u).catch(() => undefined);
      throw e;
    }
    return out;
  }

  /**
   * Several deletes as one gesture (J16: `Delete` on an object multi-selection). A failure creates the deleted ones
   * again from their bodies (best effort, under new ids) and rethrows.
   */
  async deleteObjects(items: readonly { id: number; body: ObjectCreateInput }[]): Promise<void> {
    const done: ObjectCreateInput[] = [];
    try {
      for (const it of items) {
        await this.deleteObject(it.id);
        done.push(it.body);
      }
    } catch (e) {
      for (const b of done.reverse()) await this.createObject(b).catch(() => undefined);
      throw e;
    }
  }

  /** `courseObject.delete` with the object's token. */
  deleteObject(id: number): Promise<void> {
    return this.serialRow("object", id, async () => {
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
    // One patch write in flight (MAP-8): a later one is sent after an earlier one's reply, so the replies come in order.
    const patches = this.patches();
    return this.serialRow("patch", 0, () => patches.applyChange.mutate({ documentHash, ...change }));
  }

  /**
   * *Attach* of an unresolved correction (§13 "Unresolved"; docs/map-patches.md §4.3): `mapPatch.attachUnresolved`
   * onto the selected object (`sourceIndex`) or with a picked symbol (G12b). No token; a refusal propagates.
   */
  attachUnresolvedPatch(documentHash: string, key: string, at: { sourceIndex?: number; symbol?: mapDocument.PatchSymbolRef }): Promise<PatchWriteResult> {
    const patches = this.patches();
    return this.serialRow("patch", 0, () => patches.attachUnresolved.mutate({ documentHash, key, ...at }));
  }

  /** *Apply corrections* (§13; docs/map-patches.md §1.4): `mapPatch.setEnabled`, no token. */
  setPatchEnabled(enabled: boolean): Promise<PatchWriteResult> {
    const patches = this.patches();
    return this.serialRow("patch", 0, () => patches.setEnabled.mutate({ enabled }));
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

/** The last token per row, in first-seen order. */
function lastPerRow(rows: readonly WrittenRow[]): WrittenRow[] {
  const out = new Map<string, WrittenRow>();
  for (const r of rows) out.set(rowKey(r.kind, r.id), r);
  return [...out.values()];
}
