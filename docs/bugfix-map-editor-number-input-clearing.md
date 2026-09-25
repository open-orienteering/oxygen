# Bugfix: Map editor number inputs could not be cleared

## Symptom

In the map layout editor property panel, the line-width (and font-size)
`<input type="number">` fields snapped back as soon as the user deleted a
digit. Clearing the field to type a new value was impossible.

## Cause

`onChange` wrote `Number(event.target.value)` straight into object state.
An empty string becomes `0`, which React then pushed back into the
controlled `value`, so the field never stayed blank.

## Fix

`NumberField` keeps a string draft while the input is focused and only
commits through `parseLiveNumberDraft` when the draft is a finite number
inside `[min, max]`. On blur (or Enter) an invalid/empty draft falls back
to the last committed value. The same pattern was already used for print
scale and description cell size via `parseClampedNumberDraft`; the live
variant exists so partial edits like `"0."` do not commit prematurely.
