# Course-map exports with black terrain areas

## Symptom

Some OCAD maps rendered correctly in Oxygen's screen map but produced course
map previews/PDFs with large black areas. Nackareservatet was affected while
the Saltsjöbaden fixture looked correct.

## Cause

`ocad2geojson` emits its SVG root with `fill="transparent"`. Many line
symbols intentionally omit a `fill` attribute and inherit that root value.
The course-map composer copied only the root's children into its paper SVG:

```xml
<svg fill="transparent" viewBox="...">
  <!-- children copied, root presentation discarded -->
</svg>
```

Without the inherited transparent fill, SVG's default black fill applied to
open and closed paths. Maps containing more of those symbols appeared mostly
black.

The regular map tile renderer did not have the bug because it rasterized the
complete generated SVG, including the root attributes.

## Fix

The paper composer now carries the generated root `fill` value onto the
nested map viewport. It defaults to transparent if the generated root has no
explicit fill:

```xml
<svg x="..." y="..." viewBox="..." fill="transparent">
  <!-- generated map children -->
</svg>
```

The regression test uses a fill-less terrain path under a transparent OCAD
root and asserts that the composed map viewport retains the inherited fill.
