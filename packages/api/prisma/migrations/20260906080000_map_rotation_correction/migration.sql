-- Manual north/grivation correction for mis-georeferenced OCAD files
-- (drawing magnetic-north-up but ScalePar angle a=0). Degrees, clockwise
-- positive; applied on top of the file's own grivation when deriving
-- bounds / north_offset / calibration and when warping tiles.
ALTER TABLE oxygen.map_files
  ADD COLUMN rotation_correction DOUBLE PRECISION NOT NULL DEFAULT 0;
