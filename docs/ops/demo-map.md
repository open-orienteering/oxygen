# The o-kartan demo map

A real Swedish forest map that Oxygen may publish as a vector file: the
demo and showcase map since 2026-11, in place of Puit de Laven
([demo.md, "The map"](demo.md#the-map)). The demo competition's controls
stand on its invented features ([demo.md, "Controls on the demo map"](demo.md#controls-on-the-demo-map)).

| File | What it is |
|---|---|
| `fixtures/okartan/okartan-original.ocd` | The map as bought, byte for byte |
| `fixtures/okartan/okartan-demo.ocd` | The original plus invented detail, made by `packages/api/scripts/demo-map/` (below) |

## Source and licence

Bought by the project maintainer from [o-kartan.se](https://o-kartan.se) (order
1056, 2026-11-21): a cut of the club's home training grounds, licensed
to the buyer for any use, including publishing it and keeping it in this
repository. The map is made automatically from Lantmäteriet's laser
scan: OCAD 12, ISOM 2017-2, 1:15 000, about 170 × 216 mm (2.6 × 3.2 km),
georeferenced in SWEREF 99 TM. SHA-256 of the original:
`1db7dde39fb8d32dee5fb1633ce2ecc99c91213113f9cc84c519ec6ea7896672`.

The club map Oxygen's own screenshots used before (Flaten / Ekudden) is a
different map and stays out of git.

## Invented detail

The original has no boulders at all, and its cliffs are hundreds of short
(about 0.6 mm) untagged segments from the laser scan. The demo version
adds detail that fits the terrain. It is invented, not surveyed:

| Pass | What it adds | Where |
|---|---|---|
| Point features | 300 boulders (204), 35 large boulders (205), 20 boulder clusters (207), 60 knolls (109), 20 elongated knolls (110), 30 depressions (111), 20 pits (112) | Boulders lean toward cliffs and bare rock, some in loose groups of 2–4; landforms only with a contour within 2.5 mm, elongated knolls along the nearest contour. Never in water, marsh, open land, paved, out-of-bounds or built-up areas (5 mm from buildings), 0.9 mm from paths, roads and fences, near the map edge, on lines or on other points; at most 4 new features in any 6 mm circle |
| Cliff tags | Tags on 77 of the existing cliffs (201.003 → 201.000, 202.000 → 202.002) | Segments that continue each other are joined (impassable cliffs only across near-touching gaps and up to 2.5 mm long, cliffs up to 6 mm); a chain of at least 1 mm in busy relief whose two sides differ by at least 1.5 m in the ground model gets tags, pointing downhill. The joined segments are marked deleted |
| Steep ground | 113 broken tagged cliffs (202.002; 201.000 where the ground reaches 1.3 m/m) | Where the ground model is steeper than 0.8 m/m (about the steepest 2 % of the map) and no cliff is drawn within 1.1 mm: pieces of 0.9–2.4 mm with 0.4–1.3 mm gaps along the top of the steep band, each following the contours, tags downhill |

The two cliff passes read the map's ground height field, the
`ground.lantmateriet-2m` row of `map_heightfields`
([map-terrain.md](../map-terrain.md) §7), which a stack with height data
configured fetches when the map is imported. It is not committed: the
field is exported from the database that holds it.

Seed 1056 with that field gives the committed `okartan-demo.ocd` byte
for byte. The original's objects are untouched, apart from the joined
cliff segments' status byte. New objects are appended as new object index
blocks, so OCAD and Oxygen read the file as usual and the invented
objects can be edited by hand in OCAD.

## Regenerate

```bash
# The height field: the map's stored ground model, from a stack that has imported
# fixtures/okartan/okartan-original.ocd with height data configured.
psql "$DATABASE_URL" -Atc "select encode(h.bytes, 'base64') from oxygen.map_heightfields h
  join oxygen.map_documents d on d.hash = h.document_hash
  where h.source = 'ground.lantmateriet-2m' and d.hash = '<document hash>'" | base64 -d > ground.bin

pnpm --filter @oxygen/api demo-map:enrich -- --heights ground.bin [--seed 1056] [--report report.json]
```

Without `--heights` only the point features are added. Hand edits to
`okartan-demo.ocd` are lost on a regeneration, so after the first hand
edit the committed file is the source and the script is the record of
how the invented detail began.

## Tests

| Level | File | Covers |
|---|---|---|
| Unit (api) | `packages/api/src/__tests__/demo-map-enrich.test.ts` | Seeded (same seed same bytes, another seed other bytes); without a field only the planned points are appended and the original's bytes are unchanged; no invented point in water or a building; with a synthetic field falling east, every tagged cliff (retagged and steep-ground) runs so its tags point downhill, and the output reads with the joined segments gone |

## Pending

- After a hand edit in OCAD, the committed file is the source: re-pin the
  fixture (`node scripts/patch-showcase-map.mjs`), update its hash in
  `scripts/lib/map-files.mjs`, and check that the controls still stand on
  features (`pnpm test:scripts`).
