# Bugfix: Chrome's "press Esc to exit full screen" bubble flickers in the editor

**Date:** 2026-11-02 · **Branch:** `vector-map-pipeline`

## What happened

With the new course editor in fullscreen, any interaction with a control —
and in particular just moving the pointer with an armed tool (`K`, `F`, …)
— made Chrome show its "Press Esc to exit full screen" bubble again and
again, flickering as the pointer moved.

## Why

`MapPanel` locks the Escape key through the Keyboard Lock API while the
editor is fullscreen, so a short Esc reaches the editor's dismissal cascade
instead of leaving fullscreen (`docs/course-editor.md` §3). The effect that
holds the lock was keyed on the `editor` prop object:

```ts
useEffect(() => { … kb.lock(["Escape"]) …; return () => kb.unlock?.(); }, [editor, isFullscreen]);
```

`EditorPage` builds that object with `useMemo`, but its inputs include the
tool binding, and the binding changes on every hover while a tool is armed
(the ghost follows the cursor) and on every selection. So each of those
renders re-ran the effect: unlock, then lock again. Chromium shows its
exclusive-access bubble every time a keyboard lock becomes active, hence
one bubble per pointer move. The legacy editor never re-rendered at that
rate, which is why it showed up with D5's tools.

## Fix

The effect is keyed on *whether* there is an editor (`const hasEditor =
!!editor`), not on the object, so the lock is taken once when fullscreen
starts and released once when it ends
(`packages/web/src/components/MapPanel.tsx`).

## Test

`e2e/editor-fullscreen.spec.ts` stubs `navigator.keyboard` with counters,
enters fullscreen in the editor, arms `K`, moves the pointer across eight
points (the ghost follows each one), and asserts one `lock` and no
`unlock`; Escape leaves the tool with the lock still held; leaving
fullscreen unlocks once. The file stays apart from
`course-editor.spec.ts`, which two sub-slice sessions were editing at the
time; D10 folds it in.
