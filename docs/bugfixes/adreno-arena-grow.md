# Bugfix: vertex arenas lost data when growing on Adreno (Galaxy S25)

**Seen** 2026-10-23 on a Galaxy S25 Ultra (Adreno 830, Chrome 155,
`ANGLE (Qualcomm, Adreno (TM) 830, OpenGL ES 3.2)`) against production
`v0.3.0`, on an event switched to `vector`: on the smaller club map,
whole cells were missing their contour lines while everything else drew,
and sometimes a fan of straight black lines shot out of one small place
across the map. No console or network errors; `gl.getError()` was 0. The
laptop never showed it.

## Cause

`GpuArena.growTo` (`packages/web/src/map-gl/arena.ts`, 04 §6.8 point 1)
grew a vertex arena by creating a larger buffer and
`copyBufferSubData`-ing the old one into it. On this driver the copy
returns **zeros for ranges of a buffer that has in-flight draws** — the
production pattern, since detail parts arrive and are uploaded while
frames render. Diagnosed over `adb` + Chrome DevTools Protocol on the
live page:

- Reading every resident part back from the GPU (`getBufferSubData`) and
  comparing with the CPU copies: the stroke arena had one contiguous
  range (11 detail parts, ≈ 4 MB) of zeros; fill and hatch were
  byte-identical. Zeroed contour strokes are the missing contours; a part
  that is half intact, half zeros puts its remaining vertices at the
  document origin — the fan of lines.
- A synthetic replay of the arena (15 grows, 90 sub-allocated uploads):
  0 bad bytes without draws between uploads, **7.75 of 36 MB lost** with
  a draw from the buffer between them. `gl.flush()` / `gl.finish()` before
  the copy did not help (6.9 MB lost). Deleting the old buffer or not made
  no difference.
- Re-uploading the live ranges from their CPU views into the new buffer
  instead: 0 bad bytes, 378 ms vs 495 ms for the copy variant.

## Fix

`GpuArena` keeps a registry of live ranges (first vertex → the view `put`
received; the renderer keeps those alive in `ResidentPart.part` anyway)
and `growTo` re-uploads them with `bufferSubData` into the new buffer.
Offsets still never move; VAOs are re-pointed through `generation` as
before. `release` drops the range from the registry. Unit test:
`packages/web/src/map-gl/__tests__/arena.test.ts` (grow re-uploads every
live range, never calls `copyBufferSubData`, released ranges are not
re-uploaded). Spec: `docs/map-rendering.md` §5.2; decision-log row
2026-10-23.

## How to debug the next one

Chrome on Android exposes DevTools over `adb`:
`adb forward tcp:9222 localabstract:chrome_devtools_remote`, then
`http://127.0.0.1:9222/json/list` and a WebSocket to the page
(`Runtime.evaluate`; send no `Origin` header or Chrome answers 403). The
live `MapGlEngine` is reachable from the canvas's React fiber (the
`useRef` hook of `VectorMapLayer`); `engine.renderer.gl` is the context,
`engine.renderer.arena.parts` the resident parts with their CPU views and
arena offsets, so GPU contents can be compared with
`gl.getBufferSubData`. `adb exec-out screencap -p` captures the artefact.
