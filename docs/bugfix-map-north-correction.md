# Bugfix: map north correction for mis-georeferenced OCAD files

> **Superseded (Sep 2026).** The georeference half of this fix was wrong:
> the "suggested correction" measures how stale the drawn north lines
> are, not a registration error, and auto-applying it displaced GPS by
> ~200 m. Auto-apply is removed, the Settings input is gone, and the
> number is now shown as a north-line staleness warning. See
> [bugfix-auto-north-correction-gps-offset.md](bugfix-auto-north-correction-gps-offset.md).
> The display-orientation half (§2, `northOffset` fold) still stands.

## Symptom

Some club maps (e.g. Nackareservatet) declare ScalePar `a=0` (no
grivation) even though the drawing is rotated relative to true north.
After Oxygen warps tiles into true-north Web Mercator and the viewer
CSS-rotates by `-northOffset`, the map's magnetic-north lines still
leaned ~3.3° on screen — and changing the north-correction input did
not visibly do anything.

## Two distinct problems

This went through three wrong answers ("~11°" eyeballed, then a
physics-only "4.5°/5°") before the geometry was actually worked
through. There are two separate things to get right, and the original
fix conflated them:

### 1. The georeference (GPS overlays, geo bounds)

The meridian lines drawn in the file (ISOM 601.x) mark magnetic north
on the ground, so with a correct georeference their true bearing equals
the magnetic declination. In both Nackareservatet files the meridians
are **tilted 3.3° inside the paper drawing** (the drawing was rotated
to fit the sheet), which the physics-only formula ignored:

```
suggested = declination + trueNorthFromGrid − declaredGrivation − meridianTilt
          ≈ 7.8 + (−2.8) − 0 − 3.3 ≈ +1.7°     (Nackareservatet, 2026)
```

`detectNorthCorrection` (`map-north.ts`) now subtracts the measured
meridian tilt when a 601.x cluster is found. Without meridians the tilt
term is 0 and the formula degrades to the physics estimate.

### 2. The on-screen orientation ("make the north lines vertical")

The viewer shows the map rotated by `-northOffset`. `northOffset` was
derived from paper +Y, so the display was always **paper-up** — and the
meridians leaned by their in-paper tilt. Crucially, changing
`rotationCorrection` rotates the georeference *and* `northOffset` by
the same amount, which cancels exactly on screen. Measured with the
real file: on-screen lean was 3.31° at correction 0° **and** at 5°.
That is why the input appeared to be a no-op — it never was one for
GPS alignment, but it cannot affect uprightness by construction.

The fix: `metadataFromOcad` (`event-map.ts`) folds the meridian tilt
into the stored `northOffset` via `displayNorthOffsetDeg`
(`map-north.ts`), so screen-up follows the meridian lines instead of
the paper edges. Maps without meridian lines keep paper-up display.

## Fix summary

1. Persist **rotation correction** on both `map_files` and
   `club_map_files` (degrees, clockwise positive), plus a JSONB
   `north_detection` diagnostic.
2. `withGrivationCorrection(crs, deg)` wraps the OCAD CRS so effective
   grivation = file + correction (`toProjectedCoord` reimplemented —
   spreading `{...crs, grivation}` leaves the method closed over the
   original angle).
3. Import-time `detectNorthCorrection` / `resolveMapNorth` computes the
   suggestion **including the meridian-tilt term** and auto-applies when
   a meridian-line cluster is present and `|suggested| ≥ 1.5°`.
4. `northOffset` now means "bearing from true north to display-up"
   (meridian direction when present, else paper +Y). Every path that
   derives metadata goes through `metadataFromOcad`, so upload, club
   upload, `setRotation` on either table, and the legacy-row backfill
   all agree.
5. Tile renderer applies the same CRS wrapper before `wgs84ToOcad`.
6. Admin UI: single "North correction (°)" input on **Settings → Maps**
   (`clubMap.setRotation`), with a scope hint. The value only affects
   the georeference; display uprightness is automatic. Events copy the
   value when the map is added (`course.useClubMap`) — changing the
   library value later requires re-adding the map to the event.
   `course.setMapRotation` remains for ops/API.

## Ops note

Maps uploaded before this fix stored the physics-only suggestion
(≈5° for Nackareservatet) and a paper-up `northOffset`. Re-upload the
map (or re-add it to the event) so detection reruns; that also bumps
`uploadedAt`, which busts the client tile cache.

## Tests

- Unit: `map-projection-correction.test.ts`, `map-north.test.ts`
  (tilt subtraction + `displayNorthOffsetDeg` fold)
- Integration: `map-rotation.test.ts`, club-map `setRotation` + copy-on-use
- E2E: Settings → Maps north-correction smoke
