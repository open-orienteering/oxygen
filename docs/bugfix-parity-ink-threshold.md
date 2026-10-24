# Bugfix: corpus parity counted a tone on the ink threshold as a missing shape

## What happened

B9's shape measure (`unexplainedPixels`, `packages/api/src/render/parity.ts`,
`docs/map-rendering.md` §6.4) marks a pixel as ink when some channel is
more than 48 levels below white, and counts a pixel as unexplained when it
is ink on one side with no ink within one pixel on the other. A flat tone
whose deviation from white sits on the threshold flips the mask on a
one-level difference: the C7 corpus print run (`docs/course-print.md`
§11) found Crop-A's 214.0 (bare rock) drawn at `(206, 207, 209)` by the
legacy and `(207, 208, 210)` by the document path. Deviation 49 is ink, 48
is not, so the whole area counted as missing on one side: 68 % of its ink
"unexplained", the symbol `diverges` without a sanctioned code, and the
map failed the gate on identical shapes. No pixel of the symbol differed
by more than the channel tolerance.

## The fix

A pixel counts as unexplained only if it also differs from the other side
by more than the channel tolerance (16, the one `runParity` passes for
*differing*). A real missing, extra or displaced part is ink against
paper — far beyond 16 levels — so it still counts; a tone a level either
side of the threshold no longer does. Crop-A's 214.0: 68 % → 0, `close`.

The rule only removes counts, so no verdict recorded before it (the
`map-rendering.md` §6.4 tables, measured by B9 and B10) can flip from
`close` to `diverges`.

## Tests

`packages/api/src/render/__tests__/parity.test.ts` "does not count a tone
on the ink threshold that differs by less than the channel tolerance":
the same 4 × 4 area at 206 and at 207 has no unexplained pixels, at 180
against white all 16 count. The test fails on the old rule (16 for the
first pair).
