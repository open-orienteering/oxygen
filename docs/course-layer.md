# Course layer

Status: **draft** — chapter of the vector map pipeline specification,
started by sub-slice C0. The research record is
`docs/research/vector-map-pipeline/08-course-editor.md` §4.1, §4.5 and
`04-render-core.md` §7; when the two disagree, this document wins.

This chapter is normative for `packages/shared/src/course/`.

## Decisions taken before the code (user, 2026-10-24)

- **Sizes.** The 7xx symbols are drawn at the library's dimensions ×
  the document factor (03 §6.6): an ISOM map at 1:10 000 gets 7.5 mm
  circles, 0.525 mm lines and 6 mm digits; an ISSprOM map 6 mm circles.
  A stored template appearance becomes a multiplier of the library
  dimension (stored ÷ legacy default), so default templates print spec
  sizes. Legacy's 5 mm / 0.35 mm / 4 mm on every map is the third
  sanctioned difference for `course-print.md`.
- **Control numbers.** Default `numberStyle: "spec"` — the library entry
  as it is (ISOM 704 lower purple without a halo, ISSprOM 704 upper
  purple without an outline). `"knockout"` is the opt-in legacy look:
  upper purple with a 0.15 mm upper-white outline (ISSprOM 704.b) on both
  libraries.
