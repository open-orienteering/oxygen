import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { trpc } from "../lib/trpc";
import type { ControlDescription } from "@oxygen/shared";
import { MapPanel } from "../components/MapPanel";
import { ControlDescriptionEditor } from "../components/ControlDescriptionEditor";
import type {
  EditorContextAction,
  EditorDescriptionSuggestion,
  MapViewerEditorProps,
} from "../components/MapViewer";
import { IOF_SYMBOLS } from "../iof-symbols";
import { iofSymbolName } from "../iof-symbol-meta";
import { ocadToIof } from "../lib/control-description-options";
import {
  courseEditorReducer,
  courseMembership,
  initialCourseEditorState,
  nextFreeControlCode,
  sequenceLegMeters,
} from "../lib/course-editor";
import { UndoStack } from "../lib/undo-stack";

/**
 * Interactive course editor.
 *
 * Tool-less, contextual interaction model: every map click resolves to a
 * selection — an existing control, or a phantom point on empty map / on
 * a course leg — and a floating menu next to it offers the applicable
 * actions (add control, add to course, insert into course, delete).
 * Drag moves a control; a floating panel inside the map box (so it
 * survives fullscreen) builds courses — course list, sequence rows with
 * per-leg distances, reorder/remove, start/finish flags; everything is
 * undoable via a bounded stack (Ctrl+Z / Ctrl+Shift+Z).
 *
 * For a placed control with no description yet, the same menu lists what
 * the base map has around that point (`control.suggestDescription`) as
 * one-click column D (+ side-of G) rows.
 *
 * The page renders its own inline MapPanel — deliberately NOT the shared
 * wide-screen shell pane — so editing gestures stay scoped to this page.
 * While a course is selected its controls render red on the map and the
 * "only course controls" toggle hides all others (MapPanel filterMode
 * "course"). Auto-pan on selection change is disabled in editor mode.
 *
 * Deep links: `?course=<seq>` pre-selects a course, `?control=<code>`
 * pre-selects a control (used by the edit icons on the Courses and
 * Controls pages). Params are consumed once when the data loads.
 *
 * Mutations run through the vanilla tRPC client (`utils.client`) so each
 * handler can await the round-trip and push an inverse-mutation pair
 * onto the undo stack. Course creation is not undoable (there is no
 * course.restore); everything else is.
 */
export function CourseEditorPage() {
  const { t, i18n } = useTranslation("courses");
  const utils = trpc.useUtils();
  const [state, dispatch] = useReducer(courseEditorReducer, initialCourseEditorState);
  const [searchParams] = useSearchParams();

  // Undo stack — stable instance; histVersion re-renders the buttons.
  const [undoStack] = useState(() => new UndoStack(50));
  const [, setHistVersion] = useState(0);
  const bumpHistory = useCallback(() => setHistVersion((v) => v + 1), []);
  // Bumped on undo/redo so the viewer discards its anti-snap-back move
  // bridges — an undone move must render at the restored position.
  const [moveEpoch, setMoveEpoch] = useState(0);

  // In-flight counter for the "Saving…" indicator (mutations go through
  // the vanilla client, so there is no useMutation isPending to lean on).
  const [pendingOps, setPendingOps] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // The control most recently moved by drag. A move re-opens the
  // description question — the old description described the old spot —
  // so the autodetect also runs for this control even when it already
  // has a description. Cleared when the selection leaves it.
  const [lastMovedId, setLastMovedId] = useState<number | null>(null);

  // ─── Data ────────────────────────────────────────────────

  // Full control list (includes unpositioned controls) — the code
  // universe for next-free-code suggestions.
  const controlList = trpc.control.list.useQuery();
  // Positioned controls — shares the React Query cache entry MapPanel
  // renders from, so the sidebar readouts match the map.
  const controlCoords = trpc.course.controlCoordinates.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  const courses = trpc.course.list.useQuery();
  const mapInfo = trpc.course.mapFileInfo.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
  });
  const mapMetadata = trpc.course.mapMetadata.useQuery(undefined, {
    staleTime: Number.POSITIVE_INFINITY,
    enabled: !!mapInfo.data,
  });
  const mapScale = mapMetadata.data?.scale ?? null;

  const selectedCourse = useMemo(
    () =>
      state.selectedCourseId != null
        ? courses.data?.find((c) => c.id === state.selectedCourseId) ?? null
        : null,
    [state.selectedCourseId, courses.data],
  );

  /** Ordered public control ids of the selected course. */
  const sequenceIds = useMemo(
    () =>
      selectedCourse
        ? selectedCourse.controls.split(";").filter(Boolean).map(Number)
        : [],
    [selectedCourse],
  );

  const coordsById = useMemo(
    () => new Map((controlCoords.data ?? []).map((c) => [c.id, c] as const)),
    [controlCoords.data],
  );

  /**
   * Display sequence: [start] + course controls + [finish], mirroring
   * the server's geometry builder (event start/finish rows unless the
   * course uses its first/last control in that role). Drives the
   * sidebar rows, the leg distances and the insert-on-leg index math.
   */
  const displaySeq = useMemo(() => {
    if (!selectedCourse) return [];
    const rows: Array<{
      kind: "start" | "control" | "finish";
      id: number | null;
      code: string;
      pt: { x: number; y: number } | null;
      /** Index into sequenceIds for control rows. */
      seqIndex: number;
    }> = [];
    const coords = controlCoords.data ?? [];
    if (!selectedCourse.firstAsStart) {
      const start = coords.find((c) => c.status === 4);
      if (start) {
        rows.push({
          kind: "start", id: start.id, code: start.code,
          pt: start.mapX !== 0 || start.mapY !== 0 ? { x: start.mapX, y: start.mapY } : null,
          seqIndex: -1,
        });
      }
    }
    sequenceIds.forEach((id, i) => {
      const c = coordsById.get(id);
      rows.push({
        kind: "control", id, code: c?.code ?? String(id),
        pt: c && (c.mapX !== 0 || c.mapY !== 0) ? { x: c.mapX, y: c.mapY } : null,
        seqIndex: i,
      });
    });
    if (!selectedCourse.lastAsFinish) {
      const finish = coords.find((c) => c.status === 5);
      if (finish) {
        rows.push({
          kind: "finish", id: finish.id, code: finish.code,
          pt: finish.mapX !== 0 || finish.mapY !== 0 ? { x: finish.mapX, y: finish.mapY } : null,
          seqIndex: -1,
        });
      }
    }
    return rows;
  }, [selectedCourse, sequenceIds, controlCoords.data, coordsById]);

  const legMeters = useMemo(
    () => sequenceLegMeters(displaySeq.map((r) => r.pt), mapScale),
    [displaySeq, mapScale],
  );
  const totalMeters = useMemo(
    () => legMeters.reduce<number>((sum, m) => sum + (m ?? 0), 0),
    [legMeters],
  );

  const selectedControl = useMemo(
    () =>
      state.selectedControlId != null
        ? coordsById.get(state.selectedControlId) ?? null
        : null,
    [state.selectedControlId, coordsById],
  );

  // ─── Mutation plumbing ───────────────────────────────────

  const invalidateMapData = useCallback(() => {
    utils.course.controlCoordinates.invalidate();
    utils.control.list.invalidate();
    utils.course.courseGeometries.invalidate();
    utils.course.list.invalidate();
    utils.course.detail.invalidate();
  }, [utils]);

  /** Run a mutation with pending tracking and user-facing error display. */
  const run = useCallback(
    async <T,>(op: () => Promise<T>): Promise<T | undefined> => {
      setPendingOps((n) => n + 1);
      setErrorMsg(null);
      try {
        return await op();
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        setPendingOps((n) => n - 1);
        invalidateMapData();
      }
    },
    [invalidateMapData],
  );

  const client = utils.client;

  /** Update a course's sequence (and optionally flags), undoably. */
  const applySequence = useCallback(
    async (
      courseSeq: number,
      prev: { ids: number[]; firstAsStart: boolean; lastAsFinish: boolean },
      next: { ids: number[]; firstAsStart?: boolean; lastAsFinish?: boolean },
    ) => {
      const redo = () =>
        client.course.update.mutate({
          id: courseSeq,
          controlIds: next.ids,
          ...(next.firstAsStart !== undefined ? { firstAsStart: next.firstAsStart } : {}),
          ...(next.lastAsFinish !== undefined ? { lastAsFinish: next.lastAsFinish } : {}),
        });
      const done = await run(redo);
      if (done === undefined) return false;
      undoStack.push({
        redo,
        undo: () =>
          client.course.update.mutate({
            id: courseSeq,
            controlIds: prev.ids,
            firstAsStart: prev.firstAsStart,
            lastAsFinish: prev.lastAsFinish,
          }),
      });
      bumpHistory();
      return true;
    },
    [client, run, undoStack, bumpHistory],
  );

  /** Create a control; when `insertAt` is set, also insert it into the
   *  selected course's sequence at that position (one undo entry). */
  const createControl = useCallback(
    async (pt: { x: number; y: number }, insertAt: number | null) => {
      if (!controlList.data) return;
      const code = nextFreeControlCode(controlList.data.map((c) => c.codes));
      const created = await run(() =>
        client.control.create.mutate({ codes: String(code), status: 0, xpos: pt.x, ypos: pt.y }),
      );
      if (!created) return;
      const id = created.id;

      const course = selectedCourse;
      if (insertAt !== null && course) {
        const prevIds = [...sequenceIds];
        const nextIds = [...sequenceIds];
        nextIds.splice(Math.min(insertAt, nextIds.length), 0, id);
        const appended = await run(() =>
          client.course.update.mutate({ id: course.id, controlIds: nextIds }),
        );
        if (appended !== undefined) {
          undoStack.push({
            undo: async () => {
              await client.course.update.mutate({ id: course.id, controlIds: prevIds });
              await client.control.delete.mutate({ id });
            },
            redo: async () => {
              await client.control.restore.mutate({ id });
              await client.course.update.mutate({ id: course.id, controlIds: nextIds });
            },
          });
          bumpHistory();
        }
      } else {
        undoStack.push({
          undo: () => client.control.delete.mutate({ id }),
          redo: () => client.control.restore.mutate({ id }),
        });
        bumpHistory();
      }
      dispatch({ type: "placed", id });
    },
    [controlList.data, run, client, selectedCourse, sequenceIds, undoStack, bumpHistory],
  );

  // ─── Gesture callbacks (stabilized — they flow through MapPanel's memo) ──

  const handleMapClick = useCallback((pt: { x: number; y: number }) => {
    dispatch({ type: "map-click", x: pt.x, y: pt.y });
  }, []);

  const handleMoveEnd = useCallback(
    (idStr: string, pt: { x: number; y: number }) => {
      const id = parseInt(idStr, 10);
      if (Number.isNaN(id)) return;
      const prev = coordsById.get(id);
      dispatch({ type: "select", id });
      // A move re-opens the description question for this control (the
      // suggestion query keys off the new position once it refetches).
      setLastMovedId(id);
      void (async () => {
        const redo = () => client.control.update.mutate({ id, xpos: pt.x, ypos: pt.y });
        const done = await run(redo);
        if (done === undefined || !prev) return;
        undoStack.push({
          redo,
          undo: () => client.control.update.mutate({ id, xpos: prev.mapX, ypos: prev.mapY }),
        });
        bumpHistory();
      })();
    },
    [coordsById, client, run, undoStack, bumpHistory],
  );

  const handleSelect = useCallback((idStr: string | null) => {
    if (idStr === null) {
      dispatch({ type: "select", id: null });
      return;
    }
    const id = parseInt(idStr, 10);
    if (!Number.isNaN(id)) dispatch({ type: "select", id });
  }, []);

  const handleLegClick = useCallback(
    (courseName: string, legIndex: number, pt: { x: number; y: number }) => {
      if (!selectedCourse || courseName !== selectedCourse.name) return;
      // Leg i of the rendered route connects positioned row i → i+1 of
      // the display sequence. Insert before the row the leg ends at
      // (append when it ends at the finish).
      const positioned = displaySeq.filter((r) => r.pt !== null);
      const target = positioned[legIndex + 1];
      const insertAt =
        target === undefined || target.kind === "finish" || target.seqIndex < 0
          ? sequenceIds.length
          : target.seqIndex;
      dispatch({ type: "leg-click", x: pt.x, y: pt.y, insertAt });
    },
    [selectedCourse, displaySeq, sequenceIds.length],
  );

  const handleDelete = useCallback(() => {
    const sel = state.selectedControlId;
    if (sel == null || pendingOps > 0) return;
    const code = coordsById.get(sel)?.code ?? String(sel);
    if (!window.confirm(t("editor.deleteConfirm", { code }))) return;
    // The server cascades the delete out of every course sequence, so
    // undo must put those memberships back — capture the sequences of
    // the courses that currently visit the control.
    const affected = (courses.data ?? [])
      .map((c) => ({
        id: c.id,
        ids: c.controls.split(";").filter(Boolean).map(Number),
      }))
      .filter((c) => c.ids.includes(sel));
    void (async () => {
      const redo = () => client.control.delete.mutate({ id: sel });
      const done = await run(redo);
      if (done === undefined) return;
      undoStack.push({
        redo,
        undo: async () => {
          await client.control.restore.mutate({ id: sel });
          for (const course of affected) {
            await client.course.update.mutate({
              id: course.id,
              controlIds: course.ids,
            });
          }
        },
      });
      bumpHistory();
      dispatch({ type: "deleted", id: sel });
    })();
  }, [state.selectedControlId, pendingOps, coordsById, courses.data, t, client, run, undoStack, bumpHistory]);

  // ─── Control description editor (modal) ──────────────────

  const [descControlId, setDescControlId] = useState<number | null>(null);
  const descControl = descControlId != null ? coordsById.get(descControlId) ?? null : null;

  const saveDescription = useCallback(
    (next: ControlDescription | null) => {
      const id = descControlId;
      setDescControlId(null);
      if (id == null) return;
      // The user has now dealt with this control's description — stop
      // re-offering suggestions for the move that preceded it.
      setLastMovedId((v) => (v === id ? null : v));
      const prev = coordsById.get(id)?.description ?? null;
      void (async () => {
        const redo = () => client.control.update.mutate({ id, description: next });
        const done = await run(redo);
        if (done === undefined) return;
        undoStack.push({
          redo,
          undo: () => client.control.update.mutate({ id, description: prev }),
        });
        bumpHistory();
      })();
    },
    [descControlId, coordsById, client, run, undoStack, bumpHistory],
  );

  const closeDescription = useCallback(() => setDescControlId(null), []);

  // ─── Description autodetect ──────────────────────────────
  // What does the base map say the selected control sits on? Asked for a
  // placed control with no description yet (the freshly placed one, which
  // the reducer auto-selects) — and for the just-moved control, even if
  // it already has one (see `lastMovedId`).

  useEffect(() => {
    if (lastMovedId != null && state.selectedControlId !== lastMovedId) {
      setLastMovedId(null);
    }
  }, [state.selectedControlId, lastMovedId]);

  const suggestFor =
    selectedControl &&
    (!selectedControl.description || selectedControl.id === lastMovedId) &&
    (selectedControl.mapX !== 0 || selectedControl.mapY !== 0) &&
    !state.phantom &&
    descControlId === null
      ? selectedControl
      : null;

  const suggestQuery = trpc.control.suggestDescription.useQuery(
    { x: suggestFor?.mapX ?? 0, y: suggestFor?.mapY ?? 0 },
    { enabled: !!suggestFor && !!mapInfo.data, staleTime: Number.POSITIVE_INFINITY },
  );

  /** Apply a suggested description to a control, undoably. */
  const applyDescription = useCallback(
    (id: number, next: ControlDescription) => {
      const prev = coordsById.get(id)?.description ?? null;
      // Applying settles the description question a move re-opened.
      setLastMovedId((v) => (v === id ? null : v));
      void (async () => {
        const redo = () => client.control.update.mutate({ id, description: next });
        const done = await run(redo);
        if (done === undefined) return;
        undoStack.push({
          redo,
          undo: () => client.control.update.mutate({ id, description: prev }),
        });
        bumpHistory();
      })();
    },
    [coordsById, client, run, undoStack, bumpHistory],
  );

  /**
   * Suggestion rows for the context menu. The viewer takes labels and
   * SVG fragments ready-made, so symbol lookup and localization stay
   * here (same contract as `moveWarnings`).
   */
  const suggestions = useMemo<EditorDescriptionSuggestion[]>(() => {
    const id = suggestFor?.id;
    if (id == null) return [];
    const rows: EditorDescriptionSuggestion[] = [];
    for (const c of suggestQuery.data?.candidates ?? []) {
      const iofD = ocadToIof("d", c.d);
      if (!iofD) continue;
      const iofG = c.g ? ocadToIof("g", c.g) : null;
      const name = iofSymbolName(iofD, i18n.language);
      rows.push({
        id: String(c.isom),
        label: iofG ? `${name} · ${iofSymbolName(iofG, i18n.language)}` : name,
        symbolSvg: IOF_SYMBOLS[iofD] ?? null,
        sideSvg: iofG ? IOF_SYMBOLS[iofG] ?? null : null,
        onApply: () =>
          applyDescription(id, { d: c.d, ...(c.g ? { g: c.g } : {}) }),
      });
    }
    return rows;
  }, [suggestFor?.id, suggestQuery.data, i18n.language, applyDescription]);

  /** Append an existing control to the selected course, undoably. */
  const appendControlToCourse = useCallback(
    (id: number) => {
      if (!selectedCourse) return;
      void applySequence(
        selectedCourse.id,
        { ids: sequenceIds, firstAsStart: selectedCourse.firstAsStart, lastAsFinish: selectedCourse.lastAsFinish },
        { ids: [...sequenceIds, id] },
      );
    },
    [selectedCourse, sequenceIds, applySequence],
  );

  /** Take a control out of the selected course (all visits), undoably.
   *  The control itself survives — this is membership, not deletion. */
  const removeControlFromCourse = useCallback(
    (id: number) => {
      if (!selectedCourse) return;
      void applySequence(
        selectedCourse.id,
        { ids: sequenceIds, firstAsStart: selectedCourse.firstAsStart, lastAsFinish: selectedCourse.lastAsFinish },
        { ids: sequenceIds.filter((x) => x !== id) },
      );
    },
    [selectedCourse, sequenceIds, applySequence],
  );

  // ─── Contextual actions (floating menu at the selection/phantom) ────

  const contextActions = useMemo<EditorContextAction[]>(() => {
    const actions: EditorContextAction[] = [];
    if (state.phantom) {
      const pt = { x: state.phantom.x, y: state.phantom.y };
      if (state.phantom.insertAt !== null && selectedCourse) {
        const at = state.phantom.insertAt;
        actions.push({
          id: "insert",
          label: t("editor.actionInsert"),
          onClick: () => void createControl(pt, at),
        });
      } else {
        if (selectedCourse) {
          actions.push({
            id: "add-to-course",
            label: t("editor.actionAddToCourse", { name: selectedCourse.name }),
            onClick: () => void createControl(pt, sequenceIds.length),
          });
        }
        actions.push({
          id: "add",
          label: t("editor.actionAdd"),
          onClick: () => void createControl(pt, null),
        });
      }
    } else if (state.selectedControlId != null) {
      const sel = state.selectedControlId;
      const c = coordsById.get(sel);
      const isStartFinish = c ? c.status === 4 || c.status === 5 : false;
      if (selectedCourse && !isStartFinish) {
        actions.push({
          id: "append",
          label: t("editor.actionAppend", { name: selectedCourse.name }),
          onClick: () => appendControlToCourse(sel),
        });
        if (sequenceIds.includes(sel)) {
          actions.push({
            id: "remove-from-course",
            label: t("editor.actionRemoveFromCourse", { name: selectedCourse.name }),
            onClick: () => removeControlFromCourse(sel),
          });
        }
      }
      actions.push({
        id: "description",
        label: t("editor.actionDescription"),
        onClick: () => setDescControlId(sel),
      });
      actions.push({
        id: "delete",
        label: t("editor.deleteControl"),
        variant: "danger",
        onClick: handleDelete,
      });
    }
    return actions;
  }, [state.phantom, state.selectedControlId, selectedCourse, sequenceIds,
    coordsById, createControl, appendControlToCourse, removeControlFromCourse,
    handleDelete, t]);

  /** Ids (as overlay strings) of the edited course's controls — these
   *  stay at full strength while everything else fades. */
  const courseControlIdSet = useMemo(
    () => new Set(sequenceIds.map(String)),
    [sequenceIds],
  );

  // ─── Cross-course awareness ──────────────────────────────
  // Which courses use each control, so moving a shared control warns
  // about the other courses it would affect.

  const membership = useMemo(
    () => courseMembership(courses.data ?? []),
    [courses.data],
  );

  /** "Also in: …" info line for the selected control (courses other
   *  than the one being edited). */
  const contextInfo = useMemo(() => {
    if (state.selectedControlId == null) return null;
    const names = membership.get(state.selectedControlId) ?? [];
    const others = selectedCourse ? names.filter((n) => n !== selectedCourse.name) : names;
    return others.length > 0 ? t("editor.alsoIn", { names: others.join(", ") }) : null;
  }, [state.selectedControlId, membership, selectedCourse, t]);

  /** Drag-time warning per control id: moving it affects these courses. */
  const moveWarnings = useMemo(() => {
    const m = new Map<string, string>();
    for (const [id, names] of membership) {
      const others = selectedCourse ? names.filter((n) => n !== selectedCourse.name) : names;
      if (others.length > 0) {
        m.set(String(id), t("editor.affects", { names: others.join(", ") }));
      }
    }
    return m;
  }, [membership, selectedCourse, t]);

  const editor: MapViewerEditorProps = useMemo(
    () => ({
      selectedControlId:
        state.selectedControlId != null ? String(state.selectedControlId) : null,
      phantom: state.phantom ? { x: state.phantom.x, y: state.phantom.y } : null,
      contextActions,
      contextInfo,
      suggestions,
      suggestionsHeading: t("editor.suggestedHeading"),
      courseControlIds: courseControlIdSet,
      fadeNonCourse: !!selectedCourse,
      moveWarnings,
      moveEpoch,
      onMapClick: handleMapClick,
      onMoveEnd: handleMoveEnd,
      onSelect: handleSelect,
      ...(selectedCourse ? { onLegClick: handleLegClick } : {}),
    }),
    [state.selectedControlId, state.phantom, contextActions, contextInfo,
      suggestions, t, courseControlIdSet, moveWarnings, moveEpoch, selectedCourse,
      handleMapClick, handleMoveEnd, handleSelect, handleLegClick],
  );

  // ─── Sidebar actions ─────────────────────────────────────

  const [newCourseName, setNewCourseName] = useState("");
  /** Hide all controls except the selected course's (+ start/finish). */
  const [onlyCourse, setOnlyCourse] = useState(false);
  /** Expanded state of the in-map course selector card. */
  const [mapSelectorOpen, setMapSelectorOpen] = useState(true);
  const handleCreateCourse = useCallback(() => {
    const name = newCourseName.trim();
    if (!name) return;
    void (async () => {
      // Not undoable: there is no course.restore, so an undo/redo pair
      // could not survive; the course can be deleted from the Courses page.
      const created = await run(() => client.course.create.mutate({ name }));
      if (!created) return;
      setNewCourseName("");
      dispatch({ type: "select-course", id: created.id });
    })();
  }, [newCourseName, run, client]);

  const sequenceUpdate = useCallback(
    (nextIds: number[]) => {
      if (!selectedCourse) return;
      void applySequence(
        selectedCourse.id,
        { ids: sequenceIds, firstAsStart: selectedCourse.firstAsStart, lastAsFinish: selectedCourse.lastAsFinish },
        { ids: nextIds },
      );
    },
    [selectedCourse, sequenceIds, applySequence],
  );

  const moveInSequence = useCallback(
    (index: number, dir: -1 | 1) => {
      const next = [...sequenceIds];
      const j = index + dir;
      if (j < 0 || j >= next.length) return;
      [next[index], next[j]] = [next[j], next[index]];
      sequenceUpdate(next);
    },
    [sequenceIds, sequenceUpdate],
  );

  const removeFromSequence = useCallback(
    (index: number) => {
      const next = [...sequenceIds];
      next.splice(index, 1);
      sequenceUpdate(next);
    },
    [sequenceIds, sequenceUpdate],
  );

  const toggleFlag = useCallback(
    (flag: "firstAsStart" | "lastAsFinish") => {
      if (!selectedCourse) return;
      // controlIds is always included so the server rebuilds geometry —
      // flag changes alter which start/finish legs exist.
      void applySequence(
        selectedCourse.id,
        { ids: sequenceIds, firstAsStart: selectedCourse.firstAsStart, lastAsFinish: selectedCourse.lastAsFinish },
        { ids: sequenceIds, [flag]: !selectedCourse[flag] },
      );
    },
    [selectedCourse, sequenceIds, applySequence],
  );

  // ─── Undo / redo ─────────────────────────────────────────

  const runUndo = useCallback(() => {
    setMoveEpoch((v) => v + 1);
    void run(async () => {
      await undoStack.undo();
      bumpHistory();
    });
  }, [run, undoStack, bumpHistory]);

  const runRedo = useCallback(() => {
    setMoveEpoch((v) => v + 1);
    void run(async () => {
      await undoStack.redo();
      bumpHistory();
    });
  }, [run, undoStack, bumpHistory]);

  // ─── Keyboard shortcuts (page-level, not viewer-level) ──────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The description modal owns the keyboard while open (its own
      // capture-phase handler deals with Escape).
      if (descControlId != null) return;
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) runRedo();
        else runUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        runRedo();
      } else if (e.key === "Escape") {
        // Dismissal cascade first (phantom → selection → course); once
        // nothing is left, Esc leaves fullscreen. In fullscreen the map
        // panel holds a keyboard lock on Escape (Chromium) so a short
        // press actually reaches this handler instead of the browser
        // swallowing it for its own fullscreen exit.
        if (
          state.phantom === null &&
          state.selectedControlId === null &&
          state.selectedCourseId === null &&
          document.fullscreenElement
        ) {
          void document.exitFullscreen().catch(() => {});
        } else {
          dispatch({ type: "escape" });
        }
      } else if (e.key === "h" || e.key === "H") {
        // Toggle "hide other controls" — same as the toolbar button, so
        // it needs a selected course to mean anything.
        if (selectedCourse && !e.ctrlKey && !e.metaKey && !e.altKey) {
          setOnlyCourse((v) => !v);
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleDelete();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleDelete, runUndo, runRedo, descControlId, selectedCourse,
    state.phantom, state.selectedControlId, state.selectedCourseId]);

  // ─── Deep links (?course=<seq>, ?control=<code>) ─────────────────────

  const deepLinkConsumedRef = useRef(false);
  useEffect(() => {
    if (deepLinkConsumedRef.current) return;
    const courseParam = searchParams.get("course");
    const controlParam = searchParams.get("control");
    if (!courseParam && !controlParam) {
      deepLinkConsumedRef.current = true;
      return;
    }
    if (courseParam && !courses.data) return; // wait for data
    if (controlParam && !controlCoords.data) return;
    deepLinkConsumedRef.current = true;
    if (courseParam) {
      const id = parseInt(courseParam, 10);
      if (courses.data?.some((c) => c.id === id)) {
        dispatch({ type: "select-course", id });
      }
    }
    if (controlParam) {
      const id = parseInt(controlParam, 10);
      if (controlCoords.data?.some((c) => c.id === id)) {
        dispatch({ type: "select", id });
      }
    }
  }, [searchParams, courses.data, controlCoords.data]);

  // ─── Toolbar (rendered inside MapPanel's unified toolbar row) ───────

  const canUndo = undoStack.canUndo;
  const canRedo = undoStack.canRedo;

  const toolbar = useMemo(
    () => (
      <div className="flex items-center gap-2 min-w-0" data-testid="course-editor-toolbar">
        <button
          data-testid="editor-undo"
          disabled={!canUndo}
          onClick={runUndo}
          title={t("editor.undo")}
          className={`text-xs px-2 py-1 rounded-md transition-colors ${canUndo ? "text-slate-500 hover:text-slate-700 hover:bg-slate-100 cursor-pointer" : "text-slate-300 cursor-not-allowed"}`}
        >
          ⟲
        </button>
        <button
          data-testid="editor-redo"
          disabled={!canRedo}
          onClick={runRedo}
          title={t("editor.redo")}
          className={`text-xs px-2 py-1 rounded-md transition-colors ${canRedo ? "text-slate-500 hover:text-slate-700 hover:bg-slate-100 cursor-pointer" : "text-slate-300 cursor-not-allowed"}`}
        >
          ⟳
        </button>
        <span className="w-px h-4 bg-slate-200" />
        <button
          data-testid="editor-hide-others"
          disabled={!selectedCourse}
          onClick={() => setOnlyCourse((v) => !v)}
          title={t("editor.hideOtherControls")}
          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
            !selectedCourse
              ? "text-slate-300 cursor-not-allowed"
              : onlyCourse
                ? "bg-purple-100 text-purple-700 font-medium cursor-pointer"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"
          }`}
        >
          {t("editor.hideOtherControls")}
        </button>
        {selectedControl && (
          <span
            data-testid="editor-selected-info"
            className="text-xs text-slate-600 truncate"
          >
            {t("editor.selectedControl", { code: selectedControl.code })}
            {" · "}
            {t("editor.position", {
              x: selectedControl.mapX.toFixed(1),
              y: selectedControl.mapY.toFixed(1),
            })}
          </span>
        )}
        {pendingOps > 0 && (
          <span className="text-xs text-slate-400">{t("editor.saving")}</span>
        )}
        {errorMsg && (
          <span className="text-xs text-red-600 truncate" data-testid="editor-error">
            {errorMsg}
          </span>
        )}
      </div>
    ),
    [t, selectedCourse, selectedControl, onlyCourse,
      pendingOps, errorMsg, canUndo, canRedo, runUndo, runRedo],
  );

  // ─── In-map course panel ─────────────────────────────────

  // THE course UI — there is no page sidebar. Living inside the map box
  // (via MapPanel's `mapOverlay` slot) keeps it visible in fullscreen,
  // which the browser only grants to the map panel element. Contents:
  // create-course row, the course list, and — with a course selected —
  // the full display sequence with per-leg meters, reorder/remove and
  // the start/finish flags. The header row collapses everything down to
  // the selected course's name.
  const coursePanel = useMemo(
    () => (
      <div
        data-testid="editor-map-course-selector"
        className="pointer-events-auto bg-white/95 backdrop-blur-sm border border-slate-200 rounded-lg shadow-sm text-xs w-64 max-h-full flex flex-col overflow-hidden"
      >
        <button
          data-testid="editor-map-selector-toggle"
          onClick={() => setMapSelectorOpen((v) => !v)}
          title={t("editor.mapSelectorToggle")}
          className="w-full shrink-0 flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-slate-50 cursor-pointer"
        >
          <span className="text-slate-400">{mapSelectorOpen ? "▾" : "▸"}</span>
          <span className="flex-1 truncate font-medium text-slate-700">
            {selectedCourse?.name ?? t("editor.mapSelectorNone")}
          </span>
        </button>
        {mapSelectorOpen && (
          <>
            <div className="shrink-0 flex gap-1.5 px-2 pb-1.5 border-b border-slate-100">
              <input
                data-testid="editor-new-course-name"
                value={newCourseName}
                onChange={(e) => setNewCourseName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateCourse(); }}
                placeholder={t("editor.newCoursePlaceholder")}
                className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-purple-400"
              />
              <button
                data-testid="editor-create-course"
                onClick={handleCreateCourse}
                disabled={!newCourseName.trim()}
                className={`px-2 py-1 rounded-md transition-colors ${newCourseName.trim() ? "bg-purple-600 text-white hover:bg-purple-700 cursor-pointer" : "bg-slate-100 text-slate-400 cursor-not-allowed"}`}
              >
                {t("editor.createCourse")}
              </button>
            </div>
            {/* Scales with the viewport so a long course list can use the
                room a big screen offers; the sequence below takes whatever
                height remains (the card itself is capped to the map). */}
            <div className="shrink-0 max-h-[40vh] overflow-y-auto divide-y divide-slate-50">
              {(courses.data ?? []).map((c) => (
                <button
                  key={c.id}
                  data-testid="editor-course-item"
                  data-course-name={c.name}
                  onClick={() =>
                    dispatch({
                      type: "select-course",
                      id: state.selectedCourseId === c.id ? null : c.id,
                    })
                  }
                  className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left transition-colors cursor-pointer ${
                    state.selectedCourseId === c.id
                      ? "bg-purple-50 text-purple-800 font-medium"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <span className="truncate">{c.name}</span>
                  <span className="text-slate-400 shrink-0">
                    {c.controlCount} · {c.length} m
                  </span>
                </button>
              ))}
              {courses.data && courses.data.length === 0 && (
                <p className="px-2.5 py-2 text-slate-400">{t("noCourses")}</p>
              )}
            </div>
            {selectedCourse ? (
              <>
                <div className="shrink-0 px-2.5 py-1.5 flex items-center gap-3 border-t border-slate-200">
                  <label className="flex items-center gap-1 text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="editor-toggle-first-start"
                      checked={selectedCourse.firstAsStart}
                      onChange={() => toggleFlag("firstAsStart")}
                    />
                    {t("firstAsStartShort")}
                  </label>
                  <label className="flex items-center gap-1 text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      data-testid="editor-toggle-last-finish"
                      checked={selectedCourse.lastAsFinish}
                      onChange={() => toggleFlag("lastAsFinish")}
                    />
                    {t("lastAsFinishShort")}
                  </label>
                </div>
                <ol
                  className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-50 border-t border-slate-100"
                  data-testid="editor-sequence"
                >
                  {displaySeq.map((row, i) => (
                    <li
                      key={`${row.kind}-${i}`}
                      data-testid="editor-seq-row"
                      data-kind={row.kind}
                      data-code={row.code}
                      className="flex items-center gap-1.5 px-2.5 py-1"
                    >
                      <span className={`w-5 shrink-0 font-semibold ${row.kind === "control" ? "text-purple-700" : "text-slate-400"}`}>
                        {row.kind === "start" ? "S" : row.kind === "finish" ? "F" : row.seqIndex + 1}
                      </span>
                      <span className="flex-1 text-slate-700 truncate">{row.code}</span>
                      <span className="text-slate-400 w-12 text-right shrink-0">
                        {legMeters[i] != null ? `${legMeters[i]} m` : ""}
                      </span>
                      {row.kind === "control" && (
                        <span className="flex gap-0.5 shrink-0">
                          <button
                            data-testid="editor-seq-up"
                            disabled={row.seqIndex === 0}
                            onClick={() => moveInSequence(row.seqIndex, -1)}
                            className={`px-1 rounded ${row.seqIndex === 0 ? "text-slate-200 cursor-not-allowed" : "text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"}`}
                            title={t("editor.moveUp")}
                          >↑</button>
                          <button
                            data-testid="editor-seq-down"
                            disabled={row.seqIndex === sequenceIds.length - 1}
                            onClick={() => moveInSequence(row.seqIndex, 1)}
                            className={`px-1 rounded ${row.seqIndex === sequenceIds.length - 1 ? "text-slate-200 cursor-not-allowed" : "text-slate-400 hover:text-slate-700 hover:bg-slate-100 cursor-pointer"}`}
                            title={t("editor.moveDown")}
                          >↓</button>
                          <button
                            data-testid="editor-seq-remove"
                            onClick={() => removeFromSequence(row.seqIndex)}
                            className="px-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 cursor-pointer"
                            title={t("editor.removeFromCourse")}
                          >✕</button>
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
                <div
                  className="shrink-0 px-2.5 py-1.5 border-t border-slate-200 flex items-center justify-between text-slate-600"
                  data-testid="editor-course-total"
                >
                  <span>{t("controlCount", { count: sequenceIds.length })}</span>
                  <span className="font-semibold">{totalMeters} m</span>
                </div>
              </>
            ) : (
              <p className="shrink-0 px-2.5 py-2 text-slate-400 border-t border-slate-100">
                {t("editor.noCourseSelected")}
              </p>
            )}
          </>
        )}
      </div>
    ),
    [t, courses.data, state.selectedCourseId, selectedCourse, mapSelectorOpen,
      newCourseName, handleCreateCourse, displaySeq, legMeters, totalMeters,
      sequenceIds.length, moveInSequence, removeFromSequence, toggleFlag],
  );

  // ─── Render ──────────────────────────────────────────────

  const hint = t("editor.hint");

  return (
    <div data-testid="course-editor-page">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-slate-800">{t("editor.title")}</h1>
        <p className="text-sm text-slate-500" data-testid="editor-hint">{hint}</p>
      </div>
      <div className="h-[calc(100vh-240px)] min-h-[420px]">
        {/* ── Map (the course panel floats inside it, see coursePanel) ── */}
        <div className="h-full bg-white rounded-xl border border-slate-200 overflow-hidden">
          <MapPanel
            fillContainer
            fitToControls
            filterMode={onlyCourse && selectedCourse ? "course" : "all"}
            defaultShowDescriptions
            descriptionsAllControls
            toolbar={toolbar}
            mapOverlay={coursePanel}
            editor={editor}
            highlightCourseName={selectedCourse?.name}
          />
        </div>
      </div>

      {descControl && (
        <ControlDescriptionEditor
          controlCode={descControl.code}
          initial={descControl.description}
          onSave={saveDescription}
          onCancel={closeDescription}
        />
      )}
    </div>
  );
}
