-- Stacked 256×512 tile format (composite + ink). Pure cache — drop all
-- rows so no legacy 256×256 PNG is served into the client slicer.
TRUNCATE TABLE oxygen.map_tiles;
