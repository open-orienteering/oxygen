-- J2: a graphic's pixel size (docs/course-maps.md "Data model"). Additive and nullable.
ALTER TABLE "oxygen"."graphics" ADD COLUMN "width_px" INTEGER;
ALTER TABLE "oxygen"."graphics" ADD COLUMN "height_px" INTEGER;

-- Backfill the PNGs from their IHDR (bytes 16–23, big-endian). SVGs are
-- filled by the API the first time `graphics.list` reads them.
UPDATE "oxygen"."graphics"
SET
  "width_px" = (get_byte("data", 16) << 24) | (get_byte("data", 17) << 16) | (get_byte("data", 18) << 8) | get_byte("data", 19),
  "height_px" = (get_byte("data", 20) << 24) | (get_byte("data", 21) << 16) | (get_byte("data", 22) << 8) | get_byte("data", 23)
WHERE "mime" = 'image/png'
  AND length("data") >= 24
  AND substring("data" from 13 for 4) = 'IHDR'::bytea
  AND get_byte("data", 16) < 128
  AND get_byte("data", 20) < 128;
