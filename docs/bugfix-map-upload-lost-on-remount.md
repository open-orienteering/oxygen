# Bugfix: a map upload could be silently dropped on a remounting panel

## Symptom

`e2e/class-presets.spec.ts` failed reproducibly (3 runs out of 3) waiting
for `map-viewer` after uploading `e2e/test.ocd`:

```
Error: expect(locator).toBeVisible() failed
Locator: getByTestId('map-viewer')
Timeout: 60000ms
Error: element(s) not found
```

The failure screenshot showed the map panel sitting in its untouched empty
state — "Drop an OCAD map file (.ocd) here" with the **Upload map** button,
no spinner, no error text. The server logged nothing: no `course.uploadMap`
request ever arrived.

## Root cause

Two defects stacked, which is why it presented as "nothing happened".

### 1. The file input is remounted on navigation

At narrow viewports `MapSlot` renders `<MapPanel>` inline rather than
delegating to the shell-owned persistent panel:

```tsx
if (isWide) return null;
return <MapPanel {...props} />;
```

Inline means the panel sits at a different position in the React tree on
every page, so React unmounts and remounts it across a route change — as
`MapSlot`'s own doc comment notes. The hidden `<input type="file">` that
the **Upload map** button drives is recreated along with it.

Instrumenting the DOM with a `MutationObserver` on the panel's
`data-instance-id` (a `useId()`, so it changes on every mount) shows the
race precisely. Failing run:

```
87ms  --- clickTab(Courses) returned ---
178ms panel instance _r_0_ -> _r_1_     <- remount, new file input node
184ms --- clicked Upload map ---        <- 6 ms later
204ms --- setFiles done ---
map-viewer count: 0                     <- upload lost, no request
```

Passing run, same code, only the timing differs:

```
156ms mounted input serial=1
237ms --- clicked Upload map ---        <- 81 ms after the remount
272ms CHANGE on serial=1 connected=true files=1
```

When the file arrives too soon after the remount it lands on the detached
input. React's event delegation never sees the `change`, `handleFile` is
never called, and no request is made. Tracking every input node across the
run makes the discarded generations visible:

```
nodes: [{serial:0,connected:false},{serial:1,connected:false,files:1},{serial:2,connected:true,files:0}]
```

### 2. Every failure path in `handleFile` was silent

```tsx
const handleFile = useCallback((file: File) => {
  if (!file.name.toLowerCase().endsWith(".ocd")) return;
  void fileToBase64(file).then((fileDataBase64) => {
    uploadMutation.mutate({ fileName: file.name, fileDataBase64 });
  });
}, [uploadMutation]);
```

The extension check returns quietly, and the promise has no `.catch()`, so
a read failure became an unhandled rejection. The panel renders
`uploadError` and `uploadMutation.isPending` — neither is set on those
paths, so the UI is indistinguishable from "the button did nothing".

## Fix

### App

`handleFile` now ends every path in `uploadError`: a rejected extension
says so by name, and a failed read is caught and reported. This does not
prevent a lost `change` event (no handler runs at all in that case), but it
removes the whole class of silent no-ops around it, including the one a
user can trigger today by drag-dropping a non-`.ocd` file.

### Tests

New helper `e2e/helpers/map-upload.ts`:

- `waitForStableMapPanel(page)` polls `data-instance-id` until three
  consecutive reads agree, so it waits on observed quiescence rather than
  sleeping for a guessed duration.
- `uploadEventMap(page, file?)` wraps the settle-then-choose-file dance.

`class-presets.spec.ts` now asserts the courses list has rendered before
uploading, then calls `uploadEventMap(page)`. The page-ready assertion
matters: it guarantees the route transition (and therefore the remount)
has already happened before the stability poll starts, so the poll cannot
sample three times inside the pre-navigation window and declare victory
early.

Verified 3 consecutive passes of the previously 3-for-3 failing spec, plus
a full sharded suite run.

## Why not a real user's problem (mostly)

Nobody clicks **Upload map** within 6 ms of a route change, so the
navigation-remount race is effectively test-only. The narrower version is
reachable, though: the panel also remounts when it switches between its
empty / loading / has-map branches, so if `hasMap` flips while the OS file
dialog is open — another operator uploading a map for the same event, say —
the returning file lands on a dead input. That is rare enough not to
justify restructuring the component now, but it is the reason the silent
paths were worth closing: the next person to hit it will at least not be
told "nothing happened".

If it does resurface, the fix is to lift the hidden input out of the three
conditional `return` branches so a branch switch stops recreating it.

## Adjacent coverage gap

Six other specs (`course-editor`, `control-series`, `map-multicourse`,
`map-control-circles`, `editor-start-finish`, `competition`) do the same
click-then-`setFiles` dance by hand and are exposed to the same race; they
happen to pass today because they upload later in a settled page. They
should move to `uploadEventMap` when next touched.
