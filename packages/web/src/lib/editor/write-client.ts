/**
 * The new editor's writes (docs/course-editor.md §3): every course and
 * control write sends the newest token this client has seen
 * (`VersionBook`), each result advances it, and a version `CONFLICT` is
 * decided by the G1 client rules (`conflict.ts`):
 *
 * - `rebase` → the same write is re-sent once with the server's token;
 * - `moved` / `refresh` → an `EditorConflict` is thrown for the page to
 *   show (and the caller's cache invalidation reloads the rows).
 *
 * Over a minimal client interface so the rules are unit-tested without
 * tRPC; the page passes `utils.client`.
 */

import type { course } from "@oxygen/shared";
import { VersionBook, publicIdAfterCodes, versionConflictOfError } from "../version-book";
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

/** What the editor needs of the tRPC client (structural: `utils.client` fits). */
export interface EditorClient {
  course: {
    setStructure: { mutate(input: { courseId: number; structure: course.WireCourseStructure; baseVersion?: string }): Promise<{ version: string }> };
    setControlLabelOffset: { mutate(input: { id: number; controlId: number; offset: { dx: number; dy: number } | null }): Promise<{ version: string }> };
  };
  control: {
    // `description` is the tRPC input's own type; the editor passes it through untouched.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fit for the router's input type
    update: { mutate(input: any): Promise<{ version: string }> };
    delete: { mutate(input: { id: number }): Promise<{ courses: { id: number; version: string }[] }> };
  };
}

/** A conflict the user has to see: both moved the control, or the row must be refreshed and the edit redone. */
export class EditorConflict extends Error {
  constructor(
    readonly decision: Exclude<ConflictDecision, { kind: "rebase" }>,
    readonly kind: "course" | "control",
    readonly id: number,
  ) {
    super(decision.kind === "moved" ? "moved elsewhere" : "changed elsewhere");
  }
}

export class EditorWrites {
  constructor(private readonly client: EditorClient, readonly versions: VersionBook = new VersionBook()) {}

  /** Sends `send(token)`; on a version conflict decides, re-sends once on `rebase`, throws `EditorConflict` otherwise. */
  private async withToken<T>(
    kind: "course" | "control",
    id: number,
    write: { fields: readonly string[]; base?: Pt },
    send: (baseVersion: string | undefined) => Promise<T>,
  ): Promise<T> {
    try {
      return await send(this.versions.get(kind, id));
    } catch (e) {
      const conflict = versionConflictOfError(e);
      if (!conflict) throw e;
      this.versions.seed(conflict.kind, conflict.id, conflict.version);
      const decision = conflictDecision(conflict, write);
      if (decision.kind !== "rebase") throw new EditorConflict(decision, conflict.kind, conflict.id);
      return send(decision.version);
    }
  }

  async setStructure(courseId: number, structure: course.WireCourseStructure): Promise<{ version: string }> {
    const res = await this.withToken("course", courseId, { fields: ["structure"] }, (baseVersion) =>
      this.client.course.setStructure.mutate({ courseId, structure, baseVersion }),
    );
    this.versions.seed("course", courseId, res.version);
    return res;
  }

  /**
   * `control.update`. A move (`xpos` / `ypos` and nothing else the user
   * chose) passes `from`, the position it moved from, for the field-move rule.
   */
  async updateControl(input: Omit<ControlUpdateInput, "baseVersion">, from?: Pt): Promise<{ version: string }> {
    const fields = Object.keys(input).filter((k) => k !== "id" && k !== "autoDescribe");
    const isMove = from !== undefined && MOVE_FIELDS.every((f) => fields.includes(f));
    const write = isMove ? { fields: MOVE_FIELDS, base: from } : { fields };
    const res = await this.withToken("control", input.id, write, (baseVersion) =>
      this.client.control.update.mutate({ ...input, baseVersion }),
    );
    this.versions.seed("control", publicIdAfterCodes(input.id, input.codes), res.version);
    return res;
  }

  /** `course.setControlLabelOffset` (no token in; the course's out). */
  async setLabelOffset(courseId: number, controlId: number, offset: { dx: number; dy: number } | null): Promise<{ version: string }> {
    const res = await this.client.course.setControlLabelOffset.mutate({ id: courseId, controlId, offset });
    this.versions.seed("course", courseId, res.version);
    return res;
  }

  /** `control.delete`: the cascade advances the tokens of the courses that lost it. */
  async deleteControl(id: number): Promise<{ courses: { id: number; version: string }[] }> {
    const res = await this.client.control.delete.mutate({ id });
    this.versions.seedAll("course", res.courses);
    return res;
  }
}
