-- J19 (docs/course-maps.md "Data model", docs/map-rendering.md §4.11): a graphic's traced outline, the footprint a
-- knockout image cuts by. NULL until traced (lazily, the first time a knockout image of it is loaded); `[]` when the
-- silhouette is the whole box; else outer rings in fractions of the graphic (`render.traceOutline`).
ALTER TABLE "oxygen"."graphics" ADD COLUMN "outline" JSONB;
