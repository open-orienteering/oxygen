# Bugfix: red bands around maps (empty-tile placeholder was red, not transparent)

## Symptom

After the tile-retry work shipped, every map grew semi-transparent red
bands over the areas outside the map extent — a rotated grid of pink
tiles flanking the drawing.

## Root cause

`/api/map-tile` returns a shared 1×1 placeholder PNG for tiles that are
entirely outside the map bounds or render empty (previously a 204; the
change to a real PNG was intentional so the client's fetch path treats
them as normal loads instead of blacklisting them).

The base64 constant checked in as the "transparent" pixel actually
decoded to **RGBA(255, 0, 0, 127)** — a half-transparent red pixel.
Nothing in the pipeline noticed: the integration test only asserted the
PNG magic bytes and content type, which a red pixel satisfies just as
well.

## Fix

- Replaced the constant in `packages/api/src/map-tiles.ts` with a
  verified RGBA(0, 0, 0, 0) pixel.
- The integration test (`map-tiles.test.ts`, off-bounds case) now
  inflates the IDAT chunk and asserts the decoded pixel is exactly
  `[0, 0, 0, 0]`, so the constant can't silently regress again.

## Ops note

The placeholder is served with `Cache-Control: public, max-age=604800`,
so browsers that already fetched red tiles keep them for up to a week
for the same map version. The tile URL includes `?v=<uploadedAt>` —
re-uploading or re-adding the map busts it immediately, as does a
hard reload.
